import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { z } from "zod";

export const ContactSchema = z.object({
  contact_id: z.string().min(1),
  phone: z.string().regex(/^\+\d{8,15}$/, "phone must be E.164, e.g. +15551234567"),
  first_name: z.string().min(1),
  timezone: z.string().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

export async function loadContacts(path: string): Promise<Contact[]> {
  const text = await readFile(path, "utf8");
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows.map((row, i) => {
    const cleaned = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === "" ? undefined : v]));
    const parsed = ContactSchema.safeParse(cleaned);
    if (!parsed.success) throw new Error(`contacts row ${i + 2}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
}
