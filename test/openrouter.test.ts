import pino from "pino";
import { describe, expect, it } from "vitest";
import type { HistoryStep } from "../src/conversation/llm.js";
import { historyToMessages, OpenRouterAdapter } from "../src/conversation/openrouter.js";
import { TOOL_DECLARATIONS } from "../src/conversation/tools.js";

function sse(lines: string[], opts: { hold?: AbortSignal } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i < lines.length) {
        controller.enqueue(enc.encode(lines[i++] + "\n"));
        return;
      }
      if (opts.hold) {
        await new Promise<void>((resolve) => opts.hold!.addEventListener("abort", () => resolve(), { once: true }));
        controller.error(new Error("aborted"));
        return;
      }
      controller.close();
    },
  });
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: "x", choices: [{ delta, finish_reason: finish }] })}`;

describe("historyToMessages", () => {
  it("collapses model steps into one assistant message and maps tool results", () => {
    const history: HistoryStep[] = [
      { type: "user_input", content: [{ type: "text", text: "Hello?" }] },
      { type: "thought", reasoning_details: [{ type: "reasoning.encrypted", data: "abc" }] },
      { type: "model_output", content: [{ type: "text", text: "Got it. " }] },
      { type: "function_call", id: "call_1", name: "confirm_identity", arguments: { result: "confirmed" } },
      { type: "function_result", call_id: "call_1", name: "confirm_identity", result: [{ type: "text", text: '{"ok":true}' }] },
      { type: "model_output", content: [{ type: "text", text: "Do you have five minutes?" }] },
    ];
    const msgs = historyToMessages("SYS", history);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(msgs[2]).toMatchObject({ content: "Got it. ", reasoning_details: [{ type: "reasoning.encrypted", data: "abc" }] });
    expect(msgs[2]!.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "confirm_identity", arguments: '{"result":"confirmed"}' } }]);
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"ok":true}' });
  });

  it("uses null content for tool-only assistant turns", () => {
    const msgs = historyToMessages("S", [
      { type: "user_input", content: [{ type: "text", text: "yes" }] },
      { type: "function_call", id: "c", name: "record_consent", arguments: { proceed: true } },
    ]);
    expect(msgs[2]!.content).toBeNull();
  });
});

describe("OpenRouterAdapter", () => {
  const base = { apiKey: "k", model: "test/model", log: pino({ level: "silent" }) };

  it("streams text, rebuilds chunked tool calls, and keeps reasoning details", async () => {
    let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers as Record<string, string> };
      return new Response(
        sse([
          ": OPENROUTER PROCESSING",
          chunk({ role: "assistant", content: "" }),
          chunk({ reasoning_details: [{ type: "reasoning.text", text: "hmm" }] }),
          chunk({ content: "Got " }),
          chunk({ content: "it." }),
          chunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "record_answer", arguments: '{"question_id":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"age","value":42}' } }] }),
          chunk({}, "tool_calls"),
          "data: [DONE]",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const adapter = new OpenRouterAdapter({ ...base, fetchImpl, reasoningEffort: "low" });
    const texts: string[] = [];
    const result = await adapter.run({ system: "SYS", history: [{ type: "user_input", content: [{ type: "text", text: "forty two" }] }], tools: TOOL_DECLARATIONS, signal: new AbortController().signal }, { onText: (t) => texts.push(t) });
    expect(texts).toEqual(["Got ", "it."]);
    expect(result.text).toBe("Got it.");
    expect(result.toolCalls).toEqual([{ id: "call_9", name: "record_answer", args: { question_id: "age", value: 42 } }]);
    expect(result.steps.map((s) => s.type)).toEqual(["thought", "model_output", "function_call"]);
    expect(captured?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured?.headers.authorization).toBe("Bearer k");
    expect(captured?.body).toMatchObject({ model: "test/model", stream: true, reasoning: { effort: "low" }, provider: { sort: "latency", data_collection: "deny", require_parameters: true }, tool_choice: "auto" });
    expect((captured?.body.tools as unknown[]).length).toBe(TOOL_DECLARATIONS.length);
    expect((captured?.body.messages as unknown[])[0]).toEqual({ role: "system", content: "SYS" });
  });

  it("surfaces HTTP errors with OpenRouter's message", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ ...base, fetchImpl });
    await expect(adapter.run({ system: "S", history: [], tools: [], signal: new AbortController().signal }, { onText: () => undefined })).rejects.toThrow(/OpenRouter 401.*bad key/);
  });

  it("resolves as aborted, keeping spoken text, when interrupted mid-stream", async () => {
    const ac = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => new Response(sse([chunk({ content: "Let me explain " })], { hold: init?.signal ?? undefined }), { status: 200 })) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ ...base, fetchImpl });
    const texts: string[] = [];
    const run = adapter.run({ system: "S", history: [], tools: [], signal: ac.signal }, { onText: (t) => texts.push(t) });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.text).toBe("Let me explain ");
    expect(result.steps).toEqual([{ type: "model_output", content: [{ type: "text", text: "Let me explain " }] }]);
    expect(texts).toEqual(["Let me explain "]);
  });
});
