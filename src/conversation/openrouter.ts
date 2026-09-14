import type { Logger } from "../logger.js";
import type { HistoryStep, LlmAdapter, LlmRunHandlers, LlmRunParams, LlmRunResult, LlmToolCall } from "./llm.js";
import type { FunctionToolDecl } from "./tools.js";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface OpenRouterAdapterOptions {
  apiKey: string;
  model: string;
  /** Unified OpenRouter reasoning effort; "low" keeps replies fast on a call. */
  reasoningEffort?: ReasoningEffort;
  providerSort?: "latency" | "throughput" | "price";
  maxOutputTokens?: number;
  timeoutMs?: number;
  baseUrl?: string;
  appName?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  log?: Logger;
}

interface ToolCallPart {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallPart[];
  tool_call_id?: string;
  reasoning_details?: unknown[];
}

/**
 * Converts the provider-neutral step history into OpenAI-style chat messages.
 * Consecutive model steps (text, tool calls, reasoning) collapse into one
 * assistant message; reasoning details are echoed back untouched so models
 * that need them for tool-call continuity (Gemini, Claude) keep working.
 */
export function historyToMessages(system: string, history: HistoryStep[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: "system", content: system }];
  let assistant: OpenAiMessage | undefined;
  const flush = (): void => {
    if (!assistant) return;
    if (assistant.content === "") assistant.content = assistant.tool_calls?.length ? null : "";
    messages.push(assistant);
    assistant = undefined;
  };
  const ensureAssistant = (): OpenAiMessage => {
    if (!assistant) assistant = { role: "assistant", content: "" };
    return assistant;
  };
  for (const step of history) {
    switch (step.type) {
      case "user_input":
        flush();
        messages.push({ role: "user", content: step.content.map((c) => c.text).join("\n") });
        break;
      case "function_result":
        flush();
        messages.push({ role: "tool", tool_call_id: step.call_id, content: step.result.map((r) => r.text).join("\n") });
        break;
      case "model_output": {
        const a = ensureAssistant();
        a.content = (a.content ?? "") + step.content.map((c) => c.text).join("");
        break;
      }
      case "function_call": {
        const a = ensureAssistant();
        (a.tool_calls ??= []).push({ id: step.id, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments ?? {}) } });
        break;
      }
      case "thought": {
        if (step.reasoning_details?.length) {
          const a = ensureAssistant();
          a.reasoning_details = [...(a.reasoning_details ?? []), ...step.reasoning_details];
        }
        break;
      }
    }
  }
  flush();
  return messages;
}

export function toolsToOpenAi(tools: FunctionToolDecl[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

interface StreamDelta {
  content?: string | null;
  reasoning_details?: unknown[];
  tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

interface StreamChunk {
  id?: string;
  choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
  error?: { message?: string; code?: number | string };
}

/** Yields parsed SSE data payloads from a chat-completions stream. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (data) yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * OpenRouter (OpenAI-compatible) adapter. Streams text as it arrives, rebuilds
 * tool calls from argument fragments, and keeps reasoning details for replay.
 */
export class OpenRouterAdapter implements LlmAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenRouterAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  }

  async run(params: LlmRunParams, handlers: LlmRunHandlers): Promise<LlmRunResult> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: historyToMessages(params.system, params.history),
      stream: true,
      max_tokens: this.opts.maxOutputTokens ?? 400,
      provider: { sort: this.opts.providerSort ?? "latency", data_collection: "deny", ...(params.tools.length ? { require_parameters: true } : {}) },
      reasoning: { effort: this.opts.reasoningEffort ?? "low" },
    };
    if (params.tools.length) {
      body.tools = toolsToOpenAi(params.tools);
      body.tool_choice = "auto";
    }

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const reasoning: unknown[] = [];
    const abortedResult = (): LlmRunResult => ({
      steps: text ? [{ type: "model_output", content: [{ type: "text", text }] }] : [],
      toolCalls: [],
      text,
      aborted: true,
    });

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([params.signal, timeout]);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
          "http-referer": "https://github.com/screener-voice-bot",
          "x-title": this.opts.appName ?? "screener-voice-bot",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (params.signal.aborted) return abortedResult();
      throw err;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
    }

    try {
      for await (const data of readSse(res.body)) {
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(`OpenRouter stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_details?.length) reasoning.push(...delta.reasoning_details);
        if (delta.content) {
          text += delta.content;
          handlers.onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0;
          const acc = calls.get(index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          calls.set(index, acc);
        }
      }
    } catch (err) {
      if (params.signal.aborted) return abortedResult();
      throw err;
    }
    if (params.signal.aborted) return abortedResult();

    const steps: HistoryStep[] = [];
    if (reasoning.length) steps.push({ type: "thought", reasoning_details: reasoning });
    if (text) steps.push({ type: "model_output", content: [{ type: "text", text }] });
    const toolCalls: LlmToolCall[] = [];
    for (const [index, acc] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.name) continue;
      let args: Record<string, unknown> = {};
      if (acc.args.trim()) {
        try {
          args = JSON.parse(acc.args) as Record<string, unknown>;
        } catch (err) {
          this.opts.log?.warn({ err, args: acc.args }, "could not parse streamed tool arguments");
        }
      }
      const id = acc.id || `call_${index}_${Date.now()}`;
      steps.push({ type: "function_call", id, name: acc.name, arguments: args });
      toolCalls.push({ id, name: acc.name, args });
    }
    return { steps, toolCalls, text, aborted: false };
  }
}
