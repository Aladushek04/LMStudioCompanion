import { describe, expect, test } from "vitest";
import {
  CompressionEvent,
  MAX_EVENTS,
  UsageSnapshot,
  appendEvent,
  formatUsageReport,
  totalSaved,
  usageToolResult,
} from "../src/usage";

const event = (n: number, kind: CompressionEvent["kind"] = "auto"): CompressionEvent => ({
  at: 1000 + n,
  kind,
  beforeTokens: 10_000 + n,
  afterTokens: 3_000 + n,
});

describe("compression event ledger", () => {
  test("appendEvent accumulates and caps at MAX_EVENTS keeping newest", () => {
    let events: CompressionEvent[] | undefined;
    for (let i = 0; i < MAX_EVENTS + 10; i++) {
      events = appendEvent(events, event(i));
    }
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events![events!.length - 1].at).toBe(1000 + MAX_EVENTS + 9);
    expect(events![0].at).toBe(1000 + 10);
  });

  test("totalSaved sums positive savings across events", () => {
    const events = [event(0), event(1)];
    expect(totalSaved(events)).toBe(14_000);
    expect(totalSaved(undefined)).toBe(0);
  });

  test("usage report shows the ledger and the latest event", () => {
    const out = formatUsageReport({
      ...full,
      events: [event(0, "force"), event(1, "auto")],
    });
    expect(out.toLowerCase()).toContain("compression history");
    expect(out).toContain("2 event");
    expect(out).toContain((14_000).toLocaleString('en-US'));
    expect(out.toLowerCase()).toContain("latest: auto");
  });

  test("usage tool result exposes event count and total saved", () => {
    const parsed = JSON.parse(
      usageToolResult({ ...full, events: [event(0), event(1)] }),
    );
    expect(parsed.compression_events).toBe(2);
    expect(parsed.total_saved_tokens).toBe(14_000);
  });

  test("no ledger lines when there are no events", () => {
    expect(formatUsageReport(full).toLowerCase()).not.toContain(
      "compression history",
    );
  });
});

const full: UsageSnapshot = {
  promptTokens: 12_350,
  contextLength: 101_888,
  limit: 76_416,
  transcriptTokens: 44_277,
  totalMessages: 31,
  coveredMessages: 24,
  chunkCount: 3,
};

describe("formatUsageReport", () => {
  test("reports prompt size, percentage, and headroom", () => {
    const out = formatUsageReport(full);
    expect(out).toContain("12,350");
    expect(out).toContain("12%");
    expect(out).toContain("101,888");
    expect(out).toContain("76,416");
  });

  test("reports transcript size and compression state", () => {
    const out = formatUsageReport(full);
    expect(out).toContain("44,277");
    expect(out).toContain("31");
    expect(out).toContain("24");
    expect(out).toContain("3");
  });

  test("handles unknown context length without percentages", () => {
    const out = formatUsageReport({
      ...full,
      contextLength: undefined,
      limit: undefined,
    });
    expect(out).toContain("12,350");
    expect(out.toLowerCase()).toContain("unknown");
    expect(out).not.toContain("%");
  });

  test("says auto-compact is armed when over the trigger", () => {
    const out = formatUsageReport({ ...full, promptTokens: 96_643 });
    expect(out.toLowerCase()).toContain("next message");
  });

  test("does not mention arming when under the trigger", () => {
    expect(formatUsageReport(full).toLowerCase()).not.toContain("next message");
  });

  test("reports tool definition cost when known", () => {
    const out = formatUsageReport({ ...full, toolSchemaTokens: 9244 });
    expect(out).toContain("9,244");
    expect(out.toLowerCase()).toContain("tool definitions");
    expect(formatUsageReport(full).toLowerCase()).not.toContain(
      "tool definitions",
    );
  });

  test("notes consolidated chunks so shrinking counts stay explainable", () => {
    const out = formatUsageReport({
      ...full,
      chunkCount: 5,
      consolidatedChunks: 26,
    });
    expect(out).toContain("26");
    expect(out.toLowerCase()).toContain("consolidated");
    expect(formatUsageReport(full).toLowerCase()).not.toContain("consolidated");
  });

  test("reports remembered attachments when present", () => {
    const out = formatUsageReport({ ...full, rememberedAttachments: 3 });
    expect(out.toLowerCase()).toContain("attachment");
    expect(out).toContain("3");
    expect(formatUsageReport(full).toLowerCase()).not.toContain("attachment");
  });

  test("uncompressed chats read as such", () => {
    const out = formatUsageReport({
      ...full,
      promptTokens: 44_277,
      coveredMessages: 0,
      chunkCount: 0,
    });
    expect(out.toLowerCase()).toContain("no compression");
  });
});

describe("usageToolResult", () => {
  test("gives the model the key numbers", () => {
    const out = usageToolResult(full);
    expect(out).toContain("12350");
    expect(out).toContain("101888");
    expect(out).toContain("44277");
  });

  test("parses as JSON so the model can extract fields", () => {
    const parsed = JSON.parse(usageToolResult(full));
    expect(parsed.prompt_tokens).toBe(12_350);
    expect(parsed.context_length).toBe(101_888);
    expect(parsed.context_used_percent).toBe(12);
  });

  test("omits unknown fields rather than inventing them", () => {
    const parsed = JSON.parse(
      usageToolResult({ ...full, contextLength: undefined, limit: undefined }),
    );
    expect(parsed.context_length).toBeUndefined();
    expect(parsed.context_used_percent).toBeUndefined();
  });
});

describe("compact-down-to floor clamp", () => {
  const base: UsageSnapshot = {
    promptTokens: 9_000,
    contextLength: 16_384,
    limit: 12_288,
    transcriptTokens: 20_000,
    totalMessages: 30,
    coveredMessages: 0,
    chunkCount: 0,
  };
  const clamp = { configuredTokens: 4_915, effectiveTokens: 8_000, blocksCompaction: false };

  test("report names the effective and configured floor when clamped", () => {
    const text = formatUsageReport({ ...base, floorClamp: clamp });
    expect(text).toContain("Compact-down-to floor: ~8,000 tokens (configured ~4,915");
    expect(text).not.toContain("cannot get under");
  });

  test("report says when the floor blocks compaction", () => {
    const text = formatUsageReport({
      ...base,
      floorClamp: { ...clamp, effectiveTokens: 12_500, blocksCompaction: true },
    });
    expect(text).toContain("cannot get under the trigger");
  });

  test("report is silent when nothing was clamped", () => {
    expect(formatUsageReport(base)).not.toContain("Compact-down-to floor");
  });

  test("tool result carries the floor fields only when clamped", () => {
    const parsed = JSON.parse(usageToolResult({ ...base, floorClamp: clamp }));
    expect(parsed.compact_floor_tokens).toBe(8_000);
    expect(parsed.compact_floor_configured_tokens).toBe(4_915);
    expect(parsed.floor_blocks_compaction).toBe(false);
    expect(JSON.parse(usageToolResult(base)).compact_floor_tokens).toBeUndefined();
  });
});
