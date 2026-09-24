import "dotenv/config";
import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC").optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().regex(/^\+\d{8,15}$/, "E.164 number expected").optional(),
  PUBLIC_HOST: z.string().min(1).optional(),
  SESSION_TOKEN_SECRET: z.string().min(16).optional(),

  LLM_PROVIDER: z.enum(["openrouter", "gemini"]).default("openrouter"),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().default("openai/gpt-5.6-luna"),
  OPENROUTER_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high"]).default("low"),
  OPENROUTER_PROVIDER_SORT: z.enum(["latency", "throughput", "price"]).default("latency"),

  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_THINKING_LEVEL: z.enum(["low", "medium", "high"]).default("low"),

  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  /** Voice for the laptop page (/local); unset picks Cartesia when its key is set, else ElevenLabs. Phone calls always speak through Twilio with ELEVENLABS_VOICE. */
  TTS_PROVIDER: z.enum(["cartesia", "elevenlabs"]).optional(),
  CARTESIA_API_KEY: z.string().min(1).optional(),
  /** Katie: US English, female, Cartesia's recommended voice for agents. */
  CARTESIA_VOICE_ID: z.string().min(1).default("f786b574-daa5-4673-aa0c-cbe3e8534c02"),
  CARTESIA_MODEL_ID: z.string().min(1).default("sonic-3.6"),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  /** Overrides the voice id parsed from ELEVENLABS_VOICE for the laptop voice mode (TTS_PROVIDER=elevenlabs). */
  ELEVENLABS_VOICE_ID: z.string().min(1).optional(),
  ELEVENLABS_MODEL_ID: z.string().min(1).optional(),
  LOCAL_OUTPUT_CSV: z.string().default("data/local_results.csv"),
  LOCAL_SAMPLE_RATE: z.coerce.number().int().default(24000),
  /** Deepgram Flux eager end-of-turn threshold (0.3-0.9); unset disables speculative replies. */
  LOCAL_EAGER_EOT_THRESHOLD: z.coerce.number().min(0.3).max(0.9).optional(),

  ELEVENLABS_VOICE: z.string().default("aMSt68OGf4xUZAnLpTU8-flash_v2_5-1.0_0.5_0.75"),
  EOT_THRESHOLD: z.coerce.number().min(0.5).max(0.9).default(0.7),
  INTERRUPT_SENSITIVITY: z.enum(["high", "medium", "low"]).default("medium"),

  QUESTIONNAIRE_PATH: z.string().default("config/questionnaire.yaml"),
  OUTPUT_CSV: z.string().default("data/screening_results.csv"),
  TRANSCRIPTS_DIR: z.string().default("data/calls"),
  RECORD_CALLS: boolFromEnv.default(false),

  /** Admin panel at /admin. Required for access from anywhere but localhost. */
  ADMIN_TOKEN: z.string().min(12).optional(),
  /** /admin and /local answer anyone, with no token (test data only; set false to require ADMIN_TOKEN again). */
  OPEN_ACCESS: boolFromEnv.default(true),
  /** Model for post-call analysis; defaults to the conversation model. Latency does not matter here, so a stronger model pays off. */
  ANALYSIS_MODEL: z.string().min(1).optional(),
  ANALYSIS_DIR: z.string().default("data/analysis"),
  /** Postgres connection string. When set, transcripts, results and analyses live there instead of data/ (hosts without a disk). */
  DATABASE_URL: z.string().min(1).optional(),

  /** Twilio trial accounts cannot run ConversationRelay; dialing is refused unless this is set. */
  ALLOW_TRIAL_CALLS: boolFromEnv.default(false),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(20).default(2),
  CALL_WINDOW_LOCAL: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "HH:MM-HH:MM expected").default("09:00-20:00"),
  DEFAULT_TIMEZONE: z.string().default("America/New_York"),

  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  // A blank `KEY=` line (as copied from .env.example) means "not set", not an empty value.
  const set = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(set);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests: override the cached environment. */
export function setEnvForTests(overrides: Partial<Env>): void {
  cached = { ...env(), ...overrides };
}

export interface TwilioEnv {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  publicHost: string;
  sessionTokenSecret: string;
}

export function requireTwilio(): TwilioEnv {
  const e = env();
  const missing = (["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "PUBLIC_HOST", "SESSION_TOKEN_SECRET"] as const).filter((k) => !e[k]);
  if (missing.length) throw new Error(`Missing Twilio configuration: ${missing.join(", ")} (see .env.example)`);
  return {
    accountSid: e.TWILIO_ACCOUNT_SID!,
    authToken: e.TWILIO_AUTH_TOKEN!,
    fromNumber: e.TWILIO_FROM_NUMBER!,
    publicHost: e.PUBLIC_HOST!.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    sessionTokenSecret: e.SESSION_TOKEN_SECRET!,
  };
}

export function requireGemini(): { apiKey: string; model: string; thinkingLevel: Env["GEMINI_THINKING_LEVEL"] } {
  const e = env();
  if (!e.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY (see .env.example)");
  return { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL, thinkingLevel: e.GEMINI_THINKING_LEVEL };
}
