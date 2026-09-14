import type { Env } from "../config.js";
import type { Logger } from "../logger.js";
import { GeminiInteractionsAdapter } from "./gemini.js";
import type { LlmAdapter } from "./llm.js";
import { OpenRouterAdapter } from "./openrouter.js";

export interface LlmChoice {
  provider: "openrouter" | "gemini";
  model: string;
}

/** OpenRouter by default; falls back to a direct Gemini key when that is all that is configured. */
function resolveProvider(e: Env): LlmChoice["provider"] {
  if (e.LLM_PROVIDER === "gemini") return "gemini";
  if (!e.OPENROUTER_API_KEY && e.GEMINI_API_KEY && !process.env.LLM_PROVIDER) return "gemini";
  return "openrouter";
}

export function describeLlm(e: Env, modelOverride?: string): LlmChoice {
  const provider = resolveProvider(e);
  if (provider === "gemini") return { provider, model: modelOverride ?? e.GEMINI_MODEL };
  return { provider, model: modelOverride ?? e.OPENROUTER_MODEL };
}

/** The one place that turns configuration into a model adapter. */
export function createLlm(e: Env, log: Logger, modelOverride?: string): LlmAdapter {
  const choice = describeLlm(e, modelOverride);
  if (choice.provider === "gemini") {
    if (!e.GEMINI_API_KEY) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY (see .env.example)");
    if (!e.OPENROUTER_API_KEY && e.LLM_PROVIDER !== "gemini") log.warn("OPENROUTER_API_KEY is not set; using the direct Gemini key instead. Add OPENROUTER_API_KEY to route through OpenRouter.");
    return new GeminiInteractionsAdapter({ apiKey: e.GEMINI_API_KEY, model: choice.model, thinkingLevel: e.GEMINI_THINKING_LEVEL, log });
  }
  if (!e.OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY (see .env.example), or set LLM_PROVIDER=gemini");
  return new OpenRouterAdapter({
    apiKey: e.OPENROUTER_API_KEY,
    model: choice.model,
    reasoningEffort: e.OPENROUTER_REASONING_EFFORT,
    providerSort: e.OPENROUTER_PROVIDER_SORT,
    log,
  });
}
