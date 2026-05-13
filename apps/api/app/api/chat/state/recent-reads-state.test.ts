// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RecentReadsEntry } from '#api/chat/state/recent-reads-state.js';
import {
  buildReadFingerprint,
  isRecentReadsResetSignal,
  mergeRecentReads,
  recentReadsCap,
} from '#api/chat/state/recent-reads-state.js';

const entry = (priorToolCallId: string, modifiedAt: string): RecentReadsEntry => ({
  priorToolCallId,
  modifiedAt,
});

describe('buildReadFingerprint', () => {
  it('uses defaults when offset/limit are absent', () => {
    expect(buildReadFingerprint({ targetFile: 'src/index.ts' })).toBe('src/index.ts:1:-1');
  });

  it('round-trips offset and limit into the fingerprint', () => {
    expect(buildReadFingerprint({ targetFile: 'a.ts', offset: 50, limit: 100 })).toBe('a.ts:50:100');
  });

  it('treats different ranges as distinct fingerprints', () => {
    const a = buildReadFingerprint({ targetFile: 'a.ts', offset: 1, limit: 10 });
    const b = buildReadFingerprint({ targetFile: 'a.ts', offset: 11, limit: 10 });
    expect(a).not.toBe(b);
  });
});

describe('mergeRecentReads', () => {
  it('returns the delta when prev is empty', () => {
    const result = mergeRecentReads({}, { 'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z') });
    expect(result).toEqual({ 'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z') });
  });

  it('returns previous unchanged when delta is empty', () => {
    const previous = { 'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z') };
    expect(mergeRecentReads(previous, {})).toEqual(previous);
  });

  it('promotes overlapping keys to MRU position', () => {
    const previous = {
      'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z'),
      'b.ts:1:-1': entry('tc-2', '2026-05-13T10:00:01.000Z'),
    };
    const delta = { 'a.ts:1:-1': entry('tc-3', '2026-05-13T10:00:02.000Z') };
    const result = mergeRecentReads(previous, delta);
    expect(Object.keys(result)).toEqual(['b.ts:1:-1', 'a.ts:1:-1']);
    expect(result['a.ts:1:-1']).toEqual(entry('tc-3', '2026-05-13T10:00:02.000Z'));
  });

  it('is deterministic across repeated calls (reducer purity)', () => {
    const previous = { 'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z') };
    const delta = { 'b.ts:1:-1': entry('tc-2', '2026-05-13T10:00:01.000Z') };
    const first = mergeRecentReads(previous, delta);
    const second = mergeRecentReads(previous, delta);
    expect(first).toEqual(second);
    expect(previous).toEqual({ 'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z') });
    expect(delta).toEqual({ 'b.ts:1:-1': entry('tc-2', '2026-05-13T10:00:01.000Z') });
  });

  it('drops the oldest entries when the cap is exceeded', () => {
    const previous: Record<string, RecentReadsEntry> = {};
    for (let i = 0; i < recentReadsCap; i++) {
      previous[`f${i}.ts:1:-1`] = entry(`tc-${i}`, `2026-05-13T10:00:${String(i).padStart(2, '0')}.000Z`);
    }
    const delta = { 'fresh.ts:1:-1': entry('tc-fresh', '2026-05-13T11:00:00.000Z') };
    const result = mergeRecentReads(previous, delta);
    expect(Object.keys(result).length).toBe(recentReadsCap);
    expect('f0.ts:1:-1' in result).toBe(false);
    expect(result['fresh.ts:1:-1']).toEqual(entry('tc-fresh', '2026-05-13T11:00:00.000Z'));
    expect(result['f1.ts:1:-1']).toEqual(entry('tc-1', '2026-05-13T10:00:01.000Z'));
  });

  it('clears every entry on a reset signal', () => {
    const previous = {
      'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z'),
      'b.ts:1:-1': entry('tc-2', '2026-05-13T10:00:01.000Z'),
    };
    const result = mergeRecentReads(previous, { __resetRecentReads: true });
    expect(result).toEqual({});
  });
});

describe('isRecentReadsResetSignal', () => {
  it('matches the canonical reset signal', () => {
    expect(isRecentReadsResetSignal({ __resetRecentReads: true })).toBe(true);
  });

  it('rejects regular merge deltas', () => {
    expect(isRecentReadsResetSignal({ 'a.ts:1:-1': entry('tc-1', '2026-05-13T10:00:00.000Z') })).toBe(false);
    expect(isRecentReadsResetSignal({})).toBe(false);
  });
});
