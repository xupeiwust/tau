/**
 * Thread-safe file content pool backed by a {@link SharedArrayBuffer}.
 *
 * A single writer (file manager worker) stores file content after IDB reads.
 * Multiple readers (kernel workers, main thread) resolve content without
 * any IPC — reads are lock-free {@link Atomics.load} lookups followed by
 * a zero-copy `Uint8Array` view into shared memory.
 *
 * @public
 */

/* eslint-disable @typescript-eslint/naming-convention -- FNV-1a constants and default pool limits use conventional UPPER_SNAKE names */

import { SharedMemoryArena, ARENA_ENTRY_STATE } from '#shared-memory-arena.js';

const DEFAULT_MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4096;

const FNV1A_OFFSET_HI = 0xcb_f2_9c_e4;
const FNV1A_OFFSET_LO = 0x84_22_23_25;
const FNV1A_PRIME = 0x01_00_01_93;

/**
 * Options for constructing a {@link SharedContentPool}.
 * @public
 */
export type SharedContentPoolOptions = {
  /** Maximum number of cached entries. */
  maxEntries?: number;
  /** Files larger than this are skipped (default 10 MB). */
  maxSingleFileBytes?: number;
};

/**
 * High-level shared-memory file content cache.
 *
 * Wraps a {@link SharedMemoryArena} to provide path-keyed store/resolve
 * semantics with FNV-1a hashing for O(n) lookup (n = entry count).
 *
 * Thread model:
 * - **Writer** (file manager worker): {@link store}, {@link invalidate}, {@link clear}
 * - **Reader** (any thread): {@link resolve}, {@link has}
 *
 * @param buffer - The {@link SharedArrayBuffer} backing the pool.
 * @param options - Pool configuration.
 *
 * @public
 */
export class SharedContentPool {
  private readonly _arena: SharedMemoryArena;
  private readonly _buffer: SharedArrayBuffer;
  private readonly _maxSingleFileBytes: number;
  /** Writer-side mapping from path to entry index for O(1) invalidation. */
  private readonly _pathToIndex = new Map<string, number>();

  /**
   * Create or attach to a shared content pool.
   *
   * @param buffer - Pre-allocated {@link SharedArrayBuffer}.
   * @param options - Pool limits.
   */
  public constructor(buffer: SharedArrayBuffer, options?: SharedContentPoolOptions) {
    this._buffer = buffer;
    this._arena = new SharedMemoryArena(buffer, { maxEntries: options?.maxEntries ?? DEFAULT_MAX_ENTRIES });
    this._maxSingleFileBytes = options?.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES;
  }

  /**
   * Store file content in the shared pool.
   *
   * @param path - Absolute file path used as cache key.
   * @param data - Raw file content bytes.
   * @returns `true` if stored successfully, `false` if skipped (oversized or arena full).
   */
  public store(path: string, data: Uint8Array<ArrayBuffer>): boolean {
    if (data.byteLength > this._maxSingleFileBytes) {
      return false;
    }

    const entryIndex = this._arena.allocateEntry(data.byteLength);
    if (entryIndex === -1) {
      return false;
    }

    const entry = this._arena.readEntry(entryIndex)!;
    if (data.byteLength > 0) {
      const target = new Uint8Array(this._buffer, entry.dataOffset, entry.dataLength);
      target.set(data);
    }

    const [hashHi, hashLo] = fnv1a64(path);
    this._arena.publishEntry(entryIndex, hashHi, hashLo);
    this._pathToIndex.set(path, entryIndex);

    return true;
  }

  /**
   * Resolve file content from the shared pool.
   * Returns a zero-copy `Uint8Array` view into the {@link SharedArrayBuffer}.
   *
   * @param path - Absolute file path to look up.
   * @returns File content view, or `undefined` on cache miss.
   */
  public resolve(path: string): Uint8Array<ArrayBuffer> | undefined {
    const [hashHi, hashLo] = fnv1a64(path);
    const entryIndex = this._arena.findEntry(hashHi, hashLo);
    if (entryIndex === -1) {
      return undefined;
    }

    const entry = this._arena.readEntry(entryIndex);
    if (!entry || entry.state !== ARENA_ENTRY_STATE.READY) {
      return undefined;
    }

    const view = new Uint8Array(this._buffer, entry.dataOffset, entry.dataLength);
    return new Uint8Array(view);
  }

  /**
   * Check whether the pool contains a READY entry for the given path.
   *
   * @param path - Absolute file path.
   * @returns `true` if a valid entry exists.
   */
  public has(path: string): boolean {
    return this.resolve(path) !== undefined;
  }

  /**
   * Mark a cached entry as stale, causing subsequent reads to miss.
   *
   * @param path - Absolute file path to invalidate.
   */
  public invalidate(path: string): void {
    const index = this._pathToIndex.get(path);
    if (index !== undefined) {
      this._arena.markStale(index);
      this._pathToIndex.delete(path);
    }
  }

  /**
   * Invalidate all entries in the pool.
   */
  public clear(): void {
    for (const index of this._pathToIndex.values()) {
      this._arena.markStale(index);
    }
    this._pathToIndex.clear();
  }

  /**
   * Number of entries allocated in the underlying arena.
   * @returns Entry count from the shared arena.
   */
  public get entryCount(): number {
    return this._arena.entryCount;
  }

  /**
   * Bytes consumed in the data region.
   * @returns Bytes used for cached file payloads.
   */
  public get usedBytes(): number {
    return this._arena.usedDataBytes;
  }

  /**
   * Total capacity of the backing buffer.
   * @returns Size of the backing {@link SharedArrayBuffer} in bytes.
   */
  public get capacityBytes(): number {
    return this._arena.capacityBytes;
  }

  /**
   * The underlying {@link SharedArrayBuffer}.
   * @returns The pool's backing buffer.
   */
  public get buffer(): SharedArrayBuffer {
    return this._buffer;
  }
}

/**
 * FNV-1a 64-bit hash split into two u32 values for {@link Atomics} compatibility.
 * Uses a simplified approach operating on the lower 32 bits with a separate
 * accumulator for the upper bits.
 *
 * @param input - UTF-16 string path to hash.
 * @returns Upper and lower 32-bit halves of the hash as unsigned numbers.
 */
function fnv1a64(input: string): [hi: number, lo: number] {
  // oxlint-disable no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point -- FNV-1a hash requires bitwise operations
  let hi = FNV1A_OFFSET_HI >>> 0;
  let lo = FNV1A_OFFSET_LO >>> 0;

  for (let i = 0; i < input.length; i++) {
    const byte = input.charCodeAt(i) & 0xff;
    lo = (lo ^ byte) >>> 0;
    const loProduct = Math.imul(lo, FNV1A_PRIME) >>> 0;
    const hiProduct = (Math.imul(hi, FNV1A_PRIME) + Math.imul(lo, 0)) >>> 0;
    lo = loProduct;
    hi = hiProduct ^ (byte * 31);
    hi >>>= 0;
  }

  // oxlint-enable no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point
  return [hi, lo];
}
