/**
 * @file `read_file` dedup state — durable, LangGraph-native.
 *
 * **Two-layer model**
 *
 * - **Source of truth**: the `_recentReads` channel persisted by
 *   `PostgresSaver` (production) / `MemorySaver` (tests). The checkpoint
 *   travels with the chat across Fly instances, regions, redeploys, and
 *   long-idle revisits, so the prompt-cache prefix stays stable for the
 *   life of the chat — never bounded by per-process memory.
 * - **Read/write surface**: tools consume the slice via `runtime.state` and
 *   emit deltas via `Command({ update: { _recentReads: ... } })`. The
 *   per-model-call hot path stays free of any state-bridging overhead
 *   (the prior in-memory `ContentReplacementStateRegistry` is gone — see
 *   `docs/research/content-replacement-state-durability-audit.md` for the
 *   audit that drove this rewrite).
 *
 * **Reducer purity contract**
 *
 * {@link mergeRecentReads} is deterministic and side-effect-free. LangGraph
 * may invoke a reducer multiple times during retry / replay; identical
 * `(prev, delta)` pairs must always produce the same output. Mutation of
 * `prev` is forbidden — every call returns a fresh object.
 *
 * **Channel naming**
 *
 * The leading underscore on `_recentReads` follows LangChain's convention for
 * agent-internal state slices (see `FilterPrivateProps` in
 * `langchain/agents/middleware/types`) so the middleware-state inference
 * filters it out of consumer-facing types.
 */
import { z } from 'zod';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { ReducedValue, StateSchema } from '@langchain/langgraph';

/**
 * Maximum number of `(targetFile, offset, limit)` fingerprints retained in
 * `_recentReads` per chat checkpoint. The cap keeps the JSONB column bounded
 * so durability scales linearly with chat length, never quadratically.
 *
 * 200 entries comfortably covers a 250-tool-call agent run while staying
 * under ~25 KB serialised at the 95th percentile read fingerprint length.
 *
 * @public
 */
export const recentReadsCap = 200;

/**
 * Stable, JSON-serialisable identifier for a `read_file` invocation. Composed
 * of `${targetFile}:${offset ?? 1}:${limit ?? -1}` so identical re-reads share
 * a key while different ranges stay distinct.
 *
 * @public
 */
export type ReadFingerprint = string;

/**
 * Per-fingerprint record carried in the `_recentReads` checkpoint channel.
 *
 * - `priorToolCallId` — the `tool_call_id` of the FIRST `read_file` that
 *   returned the current bytes for this fingerprint. The marker substitution
 *   sent on a subsequent identical re-read references this id so the LLM can
 *   trace the cached result back to the originating tool message.
 * - `modifiedAt` — RFC 3339 timestamp from the underlying RPC. The dedup
 *   branch only short-circuits when the new RPC reports the same `modifiedAt`
 *   AND the same fingerprint; mtime drift always forces a fresh read.
 *
 * @public
 */
export type RecentReadsEntry = {
  priorToolCallId: string;
  modifiedAt: string;
};

/**
 * Builds the canonical {@link ReadFingerprint} from a `read_file` invocation.
 * Centralising the shape keeps tools/middleware in lockstep and ensures the
 * fingerprint matches the one persisted in the `_recentReads` checkpoint.
 *
 * @public
 */
export const buildReadFingerprint = (input: { targetFile: string; offset?: number; limit?: number }): ReadFingerprint =>
  `${input.targetFile}:${input.offset ?? 1}:${input.limit ?? -1}`;

/**
 * Sentinel update value handed to the {@link mergeRecentReads} reducer when a
 * caller wants to atomically clear every dedup pointer (used by the compaction
 * middleware after the message tail is summarised — every `priorToolCallId`
 * pointer would otherwise dangle past compaction).
 *
 * Discriminated by the `__resetRecentReads: true` literal so it never
 * collides with a real {@link RecentReadsEntry} key/value.
 *
 * @public
 */
export type RecentReadsResetSignal = {
  __resetRecentReads: true;
};

/**
 * Update payload accepted by the `_recentReads` channel — either a merge
 * delta (the normal `read_file` write path) or a {@link RecentReadsResetSignal}
 * (the post-compaction reset path).
 *
 * @public
 */
export type RecentReadsUpdate = Record<string, RecentReadsEntry> | RecentReadsResetSignal;

/**
 * Type guard for the {@link RecentReadsResetSignal} variant.
 *
 * @public
 */
export const isRecentReadsResetSignal = (delta: RecentReadsUpdate): delta is RecentReadsResetSignal =>
  '__resetRecentReads' in delta && delta.__resetRecentReads === true;

/**
 * Pure, insertion-order LRU reducer for the `_recentReads` channel.
 *
 * - A {@link RecentReadsResetSignal} input clears every entry (used by
 *   compaction so dangling `priorToolCallId` pointers cannot survive a
 *   message-tail summarisation).
 * - Re-inserting an existing key promotes it to the most-recent slot
 *   (delete-then-set keeps insertion-order semantics on plain objects).
 * - When the merged result exceeds {@link recentReadsCap}, the oldest
 *   fingerprints (lowest insertion index) are dropped first.
 *
 * The function is deterministic and side-effect-free — required by
 * LangGraph's `ReducedValue` contract so checkpoint replay produces the same
 * channel value every time.
 *
 * @public
 */
export const mergeRecentReads = (
  previous: Record<string, RecentReadsEntry>,
  delta: RecentReadsUpdate,
): Record<string, RecentReadsEntry> => {
  if (isRecentReadsResetSignal(delta)) {
    return {};
  }

  const merged: Record<string, RecentReadsEntry> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!(key in delta)) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(delta)) {
    merged[key] = value;
  }

  const keys = Object.keys(merged);
  if (keys.length <= recentReadsCap) {
    return merged;
  }

  const survivingKeys = keys.slice(keys.length - recentReadsCap);
  const capped: Record<string, RecentReadsEntry> = {};
  for (const key of survivingKeys) {
    capped[key] = merged[key]!;
  }
  return capped;
};

const recentReadsEntrySchema = z.object({
  priorToolCallId: z.string(),
  modifiedAt: z.string(),
});

const recentReadsResetSchema = z.object({
  __resetRecentReads: z.literal(true),
});

const recentReadsUpdateSchema = z.union([z.record(z.string(), recentReadsEntrySchema), recentReadsResetSchema]);

const recentReadsRecordSchema = z.record(z.string(), recentReadsEntrySchema).default(() => ({}));

/**
 * StateSchema channel for the `_recentReads` LRU map. The underscore prefix
 * marks the field as agent-internal so middleware-state inference filters it
 * out of consumer-facing types (matches LangChain's convention for hidden
 * state — see `FilterPrivateProps` in `langchain/agents/middleware/types`).
 *
 * Stored value: `Record<ReadFingerprint, RecentReadsEntry>`.
 * Reducer: {@link mergeRecentReads} (insertion-order LRU, capped at
 * {@link recentReadsCap}).
 *
 * @public
 */
export const recentReadsStateSchema = new StateSchema({
  _recentReads: new ReducedValue(recentReadsRecordSchema, {
    inputSchema: recentReadsUpdateSchema,
    reducer: mergeRecentReads,
  }),
});

/**
 * Inferred shape of the `_recentReads` state slice as seen by tools that
 * consume `runtime.state` via {@link import('@langchain/core/tools').ToolRuntime}.
 *
 * @public
 */
export type RecentReadsState = typeof recentReadsStateSchema.State;

/**
 * Hook-free middleware whose only job is to register the {@link recentReadsStateSchema}
 * channel on the agent. Tools (`tool-read-file.ts`) read/write the channel
 * directly via `runtime.state._recentReads` and `Command({ update: { _recentReads: ... } })`.
 *
 * No `beforeModel` / `afterModel` / `wrapModelCall` / `wrapToolCall` hooks
 * are defined — the entire dedup pipeline is owned by the tool itself, which
 * keeps the per-model-call hot path free of any state-bridging overhead.
 *
 * @public
 */
export const createReadDedupStateMiddleware = (): AgentMiddleware =>
  createMiddleware({
    name: 'ReadDedupState',
    stateSchema: recentReadsStateSchema,
  });
