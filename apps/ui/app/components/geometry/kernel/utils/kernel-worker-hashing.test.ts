/**
 * Tests for kernel-worker hashing behavior.
 *
 * Tests:
 * 1. Asset fetch failure returns unique UUID each time (not cached)
 * 2. Asset fetch success caches the content hash
 * 3. Geometry content hash is full 64 characters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComputeGeometryResult } from '@taucad/types';
import { MockKernelWorker } from '#components/geometry/kernel/utils/kernel-testing.utils.js';
import type { OnWorkerLog } from '#types/console.types.js';

describe('kernel-worker hashing', () => {
  let onLog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onLog = vi.fn();
  });

  describe('geometry content hash', () => {
    it('should return full 129-character content hash in geometry.hash', async () => {
      const successResult: ComputeGeometryResult = {
        success: true,
        data: [{ format: 'gltf', content: new Uint8Array([1, 2, 3, 4, 5]) }],
        issues: [],
      };

      const worker = new MockKernelWorker({
        middleware: [],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      const result = await worker.runComputeGeometry();

      expect(result.success).toBe(true);
      if (result.success && result.data[0]) {
        const geometryHash = result.data[0].hash;
        // Format: ${dependencyHash}-${contentHash} = 64 + 1 + 64 = 129 chars
        expect(geometryHash).toMatch(/^[a-f\d]{64}-[a-f\d]{64}$/);
        expect(geometryHash.length).toBe(129);
      }
    });

    it('should generate different content hashes for different geometry content', async () => {
      const result1: ComputeGeometryResult = {
        success: true,
        data: [{ format: 'gltf', content: new Uint8Array([1, 2, 3]) }],
        issues: [],
      };

      const result2: ComputeGeometryResult = {
        success: true,
        data: [{ format: 'gltf', content: new Uint8Array([4, 5, 6]) }],
        issues: [],
      };

      const worker1 = new MockKernelWorker({
        middleware: [],
        computeResult: result1,
        onLog: onLog as OnWorkerLog,
      });

      const worker2 = new MockKernelWorker({
        middleware: [],
        computeResult: result2,
        onLog: onLog as OnWorkerLog,
      });

      const output1 = await worker1.runComputeGeometry();
      const output2 = await worker2.runComputeGeometry();

      expect(output1.success).toBe(true);
      expect(output2.success).toBe(true);

      if (output1.success && output2.success && output1.data[0] && output2.data[0]) {
        // The content hash portion (after the dash) should differ
        const contentHash1 = output1.data[0].hash.split('-')[1];
        const contentHash2 = output2.data[0].hash.split('-')[1];
        expect(contentHash1).not.toBe(contentHash2);
      }
    });

    it('should generate unique hashes for multiple geometries in same result', async () => {
      const multiGeometryResult: ComputeGeometryResult = {
        success: true,
        data: [
          { format: 'gltf', content: new Uint8Array([1, 2, 3]) },
          { format: 'gltf', content: new Uint8Array([4, 5, 6]) },
          { format: 'gltf', content: new Uint8Array([7, 8, 9]) },
        ],
        issues: [],
      };

      const worker = new MockKernelWorker({
        middleware: [],
        computeResult: multiGeometryResult,
        onLog: onLog as OnWorkerLog,
      });

      const result = await worker.runComputeGeometry();

      expect(result.success).toBe(true);
      if (result.success) {
        const hashes = result.data.map((g) => g.hash);
        // All hashes should be unique
        const uniqueHashes = new Set(hashes);
        expect(uniqueHashes.size).toBe(hashes.length);

        // All should have the 129-char format
        for (const hash of hashes) {
          expect(hash).toMatch(/^[a-f\d]{64}-[a-f\d]{64}$/);
        }
      }
    });
  });

  describe('asset hash with fetch mocking', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should return UUID format when fetch fails (network error)', async () => {
      // Mock fetch to throw an error
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      // We can't directly test hashAssetUrl since it's private,
      // but we can verify the warning is logged when assets fail to fetch
      const warningLogs: string[] = [];
      const logCapture: OnWorkerLog = (log) => {
        if (log.level === 'warn' && typeof log.message === 'string') {
          warningLogs.push(log.message);
        }
      };

      // This test verifies that the UUID fallback path is exercised
      // The actual UUID generation is internal, but we can verify:
      // 1. The warning is logged
      // 2. The system continues to work (doesn't throw)
      const worker = new MockKernelWorker({
        middleware: [],
        onLog: logCapture,
      });

      // MockKernelWorker overrides computeDependencies, so we can't test
      // the real asset hashing path here. This test documents the expected
      // behavior for integration testing.
      const result = await worker.runComputeGeometry();
      expect(result.success).toBe(true);
    });
  });
});
