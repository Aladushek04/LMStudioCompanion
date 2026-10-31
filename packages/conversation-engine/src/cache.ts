/**
 * Content-addressed summary cache. An entry stored under prefix-hash H means:
 * "the messages hashed by H are covered by these byte-stable chunk summaries."
 * Persistence is a single JSON file written atomically; the cache is always
 * reconstructible, so corruption or loss just means re-summarizing.
 */
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

export interface CacheEntry {
  /** Byte-stable chunk summaries covering messages [0, coveredCount). */
  chunkSummaries: string[];
  coveredCount: number;
  tokensBefore: number;
  createdAt: number;
  lastUsedAt: number;
  /**
   * When set, chunkSummaries[0] is a consolidated (L1) summary folded from
   * this many original chunk summaries.
   */
  consolidated?: number;
  /** Per-chat compression ledger carried forward across entries. */
  stats?: {
    events: Array<{
      at: number;
      kind: "auto" | "force" | "safety" | "mid-task" | "consolidation";
      beforeTokens: number;
      afterTokens: number;
    }>;
  };
}

export const MAX_ENTRIES = 200;

export class ChunkCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private readonly filePath?: string) {}

  /** Test hook: lets tests inject write latency to reproduce races. */
  protected async beforeWrite(): Promise<void> {}

  static async load(filePath: string): Promise<ChunkCache> {
    const cache = new ChunkCache(filePath);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      if (raw && typeof raw.entries === "object" && raw.entries !== null) {
        for (const [hash, entry] of Object.entries(raw.entries)) {
          const e = entry as CacheEntry;
          if (Array.isArray(e.chunkSummaries) && typeof e.coveredCount === "number") {
            cache.entries.set(hash, e);
          }
        }
      }
    } catch {
      // Missing or corrupt file: start empty; the cache is reconstructible.
    }
    return cache;
  }

  get size(): number {
    return this.entries.size;
  }

  get(hash: string): CacheEntry | undefined {
    const entry = this.entries.get(hash);
    if (entry) entry.lastUsedAt = Date.now();
    return entry;
  }

  put(hash: string, entry: CacheEntry): void {
    this.entries.set(hash, entry);
    while (this.entries.size > MAX_ENTRIES) {
      let oldestHash: string | undefined;
      let oldestUsed = Infinity;
      for (const [h, e] of this.entries) {
        if (e.lastUsedAt < oldestUsed) {
          oldestUsed = e.lastUsedAt;
          oldestHash = h;
        }
      }
      if (oldestHash === undefined) break;
      this.entries.delete(oldestHash);
    }
  }

  /** Scan from the end: the longest prefix with a cached entry wins. */
  findLongestMatch(
    hashes: string[],
  ): { index: number; entry: CacheEntry } | undefined {
    for (let i = hashes.length - 1; i >= 0; i--) {
      const entry = this.entries.get(hashes[i]);
      if (entry) {
        entry.lastUsedAt = Date.now();
        return { index: i, entry };
      }
    }
    return undefined;
  }

  private persistChain: Promise<void> = Promise.resolve();
  private persistDirty = false;

  /**
   * Serialized and coalesced: concurrent calls queue behind one another
   * (so an older snapshot can never overwrite a newer one on disk) and
   * each executed write snapshots the map at execution time, collapsing
   * queued requests into a single write of the freshest state.
   */
  persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    this.persistDirty = true;
    this.persistChain = this.persistChain.then(() => this.persistNow());
    return this.persistChain;
  }

  private async persistNow(): Promise<void> {
    if (!this.persistDirty || !this.filePath) return;
    this.persistDirty = false;
    try {
      const payload = JSON.stringify(
        { version: 1, entries: Object.fromEntries(this.entries) },
        null,
        0,
      );
      const tmp = join(
        dirname(this.filePath),
        `.cache-${process.pid}-${randomUUID()}.tmp`,
      );
      await this.beforeWrite();
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch {
      // Best-effort: a failed persist only costs a future re-summarization.
      // Swallowing also keeps the chain resolvable for future persists.
    }
  }
}
