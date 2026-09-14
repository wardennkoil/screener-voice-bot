import { readFileSync } from "node:fs";
import { parseQuestionnaire } from "../src/screening/loader.js";

export function sampleQuestionnaire() {
  return parseQuestionnaire(readFileSync(new URL("../config/questionnaire.yaml", import.meta.url), "utf8"));
}
