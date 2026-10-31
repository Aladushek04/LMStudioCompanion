/**
 * Attachment memory: when compaction summarizes past a message with
 * attachments, their extracted content (document fact-sheets, image
 * descriptions) survives here — keyed by LM Studio's stable file
 * identifier, persisted with the same serialized/coalesced atomic-write
 * pattern as the chunk cache.
 */
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type AttachmentKind = "document" | "image" | "unknown";

/** Map an SDK FileType to the extraction path it should take. */
export function classifyFileType(type: string): AttachmentKind {
  switch (type) {
    case "text/plain":
    case "application/pdf":
    case "application/word":
    case "text/other":
      return "document";
    case "image":
      return "image";
    default:
      return "unknown";
  }
}

export interface AttachmentMemoryEntry {
  name: string;
  type: string;
  sizeBytes: number;
  kind: "document" | "image";
  memory: string;
  model?: string;
  createdAt: number;
  lastUsedAt: number;
}

export const MAX_ATTACHMENT_ENTRIES = 500;

export class AttachmentMemoryStore {
  private entries = new Map<string, AttachmentMemoryEntry>();
  private persistChain: Promise<void> = Promise.resolve();
  private persistDirty = false;

  constructor(private readonly filePath?: string) {}

  /** Test hook: lets tests inject write latency to reproduce races. */
  protected async beforeWrite(): Promise<void> {}

  static async load(filePath: string): Promise<AttachmentMemoryStore> {
    const store = new AttachmentMemoryStore(filePath);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      if (raw && typeof raw.entries === "object" && raw.entries !== null) {
        for (const [identifier, entry] of Object.entries(raw.entries)) {
          const e = entry as AttachmentMemoryEntry;
          if (typeof e.memory === "string" && typeof e.name === "string") {
            store.entries.set(identifier, e);
          }
        }
      }
    } catch {
      // Missing or corrupt file: start empty; memories are regenerable.
    }
    return store;
  }

  get size(): number {
    return this.entries.size;
  }

  get(identifier: string): AttachmentMemoryEntry | undefined {
    const entry = this.entries.get(identifier);
    if (entry) entry.lastUsedAt = Date.now();
    return entry;
  }

  has(identifier: string): boolean {
    return this.entries.has(identifier);
  }

  put(identifier: string, entry: AttachmentMemoryEntry): void {
    this.entries.set(identifier, entry);
    while (this.entries.size > MAX_ATTACHMENT_ENTRIES) {
      let oldest: string | undefined;
      let oldestUsed = Infinity;
      for (const [id, e] of this.entries) {
        if (e.lastUsedAt < oldestUsed) {
          oldestUsed = e.lastUsedAt;
          oldest = id;
        }
      }
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Serialized + coalesced, same guarantees as ChunkCache.persist. */
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
        `.attachments-${process.pid}-${randomUUID()}.tmp`,
      );
      await this.beforeWrite();
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch {
      // Best-effort: a failed persist only costs a future re-extraction.
    }
  }
}
