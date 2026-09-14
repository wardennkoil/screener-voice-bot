import { GoogleGenAI } from "@google/genai";
import type { Logger } from "../logger.js";
import type { HistoryStep, LlmAdapter, LlmRunHandlers, LlmRunParams, LlmRunResult, LlmToolCall } from "./llm.js";

export interface GeminiAdapterOptions {
  apiKey: string;
  model: string;
  thinkingLevel: "low" | "medium" | "high";
  /** Cap per reply; phone replies are short and a cap prevents runaway monologues. */
  maxOutputTokens?: number;
  /** HTTP timeout per interaction in ms. */
  timeoutMs?: number;
  log?: Logger;
}

type ModelOutputStep = Extract<HistoryStep, { type: "model_output" }>;
type FunctionCallStep = Extract<HistoryStep, { type: "function_call" }>;
type ThoughtStep = Extract<HistoryStep, { type: "thought" }>;

interface Accumulator {
  step: HistoryStep;
  args: string;
  completed: boolean;
}

/**
 * Gemini via the Interactions API in stateless mode: the full step history is
 * sent every turn (store: false keeps screening answers out of Google's stored
 * interactions), text streams out as it is generated, and function calls are
 * reconstructed from step events.
 */
export class GeminiInteractionsAdapter implements LlmAdapter {
  private readonly ai: GoogleGenAI;

  constructor(private readonly opts: GeminiAdapterOptions) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  async run(params: LlmRunParams, handlers: LlmRunHandlers): Promise<LlmRunResult> {
    const steps: HistoryStep[] = [];
    const toolCalls: LlmToolCall[] = [];
    const byIndex = new Map<number, Accumulator>();
    let text = "";

    const abortedResult = (): LlmRunResult => ({
      // Keep what was actually said; drop reasoning and half-received calls.
      steps: steps.filter((s) => s.type === "model_output" && s.content.some((c) => c.text.length > 0)),
      toolCalls: [],
      text,
      aborted: true,
    });

    const emitText = (index: number, delta: string): void => {
      if (!delta) return;
      let acc = byIndex.get(index);
      if (!acc || acc.step.type !== "model_output") {
        const step: ModelOutputStep = { type: "model_output", content: [{ type: "text", text: "" }] };
        acc = { step, args: "", completed: false };
        byIndex.set(index, acc);
        steps.push(step);
      }
      (acc.step as ModelOutputStep).content[0]!.text += delta;
      text += delta;
      handlers.onText(delta);
    };

    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.ai.interactions.create(
        {
          model: this.opts.model,
          input: params.history,
          system_instruction: params.system,
          ...(params.tools.length > 0 ? { tools: params.tools } : {}),
          generation_config: { thinking_level: this.opts.thinkingLevel, max_output_tokens: this.opts.maxOutputTokens ?? 400 },
          stream: true,
          store: false,
        },
        { fetchOptions: { signal: params.signal }, timeout: this.opts.timeoutMs ?? 20_000 },
      );
    } catch (err) {
      if (params.signal.aborted) return abortedResult();
      throw err;
    }

    try {
      for await (const raw of stream) {
        const event = raw as GeminiEvent;
        switch (event.event_type) {
          case "step.start": {
            const s = event.step;
            if (s.type === "model_output") {
              const content: Array<{ type: string; text?: string }> = s.content ?? [];
              const initial = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
              emitText(event.index, initial);
              if (!byIndex.has(event.index)) {
                const step: ModelOutputStep = { type: "model_output", content: [{ type: "text", text: "" }] };
                byIndex.set(event.index, { step, args: "", completed: false });
                steps.push(step);
              }
            } else if (s.type === "function_call") {
              const step: FunctionCallStep = { type: "function_call", id: s.id, name: s.name, arguments: s.arguments ?? {} };
              byIndex.set(event.index, { step, args: "", completed: false });
              steps.push(step);
            } else if (s.type === "thought") {
              const step: ThoughtStep = { type: "thought", ...(s.signature ? { signature: s.signature } : {}) };
              byIndex.set(event.index, { step, args: "", completed: false });
              steps.push(step);
            }
            break;
          }
          case "step.delta": {
            const d = event.delta;
            const acc = byIndex.get(event.index);
            if (d.type === "text") emitText(event.index, d.text);
            else if (d.type === "arguments_delta" && acc?.step.type === "function_call") acc.args += d.arguments ?? "";
            else if (d.type === "thought_signature" && acc?.step.type === "thought" && d.signature) acc.step.signature = d.signature;
            break;
          }
          case "step.stop": {
            const acc = byIndex.get(event.index);
            if (acc && !acc.completed) {
              acc.completed = true;
              if (acc.step.type === "function_call") {
                if (acc.args.trim()) {
                  try {
                    acc.step.arguments = JSON.parse(acc.args) as Record<string, unknown>;
                  } catch (err) {
                    this.opts.log?.warn({ err, args: acc.args }, "could not parse streamed function arguments");
                  }
                }
                toolCalls.push({ id: acc.step.id, name: acc.step.name, args: acc.step.arguments });
              }
            }
            break;
          }
          case "error":
            throw new Error(`Gemini interaction error: ${event.error?.message ?? "unknown"}`);
          default:
            break;
        }
      }
    } catch (err) {
      if (params.signal.aborted) return abortedResult();
      throw err;
    }

    if (params.signal.aborted) return abortedResult();
    // Function calls that never reached step.stop are not executable.
    const finalSteps = steps.filter((s) => s.type !== "function_call" || toolCalls.some((c) => c.id === s.id));
    return { steps: finalSteps, toolCalls, text, aborted: false };
  }
}

/** Minimal structural view of the SSE events we consume (other event types fall through the default branch). */
type GeminiStep =
  | { type: "model_output"; content?: Array<{ type: string; text?: string }> }
  | { type: "function_call"; id: string; name: string; arguments?: Record<string, unknown> }
  | { type: "thought"; signature?: string }
  | { type: "user_input" | "function_result" | "other" };
type GeminiDelta =
  | { type: "text"; text: string }
  | { type: "arguments_delta"; arguments?: string }
  | { type: "thought_signature"; signature?: string }
  | { type: "thought_summary" | "other" };
type GeminiEvent =
  | { event_type: "step.start"; index: number; step: GeminiStep }
  | { event_type: "step.delta"; index: number; delta: GeminiDelta }
  | { event_type: "step.stop"; index: number }
  | { event_type: "error"; error?: { message?: string } }
  | { event_type: "interaction.created" | "interaction.status_update" | "interaction.completed" };
