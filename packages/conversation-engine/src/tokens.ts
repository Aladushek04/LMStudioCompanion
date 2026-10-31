/**
 * Memoized token counting. Counting goes through the model's real tokenizer
 * (injected), but each distinct message is only counted once per process.
 */
import { CanonMessage, canon } from "./view";

export const PER_MESSAGE_OVERHEAD = 4;

/**
 * Plain-text rendering of a message for token counting — canon() is a JSON
 * serialization (role/text/toolCalls/toolResults/files scaffolding plus
 * escaping) that the model never actually sees; counting it systematically
 * inflates estimates by ~20-30 tokens per message. This is what the model's
 * chat template roughly renders instead: one line per role/text, tool call,
 * tool result, and file, newline-joined. No truncation.
 */
export function renderForCount(m: CanonMessage): string {
  const lines = [`${m.role}: ${m.text}`];
  for (const c of m.toolCalls ?? []) {
    lines.push(`tool call: ${c.name}(${c.args})`);
  }
  for (const r of m.toolResults ?? []) {
    lines.push(`tool result: ${r.content}`);
  }
  for (const f of m.files ?? []) {
    lines.push(`file: ${f}`);
  }
  return lines.join("\n");
}

export class TokenCounter {
  private memo = new Map<string, Promise<number>>();

  constructor(
    private readonly count: (text: string) => Promise<number>,
    private readonly perMessageOverhead: number = PER_MESSAGE_OVERHEAD,
  ) {}

  async countMessage(m: CanonMessage): Promise<number> {
    // canon() stays the memo key (stable, content-addressed identity) even
    // though what actually gets tokenized is the plain-text rendering.
    const key = canon(m);
    let pending = this.memo.get(key);
    if (!pending) {
      pending = this.count(renderForCount(m));
      this.memo.set(key, pending);
    }
    return (await pending) + this.perMessageOverhead;
  }

  /** Per-message counts (incl. overhead), aligned with the input array. */
  async countMessages(msgs: CanonMessage[]): Promise<number[]> {
    return Promise.all(msgs.map((m) => this.countMessage(m)));
  }
}
