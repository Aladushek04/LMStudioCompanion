/**
 * Context/token usage reporting: the /usage command's human-readable report
 * and the machine-readable result for the get_context_usage tool the model
 * can call when the user asks about their context.
 */

export interface CompressionEvent {
  at: number;
  kind: "auto" | "force" | "safety" | "mid-task" | "consolidation";
  beforeTokens: number;
  afterTokens: number;
}

export const MAX_EVENTS = 50;

/** Append to the per-chat ledger, capped at MAX_EVENTS keeping the newest. */
export function appendEvent(
  prior: CompressionEvent[] | undefined,
  event: CompressionEvent,
): CompressionEvent[] {
  const events = [...(prior ?? []), event];
  return events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
}

/** Total tokens saved across all recorded compression events. */
export function totalSaved(events: CompressionEvent[] | undefined): number {
  if (!events) return 0;
  return events.reduce(
    (sum, e) => sum + Math.max(0, e.beforeTokens - e.afterTokens),
    0,
  );
}

/**
 * The compact-down-to floor after clamping. Present only when the configured
 * floor (a % of the context) was smaller than what must fit under it: the
 * system prompt, the summary budget and the kept-verbatim tail.
 */
export interface FloorClamp {
  /** Floor the settings asked for. */
  configuredTokens: number;
  /** Floor actually used. */
  effectiveTokens: number;
  /** True when the effective floor is at or above the trigger: compaction can never get under it. */
  blocksCompaction: boolean;
}

export interface UsageSnapshot {
  /** Tokens in the prompt actually sent to the model (compressed view). */
  promptTokens: number;
  /** Model's context window; undefined when unknown. */
  contextLength?: number;
  /** Auto-compaction trigger in tokens; undefined when auto is unavailable. */
  limit?: number;
  /** Tokens of the full visible transcript (uncompressed). */
  transcriptTokens: number;
  totalMessages: number;
  /** Messages currently replaced by summaries. */
  coveredMessages: number;
  chunkCount: number;
  /** Tokens the tool definitions add to every reply; undefined if unknown. */
  toolSchemaTokens?: number;
  /** Original chunk summaries folded into one consolidated summary. */
  consolidatedChunks?: number;
  /** Attachments in this chat with remembered content. */
  rememberedAttachments?: number;
  /** Per-chat compression ledger (newest last). */
  events?: CompressionEvent[];
  /** Set when the compact-down-to floor had to be raised above its configured value. */
  floorClamp?: FloorClamp;
}

/** Multi-line human report shown by the /usage command. */
export function formatUsageReport(u: UsageSnapshot): string {
  const lines: string[] = [];
  if (u.contextLength !== undefined) {
    const percent = Math.round((u.promptTokens / u.contextLength) * 100);
    lines.push(
      `Prompt to model: ~${u.promptTokens.toLocaleString('en-US')} tokens — ${percent}% of ${u.contextLength.toLocaleString('en-US')}-token context`,
    );
  } else {
    lines.push(
      `Prompt to model: ~${u.promptTokens.toLocaleString('en-US')} tokens — context window unknown`,
    );
  }
  if (u.limit !== undefined) {
    const headroom = Math.max(0, u.limit - u.promptTokens);
    lines.push(
      `Auto-compact trigger: ~${u.limit.toLocaleString('en-US')} tokens — headroom ~${headroom.toLocaleString('en-US')}`,
    );
    if (u.promptTokens > u.limit) {
      lines.push(
        "Over the trigger: auto-compaction will run on your next message (/usage itself never compacts).",
      );
    }
  }
  if (u.floorClamp !== undefined) {
    const f = u.floorClamp;
    lines.push(
      `Compact-down-to floor: ~${f.effectiveTokens.toLocaleString('en-US')} tokens (configured ~${f.configuredTokens.toLocaleString('en-US')}; raised to fit the system prompt + summary budget + kept-verbatim)`,
    );
    if (f.blocksCompaction) {
      lines.push(
        "Floor is at or above the trigger: compaction cannot get under the trigger. Raise the context length, or lower 'Recent context kept verbatim' or 'Summary budget'.",
      );
    }
  }
  if (u.events !== undefined && u.events.length > 0) {
    const saved = totalSaved(u.events);
    const latest = u.events[u.events.length - 1];
    lines.push(
      `Compression history: ${u.events.length} event(s) — total saved ~${saved.toLocaleString('en-US')} tokens`,
    );
    lines.push(
      `  latest: ${latest.kind} ~${latest.beforeTokens.toLocaleString('en-US')} -> ~${latest.afterTokens.toLocaleString('en-US')} (saved ~${Math.max(0, latest.beforeTokens - latest.afterTokens).toLocaleString('en-US')})`,
    );
  }
  if (u.rememberedAttachments !== undefined && u.rememberedAttachments > 0) {
    lines.push(
      `Attachment memories: ${u.rememberedAttachments} file(s) with content preserved`,
    );
  }
  if (u.toolSchemaTokens !== undefined) {
    lines.push(
      `Tool definitions: ~${u.toolSchemaTokens.toLocaleString('en-US')} tokens (sent with every reply)`,
    );
  }
  lines.push(
    `Visible chat: ~${u.transcriptTokens.toLocaleString('en-US')} tokens in ${u.totalMessages} messages`,
  );
  if (u.coveredMessages > 0) {
    const saved = Math.max(0, u.transcriptTokens - u.promptTokens);
    const consolidatedNote =
      u.consolidatedChunks !== undefined && u.consolidatedChunks > 0
        ? ` (incl. 1 consolidated from ${u.consolidatedChunks} earlier chunks)`
        : "";
    lines.push(
      `Compressed: ${u.coveredMessages} messages in ${u.chunkCount} summary chunk(s)${consolidatedNote} — saving ~${saved.toLocaleString('en-US')} tokens`,
    );
  } else {
    lines.push("No compression yet in this chat.");
  }
  return lines.join("\n");
}

/** Compact JSON result returned to the model by the usage tool. */
export function usageToolResult(u: UsageSnapshot): string {
  return JSON.stringify({
    prompt_tokens: u.promptTokens,
    context_length: u.contextLength,
    context_used_percent:
      u.contextLength !== undefined
        ? Math.round((u.promptTokens / u.contextLength) * 100)
        : undefined,
    auto_compact_trigger_tokens: u.limit,
    compact_floor_tokens: u.floorClamp?.effectiveTokens,
    compact_floor_configured_tokens: u.floorClamp?.configuredTokens,
    floor_blocks_compaction: u.floorClamp?.blocksCompaction,
    tool_schema_tokens: u.toolSchemaTokens,
    transcript_tokens: u.transcriptTokens,
    total_messages: u.totalMessages,
    messages_compressed: u.coveredMessages,
    summary_chunks: u.chunkCount,
    chunks_consolidated: u.consolidatedChunks,
    attachment_memories: u.rememberedAttachments,
    compression_events: u.events !== undefined ? u.events.length : undefined,
    total_saved_tokens:
      u.events !== undefined && u.events.length > 0
        ? totalSaved(u.events)
        : undefined,
  });
}
