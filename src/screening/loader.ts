import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { QuestionnaireSchema, type Questionnaire } from "./schema.js";

export async function loadQuestionnaire(path: string): Promise<Questionnaire> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read questionnaire at ${path}: ${(err as Error).message}`);
  }
  return parseQuestionnaire(text, path);
}

export function parseQuestionnaire(yamlText: string, sourceLabel = "questionnaire"): Questionnaire {
  const raw: unknown = parseYaml(yamlText);
  const parsed = QuestionnaireSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${sourceLabel}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
