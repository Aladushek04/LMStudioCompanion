import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { CacheEntry, ChunkCache, MAX_ENTRIES } from "../src/cache";

const entry = (n: number): CacheEntry => ({
  chunkSummaries: [`summary-${n}`],
  coveredCount: n,
  tokensBefore: n * 100,
  createdAt: 1000 + n,
  lastUsedAt: 1000 + n,
});

describe("ChunkCache", () => {
  test("put then get returns the entry", () => {
    const cache = new ChunkCache();
    cache.put("h1", entry(1));
    expect(cache.get("h1")?.chunkSummaries).toEqual(["summary-1"]);
  });

  test("get returns undefined for unknown hash", () => {
    expect(new ChunkCache().get("nope")).toBeUndefined();
  });

  test("findLongestMatch returns the latest matching index", () => {
    const cache = new ChunkCache();
    cache.put("h2", entry(2));
    cache.put("h4", entry(4));
    const match = cache.findLongestMatch(["h1", "h2", "h3", "h4", "h5"]);
    expect(match?.index).toBe(3);
    expect(match?.entry.coveredCount).toBe(4);
  });

  test("findLongestMatch returns undefined when nothing matches", () => {
    const cache = new ChunkCache();
    cache.put("hx", entry(1));
    expect(cache.findLongestMatch(["a", "b"])).toBeUndefined();
  });

  test("evicts the least recently used entry beyond capacity", () => {
    const cache = new ChunkCache();
    for (let i = 0; i < MAX_ENTRIES; i++) cache.put(`h${i}`, entry(i));
    cache.get("h0"); // touch: h0 becomes recently used
    cache.put("overflow", entry(999));
    expect(cache.get("h0")).toBeDefined();
    expect(cache.get("h1")).toBeUndefined(); // oldest untouched entry evicted
    expect(cache.size).toBe(MAX_ENTRIES);
  });

  test("same-hash overwrite wins in memory and on disk (consolidation path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lmcc-"));
    const file = join(dir, "cache.json");
    const cache = new ChunkCache(file);
    cache.put("h", { ...entry(9), chunkSummaries: ["a", "b", "c"] });
    cache.put("h", {
      ...entry(9),
      chunkSummaries: ["L1(a+b)", "c"],
      consolidated: 2,
    });
    expect(cache.get("h")?.chunkSummaries).toEqual(["L1(a+b)", "c"]);
    expect(cache.get("h")?.consolidated).toBe(2);
    await cache.persist();
    const loaded = await ChunkCache.load(file);
    expect(loaded.get("h")?.chunkSummaries).toEqual(["L1(a+b)", "c"]);
    expect(loaded.get("h")?.consolidated).toBe(2);
  });

  test("persist then load round-trips entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lmcc-"));
    const file = join(dir, "cache.json");
    const cache = new ChunkCache(file);
    cache.put("h1", entry(1));
    await cache.persist();
    const loaded = await ChunkCache.load(file);
    expect(loaded.get("h1")?.coveredCount).toBe(1);
  });

  test("load of a corrupt file yields an empty working cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lmcc-"));
    const file = join(dir, "cache.json");
    await writeFile(file, "{ not json !!", "utf8");
    const loaded = await ChunkCache.load(file);
    expect(loaded.get("h1")).toBeUndefined();
    loaded.put("h1", entry(1));
    await loaded.persist();
    expect(JSON.parse(await readFile(file, "utf8")).entries.h1).toBeDefined();
  });

  test("load of a missing file yields an empty working cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lmcc-"));
    const loaded = await ChunkCache.load(join(dir, "does-not-exist.json"));
    expect(loaded.size).toBe(0);
  });

  test("concurrent persists cannot land an older snapshot last", async () => {
    // Reproduces the write-inversion race: the first persist is slow, the
    // second fast. Without serialization the slow (older) write renames
    // last and clobbers the newer state on disk.
    const dir = await mkdtemp(join(tmpdir(), "lmcc-"));
    const file = join(dir, "cache.json");
    const cache = new (class extends ChunkCache {
      slowNext = true;
      protected override async beforeWrite(): Promise<void> {
        if (this.slowNext) {
          this.slowNext = false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    })(file);

    cache.put("h1", entry(1));
    const first = cache.persist(); // slow
    cache.put("h2", entry(2));
    const second = cache.persist(); // fast
    await Promise.all([first, second]);

    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.entries.h2).toBeDefined(); // newest state must survive
    expect(onDisk.entries.h1).toBeDefined();
  });
});
