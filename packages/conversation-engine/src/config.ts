import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "autoCompact",
    "boolean",
    {
      displayName: "Auto-compact",
      subtitle:
        "Automatically compress old messages when context usage crosses the threshold. " +
        "Turn off for bulk-data tasks (log parsing, hex dumps) where the past IS the data.",
    },
    true,
  )
  .field(
    "thresholdPercent",
    "numeric",
    {
      displayName: "Compaction threshold (% of context)",
      subtitle: "Compact when the prompt would exceed this share of the model's context window.",
      min: 10,
      max: 95,
      int: true,
      slider: { step: 5, min: 10, max: 95 },
    },
    75,
  )
  .field(
    "compactFloorPercent",
    "numeric",
    {
      displayName: "Compact down to (% of context)",
      subtitle:
        "Once compaction triggers, keep going until the prompt is below this — " +
        "well under the trigger, so long agentic turns have headroom and " +
        "compaction doesn't re-trigger every few turns.",
      min: 20,
      max: 90,
      int: true,
      slider: { step: 5, min: 20, max: 90 },
    },
    55,
  )
  .field(
    "reservedOutputTokens",
    "numeric",
    {
      displayName: "Reserved output tokens",
      subtitle:
        "Room kept free for the model's reply: the prompt must fit within " +
        "context minus this reserve.",
      min: 0,
      max: 32000,
      int: true,
    },
    2000,
  )
  .field(
    "thresholdTokensOverride",
    "numeric",
    {
      displayName: "Absolute token trigger (0 = use %)",
      subtitle:
        "Compact when the prompt exceeds this many tokens, ignoring the percentage. " +
        "Useful for testing (e.g. 2000) or when the context length is unknown.",
      min: 0,
      int: true,
    },
    0,
  )
  .field(
    "keepRecentTokens",
    "numeric",
    {
      displayName: "Recent context kept verbatim (tokens)",
      subtitle: "The most recent part of the conversation is never summarized.",
      min: 500,
      max: 50000,
      int: true,
    },
    6000,
  )
  .field(
    "chunkTokens",
    "numeric",
    {
      displayName: "Summarize in chunks of (tokens)",
      subtitle: "History is summarized chunk by chunk; finished chunks are cached and reused.",
      min: 1000,
      max: 64000,
      int: true,
    },
    16000,
  )
  .field(
    "roundsPerPass",
    "numeric",
    {
      displayName: "Tool rounds per pass (0 = unlimited)",
      subtitle:
        "Long agentic turns run in passes of this many tool rounds; between " +
        "passes the plugin can compact mid-task, so a marathon tool loop can " +
        "never overflow the context. 0 restores one uncapped loop.",
      min: 0,
      max: 64,
      int: true,
    },
    6,
  )
  .field(
    "maxChunksPerPass",
    "numeric",
    {
      displayName: "Max chunks per pass (0 = auto)",
      subtitle:
        "Limit how many chunk summaries one compaction run performs. " +
        "Auto: only as many as needed to fit (everything for /compress). " +
        "Progress is cached, so the next pass continues where this one stopped.",
      min: 0,
      max: 100,
      int: true,
    },
    0,
  )
  .field(
    "maxToolResultTokens",
    "numeric",
    {
      displayName: "Max tool result size (tokens, 0 = unlimited)",
      subtitle:
        "Oversized tool results are truncated before entering the conversation. " +
        "Side effects still happen; only what the model sees shrinks.",
      min: 0,
      int: true,
    },
    4000,
  )
  .field(
    "maxTotalToolResultTokens",
    "numeric",
    {
      displayName: "Max total tool output per reply (tokens, 0 = unlimited)",
      subtitle:
        "Aggregate budget across all tool calls in one reply — the second " +
        "line of defense after the per-result cap.",
      min: 0,
      int: true,
    },
    20000,
  )
  .field(
    "attachmentMemory",
    "boolean",
    {
      displayName: "Attachment memory",
      subtitle:
        "Before compressing past an attachment, preserve its content: " +
        "documents become fact-sheets, images get described (vision models). " +
        "Preserved once per file, cached across sessions.",
    },
    true,
  )
  .field(
    "summaryBudgetTokens",
    "numeric",
    {
      displayName: "Summary budget (tokens, 0 = unbounded)",
      subtitle:
        "When accumulated chunk summaries exceed this, the oldest are " +
        "consolidated into one denser summary — so summaries can never " +
        "swallow the context, no matter how long the chat gets.",
      min: 0,
      max: 64000,
      int: true,
    },
    12000,
  )
  .field(
    "summarizerMaxTokens",
    "numeric",
    {
      displayName: "Max tokens per chunk summary",
      min: 200,
      max: 8000,
      int: true,
    },
    1500,
  )
  .field(
    "summarizerPromptMode",
    "select",
    {
      displayName: "Summarizer prompt",
      options: [
        { value: "auto", displayName: "Auto (recommended)" },
        { value: "full", displayName: "Full (10-section)" },
        { value: "compact", displayName: "Compact" },
      ],
      hint:
        "Full prompt (recommended); Compact is used automatically only as a " +
        "rescue when a model's reasoning runs away, and can be forced here.",
    },
    "auto",
  )
  .field(
    "showStats",
    "boolean",
    {
      displayName: "Announce compaction in chat",
      subtitle: "Show a token before/after note when compaction happens.",
    },
    true,
  )
  .field(
    "meterDisplay",
    "select",
    {
      options: [
        { value: "status", displayName: "Status line" },
        { value: "sender", displayName: "Sender name" },
        { value: "off", displayName: "Off" },
      ],
      displayName: "Prompt meter",
      subtitle:
        "Where to show the real prompt size while compression is active " +
        "(LM Studio's own context ring counts the visible transcript and cannot be overridden).",
    },
    "status",
  )
  .build();
