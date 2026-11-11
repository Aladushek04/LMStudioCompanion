/**
 * The prediction loop handler: every turn, map the full (never-shrinking) UI
 * history to a compressed view via the content-addressed chunk cache, compact
 * lazily when over the token budget (or fully on /compress), then run the
 * user's selected model over the view with tools passed through.
 */
import {
  Chat,
  ChatMessage,
  FileHandle,
  LLM,
  PredictionLoopHandlerController,
  PredictionResult,
  Tool,
  rawFunctionTool,
} from "@lmstudio/sdk";
import { homedir } from "os";
import { join } from "path";
import { setTimeout as waitBeforeRetry } from "node:timers/promises";
import {runCompanionTurn,CoreTurnError,type CoreTurn} from './companion/turn';
import {showCoreStatus,isCoreStatusText} from './companion/status-command';
import {runConfirmedTool} from './companion/tool-call';
import { toCanon } from "./adapter";
import { EffectiveSizes, effectiveSizes, pickPromptVariant } from "./budget";
import { ChunkCache } from "./cache";
import { configSchematics } from "./config";
import { planCompaction } from "./plan";
import { overallFraction, progressBar } from "./progress";
import {
  AttachmentMemoryStore,
  classifyFileType,
} from "./attachments";
import { effectiveSummaryBudget, pickConsolidation } from "./consolidate";
import { estimateMessageTokens, estimateTokens } from "./estimate";
import { decideFallback } from "./fallback";
import {
  burnedOutInReasoning,
  extractPayload,
  isTruncatedStop,
  noThinkDirective,
} from "./reasoning";
import { isTransientEngineError } from "./retry";
import { ModelState, getModelState, warnOnce } from "./state";
import { decideTools } from "./toolGate";
import { ViewStrategy, planViewMessages, promptChatMessages } from "./viewPlan";
import {
  PromptVariant,
  RETRY_NUDGE,
  buildAttachmentDocPrompt,
  buildAttachmentImagePrompt,
  buildMergePrompt,
  buildMergeRescuePrompt,
  buildSummaryPrompt,
  buildSummaryRescuePrompt,
  composeSystemMessage,
  nudgeForRetry,
  structuralDigest,
  summarySystemMessage,
  summarySystemPrompt,
} from "./summarizer";
import { TokenCounter } from "./tokens";
import { invalidToolRequestResult, wrapToolsWithCap } from "./toolWrap";
import {
  type ToolCallCtx,
  type ToolStatusFactory,
  runWithToolStatus,
} from "./toolStatus";
import {
  type PassEndReason,
  type RoundFitInput,
  createPassCap,
  nextRoundFits,
} from "./passCap";

/** The per-pass fit budget handed to actWithUi; growth is measured inside. */
type RoundFitBudget = Omit<RoundFitInput, "grownTokens">;
import {
  CompressionEvent,
  FloorClamp,
  UsageSnapshot,
  appendEvent,
  formatUsageReport,
  usageToolResult,
} from "./usage";
import {
  CanonMessage,
  SENTINEL,
  SYNTHETIC_USER_MESSAGE,
  currentTurnStart,
  fitCuts,
  hashNamespace,
  isCompressCommand,
  isUsageCommand,
  prefixHashes,
  roundBoundaries,
  transformForView,
} from "./view";

// Companion fork: never share persisted summaries with the installed upstream plugin.
const CACHE_PATH = join(homedir(), ".lm-companion-conversation", "cache.json");

let cachePromise: Promise<ChunkCache> | undefined;
function getCache(): Promise<ChunkCache> {
  cachePromise ??= ChunkCache.load(CACHE_PATH);
  return cachePromise;
}

const ATTACHMENTS_PATH = join(
  homedir(),
  ".lm-companion-conversation",
  "attachments.json",
);
let attachmentStorePromise: Promise<AttachmentMemoryStore> | undefined;
function getAttachmentStore(): Promise<AttachmentMemoryStore> {
  attachmentStorePromise ??= AttachmentMemoryStore.load(ATTACHMENTS_PATH);
  return attachmentStorePromise;
}

interface AttachmentOpts {
  enabled: boolean;
  maxExcerptChars: number;
  summarizerMaxTokens: number;
}

/** The extracted payload from a respondForPayload attempt, plus the final
 * attempt's stop reason so callers that care (e.g. to log a
 * may-be-truncated warning) don't have to re-derive it. */
interface PayloadAttempt {
  payload: string;
  stopReason: string | undefined;
}

/**
 * Run a prediction and extract its usable payload (finding L1): qwen3.5+
 * models ignore the /no_think soft-switch, reason regardless, and
 * concatenate that reasoning into `content` with no markers — so with a
 * tight maxTokens the model can exhaust the whole budget on reasoning,
 * leaving nonReasoningContent (and so extractPayload) empty even though
 * generation only stopped because it was truncated, not because the model
 * had nothing to say. When that happens, retry the SAME prompt (plus
 * RETRY_NUDGE, applied by the caller's makeRequest closure) once with
 * max(4x maxTokens, 6000) before giving up — at most one retry per call.
 * Live measurement on qwen3.8-27b showed reasoning burn is highly variable
 * (400 truncated; 1600 succeeded needing 1233; 6000 succeeded needing
 * 1101) — a bare 4x multiplier is borderline against a small base
 * maxTokens (bench's 400 -> 1600 still lets an unlucky chunk truncate
 * inside reasoning on the retry), so 6000 is floored in as deterministic
 * headroom for heavy reasoners. contextOverflowPolicy: "stopAtLimit"
 * (already set at every call site) still bounds this on small contexts —
 * a context-limit truncation on the retry still comes back empty and
 * falls through to the caller's existing throw/undefined/digest path. A
 * payload that comes back empty for any other reason (stop reason not
 * truncation — the model simply refused) is returned as-is on the FIRST
 * attempt without retrying (retrying a refusal wastes a full 6000-token
 * round trip for no expected benefit); callers decide whether an empty
 * payload is fatal, skippable, or gets a structural-digest fallback (see
 * structuralDigest in summarizer.ts / finding L2).
 * `makeRequest` issues one prediction at the given maxTokens, told whether
 * this is the retry (so it can apply RETRY_NUDGE and any other
 * retry-specific tweak), and registers its own ctl.onAborted cancellation.
 */
async function respondForPayload(
  makeRequest: (maxTokens: number, isRetry: boolean) => Promise<PredictionResult>,
  maxTokens: number,
): Promise<PayloadAttempt> {
  let result = await makeRequest(maxTokens, false);
  let payload = extractPayload(result);
  if (!payload && isTruncatedStop(result.stats.stopReason)) {
    result = await makeRequest(Math.max(maxTokens * 4, 6000), true);
    payload = extractPayload(result);
  }
  return { payload, stopReason: result.stats.stopReason };
}

async function generateAttachmentMemory(
  ctl: PredictionLoopHandlerController,
  source: LLM,
  handle: FileHandle,
  kind: "document" | "image",
  opts: AttachmentOpts,
  strategy: ViewStrategy,
): Promise<string | undefined> {
  const directive = noThinkDirective(source.identifier);
  if (kind === "document") {
    const parsed = await ctl.client.files.parseDocument(handle, {
      signal: ctl.abortSignal,
    });
    if (!parsed.content.trim()) return undefined;
    const prompt = buildAttachmentDocPrompt(
      handle.name,
      parsed.content,
      opts.maxExcerptChars,
      { noThinkDirective: directive },
    );
    const { payload } = await respondForPayload((maxTokens, isRetry) => {
      const prediction = source.respond(
        Chat.from(promptChatMessages(nudgeForRetry(prompt, isRetry), strategy)),
        {
          maxTokens,
          temperature: 0.2,
          contextOverflowPolicy: "stopAtLimit",
        },
      );
      ctl.onAborted(() => void prediction.cancel());
      return prediction;
    }, Math.min(400, opts.summarizerMaxTokens));
    return payload || undefined;
  }
  // image: only vision models can describe it
  let vision = false;
  try {
    vision =
      (source as unknown as { vision?: boolean }).vision ??
      ((await source.getModelInfo()) as unknown as { vision?: boolean })
        .vision ??
      false;
  } catch (error) {
    vision = false;
    ctl.debug("vision-capability probe failed", error);
  }
  if (!vision) return undefined;
  const prompt = buildAttachmentImagePrompt(handle.name, {
    noThinkDirective: directive,
  });
  // The image attaches to whichever message is the user turn — the last one
  // in both strategies ("system": [system, user]; "foldSystem": [user]).
  // Built fresh inside the closure (rather than once, outside) so the retry
  // attempt can append RETRY_NUDGE to that same last message.
  const buildImageChat = (isRetry: boolean) => {
    const chat = Chat.empty();
    const chatMsgs = promptChatMessages(prompt, strategy);
    chatMsgs.forEach((m, i) => {
      const isLast = i === chatMsgs.length - 1;
      const content = isLast && isRetry ? m.content + RETRY_NUDGE : m.content;
      const msgOpts = isLast ? { images: [handle] } : undefined;
      chat.append(m.role, content, msgOpts);
    });
    return chat;
  };
  const { payload } = await respondForPayload((maxTokens, isRetry) => {
    const prediction = source.respond(buildImageChat(isRetry), {
      maxTokens,
      temperature: 0.2,
      contextOverflowPolicy: "stopAtLimit",
    });
    ctl.onAborted(() => void prediction.cancel());
    return prediction;
  }, 300);
  return payload || undefined;
}

/**
 * Collect (and lazily generate) attachment memories for the chunk
 * pairs[from..to). Returns a name→memory map for renderForSummary, or
 * undefined when the chunk has no attachments / the feature is off.
 * Failures are never persisted (transient errors must not poison the store).
 */
async function ensureAttachmentMemories(
  ctl: PredictionLoopHandlerController,
  source: LLM,
  pairs: Pair[],
  from: number,
  to: number,
  opts: AttachmentOpts,
  strategy: ViewStrategy,
): Promise<Map<string, string> | undefined> {
  if (!opts.enabled) return undefined;
  const handles: FileHandle[] = [];
  for (let i = from; i < to && i < pairs.length; i++) {
    const raw = pairs[i].raw;
    if (raw === undefined) continue;
    try {
      if (raw.hasFiles()) handles.push(...raw.getFiles(ctl.client));
    } catch {
      // unreadable attachment metadata: renders as not-retained
    }
  }
  if (handles.length === 0) return undefined;
  const store = await getAttachmentStore();
  const memories = new Map<string, string>();
  const seen = new Set<string>();
  const pending: FileHandle[] = [];
  for (const handle of handles) {
    if (seen.has(handle.identifier)) continue;
    seen.add(handle.identifier);
    const cached = store.get(handle.identifier);
    if (cached !== undefined) {
      memories.set(handle.name, cached.memory);
    } else {
      pending.push(handle);
    }
  }
  if (pending.length > 0) {
    const status = ctl.createStatus({
      status: "loading",
      text: `Preserving attachment content… (0/${pending.length})`,
    });
    let done = 0;
    let preserved = 0;
    try {
      for (const handle of pending) {
        ctl.guardAbort();
        done++;
        status.setState({
          status: "loading",
          text: `Preserving attachment "${handle.name}" (${done}/${pending.length})…`,
        });
        const kind = classifyFileType(handle.type);
        if (kind === "unknown") continue;
        try {
          const memory = await generateAttachmentMemory(
            ctl,
            source,
            handle,
            kind,
            opts,
            strategy,
          );
          if (memory !== undefined) {
            store.put(handle.identifier, {
              name: handle.name,
              type: handle.type,
              sizeBytes: handle.sizeBytes,
              kind,
              memory,
              model: source.identifier,
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
            });
            void store.persist();
            memories.set(handle.name, memory);
            preserved++;
          }
        } catch (error) {
          if (ctl.abortSignal.aborted) throw error;
          // this file renders as not-retained; others still proceed
        }
      }
      status.setState({
        status: preserved > 0 ? "done" : "error",
        text:
          preserved === pending.length
            ? `Attachment content preserved (${preserved}/${pending.length})`
            : `Attachments: ${preserved} preserved, ${pending.length - preserved} not retained`,
      });
    } catch (error) {
      if (ctl.abortSignal.aborted) {
        try {
          status.setState({ status: "canceled", text: "Attachment reading canceled" });
        } catch {
          // teardown
        }
      }
      throw error;
    }
  }
  return memories;
}

/** Unique attachments in this chat whose content is remembered. */
async function countRememberedAttachments(
  ctl: PredictionLoopHandlerController,
  pairs: Pair[],
): Promise<number | undefined> {
  const store = await getAttachmentStore();
  const seen = new Set<string>();
  let count = 0;
  for (const p of pairs) {
    if (p.raw === undefined) continue;
    try {
      if (!p.raw.hasFiles()) continue;
      for (const handle of p.raw.getFiles(ctl.client)) {
        if (seen.has(handle.identifier)) continue;
        seen.add(handle.identifier);
        if (store.has(handle.identifier)) count++;
      }
    } catch {
      // ignore unreadable attachment metadata
    }
  }
  return count > 0 ? count : undefined;
}
/**
 * Detect once per model whether its chat template accepts a system-role
 * message at all — stock Gemma and some Mistral variants throw on one. Runs
 * eagerly, before any compaction/summarization work, so every internal
 * prediction this turn (chunk summaries, consolidation merges, attachment
 * memory) agrees on the same strategy from the start rather than only
 * discovering the rejection lazily when the final view is rendered (by then
 * several system-role prompts may already have been sent and failed).
 * Memoized on state.systemStrategy: later turns skip the probe entirely, and
 * a flip mid-chat never happens from this path since it only ever resolves
 * an undefined value. countRenderedPrompt still backstops the rarer case
 * where this minimal probe passes but the real, full-size view still fails
 * to render.
 */
async function resolveSystemStrategy(
  ctl: PredictionLoopHandlerController,
  source: LLM,
  state: ModelState,
): Promise<ViewStrategy> {
  if (state.systemStrategy !== undefined) return state.systemStrategy;
  try {
    await source.applyPromptTemplate(
      Chat.from([
        { role: "system", content: "probe" },
        { role: "user", content: "probe" },
      ]),
    );
    state.systemStrategy = "system";
  } catch (error) {
    ctl.debug(
      "system-role probe failed; folding system text into user messages",
      error,
    );
    state.systemStrategy = "foldSystem";
  }
  return state.systemStrategy;
}

interface Pair {
  /** Original message; absent when the canon text was rewritten (e.g. a
   * command line stripped out) and must be re-serialized from canon. */
  raw?: ChatMessage;
  canon: CanonMessage;
}

function sum(nums: number[], from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i++) total += nums[i];
  return total;
}

export async function predictionLoopHandler(
  ctl: PredictionLoopHandlerController,
): Promise<void> {
  await runCompanionTurn(ctl,turn=>runHandler(ctl,turn));
}

async function runHandler(ctl: PredictionLoopHandlerController,turn:CoreTurn): Promise<void> {
  if(showCoreStatus(ctl,turn))return;
  const cfg = ctl.getPluginConfig(configSchematics);
  const source = turn.source;
  const history = turn.history;
  const rawMessages = history.getMessagesArray();

  // Leading system messages (the user's system prompt) always stay verbatim.
  let bodyStart = 0;
  while (
    bodyStart < rawMessages.length &&
    rawMessages[bodyStart].getRole() === "system"
  ) {
    bodyStart++;
  }
  const preamble = rawMessages.slice(0, bodyStart);
  const body = rawMessages.slice(bodyStart);

  const allPairs: Pair[] = body.map((raw) => ({
    raw,
    canon: toCanon(raw, ctl.client),
  }));
  const lastCanon = allPairs[allPairs.length - 1]?.canon;
  const force = lastCanon !== undefined && isCompressCommand(lastCanon);

  // Drop this plugin's own exchanges from what the model sees; a message
  // mixing a command with real content keeps the content (command stripped).
  const pairs: Pair[] = [];
  for (const p of allPairs) {
    if(p.canon.role==='user'&&isCoreStatusText(p.canon.text))continue;
    const transformed = transformForView(p.canon);
    if (transformed === null) continue;
    pairs.push(transformed === p.canon ? p : { canon: transformed });
  }
  const msgs = pairs.map((p) => p.canon);

  const cache = await getCache();
  const state = getModelState(
    source.identifier ?? "",
    () => new TokenCounter((t) => source.countTokens(t)),
  );
  // Resolve before any compaction/summarization work — every internal
  // prediction this turn must agree on whether the model's template accepts
  // a system role.
  await resolveSystemStrategy(ctl, source, state);
  const counter = state.counter;
  const tokens = await counter.countMessages(msgs);

  let contextLength: number | undefined;
  try {
    const length = await source.getContextLength();
    if (length > 0) {
      contextLength = length;
    } else {
      ctl.debug("getContextLength returned a non-positive value", length);
    }
  } catch (error) {
    contextLength = undefined;
    ctl.debug("getContextLength failed", error);
  }
  // select fields type as plain string, not the option literal union —
  // narrow defensively (falls back to "auto", the field's own default) so
  // an unexpected stored value can never reach pickPromptVariant untyped.
  const promptModeRaw = cfg.get("summarizerPromptMode");
  const promptMode: "auto" | "full" | "compact" =
    promptModeRaw === "full" || promptModeRaw === "compact"
      ? promptModeRaw
      : "auto";
  const promptVariant = pickPromptVariant(promptMode);

  // contextLength undefined silently disables auto-compaction, the floor,
  // the exact-fit safety loop, and the hard-fit refusal below — an override
  // means the user already handled sizing manually, so only warn without one.
  if (contextLength === undefined && cfg.get("thresholdTokensOverride") === 0) {
    warnOnce(
      ctl,
      state,
      "context-length-unknown",
      "Context length unknown for this model — auto-compaction is disabled. Set 'Absolute token trigger' (thresholdTokensOverride) to compress anyway.",
    );
  }
  // Small-context models can't afford the configured verbatim/chunk/reserve/
  // summary sizes at all (e.g. keepRecentTokens 6000 on a 4k window leaves no
  // room for compaction to ever cut) — auto-scale them down instead of
  // silently disabling compaction exactly where it's needed most.
  const configuredSizes = {
    keepRecentTokens: cfg.get("keepRecentTokens"),
    chunkTokens: cfg.get("chunkTokens"),
    reservedOutputTokens: cfg.get("reservedOutputTokens"),
    summarizerMaxTokens: cfg.get("summarizerMaxTokens"),
    maxToolResultTokens: cfg.get("maxToolResultTokens"),
    roundsPerPass: cfg.get("roundsPerPass"),
  };
  // The tool definitions ride along with every prompt (a tools provider's
  // schemas alone can be ~5k tokens). This turn's exact size is only known
  // once the session's tools are listed, so the previous turn's measurement
  // stands in; every size, the trigger and the floor are computed on the
  // window that is left, not on the raw context length.
  const fixedOverheadTokens = state.lastToolSchemaTokens ?? 0;
  const eff: EffectiveSizes = effectiveSizes({
    contextLength,
    fixedOverheadTokens,
    ...configuredSizes,
  });
  const usableContext = eff.usableContextTokens ?? contextLength;
  // What the rendered prompt plus the tool definitions must fit under: the
  // window minus the reply reserve and a pass of tool rounds. Enforced by
  // fitToWindow before the turn and again between passes.
  const safeBudget =
    contextLength !== undefined
      ? contextLength - eff.reservedOutputTokens - eff.passAllowanceTokens
      : undefined;
  if (eff.clamped.length > 0) {
    type SizeKey = keyof typeof configuredSizes;
    const changes = eff.clamped
      .map((name) => {
        const key = name as SizeKey;
        return `${name} ${configuredSizes[key]}→${eff[key]}`;
      })
      .join(", ");
    warnOnce(
      ctl,
      state,
      "sizes-clamped",
      `Small context window (${contextLength?.toLocaleString()} tokens${fixedOverheadTokens > 0 ? `, ~${usableContext?.toLocaleString()} left after ~${fixedOverheadTokens.toLocaleString()} of tool definitions` : ""}) — auto-scaled: ${changes} (raise the model's context or lower these settings to silence this)`,
    );
  }

  // Namespace the hash chain: summaries produced under a different model,
  // summarizer prompt, chunking settings, or prompt SHAPE must never be
  // reused. Both the non-agentic core and the agentic addendum are included
  // (rather than one prompt resolved for "this chunk") because per-chunk
  // agentic detection is itself a pure function of chunk content — the
  // namespace only needs to capture the (variant) identity that could change
  // the resulting text. promptShape captures the resolved system/foldSystem
  // strategy: under foldSystem the summarizer prompt is sent as a single
  // merged user message instead of separate system+user messages (see
  // promptChatMessages in viewPlan.ts), which changes the summary bytes even
  // though summarizerPromptCore/agenticAddendumPrompt themselves don't.
  const namespace = hashNamespace({
    // 4: agenticProtocol.ts now renders staged approvals (status, mode, the
    // approval record and its verbatim resume call), plan/approval recovery
    // keys, and the rest of the 0.3.0 contract pass (overview `recent*` ids,
    // research wrappers, created directories, capability flags, sub-agent gate
    // state, hidden-payload counters) into the summarized chunk text — the
    // rendering is not otherwise part of this namespace, so entries summarized
    // from the old rendering must not be reused. Schema 4 is unreleased, so
    // every one of those changes rides the same bump.
    schema: 4,
    summarizerPromptCore: summarySystemPrompt({
      variant: promptVariant,
      agentic: false,
    }),
    agenticAddendumPrompt: summarySystemPrompt({
      variant: promptVariant,
      agentic: true,
    }),
    promptVariant,
    promptShape: state.systemStrategy ?? "system",
    model: source.identifier ?? "",
    chunkTokens: eff.chunkTokens,
    summarizerMaxTokens: eff.summarizerMaxTokens,
  });
  const hashes = prefixHashes(msgs, namespace);

  const match = cache.findLongestMatch(hashes);
  const initialCovered = match ? match.index + 1 : 0;
  let coveredUpTo = initialCovered;
  const chunkSummaries = match ? [...match.entry.chunkSummaries] : [];
  const summaryTokensOf = async (summaries: string[]) =>
    summaries.length > 0
      ? await source.countTokens(summarySystemMessage(summaries))
      : 0;
  const summaryTokensBefore = await summaryTokensOf(chunkSummaries);

  let limit: number | undefined;
  if (cfg.get("thresholdTokensOverride") > 0) {
    limit = cfg.get("thresholdTokensOverride");
  } else if (usableContext !== undefined) {
    limit = Math.floor((usableContext * cfg.get("thresholdPercent")) / 100);
    // The trigger is in view tokens; it can never sit above what the fit
    // check will accept once the tool definitions are added back.
    if (safeBudget !== undefined) {
      limit = Math.min(limit, Math.max(0, safeBudget - fixedOverheadTokens));
    }
  }

  // /usage is answered further down, once the floor clamp is known, so the
  // report can show the effective compact-down-to floor.
  const wantsUsage = lastCanon !== undefined && isUsageCommand(lastCanon);

  // The summarizer prompt itself must always fit the model's context, even
  // when a single un-splittable chunk is enormous (e.g. giant tool results
  // recorded before this plugin was enabled).
  const maxExcerptTokens = Math.min(
    eff.chunkTokens * 2,
    contextLength !== undefined
      ? Math.floor(contextLength / 2)
      : eff.chunkTokens * 2,
  );
  const maxExcerptChars = maxExcerptTokens * 4;
  const attachOpts: AttachmentOpts = {
    enabled: cfg.get("attachmentMemory"),
    maxExcerptChars,
    summarizerMaxTokens: eff.summarizerMaxTokens,
  };

  // Summary budget + floor reachability: without consolidation the summary
  // block grows forever and any fixed floor eventually becomes unreachable.
  const preambleTexts = preamble.map((m) => m.getText());
  let systemPromptTokens = 0;
  if (preambleTexts.length > 0) {
    const joined = preambleTexts.join("\n\n");
    try {
      systemPromptTokens = await source.countTokens(joined);
    } catch (error) {
      systemPromptTokens = estimateTokens(joined);
      ctl.debug("countTokens failed for system prompt; estimating", error);
    }
  }
  const mergeMaxTokens = eff.mergeMaxTokens;
  const configuredFloor =
    usableContext !== undefined
      ? Math.floor((usableContext * cfg.get("compactFloorPercent")) / 100)
      : undefined;
  const budgetInfo = effectiveSummaryBudget({
    configuredBudget: cfg.get("summaryBudgetTokens"),
    floorTokens: configuredFloor,
    keepRecentTokens: eff.keepRecentTokens,
    systemPromptTokens,
    summarizerMaxTokens: eff.summarizerMaxTokens,
    mergeMaxTokens,
    keepNewest: 4,
    marginTokens: eff.marginTokens,
  });
  const clampedFloor =
    configuredFloor !== undefined
      ? Math.max(
          configuredFloor,
          systemPromptTokens +
            budgetInfo.budget +
            eff.keepRecentTokens +
            eff.marginTokens,
        )
      : undefined;
  let floorClamp: FloorClamp | undefined;
  if (
    configuredFloor !== undefined &&
    clampedFloor !== undefined &&
    (!budgetInfo.floorReachable || clampedFloor > configuredFloor)
  ) {
    floorClamp = {
      configuredTokens: configuredFloor,
      effectiveTokens: clampedFloor,
      blocksCompaction: limit !== undefined && clampedFloor >= limit,
    };
    const needs = `system prompt ~${systemPromptTokens.toLocaleString()} + summary budget ~${budgetInfo.budget.toLocaleString()} + kept-verbatim ~${eff.keepRecentTokens.toLocaleString()}`;
    if (floorClamp.blocksCompaction) {
      // Compaction still runs but can never get under the trigger, so it
      // would run again on every turn: that is a real problem and an error.
      warnOnce(
        ctl,
        state,
        "floor-blocks-compaction",
        `Compaction cannot get below its trigger (~${limit?.toLocaleString()} tokens): the compact-down-to floor had to be raised to ~${clampedFloor.toLocaleString()} to fit ${needs} + margin. Raise the model's context length, or lower 'Recent context kept verbatim' or 'Summary budget'.`,
      );
    } else {
      // A raised floor is a fact about this model + plugin set (a tool
      // provider's schemas alone can exceed a 30% floor of a 16k window),
      // not a fault: say so once as information and put the numbers in /usage.
      warnOnce(
        ctl,
        state,
        "floor-raised",
        `Compaction floor raised to ~${clampedFloor.toLocaleString()} tokens: the configured ${cfg.get("compactFloorPercent")}% (~${configuredFloor.toLocaleString()}${fixedOverheadTokens > 0 ? ` of the ~${usableContext?.toLocaleString()} tokens left after ~${fixedOverheadTokens.toLocaleString()} of tool definitions` : ""}) is smaller than ${needs} + margin need. Compaction still runs normally; it just keeps a little more. Details: /usage.`,
        "done",
      );
    }
  }

  if (wantsUsage) {
    const report = formatUsageReport({
      promptTokens: summaryTokensBefore + sum(tokens, coveredUpTo, msgs.length),
      contextLength,
      limit,
      transcriptTokens: sum(tokens, 0, msgs.length),
      totalMessages: msgs.length,
      coveredMessages: coveredUpTo,
      chunkCount: chunkSummaries.length,
      toolSchemaTokens: state.lastToolSchemaTokens,
      consolidatedChunks: match?.entry.consolidated,
      rememberedAttachments: cfg.get("attachmentMemory")
        ? await countRememberedAttachments(ctl, pairs)
        : undefined,
      events: match?.entry.stats?.events,
      floorClamp,
    });
    const block = ctl.createContentBlock({
      includeInContext: false,
      style: { type: "customLabel", label: "Companion Core" },
    });
    block.appendText(`${SENTINEL} Context usage\n${report}`);
    return; // /usage never runs a model reply
  }

  let consolidatedCount = match?.entry.consolidated ?? 0;
  let didConsolidate = false;
  // Per-chat compression ledger: carried on the cache entries themselves
  // (content-addressed, survives restarts like everything else).
  let chatEvents: CompressionEvent[] | undefined = match?.entry.stats?.events;
  const recordEvent = (
    kind: CompressionEvent["kind"],
    beforeTokens: number,
    afterTokens: number,
    hashesArr: string[] = hashes,
  ): void => {
    if (coveredUpTo === 0) return;
    chatEvents = appendEvent(chatEvents, {
      at: Date.now(),
      kind,
      beforeTokens,
      afterTokens,
    });
    const latest = cache.get(hashesArr[coveredUpTo - 1]);
    if (latest !== undefined) {
      cache.put(hashesArr[coveredUpTo - 1], {
        ...latest,
        stats: { events: chatEvents },
      });
      void cache.persist();
    }
  };
  const consolidateIfNeeded = async (
    hashesArr: string[],
    covered: number,
    tokensBeforeVal: number,
  ): Promise<void> => {
    if (state.mergeDisabled) return;
    if (budgetInfo.budget <= 0 || covered === 0 || chunkSummaries.length === 0)
      return;
    let counts: number[];
    try {
      counts = await Promise.all(
        chunkSummaries.map((s) => source.countTokens(s)),
      );
    } catch (error) {
      counts = chunkSummaries.map((s) => estimateTokens(s));
      ctl.debug("countTokens failed for chunk summaries; estimating", error);
    }
    const pick = pickConsolidation(
      chunkSummaries,
      counts,
      budgetInfo.budget,
      budgetInfo.keepNewest,
      mergeMaxTokens,
    );
    if (pick === null) return;
    const status = ctl.createStatus({
      status: "loading",
      text: `Consolidating ${pick.merge.length} summaries into one…`,
    });
    let mergeLastPercent = -1;
    const showMergeProgress = (fraction: number) => {
      const percent = Math.round(fraction * 100);
      if (percent === mergeLastPercent) return;
      mergeLastPercent = percent;
      status.setState({
        status: "loading",
        text: `Consolidating ${pick.merge.length} summaries ${progressBar(fraction)} ${percent}%`,
      });
    };
    try {
      const directive = noThinkDirective(source.identifier);
      const prompt = buildMergePrompt(pick.merge, maxExcerptChars, {
        noThinkDirective: directive,
        variant: promptVariant,
      });
      // Returns undefined (never throws for this reason) when the model
      // comes back with nothing usable even after respondForPayload's
      // headroom retry AND the L3 compact-prompt rescue below — consolidation
      // is a pure optimization, never load-bearing, so that's a graceful
      // skip below, not a digest (a structural digest of already-summarized
      // text would be worse than just keeping the summaries unmerged) and
      // not a thrown error either (an empty merge isn't an engine failure —
      // it shouldn't look like one in the status line or trip the
      // transient-error retry below).
      let sawReasoningBurn = false;
      const attemptMerge = async (): Promise<string | undefined> => {
        const { payload: text, stopReason: primaryStop } = await respondForPayload((maxTokens, isRetry) => {
          let generatedTokens = 0;
          const prediction = source.respond(
            Chat.from(
              promptChatMessages(
                nudgeForRetry(prompt, isRetry),
                state.systemStrategy ?? "system",
              ),
            ),
            {
              maxTokens,
              temperature: 0.2,
              contextOverflowPolicy: "stopAtLimit",
              onPromptProcessingProgress: (p) => showMergeProgress(p * 0.7),
              onPredictionFragment: (fragment) => {
                generatedTokens += fragment.tokensCount || 1;
                showMergeProgress(
                  0.7 + 0.3 * Math.min(1, generatedTokens / maxTokens),
                );
              },
            },
          );
          ctl.onAborted(() => void prediction.cancel());
          return prediction;
        }, mergeMaxTokens);
        if (text) return text;
        // Measured on qwen3.8-27b: the merge can burn ~6,600 tokens of pure
        // reasoning at every budget and variant — record it so a second
        // total burn disables consolidation for the session instead of
        // re-paying two doomed generations on every compaction.
        const primaryBurned = burnedOutInReasoning(text, primaryStop);
        sawReasoningBurn = primaryBurned;
        // Finding L3: same rescue as summarizeChunk's — one extra call with
        // the compact merge prompt (same summaries/excerpt bound/directive)
        // at the headroom budget, with the nudge, before giving up. Skipped
        // when the merge was already using the compact variant.
        if (promptVariant !== "compact") {
          const rescuePrompt = buildMergeRescuePrompt(pick.merge, maxExcerptChars, {
            noThinkDirective: directive,
          });
          const rescuePrediction = source.respond(
            Chat.from(
              promptChatMessages(rescuePrompt, state.systemStrategy ?? "system"),
            ),
            {
              maxTokens: Math.max(mergeMaxTokens * 4, 6000),
              temperature: 0.2,
              contextOverflowPolicy: "stopAtLimit",
            },
          );
          ctl.onAborted(() => void rescuePrediction.cancel());
          const rescueResult = await rescuePrediction;
          const rescued = extractPayload(rescueResult);
          if (rescued) {
            sawReasoningBurn = false;
            ctl.debug(
              "consolidation merge's full prompt returned empty; rescued with the compact merge prompt",
            );
            return rescued;
          }
          sawReasoningBurn =
            primaryBurned &&
            burnedOutInReasoning(rescued, rescueResult.stats.stopReason);
        }
        return undefined;
      };
      let merged: string | undefined;
      try {
        merged = await attemptMerge();
      } catch (error) {
        if (!ctl.abortSignal.aborted && isTransientEngineError(error)) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          merged = await attemptMerge();
        } else {
          throw error;
        }
      }
      if (merged === undefined) {
        if (sawReasoningBurn) {
          // Every attempt spent its entire budget reasoning without one
          // visible character: this model cannot do this task in this
          // window. Stop paying for the doomed retries on every compaction.
          state.mergeDisabled = true;
          ctl.debug(
            "consolidation merge burned out in reasoning on every attempt; disabling consolidation for this model this session",
          );
          status.setState({
            status: "error",
            text: "Consolidation disabled for this model this session: it spends any budget reasoning without answering. Summaries stay unmerged; everything else keeps working.",
          });
        } else {
          ctl.debug(
            "consolidation merge returned an empty summary even after the headroom retry; skipping this consolidation attempt (summaries remain unmerged)",
          );
          status.setState({
            status: "error",
            text: "Consolidation skipped (model returned nothing) — continuing with unconsolidated summaries",
          });
        }
        return;
      }
      const beforeBlock = counts.reduce((a, b) => a + b, 0);
      const keptTokens = counts
        .slice(pick.merge.length)
        .reduce((a, b) => a + b, 0);
      let afterBlock: number;
      try {
        afterBlock = (await source.countTokens(merged)) + keptTokens;
      } catch (error) {
        afterBlock = mergeMaxTokens + keptTokens;
        ctl.debug("countTokens failed for merged summary; estimating", error);
      }
      consolidatedCount =
        consolidatedCount > 0
          ? consolidatedCount + pick.merge.length - 1
          : pick.merge.length;
      chunkSummaries.splice(0, pick.merge.length, merged);
      cache.put(hashesArr[covered - 1], {
        chunkSummaries: [...chunkSummaries],
        coveredCount: covered,
        tokensBefore: tokensBeforeVal,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        consolidated: consolidatedCount,
      });
      void cache.persist();
      didConsolidate = true;
      recordEvent("consolidation", beforeBlock, afterBlock, hashesArr);
      status.setState({
        status: "done",
        text: `Summaries consolidated (${pick.merge.length} → 1)`,
      });
    } catch (error) {
      if (ctl.abortSignal.aborted) throw error;
      status.setState({
        status: "error",
        text: "Consolidation failed — continuing with unconsolidated summaries",
      });
    }
  };

  const plan = planCompaction({
    msgs,
    tokens,
    coveredUpTo,
    summaryTokens: summaryTokensBefore,
    estSummaryTokensPerChunk: eff.summarizerMaxTokens,
    limit,
    floor: clampedFloor,
    autoCompact: cfg.get("autoCompact"),
    force,
    keepRecentTokens: eff.keepRecentTokens,
    chunkTokens: eff.chunkTokens,
    maxChunks: cfg.get("maxChunksPerPass"),
  });

  let compactionFailed: string | undefined;
  let forceBlock: ReturnType<typeof ctl.createContentBlock> | undefined;
  if (plan.cuts.length > 0) {
    const status = ctl.createStatus({
      status: "loading",
      text: "Compacting context…",
    });
    let from = coveredUpTo;
    let done = 0;
    const totalChunks = plan.cuts.length;
    let lastShownPercent = -1;
    // Make resume visible: chunks cached by earlier (possibly canceled)
    // runs are reused, so say so instead of looking like a fresh start.
    const resumedNote =
      chunkSummaries.length > 0
        ? ` (${chunkSummaries.length} cached chunk${chunkSummaries.length === 1 ? "" : "s"} reused)`
        : "";
    const showProgress = (finishedChunks: number, within: number) => {
      const fraction = overallFraction(finishedChunks, totalChunks, within);
      const percent = Math.round(fraction * 100);
      if (percent === lastShownPercent) return; // throttle IPC updates
      lastShownPercent = percent;
      status.setState({
        status: "loading",
        text: `Compacting ${progressBar(fraction)} ${percent}% — chunk ${Math.min(finishedChunks + 1, totalChunks)}/${totalChunks}${resumedNote}`,
      });
    };
    // Update the status the instant Stop is pressed — updates attempted
    // after our code unwinds race the prediction teardown and vanish.
    ctl.onAborted(() => {
      try {
        status.setState({
          status: "canceled",
          text: "Compaction canceled — finished chunks are saved; run /compact to continue",
        });
      } catch {
        // teardown already detached the status
      }
    });
    // For a forced /compact the whole reply is our report: create it BEFORE
    // the long-running work so an abort or crash can never leave an empty
    // "This message contains no content" reply.
    if (force) {
      forceBlock = ctl.createContentBlock({
        includeInContext: false,
        style: { type: "customLabel", label: "Companion Core" },
      });
      forceBlock.appendText(
        `${SENTINEL} Compacting ${plan.cuts.length} chunk(s)${resumedNote} — progress above. Stopping is safe: finished chunks are saved and /compact resumes.`,
      );
    }
    try {
      for (const cut of plan.cuts) {
        ctl.guardAbort();
        showProgress(done, 0);
        const chunkAttachments = await ensureAttachmentMemories(
          ctl,
          source,
          pairs,
          from,
          cut,
          attachOpts,
          state.systemStrategy ?? "system",
        );
        const summary = await summarizeChunk(
          ctl,
          source,
          msgs.slice(from, cut),
          eff.summarizerMaxTokens,
          maxExcerptChars,
          (within) => showProgress(done, within),
          chunkAttachments,
          state.systemStrategy ?? "system",
          promptVariant,
        );
        done++;
        chunkSummaries.push(summary);
        cache.put(hashes[cut - 1], {
          chunkSummaries: [...chunkSummaries],
          coveredCount: cut,
          tokensBefore: sum(tokens, 0, cut),
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
        from = cut;
        await cache.persist();
      }
      coveredUpTo = from;
      status.setState({
        status: "done",
        text: `Context compacted ${progressBar(1)} 100% (${totalChunks} chunk${totalChunks === 1 ? "" : "s"})`,
      });
    } catch (error) {
      coveredUpTo = from; // keep the chunks that did succeed (already cached)
      if (ctl.abortSignal.aborted) {
        const saved = coveredUpTo - initialCovered;
        try {
          status.setState({
            status: "canceled",
            text: `Compaction canceled — ${saved > 0 ? `${done} finished chunk(s) saved; ` : ""}run /compact to continue`,
          });
        } catch {
          // prediction teardown may already have detached the status
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      // An unloaded/reloaded model rejects with an empty message; say so
      // rather than printing "Compaction failed ()".
      compactionFailed =
        message.split("\n")[0].slice(0, 200).trim() ||
        "no reason given — was the model unloaded or reloaded mid-turn?";
      status.setState({
        status: "error",
        text: `Compaction failed (${compactionFailed}); continuing with what we have.`,
      });
    }
  }

  // Consolidation triggers only alongside real compaction activity (or a
  // forced /compress — which is how a stuck over-budget chat heals on
  // demand), never on idle turns.
  if (force || plan.cuts.length > 0) {
    await consolidateIfNeeded(hashes, coveredUpTo, sum(tokens, 0, coveredUpTo));
  }

  // The engine may be unhealthy right after a failed chunk — never let the
  // bookkeeping count crash the report; estimate instead.
  let summaryTokensAfter: number;
  try {
    summaryTokensAfter = await summaryTokensOf(chunkSummaries);
  } catch {
    summaryTokensAfter = chunkSummaries.length * eff.summarizerMaxTokens;
  }
  const uncompressedTokens = sum(tokens, 0, msgs.length);
  const viewTokens = summaryTokensAfter + sum(tokens, coveredUpTo, msgs.length);

  const madeProgress = coveredUpTo > initialCovered;
  if (madeProgress) {
    recordEvent(
      force ? "force" : "auto",
      summaryTokensBefore + sum(tokens, initialCovered, msgs.length),
      viewTokens,
    );
  }

  if (force) {
    const savedPercent =
      uncompressedTokens > 0
        ? Math.round((1 - viewTokens / uncompressedTokens) * 100)
        : 0;
    const consolidationNote = didConsolidate
      ? ` Summaries consolidated (now ${chunkSummaries.length}, incl. 1 covering ${consolidatedCount} earlier chunks).`
      : "";
    const floorNote =
      floorClamp !== undefined
        ? ` Compact-down-to floor ~${floorClamp.effectiveTokens.toLocaleString()} tokens (configured ~${floorClamp.configuredTokens.toLocaleString()} could not fit the system prompt + summary budget + kept-verbatim; see /usage).`
        : "";
    let text: string;
    if (madeProgress || didConsolidate) {
      text = `${SENTINEL} Compacted: ~${uncompressedTokens.toLocaleString()} -> ~${viewTokens.toLocaleString()} tokens (${savedPercent}% saved), ${coveredUpTo} messages summarized into ${chunkSummaries.length} chunk(s).${consolidationNote}${floorNote}`;
      if (compactionFailed) {
        text += ` Stopped early: ${compactionFailed}. Run /compress again to continue.`;
      }
    } else if (compactionFailed) {
      text = `${SENTINEL} Compaction failed: ${compactionFailed}`;
    } else {
      text = `${SENTINEL} Nothing to compress (${msgs.length} messages, ~${viewTokens.toLocaleString()} tokens in the prompt).`;
    }
    if (forceBlock !== undefined) {
      // upgrade the early placeholder in place
      forceBlock.replaceText(text);
    } else {
      const block = ctl.createContentBlock({
        includeInContext: false,
        style: { type: "customLabel", label: "Companion Core" },
      });
      block.appendText(text);
    }
    return; // /compress never runs a model reply
  }

  // Build the exact view and verify it against the model's real chat
  // template — per-message estimates miss template syntax, the summary
  // wrapper, and the system prompt. If the rendered prompt exceeds the safe
  // budget (context minus the output reserve), compact further first.
  let view = buildView(
    composeSystemMessage(preambleTexts, chunkSummaries),
    pairs,
    coveredUpTo,
    state.systemStrategy ?? "system",
  );
  // Tool definitions consume context too — create the session up front so
  // their cost is measured and budgeted alongside the rendered prompt.
  // The Companion lifecycle acquires and owns this session before any generation.
  const sessionTools = wrapToolsWithCap(
    turn.tools as (Tool & {
      implementation: (
        params: Record<string, unknown>,
        ctx: unknown,
      ) => unknown | Promise<unknown>;
    })[],
    eff.maxToolResultTokens,
    cfg.get("maxTotalToolResultTokens"),
  );
  // SDK 1.5.0 exposes trainedForToolUse as a plain readonly property on the
  // already-loaded model handle, so no async probe (and its failure/catch
  // path) is needed here.
  const toolGate = decideTools({
    sessionToolCount: sessionTools.length,
    trainedForToolUse: source.trainedForToolUse,
  });
  if (toolGate.warning !== undefined) {
    warnOnce(ctl, state, "tools-dropped", toolGate.warning);
  }
  const modelSupportsTools = toolGate.passTools;
  const usageSnapshot: UsageSnapshot = {
    promptTokens: viewTokens,
    contextLength,
    limit,
    floorClamp,
    transcriptTokens: uncompressedTokens,
    totalMessages: msgs.length,
    coveredMessages: coveredUpTo,
    chunkCount: chunkSummaries.length,
    consolidatedChunks: consolidatedCount > 0 ? consolidatedCount : undefined,
    rememberedAttachments: cfg.get("attachmentMemory")
      ? await countRememberedAttachments(ctl, pairs)
      : undefined,
    events: chatEvents,
  };
  const usageTool = rawFunctionTool({
    name: "get_context_usage",
    description:
      "Get current context/token usage for this chat: prompt size sent to the model, " +
      "percentage of the context window used, transcript size, and how much has been " +
      "compressed away. Call this whenever the user asks about context usage, remaining " +
      "context, token counts, or compression status.",
    parametersJsonSchema: { type: "object", properties: {}, required: [] },
    implementation: async () => usageToolResult(usageSnapshot),
  });
  const tools = modelSupportsTools
    ? [...(sessionTools as Tool[]), usageTool]
    : [];
  let toolSchemaTokens = 0;
  if (tools.length > 0) {
    const serialized = JSON.stringify(
      tools.map((t) => {
        const anyTool = t as unknown as {
          name?: string;
          description?: string;
          parametersJsonSchema?: unknown;
        };
        return {
          name: anyTool.name,
          description: anyTool.description,
          parameters: anyTool.parametersJsonSchema ?? {},
        };
      }),
    );
    try {
      toolSchemaTokens = (await source.countTokens(serialized)) + tools.length * 8;
    } catch (error) {
      toolSchemaTokens = estimateTokens(serialized) + tools.length * 8;
      ctl.debug("countTokens failed for tool schemas; estimating", error);
    }
  }
  state.lastToolSchemaTokens = toolSchemaTokens > 0 ? toolSchemaTokens : undefined;
  usageSnapshot.toolSchemaTokens = state.lastToolSchemaTokens;

  const renderAndCount = async (v: Chat): Promise<number> => {
    const rendered = await source.applyPromptTemplate(v);
    return await source.countTokens(rendered);
  };
  // Shared give-up tail for countRendered's two catch sites: warn once,
  // debug-log the triggering error, and disable exact-fit verification for
  // the rest of this reply.
  const giveUpOnRenderCount = (error: unknown): undefined => {
    const message = error instanceof Error ? error.message : String(error);
    if (/unload|cannot find model/i.test(message)) {
      // Not a template problem: the model went away under this turn (an
      // API client or the user unloaded/reloaded it). Say that, and do not
      // remember it against the model like a template rejection.
      ctl.createStatus({
        status: "error",
        text: "The model was unloaded or reloaded during this turn — exact prompt-fit verification skipped for this reply",
      });
    } else {
      warnOnce(
        ctl,
        state,
        "template-render-failed",
        "Chat template render failed — exact prompt-fit verification disabled for this model",
      );
    }
    ctl.debug(error);
    return undefined;
  };
  // Builds a view and counts its rendered size, retrying once with the
  // no-system-role fold on a template rejection (stock Gemma and some
  // Mistral chat templates throw on a system role). `rebuild` produces the
  // view for the current strategy, so a fold that fixes the count also
  // produces the view that actually flows to the reply; letting those drift
  // apart would silently crash the prediction after passing this check.
  const countRendered = async (
    rebuild: () => Chat,
  ): Promise<{ view: Chat; exact: number | undefined }> => {
    let v = rebuild();
    try {
      return { view: v, exact: await renderAndCount(v) };
    } catch (error) {
      if ((state.systemStrategy ?? "system") === "system") {
        // Backstop, not the common path: resolveSystemStrategy's minimal
        // probe already passed at the top of this turn, so a rejection here
        // is a speculative second guess for the rarer case where that probe
        // succeeds but the real, full-size view still fails to render.
        state.systemStrategy = "foldSystem";
        v = rebuild();
        ctl.debug(
          "chat template rejected the view; retrying with folded system message",
          error,
        );
        try {
          return { view: v, exact: await renderAndCount(v) };
        } catch (retryError) {
          return { view: v, exact: giveUpOnRenderCount(retryError) };
        }
      }
      return { view: v, exact: giveUpOnRenderCount(error) };
    }
  };
  const rebuildFrom = (fitPairs: Pair[]) => () =>
    buildView(
      composeSystemMessage(preambleTexts, chunkSummaries),
      fitPairs,
      coveredUpTo,
      state.systemStrategy ?? "system",
    );
  /**
   * Make the prompt fit the window. Consolidation gets the first try (when
   * the summary block itself is what overflows, chunk-compaction ADDS summary
   * tokens while removing possibly-smaller rounds); then more rounds are
   * summarized — into the verbatim tail down to the current turn when
   * nothing older is left — until the rendered prompt + tool definitions
   * fit under safeBudget, which already reserves the reply and a pass of
   * tool rounds. Shared by the pre-turn check and the between-pass check;
   * both advance coveredUpTo and chunkSummaries.
   */
  const fitToWindow = async (
    fitMsgs: CanonMessage[],
    fitTokens: number[],
    fitPairs: Pair[],
    fitHashes: string[],
  ): Promise<{ view: Chat; exact: number | undefined }> => {
    const rebuild = rebuildFrom(fitPairs);
    let fitted = await countRendered(rebuild);
    if (safeBudget === undefined) return fitted;
    if (
      fitted.exact !== undefined &&
      fitted.exact + toolSchemaTokens > safeBudget
    ) {
      await consolidateIfNeeded(
        fitHashes,
        coveredUpTo,
        sum(fitTokens, 0, coveredUpTo),
      );
      if (didConsolidate) fitted = await countRendered(rebuild);
    }
    let rounds = 0;
    while (
      fitted.exact !== undefined &&
      fitted.exact + toolSchemaTokens > safeBudget &&
      rounds < 5
    ) {
      // The verbatim tail is a preference; the window is not. When nothing
      // older than the tail is left to summarize, cut into the tail down to
      // the start of the current turn rather than send a prompt that the
      // next tool round will push over the window.
      const { cuts: nextCuts, relaxed } = fitCuts(
        roundBoundaries(fitMsgs),
        fitTokens,
        coveredUpTo,
        eff.chunkTokens,
        eff.keepRecentTokens,
        currentTurnStart(fitMsgs),
      );
      if (nextCuts.length === 0) break;
      const cut = nextCuts[0];
      const status = ctl.createStatus({
        status: "loading",
        text: relaxed
          ? "Compacting into the verbatim tail so the prompt fits…"
          : "Compacting further so the prompt fits safely…",
      });
      let lastPercent = -1;
      const showProgress = (within: number) => {
        const percent = Math.round(within * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
        status.setState({
          status: "loading",
          text: `Compacting further so the prompt fits safely ${progressBar(within)} ${percent}%`,
        });
      };
      try {
        const chunkAttachments = await ensureAttachmentMemories(
          ctl,
          source,
          fitPairs,
          coveredUpTo,
          cut,
          attachOpts,
          state.systemStrategy ?? "system",
        );
        const summary = await summarizeChunk(
          ctl,
          source,
          fitMsgs.slice(coveredUpTo, cut),
          eff.summarizerMaxTokens,
          maxExcerptChars,
          showProgress,
          chunkAttachments,
          state.systemStrategy ?? "system",
          promptVariant,
        );
        chunkSummaries.push(summary);
        cache.put(fitHashes[cut - 1], {
          chunkSummaries: [...chunkSummaries],
          coveredCount: cut,
          tokensBefore: sum(fitTokens, 0, cut),
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
        void cache.persist();
        coveredUpTo = cut;
        status.setState({
          status: "done",
          text: relaxed
            ? "Compacted into the verbatim tail to fit"
            : "Compacted further to fit",
        });
      } catch {
        status.setState({ status: "error", text: "Safety compaction failed" });
        break;
      }
      const before = fitted.exact;
      fitted = await countRendered(rebuild);
      if (before !== undefined && fitted.exact !== undefined) {
        recordEvent("safety", before, fitted.exact);
      }
      rounds++;
    }
    return fitted;
  };

  const preTurn = await fitToWindow(msgs, tokens, pairs, hashes);
  view = preTurn.view;
  const exactPromptTokens = preTurn.exact;
  if (contextLength !== undefined && safeBudget !== undefined) {
    // Without exact-fit verification the per-message estimate still refuses
    // a prompt that certainly cannot fit, instead of a cryptic engine 400.
    const totalPrompt = (exactPromptTokens ?? viewTokens) + toolSchemaTokens;
    if (totalPrompt >= contextLength) {
      // Guaranteed engine rejection: refuse the prediction with an
      // actionable message instead of letting it fail cryptically.
      throw new CoreTurnError('CONTEXT_LIMIT',`Запрос не помещается в контекст: около ${totalPrompt.toLocaleString('ru-RU')} токенов при окне ${contextLength.toLocaleString('ru-RU')}. Уменьшите объём материалов или число подключённых инструментов.`);
    }
    if (totalPrompt > safeBudget) {
      ctl.createStatus({
        status: "error",
        text: `Prompt ~${totalPrompt.toLocaleString()} tokens exceeds the safe budget (~${safeBudget.toLocaleString()}: the window minus ~${eff.reservedOutputTokens.toLocaleString()} for the reply and ~${eff.passAllowanceTokens.toLocaleString()} for this pass's tool rounds); the reply may be cut short.`,
      });
    }
  }
  const promptTokens = exactPromptTokens ?? viewTokens;
  usageSnapshot.promptTokens = promptTokens;
  usageSnapshot.coveredMessages = coveredUpTo;
  usageSnapshot.chunkCount = chunkSummaries.length;
  usageSnapshot.consolidatedChunks =
    consolidatedCount > 0 ? consolidatedCount : undefined;
  usageSnapshot.events = chatEvents;

  if (coveredUpTo > initialCovered && cfg.get("showStats")) {
    const block = ctl.createContentBlock({
      includeInContext: false,
      style: { type: "customLabel", label: "Companion Core" },
    });
    block.appendText(
      `${SENTINEL} Auto-compacted: ~${uncompressedTokens.toLocaleString()} -> ~${promptTokens.toLocaleString()} tokens in the prompt.`,
    );
  }

  // LM Studio's own context meter counts the visible transcript, which never
  // shrinks — while compression is active, show the real prompt size where
  // the user chose to see it.
  if (chunkSummaries.length > 0) {
    const usagePercent =
      contextLength !== undefined
        ? Math.round((promptTokens / contextLength) * 100)
        : undefined;
    const meterMode = cfg.get("meterDisplay");
    if (meterMode === "status") {
      const gauge =
        usagePercent !== undefined
          ? `${progressBar(promptTokens / contextLength!, 8)} ${usagePercent}% of ${contextLength!.toLocaleString()}`
          : "";
      ctl.createStatus({
        status: "done",
        text: `Prompt: ~${promptTokens.toLocaleString()} tokens ${gauge} — visible chat: ~${uncompressedTokens.toLocaleString()}`,
      });
    } else if (meterMode === "sender") {
      try {
        const suffix =
          usagePercent !== undefined ? ` · ctx ${usagePercent}%` : "";
        await ctl.setSenderName(
          `~${promptTokens.toLocaleString()} tok${suffix} (compressed)`,
        );
      } catch (error) {
        // sender-name support may vary; never let the meter break a reply
        ctl.debug("setSenderName failed", error);
      }
    }
  }

  try {
    if (tools.length === 0) {
      const block = ctl.createContentBlock();
      // stopAtLimit: never let the engine's own overflow truncation mangle
      // the prompt (dropping the user message breaks strict templates).
      const prediction = source.respond(view, {
        contextOverflowPolicy: "stopAtLimit",
      });
      ctl.onAborted(() => void prediction.cancel());
      const result = await block.pipeFrom(prediction);
      ctl.abortSignal.throwIfAborted();
      const fallback = decideFallback({
        visibleChars: extractPayload(result).length,
        reasoningText: result.reasoningContent !== "" ? result.reasoningContent : result.content,
        toolRequestCount: 0,
      });
      if (fallback?.kind === "promote") {
        block.replaceText(fallback.text);
      } else if (fallback?.kind === "notice") {
        const noticeBlock = ctl.createContentBlock({
          includeInContext: false,
          style: { type: "customLabel", label: "Companion Core" },
        });
        noticeBlock.appendText(fallback.text);
      }
    } else {
      // Marathon protection: run the tool loop in capped passes; between
      // passes, measure the grown context and compact mid-task if needed —
      // a single agentic turn can otherwise outgrow the context with no
      // boundary at which compaction could ever run.
      const roundsPerPass = eff.roundsPerPass;
      let workingPairs = pairs;
      let workingMsgs = msgs;
      let workingTokens = tokens;
      let currentView = view;
      // Exact rendered size of the prompt each pass starts from, for the
      // per-round fit guard; undefined when the exact count was unavailable.
      let currentViewTokens: number | undefined = exactPromptTokens;
      // Backoff schedule sized for an engine restart / model reload — a
      // 27B model can take tens of seconds to come back.
      const RETRY_DELAYS_MS = [1000, 5000, 15000];
      let retriesUsed = 0;
      // Stays true unless the loop exits via the normal completion break
      // below — distinguishes "ran out of passes" from "task finished".
      let passCapHit = true;
      for (let pass = 0; pass < 24; pass++) {
        let passResult: ActPassResult | undefined;
        while (passResult === undefined) {
          const passStats: ActPassStats = {
            executedToolCalls: 0,
            visibleChars: 0,
            toolRequestCount: 0,
          };
          try {
            passResult = await actWithUi(
              ctl,
              source,
              currentView,
              tools,
              roundsPerPass > 0 ? roundsPerPass : undefined,
              passStats,
              contextLength !== undefined && currentViewTokens !== undefined
                ? {
                    startTokens: currentViewTokens,
                    toolSchemaTokens,
                    reservedOutputTokens: eff.reservedOutputTokens,
                    contextLength,
                  }
                : undefined,
            );
          } catch (error) {
            // Transient engine deaths ("terminated", "fetch failed" from a
            // crashed/unloaded model) get retried with backoff — but only
            // when the failed pass provably had no side effects and showed
            // no text, so nothing can double-execute or duplicate.
            if (
              retriesUsed < RETRY_DELAYS_MS.length &&
              !ctl.abortSignal.aborted &&
              isTransientEngineError(error) &&
              passStats.executedToolCalls === 0 &&
              passStats.toolRequestCount === 0 &&
              passStats.visibleChars === 0
            ) {
              const delay = RETRY_DELAYS_MS[retriesUsed];
              retriesUsed++;
              ctl.createStatus({
                status: "loading",
                text: `Companion Core: связь с моделью прервалась; повтор через ${delay / 1000} с (${retriesUsed}/${RETRY_DELAYS_MS.length})…`,
              });
              // Keep this turn's selected source; do not trigger JIT reload.
              await waitBeforeRetry(delay, undefined, { signal: ctl.abortSignal });
              ctl.abortSignal.throwIfAborted();
            } else {
              throw error;
            }
          }
        }
        const { collected } = passResult;
        if (passResult.capped === undefined) {
          passCapHit = false;
          break;
        }
        ctl.guardAbort();
        // The pass was cut off by the round cap: fold its messages into the
        // working history, compact if the context has grown too far, and
        // continue the task seamlessly.
        const newPairs: Pair[] = [];
        for (const message of collected) {
          const canonMsg = toCanon(message, ctl.client);
          const t = transformForView(canonMsg);
          if (t === null) continue;
          newPairs.push(t === canonMsg ? { raw: message, canon: t } : { canon: t });
        }
        workingPairs = [...workingPairs, ...newPairs];
        workingMsgs = workingPairs.map((p) => p.canon);
        workingTokens = await counter.countMessages(workingMsgs);
        const workingHashes = prefixHashes(workingMsgs, namespace);
        const midSummaryTokens = await summaryTokensOf(chunkSummaries).catch(
          () => chunkSummaries.length * eff.summarizerMaxTokens,
        );
        const midCoveredBefore = coveredUpTo;
        const midPlan = planCompaction({
          msgs: workingMsgs,
          tokens: workingTokens,
          coveredUpTo,
          summaryTokens: midSummaryTokens,
          estSummaryTokensPerChunk: eff.summarizerMaxTokens,
          limit,
          floor: clampedFloor,
          autoCompact: cfg.get("autoCompact"),
          force: false,
          keepRecentTokens: eff.keepRecentTokens,
          chunkTokens: eff.chunkTokens,
          maxChunks: cfg.get("maxChunksPerPass"),
        });
        if (midPlan.cuts.length > 0) {
          const midStatus = ctl.createStatus({
            status: "loading",
            text: `Mid-task compaction (${midPlan.cuts.length} chunk(s))…`,
          });
          const midTotal = midPlan.cuts.length;
          let midDone = 0;
          let midLastPercent = -1;
          const showMidProgress = (finished: number, within: number) => {
            const fraction = overallFraction(finished, midTotal, within);
            const percent = Math.round(fraction * 100);
            if (percent === midLastPercent) return;
            midLastPercent = percent;
            midStatus.setState({
              status: "loading",
              text: `Mid-task compaction ${progressBar(fraction)} ${percent}% — chunk ${Math.min(finished + 1, midTotal)}/${midTotal}`,
            });
          };
          try {
            let midFrom = coveredUpTo;
            for (const cut of midPlan.cuts) {
              ctl.guardAbort();
              showMidProgress(midDone, 0);
              const chunkAttachments = await ensureAttachmentMemories(
                ctl,
                source,
                workingPairs,
                midFrom,
                cut,
                attachOpts,
                state.systemStrategy ?? "system",
              );
              const summary = await summarizeChunk(
                ctl,
                source,
                workingMsgs.slice(midFrom, cut),
                eff.summarizerMaxTokens,
                maxExcerptChars,
                (within) => showMidProgress(midDone, within),
                chunkAttachments,
                state.systemStrategy ?? "system",
                promptVariant,
              );
              midDone++;
              chunkSummaries.push(summary);
              cache.put(workingHashes[cut - 1], {
                chunkSummaries: [...chunkSummaries],
                coveredCount: cut,
                tokensBefore: sum(workingTokens, 0, cut),
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
              });
              void cache.persist();
              midFrom = cut;
            }
            coveredUpTo = midFrom;
            const midAfterSummary = await summaryTokensOf(
              chunkSummaries,
            ).catch(
              () => chunkSummaries.length * eff.summarizerMaxTokens,
            );
            recordEvent(
              "mid-task",
              midSummaryTokens +
                sum(workingTokens, midCoveredBefore, workingMsgs.length),
              midAfterSummary +
                sum(workingTokens, coveredUpTo, workingMsgs.length),
              workingHashes,
            );
            midStatus.setState({
              status: "done",
              text: "Mid-task compaction done — continuing",
            });
          } catch (error) {
            if (ctl.abortSignal.aborted) throw error;
            midStatus.setState({
              status: "error",
              text: "Mid-task compaction failed — continuing uncompressed",
            });
          }
          await consolidateIfNeeded(
            workingHashes,
            coveredUpTo,
            sum(workingTokens, 0, coveredUpTo),
          );
        }
        // The next pass must fit as well: the same check as before the
        // turn, over the history the pass just grew.
        const refit = await fitToWindow(
          workingMsgs,
          workingTokens,
          workingPairs,
          workingHashes,
        );
        currentView = refit.view;
        const continueText =
          "Continue the task from where you left off. If it is already complete, summarize the final result.";
        currentView.append("user", continueText);
        currentViewTokens =
          refit.exact !== undefined
            ? refit.exact + estimateMessageTokens({ text: continueText })
            : undefined;
      }
      if (passCapHit) {
        // Indistinguishable from task completion otherwise: the reply just
        // stops with no error and no sign the task is still in progress.
        const block = ctl.createContentBlock({
          includeInContext: false,
          style: { type: "customLabel", label: "Companion Core" },
        });
        block.appendText(
          `${SENTINEL} Reached the safety cap of 24 tool passes — the task was paused, not finished. Send any message to continue.`,
        );
      }
    }
  } catch (error) {
    // The lifecycle reports a single outcome and always releases tools.
    throw error;
  }
}

/**
 * Thin assembler over planViewMessages: chat templates require at most one
 * system message, at position 0 (the "system" strategy) — or, for
 * no-system-role templates (stock Gemma, some Mistral variants), none at all
 * (the "foldSystem" strategy, folded into a leading/merged user turn
 * instead). The system prompt and summary arrive pre-merged in systemText.
 */
function buildView(
  systemText: string | undefined,
  pairs: Pair[],
  coveredUpTo: number,
  strategy: ViewStrategy,
): Chat {
  const view = Chat.empty();
  const tail = pairs.slice(coveredUpTo);
  const planned = planViewMessages(
    systemText,
    tail.map((p) => p.canon),
    strategy,
    SYNTHETIC_USER_MESSAGE,
  );
  for (const msg of planned) {
    const raw =
      msg.fromTailIndex !== undefined ? tail[msg.fromTailIndex].raw : undefined;
    if (raw !== undefined) {
      view.append(raw);
    } else {
      view.append(msg.role, msg.text);
    }
  }
  return view;
}

/**
 * The minimal controller surface summarization needs — structurally
 * satisfied by PredictionLoopHandlerController, and trivially stubbable by
 * the benchmark runner.
 */
export interface SummarizeCtl {
  onAborted(listener: () => void): void;
  abortSignal: AbortSignal;
  /** Optional: the real controller has it, bench's minimal stub doesn't need it. */
  debug?(...messages: unknown[]): void;
}

export async function summarizeChunk(
  ctl: SummarizeCtl,
  model: LLM,
  chunk: CanonMessage[],
  maxTokens: number,
  maxExcerptChars: number,
  onProgress?: (within: number) => void,
  attachmentMemories?: ReadonlyMap<string, string>,
  // Defaults to "system" (today's behavior) so bench/run.ts — which calls
  // this with only the first 5 args — keeps compiling unchanged.
  promptStrategy: ViewStrategy = "system",
  // Defaults to "full" (today's behavior) for the same reason.
  variant: PromptVariant = "full",
): Promise<string> {
  // Thinking models known to honor a no-think soft-switch skip reasoning;
  // other models never see the directive. Reasoning adds nothing to
  // summaries (it's stripped) but multiplies compaction time.
  const directive = noThinkDirective(model.identifier);
  const prompt = buildSummaryPrompt(chunk, maxExcerptChars, {
    noThinkDirective: directive,
    attachmentMemories,
    variant,
  });
  const attempt = async (): Promise<string> => {
    // Most of a chunk's wall time is the model ingesting the excerpt (prompt
    // processing); map that to 0..0.7 and summary generation to 0.7..1.
    const { payload: primary, stopReason } = await respondForPayload(
      (mt, isRetry) => {
        let generatedTokens = 0;
        const prediction = model.respond(
          Chat.from(promptChatMessages(nudgeForRetry(prompt, isRetry), promptStrategy)),
          {
            maxTokens: mt,
            temperature: 0.2,
            contextOverflowPolicy: "stopAtLimit",
            onPromptProcessingProgress: (p) => onProgress?.(p * 0.7),
            onPredictionFragment: (fragment) => {
              generatedTokens += fragment.tokensCount || 1;
              onProgress?.(0.7 + 0.3 * Math.min(1, generatedTokens / mt));
            },
          },
        );
        ctl.onAborted(() => void prediction.cancel());
        return prediction;
      },
      maxTokens,
    );
    if (primary) {
      if (isTruncatedStop(stopReason)) {
        ctl.debug?.("summarizer hit maxTokens; summary may be truncated");
      }
      return primary;
    }
    // Finding L3: before falling back to a structural digest, try ONE
    // rescue with the compact prompt variant when the configured variant
    // wasn't already "compact" — a single model call, no further internal
    // retry, at the same headroom budget with the retry nudge (see
    // buildSummaryRescuePrompt in summarizer.ts for the measured evidence:
    // the FULL 10-section prompt is itself what triggers runaway reasoning
    // on some models — swapping to the much shorter compact prompt answered
    // cleanly on the exact chunk that spiraled under the full prompt).
    if (variant !== "compact") {
      const rescuePrompt = buildSummaryRescuePrompt(chunk, maxExcerptChars, {
        noThinkDirective: directive,
        attachmentMemories,
      });
      const rescuePrediction = model.respond(
        Chat.from(promptChatMessages(rescuePrompt, promptStrategy)),
        {
          maxTokens: Math.max(maxTokens * 4, 6000),
          temperature: 0.2,
          contextOverflowPolicy: "stopAtLimit",
        },
      );
      ctl.onAborted(() => void rescuePrediction.cancel());
      const rescued = extractPayload(await rescuePrediction);
      if (rescued) {
        ctl.debug?.(
          "summarizer's full prompt returned empty; rescued with the compact prompt variant",
        );
        return rescued;
      }
    }
    // Finding L2 / ruling R9: compaction must never hard-fail on any
    // model. On qwen3.8-27b with garbage-dense (tool-spam) excerpts,
    // reasoning burn is effectively unbounded — one measured chunk burned
    // 32,626 chars of reasoning and was STILL inside it when even the
    // headroom retry's cap hit (no finite retry budget guarantees an
    // answer), and the L3 compact-prompt rescue above (when attempted) can
    // still come back empty too. Either way there is no usable model
    // summary at this point, so fall back to a deterministic, model-free
    // structural digest instead of throwing. The one exception: an aborted
    // prediction must still propagate as a failure, not silently become a
    // digest — Stop must still stop.
    if (ctl.abortSignal.aborted) {
      throw new Error("summarizer returned an empty summary");
    }
    ctl.debug?.(
      "summarizer returned an empty summary even after the headroom retry" +
        (variant !== "compact" ? " and the compact-prompt rescue" : "") +
        "; falling back to a structural digest",
    );
    // maxTokens is this chunk's own summarizer token budget; ~4 chars/token
    // keeps the digest in roughly the same size class as the summary it
    // replaces (scales with the configured summarizerMaxTokens instead of
    // a fixed constant that would be wrong for both tiny and huge configs).
    return structuralDigest(chunk, maxTokens * 4);
  };
  try {
    return await attempt();
  } catch (error) {
    // Summarization has no side effects, so a transient engine failure is
    // always safe to retry once.
    if (!ctl.abortSignal.aborted && isTransientEngineError(error)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await attempt();
    }
    throw error;
  }
}

interface ActPassResult {
  /** Prediction rounds the pass actually used. */
  roundsUsed: number;
  /** Completed messages generated during the pass, in order. */
  collected: ChatMessage[];
  /**
   * Set when the pass was cut off by this plugin (round cap or the
   * per-round fit guard) and the task is still in progress; undefined when
   * the model finished on its own.
   */
  capped?: PassEndReason;
}

/**
 * Live progress counters a pass mutates as it runs, readable by the caller
 * even when the pass throws — the retry gate needs to know whether any tool
 * implementation began executing (side effects!) or any text reached the UI.
 */
interface ActPassStats {
  executedToolCalls: number;
  visibleChars: number;
  toolRequestCount: number;
}

/**
 * Run an agentic (tool-using) prediction, mirroring fragments and tool
 * activity into UI content blocks. With maxRounds set, the pass stops after
 * that many rounds so the caller can compact mid-task and continue.
 */
async function actWithUi(
  ctl: PredictionLoopHandlerController,
  model: LLM,
  view: Chat,
  tools: Tool[],
  maxRounds?: number,
  stats?: ActPassStats,
  fit?: RoundFitBudget,
): Promise<ActPassResult> {
  // Blocks are created lazily: an eagerly-created block that never receives
  // text renders as "This message contains no content" in LM Studio.
  let block: ReturnType<typeof ctl.createContentBlock> | undefined;
  const mainBlock = () => (block ??= ctl.createContentBlock());
  let thinkingBlock: ReturnType<typeof ctl.createContentBlock> | undefined;
  let visibleChars = 0;
  let reasoningBuffer = "";
  let toolRequestCount = 0;
  // Render each tool result into its own tool-role block (LM Studio rejects
  // appendToolResult on assistant blocks), correlated by the SDK-provided
  // ToolCallContext.callId — unique within one act() invocation, so
  // concurrent calls to the same tool can never swap results.
  // act() gives tools a context whose status()/warn() only reach the plugin
  // log; mirror them into a per-call tool status so another plugin's
  // progress text ("Searching…") stays visible in the chat, as it is under
  // LM Studio's native loop.
  const toolStatusFactory: ToolStatusFactory = (callId, initial) =>
    ctl.createToolStatus(callId, initial);
  const uiTools = tools.map((tool) => ({
    ...tool,
    implementation: async (
      params: Record<string, unknown>,
      ctx: ToolCallCtx,
    ) => {
      const result = await runWithToolStatus(
        ctx,
        toolStatusFactory,
        async (bridged, phase) =>
          runConfirmedTool(ctl, tool, params, bridged, async (approved) => {
            phase({ type: "callingTool" });
            // Mark only after native permission, before a side effect can begin.
            if (stats) stats.executedToolCalls++;
            return (
              tool as Tool & {
                implementation: (
                  p: Record<string, unknown>,
                  c: unknown,
                ) => unknown | Promise<unknown>;
              }
            ).implementation(approved, bridged);
          }),
        Date.now,
        tool.type === "remoteTool"
          ? { type: "confirmingToolCall" }
          : { type: "callingTool" },
      );
      if (ctx.callId !== undefined) {
        const resultBlock = ctl.createContentBlock({ roleOverride: "tool" });
        resultBlock.appendToolResult({
          callId: ctx.callId,
          content: typeof result === "string" ? result : JSON.stringify(result) ?? "",
        });
      }
      return result;
    },
  })) as Tool[];

  let roundsUsed = 0;
  const collected: ChatMessage[] = [];

  // The SDK's own maxPredictionRounds runs its final round with tools
  // DISABLED, so a mid-task model prints its tool call as text (visible
  // "<tool_call>" XML, never executed) and the next pass repeats it. End the
  // pass ourselves instead: abort after the last allowed round's messages
  // were emitted, so no tool-less round is ever generated (src/passCap.ts).
  // Also end the pass as soon as what it generated (reasoning stays in the
  // in-pass history) would push the next request past the window, so
  // mid-task compaction runs before the engine rejects the prompt.
  const grownTokens = () =>
    collected.reduce(
      (sum, m) => sum + estimateMessageTokens(toCanon(m, ctl.client)),
      0,
    );
  const cap = createPassCap({
    maxRounds,
    parentSignal: ctl.abortSignal,
    wouldOverflow:
      fit !== undefined
        ? () => !nextRoundFits({ ...fit, grownTokens: grownTokens() })
        : undefined,
  });

  await model.act(view, uiTools, {
    signal: cap.signal,
    contextOverflowPolicy: "stopAtLimit",
    onMessage: (message) => {
      collected.push(message);
    },
    onRoundEnd: (roundIndex) => {
      cap.onRoundEnd(roundIndex);
    },
    // Local models sometimes emit tool calls with malformed JSON arguments.
    // The SDK default kills the whole prediction on an unparseable request;
    // instead, surface it and keep the reply alive — parseable-but-invalid
    // requests get an error result so the model can retry.
    handleInvalidToolRequest: (error, request) => {
      const firstLine = (error.message || String(error))
        .split(/\r?\n/)[0]
        .slice(0, 200);
      ctl.createStatus({
        status: "error",
        text: `Companion Core: некорректный запрос инструмента${request ? ` (${request.name})` : ""}: ${firstLine}`,
      });
      return invalidToolRequestResult(error.message);
    },
    onPredictionFragment: (fragment) => {
      if (fragment.reasoningType === "none") {
        if (thinkingBlock) thinkingBlock = undefined;
        visibleChars += fragment.content.length;
        if (stats) stats.visibleChars = visibleChars;
        mainBlock().appendText(fragment.content, {
          tokensCount: fragment.tokensCount,
        });
      } else {
        reasoningBuffer += fragment.content;
        if (!thinkingBlock) {
          thinkingBlock = ctl.createContentBlock({
            includeInContext: false,
            style: { type: "thinking" },
          });
        }
        thinkingBlock.appendText(fragment.content, {
          tokensCount: fragment.tokensCount,
        });
      }
    },
    onRoundStart: (roundIndex) => {
      roundsUsed = roundIndex + 1;
      if (roundIndex > 0) block = undefined; // next block created on demand
    },
    onToolCallRequestFinalized: (_roundIndex, callId, info) => {
      toolRequestCount++;
      if (stats) stats.toolRequestCount = toolRequestCount;
      const requestedTool = tools.find(tool => tool.name === info.toolCallRequest.name);
      mainBlock().appendToolRequest({
        callId,
        toolCallRequestId: info.toolCallRequest.id,
        name: info.toolCallRequest.name,
        parameters: info.toolCallRequest.arguments ?? {},
        pluginIdentifier: requestedTool?.type === "remoteTool"
          ? requestedTool.pluginIdentifier
          : undefined,
      });
    },
  }).catch((error: unknown) => {
    // Our own pass-end abort is the normal way a capped pass returns; a
    // user Stop or an engine error still propagates.
    if (!cap.isCapAbort()) throw error;
  });
  // Some SDK backends resolve normally after Stop. Do not publish a fallback
  // answer from their unfinished reasoning or continue into another pass.
  ctl.abortSignal.throwIfAborted();

  // A capped pass is mid-task by definition: its rounds were tool calls plus
  // reasoning, and the next pass continues. Nothing to promote or notice.
  const fallback =
    cap.reason() !== undefined
      ? null
      : decideFallback({
          visibleChars,
          reasoningText: reasoningBuffer,
          toolRequestCount,
        });
  if (fallback?.kind === "promote") {
    mainBlock().appendText(fallback.text);
  } else if (fallback?.kind === "notice") {
    const noticeBlock = ctl.createContentBlock({
      includeInContext: false,
      style: { type: "customLabel", label: "Companion Core" },
    });
    noticeBlock.appendText(fallback.text);
  }

  return { roundsUsed, collected, capped: cap.reason() };
}
