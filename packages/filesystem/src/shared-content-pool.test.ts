import { describe, it, expect } from 'vitest';
import { SharedContentPool } from '#shared-content-pool.js';
import { ARENA_HEADER_BYTES, ARENA_ENTRY_BYTES } from '#shared-memory-arena.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createPool(totalBytes = 256 * 1024, maxEntries = 256): SharedContentPool {
  const buffer = new SharedArrayBuffer(totalBytes);
  return new SharedContentPool(buffer, { maxEntries });
}

describe('SharedContentPool', () => {
  it('should round-trip file content via store and resolve', () => {
    const pool = createPool();
    const data = encoder.encode('hello world');
    const stored = pool.store('/src/main.ts', new Uint8Array(data.buffer));
    expect(stored).toBe(true);

    const resolved = pool.resolve('/src/main.ts');
    expect(resolved).toBeDefined();
    expect(decoder.decode(resolved)).toBe('hello world');
  });

  it('should return undefined for unknown paths', () => {
    const pool = createPool();
    const resolved = pool.resolve('/does/not/exist.ts');
    expect(resolved).toBeUndefined();
  });

  it('should invalidate an entry so resolve returns undefined', () => {
    const pool = createPool();
    pool.store('/file.ts', encoder.encode('content'));

    expect(pool.resolve('/file.ts')).toBeDefined();

    pool.invalidate('/file.ts');

    expect(pool.resolve('/file.ts')).toBeUndefined();
  });

  it('should return false when storing a file exceeding maxSingleFileBytes', () => {
    const pool = createPool(256 * 1024, 256);
    const oversized = new Uint8Array(11 * 1024 * 1024);
    const stored = pool.store('/huge.bin', oversized);
    expect(stored).toBe(false);
  });

  it('should store and resolve multiple independent entries', () => {
    const pool = createPool();

    pool.store('/a.ts', encoder.encode('alpha'));
    pool.store('/b.ts', encoder.encode('bravo'));
    pool.store('/c.ts', encoder.encode('charlie'));

    expect(decoder.decode(pool.resolve('/a.ts'))).toBe('alpha');
    expect(decoder.decode(pool.resolve('/b.ts'))).toBe('bravo');
    expect(decoder.decode(pool.resolve('/c.ts'))).toBe('charlie');
  });

  it('should clear all entries', () => {
    const pool = createPool();

    pool.store('/x.ts', encoder.encode('x'));
    pool.store('/y.ts', encoder.encode('y'));
    expect(pool.entryCount).toBe(2);

    pool.clear();

    expect(pool.resolve('/x.ts')).toBeUndefined();
    expect(pool.resolve('/y.ts')).toBeUndefined();
  });

  it('should share data between two pool instances on the same buffer', () => {
    const buffer = new SharedArrayBuffer(256 * 1024);
    const writer = new SharedContentPool(buffer, { maxEntries: 128 });
    const reader = new SharedContentPool(buffer, { maxEntries: 128 });

    writer.store('/shared.ts', encoder.encode('shared data'));

    const resolved = reader.resolve('/shared.ts');
    expect(resolved).toBeDefined();
    expect(decoder.decode(resolved)).toBe('shared data');
  });

  it('should report correct entryCount', () => {
    const pool = createPool();
    expect(pool.entryCount).toBe(0);

    pool.store('/one.ts', encoder.encode('1'));
    expect(pool.entryCount).toBe(1);

    pool.store('/two.ts', encoder.encode('2'));
    expect(pool.entryCount).toBe(2);
  });

  it('should report usedBytes growing with stored content', () => {
    const pool = createPool();
    const initial = pool.usedBytes;

    pool.store('/data.ts', encoder.encode('some content here'));
    expect(pool.usedBytes).toBeGreaterThan(initial);
  });

  it('should report capacityBytes from the buffer', () => {
    const totalBytes = 128 * 1024;
    const pool = createPool(totalBytes);
    expect(pool.capacityBytes).toBe(totalBytes);
  });

  it('should report has correctly', () => {
    const pool = createPool();
    expect(pool.has('/missing.ts')).toBe(false);

    pool.store('/present.ts', encoder.encode('data'));
    expect(pool.has('/present.ts')).toBe(true);

    pool.invalidate('/present.ts');
    expect(pool.has('/present.ts')).toBe(false);
  });

  it('should return false when arena is full', () => {
    const totalBytes = ARENA_HEADER_BYTES + ARENA_ENTRY_BYTES * 2 + 128;
    const pool = new SharedContentPool(new SharedArrayBuffer(totalBytes), { maxEntries: 2 });

    expect(pool.store('/a.ts', encoder.encode('aa'))).toBe(true);
    expect(pool.store('/b.ts', encoder.encode('bb'))).toBe(true);
    expect(pool.store('/c.ts', encoder.encode('cc'))).toBe(false);
  });

  it('should handle empty file content', () => {
    const pool = createPool();
    const stored = pool.store('/empty.ts', new Uint8Array(0));
    expect(stored).toBe(true);

    const resolved = pool.resolve('/empty.ts');
    expect(resolved).toBeDefined();
    expect(resolved?.byteLength).toBe(0);
  });

  it('should produce consistent hashes for the same path', () => {
    const pool = createPool();
    pool.store('/consistent.ts', encoder.encode('data1'));

    const result = pool.resolve('/consistent.ts');
    expect(result).toBeDefined();
    expect(decoder.decode(result)).toBe('data1');
  });
});
