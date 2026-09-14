import type { FunctionToolDecl } from "./tools.js";

/** Conversation history in the Gemini Interactions API step shape (stateless mode). */
export type HistoryStep =
  | { type: "user_input"; content: Array<{ type: "text"; text: string }> }
  | { type: "model_output"; content: Array<{ type: "text"; text: string }> }
  | { type: "thought"; signature?: string; reasoning_details?: unknown[] }
  | { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "function_result"; call_id: string; name: string; result: Array<{ type: "text"; text: string }>; is_error?: boolean };

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmRunParams {
  system: string;
  history: HistoryStep[];
  tools: FunctionToolDecl[];
  signal: AbortSignal;
}

export interface LlmRunHandlers {
  /** Called with each text fragment as it streams in. */
  onText(delta: string): void;
}

export interface LlmRunResult {
  /** Steps produced by the model in this interaction, to be appended to history verbatim. */
  steps: HistoryStep[];
  /** Function calls that completed and should be executed (already included in `steps`). */
  toolCalls: LlmToolCall[];
  /** Full text produced (concatenated model_output text). */
  text: string;
  /** True when the run was cut short by the abort signal. */
  aborted: boolean;
}

/** One model interaction over the full history. Implementations must resolve (not reject) on abort. */
export interface LlmAdapter {
  run(params: LlmRunParams, handlers: LlmRunHandlers): Promise<LlmRunResult>;
}

export function userStep(text: string): HistoryStep {
  return { type: "user_input", content: [{ type: "text", text }] };
}

export function functionResultStep(callId: string, name: string, payload: unknown, isError = false): HistoryStep {
  const step: HistoryStep = { type: "function_result", call_id: callId, name, result: [{ type: "text", text: JSON.stringify(payload) }] };
  if (isError) step.is_error = true;
  return step;
}
