import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { env } from "../config.js";
import { loadContacts, type Contact } from "../storage/contacts.js";

const USAGE = `Usage:
  npm run dial -- --to +15551234567 --contact-id C001 --name Jordan [--attempt 1] [--wait]
  npm run dial -- --contacts contacts.csv [--dry-run] [--force] [--wait]

Options:
  --server URL       Screener server (default http://localhost:PORT)
  --force            Call contacts that already have a completed/declined row
  --ignore-window    Skip the local-time calling window check
  --wait             Poll until each call finishes and print the outcome
`;

interface Args {
  to?: string;
  "contact-id"?: string;
  name?: string;
  attempt?: string;
  contacts?: string;
  server?: string;
  "dry-run"?: boolean;
  force?: boolean;
  wait?: boolean;
  "ignore-window"?: boolean;
  help?: boolean;
}

function localHHMM(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at).replace(/^24/, "00");
}

export function withinWindow(window: string, timezone: string, at = new Date()): boolean {
  const [start, end] = window.split("-") as [string, string];
  const now = localHHMM(timezone, at);
  return now >= start && now <= end;
}

interface CsvHistory {
  /** Contacts with a final outcome (completed, declined, wrong person). */
  done: Set<string>;
  /** Number of prior attempts per contact. */
  attempts: Map<string, number>;
}

async function readHistory(csvPath: string): Promise<CsvHistory> {
  const history: CsvHistory = { done: new Set(), attempts: new Map() };
  try {
    const text = await readFile(csvPath, "utf8");
    const rows = parse(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
    for (const r of rows) {
      const id = r.contact_id ?? "";
      history.attempts.set(id, (history.attempts.get(id) ?? 0) + 1);
      if (["completed", "declined", "wrong_person"].includes(r.outcome ?? "")) history.done.add(id);
    }
  } catch {
    // no CSV yet
  }
  return history;
}

async function placeCall(server: string, secret: string, contact: Contact & { attempt: number }): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${server}/calls`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ contactId: contact.contact_id, phone: contact.phone, firstName: contact.first_name, attempt: contact.attempt }),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
    throw new Error(`cannot reach the screener server at ${server} (${cause}). Start it in another terminal with "npm run dev" (and keep ngrok running), then dial again.`);
  }
  if (!res.ok) throw new Error(`server refused the call: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { callSid: string };
  return body.callSid;
}

async function waitForCall(server: string, secret: string, callSid: string): Promise<{ outcome: string | null; eligible: string | null; status: string }> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${server}/calls/${callSid}`, { headers: { authorization: `Bearer ${secret}` } });
    if (!res.ok) throw new Error(`cannot poll call ${callSid}: ${res.status}`);
    const c = (await res.json()) as { status: string; finalized: boolean; outcome: string | null; eligible: string | null };
    if (c.finalized) return c;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      to: { type: "string" },
      "contact-id": { type: "string" },
      name: { type: "string" },
      attempt: { type: "string" },
      contacts: { type: "string" },
      server: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      wait: { type: "boolean" },
      "ignore-window": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const args = values as Args;
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const e = env();
  const server = args.server ?? `http://localhost:${e.PORT}`;
  const secret = e.SESSION_TOKEN_SECRET;
  if (!secret && !args["dry-run"]) throw new Error("SESSION_TOKEN_SECRET must be set (it authenticates the control API)");

  const history = await readHistory(e.OUTPUT_CSV);
  const attemptFor = (id: string): number => (args.attempt ? Number(args.attempt) : (history.attempts.get(id) ?? 0) + 1);

  let contacts: Array<Contact & { attempt: number }>;
  if (args.contacts) {
    contacts = (await loadContacts(args.contacts)).map((c) => ({ ...c, attempt: attemptFor(c.contact_id) }));
  } else if (args.to && args["contact-id"] && args.name) {
    contacts = [{ contact_id: args["contact-id"], phone: args.to, first_name: args.name, attempt: attemptFor(args["contact-id"]) }];
  } else {
    console.error(USAGE);
    process.exit(2);
  }

  const done = args.force ? new Set<string>() : history.done;
  const queue = contacts.filter((c) => {
    if (done.has(c.contact_id)) {
      console.log(`skip ${c.contact_id}: already has a final row (use --force to redo)`);
      return false;
    }
    const tz = c.timezone ?? e.DEFAULT_TIMEZONE;
    if (!args["ignore-window"] && !withinWindow(e.CALL_WINDOW_LOCAL, tz)) {
      console.log(`skip ${c.contact_id}: outside calling window ${e.CALL_WINDOW_LOCAL} (${tz}, now ${localHHMM(tz)})`);
      return false;
    }
    return true;
  });

  if (args["dry-run"]) {
    for (const c of queue) console.log(`would call ${c.contact_id} ${c.first_name} ${c.phone} (attempt ${c.attempt})`);
    console.log(`${queue.length} call(s) would be placed`);
    return;
  }

  const limit = Math.max(1, e.MAX_CONCURRENT_CALLS);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < queue.length) {
      const c = queue[index++]!;
      try {
        const callSid = await placeCall(server, secret!, c);
        console.log(`calling ${c.contact_id} ${c.first_name} ${c.phone} (attempt ${c.attempt}) -> ${callSid}`);
        if (args.wait || queue.length > 1) {
          const r = await waitForCall(server, secret!, callSid);
          console.log(`done ${c.contact_id}: outcome=${r.outcome ?? "unknown"} eligible=${r.eligible ?? "-"}`);
        }
      } catch (err) {
        console.error(`failed ${c.contact_id}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
