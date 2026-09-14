import { describe, expect, it } from "vitest";
import { SentenceChunker } from "../src/local/sentences.js";

describe("SentenceChunker", () => {
  it("emits complete sentences as tokens arrive and flushes the tail", () => {
    const c = new SentenceChunker();
    const out: string[] = [];
    for (const t of ["Got it, ", "forty-two. ", "Next, do you ", "take any sleep ", "medication? ", "Just yes"]) out.push(...c.push(t));
    expect(out).toEqual(["Got it, forty-two. ", "Next, do you take any sleep medication? "]);
    expect(c.flush()).toBe("Just yes ");
    expect(c.flush()).toBeNull();
  });

  it("does not split on decimals or very short sentences", () => {
    const c = new SentenceChunker();
    const out = c.push("It costs 3.5 dollars. Ok. Fine by me. ");
    expect(out).toEqual(["It costs 3.5 dollars. ", "Ok. Fine by me. "]);
  });

  it("cuts long clauses so the first audio starts early", () => {
    const c = new SentenceChunker({ maxChars: 40 });
    const out = c.push("So the way this works is that we go through a few quick questions, and then the team follows up ");
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]).toBe("So the way this works is that we go through a few quick questions, ");
  });
});
