import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "vitest";
import {
  AttachmentMemoryEntry,
  AttachmentMemoryStore,
  MAX_ATTACHMENT_ENTRIES,
  classifyFileType,
} from "../src/attachments";

const entry = (n: number): AttachmentMemoryEntry => ({
  name: `file-${n}.txt`,
  type: "text/plain",
  sizeBytes: n * 10,
  kind: "document",
  memory: `facts-${n}`,
  createdAt: 1000 + n,
  lastUsedAt: 1000 + n,
});

describe("classifyFileType", () => {
  test("documents, images, and unknown", () => {
    expect(classifyFileType("text/plain")).toBe("document");
    expect(classifyFileType("application/pdf")).toBe("document");
    expect(classifyFileType("application/word")).toBe("document");
    expect(classifyFileType("text/other")).toBe("document");
    expect(classifyFileType("image")).toBe("image");
    expect(classifyFileType("unknown")).toBe("unknown");
    expect(classifyFileType("weird/new")).toBe("unknown");
  });
});

describe("AttachmentMemoryStore", () => {
  test("put/get/has round-trip, get touches LRU while has does not", () => {
    const store = new AttachmentMemoryStore();
    store.put("id1", entry(1));
    expect(store.has("id1")).toBe(true);
    expect(store.get("id1")?.memory).toBe("facts-1");
    expect(store.has("nope")).toBe(false);
    expect(store.get("nope")).toBeUndefined();
  });

  test("evicts least recently used beyond capacity", () => {
    const store = new AttachmentMemoryStore();
    for (let i = 0; i < MAX_ATTACHMENT_ENTRIES; i++) {
      store.put(`id${i}`, entry(i));
    }
    store.get("id0"); // touch
    store.put("overflow", entry(999));
    expect(store.has("id0")).toBe(true);
    expect(store.has("id1")).toBe(false);
    expect(store.size).toBe(MAX_ATTACHMENT_ENTRIES);
  });

  test("persist/load round-trip and corrupt-file tolerance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lmcc-att-"));
    const file = join(dir, "attachments.json");
    const store = new AttachmentMemoryStore(file);
    store.put("id1", entry(1));
    await store.persist();
    const loaded = await AttachmentMemoryStore.load(file);
    expect(loaded.get("id1")?.memory).toBe("facts-1");

    await writeFile(file, "not json{{", "utf8");
    const corrupt = await AttachmentMemoryStore.load(file);
    expect(corrupt.size).toBe(0);
    corrupt.put("id2", entry(2));
    await corrupt.persist();
    expect(
      JSON.parse(await readFile(file, "utf8")).entries.id2,
    ).toBeDefined();
  });

  test("concurrent persists cannot land an older snapshot last", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lmcc-att-"));
    const file = join(dir, "attachments.json");
    const store = new (class extends AttachmentMemoryStore {
      slowNext = true;
      protected override async beforeWrite(): Promise<void> {
        if (this.slowNext) {
          this.slowNext = false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    })(file);
    store.put("a", entry(1));
    const first = store.persist();
    store.put("b", entry(2));
    const second = store.persist();
    await Promise.all([first, second]);
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.entries.a).toBeDefined();
    expect(onDisk.entries.b).toBeDefined();
  });
});
