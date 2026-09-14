/**
 * Turns a token stream into text-to-speech sized pieces. Emits at sentence
 * ends, or at a clause boundary once the buffer is long enough, so the first
 * audio starts early without chopping sentences into unnatural fragments.
 * Every emitted chunk ends with a single space (ElevenLabs' stream rule).
 */
export class SentenceChunker {
  private buffer = "";

  constructor(private readonly opts: { maxChars?: number; minChars?: number } = {}) {}

  push(token: string): string[] {
    this.buffer += token;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut === -1) break;
      const piece = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (piece) out.push(`${piece} `);
    }
    return out;
  }

  flush(): string | null {
    const piece = this.buffer.trim();
    this.buffer = "";
    return piece ? `${piece} ` : null;
  }

  get pending(): string {
    return this.buffer;
  }

  private findCut(): number {
    const maxChars = this.opts.maxChars ?? 110;
    const minChars = this.opts.minChars ?? 6;
    const text = this.buffer;
    // Sentence end followed by whitespace (avoids "3.5" and mid-number splits).
    const sentence = /[.!?]["')\]]?\s/g;
    let m: RegExpExecArray | null;
    while ((m = sentence.exec(text))) {
      const end = m.index + m[0].length;
      if (end >= minChars) return end;
    }
    if (text.length >= maxChars) {
      const clause = /[,;:]\s/g;
      let last = -1;
      while ((m = clause.exec(text))) {
        const end = m.index + m[0].length;
        if (end >= minChars) last = end;
      }
      if (last !== -1) return last;
      const space = text.lastIndexOf(" ");
      if (space >= maxChars) return space + 1;
    }
    return -1;
  }
}
