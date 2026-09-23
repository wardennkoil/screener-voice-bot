import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TranscriptTurn {
  role: "person" | "assistant" | "system";
  text: string;
  at: string;
  /** For assistant turns: how much of the text was actually heard before an interruption. */
  heard?: string;
  interrupted?: boolean;
}

export interface ToolCallLog {
  at: string;
  name: string;
  args: unknown;
  result: unknown;
}

export interface TurnMetrics {
  /** ISO time the person's final transcript arrived. */
  promptAt: string;
  /** ms from prompt to first model token. */
  firstTokenMs?: number;
  /** ms from prompt to last token sent. */
  lastTokenMs?: number;
  /** ms from prompt to Twilio reporting the first token played (needs events="tokens-played"). */
  firstAudioMs?: number;
  toolCalls: number;
}

export interface Transcript {
  callSid: string;
  contactId: string;
  phone: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  eligible?: string;
  turns: TranscriptTurn[];
  toolCalls: ToolCallLog[];
  metrics: TurnMetrics[];
  relayEvents: Array<{ at: string; type: string; data?: unknown }>;
  notes: string[];
}

export function newTranscript(init: Pick<Transcript, "callSid" | "contactId" | "phone">): Transcript {
  return { ...init, startedAt: new Date().toISOString(), turns: [], toolCalls: [], metrics: [], relayEvents: [], notes: [] };
}

const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A transcript id safe to use as a file name or key (what transcriptFileId produces). */
export function isValidSid(sid: string): boolean {
  return SID_RE.test(sid);
}

/** The file name (without .json) a call's transcript is saved under; also the call's id in the admin panel. */
export function transcriptFileId(callSid: string): string {
  return callSid.replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function saveTranscript(dir: string, t: Transcript): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${transcriptFileId(t.callSid)}.json`);
  await writeFile(path, JSON.stringify(t, null, 2), "utf8");
  return path;
}
