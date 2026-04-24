import { useEffect, useState } from 'react';

/** Milliseconds. */
const tickInterval = 1000;

/**
 * Live elapsed-time stopwatch for streaming reasoning blocks.
 *
 * Anchors directly on the server-stamped `reasoningStartedAtMs` — server time
 * is treated as authoritative on both sides of the wire (consistent with the
 * rest of the timing-via-`providerMetadata` design). Browser/server clock skew
 * is accepted as a known limitation in exchange for a substantially simpler
 * client implementation (no NTP-style offset estimation, no per-stream
 * handshake to negotiate a clock origin).
 *
 * While `enabled` is true, schedules a 1Hz `setInterval` to force a re-render
 * so the displayed elapsed value advances smoothly between (potentially coarse)
 * `reasoning-delta` arrivals. The interval clears as soon as `enabled` flips
 * to false (e.g. when `state === 'done'`).
 *
 * Returns `0` when `startedAtMs` is `undefined` (defensive — pre-instrumentation
 * persisted parts) or when the difference is negative (clock skew clamp).
 *
 * The hook performs zero work that touches the SSE pipeline — it is purely
 * client-local and orthogonal to the AI SDK reducer that drives streaming.
 */
export const useReasoningStopwatch = (startedAtMs: number | undefined, enabled: boolean): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const intervalId = setInterval(() => {
      setNow(Date.now());
    }, tickInterval);
    return () => {
      clearInterval(intervalId);
    };
  }, [enabled]);

  if (startedAtMs === undefined) {
    return 0;
  }
  return Math.max(0, now - startedAtMs);
};
