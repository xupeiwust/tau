/**
 * Isomorphic Message Adapter for Kernel Workers
 *
 * Provides a unified message interface for browser Web Workers and Node.js worker_threads,
 * Abstracts browser/Node.js worker context differences for the MessagePort protocol.
 */

import type { RuntimeCommand, RuntimeResponse } from '#types/runtime-protocol.types.js';
import { isWebWorker } from '#framework/environment.js';

/**
 * Unified message port interface for runtime worker communication.
 * Abstracts browser Worker and Node.js worker_threads differences.
 */
export type RuntimeMessagePort = {
  postMessage(message: RuntimeCommand | RuntimeResponse, transferables?: Transferable[]): void;
  onMessage(handler: (data: RuntimeCommand | RuntimeResponse) => void): void;
  close(): void;
};

// oxlint-disable-next-line @typescript-eslint/consistent-type-imports -- Dynamic require for Node.js detection
function getNodeParentPort(): import('node:worker_threads').MessagePort | undefined {
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports, unicorn/prefer-module, @typescript-eslint/consistent-type-imports -- Dynamic require for Node.js detection
    const workerThreads = require('node:worker_threads') as typeof import('node:worker_threads');
    return workerThreads.parentPort ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check whether the current thread is a worker context (browser or Node.js).
 * Use this to guard dispatcher setup in worker files.
 *
 * @returns `true` when running inside a Web Worker or Node.js worker_threads
 */
export function isWorkerContext(): boolean {
  return isWebWorker() || getNodeParentPort() !== undefined;
}

/**
 * Get a unified message port for the current worker context.
 * Works in both browser Web Workers and Node.js worker_threads.
 *
 * @returns RuntimeMessagePort with unified send/receive interface
 * @throws Error if called outside a worker context
 */
export function getWorkerMessagePort(): RuntimeMessagePort {
  if (isWebWorker()) {
    return {
      postMessage(message, transferables) {
        self.postMessage(message, { transfer: transferables ?? [] });
      },
      onMessage(handler) {
        globalThis.addEventListener('message', (event: MessageEvent<RuntimeCommand | RuntimeResponse>) => {
          handler(event.data);
        });
      },
      close() {
        globalThis.close();
      },
    };
  }

  const parentPort = getNodeParentPort();
  if (parentPort) {
    return {
      postMessage(message, transferables) {
        // oxlint-disable-next-line @typescript-eslint/consistent-type-imports -- Dynamic require for Node.js detection
        parentPort.postMessage(message, transferables as Array<import('node:worker_threads').Transferable> | undefined);
      },
      onMessage(handler) {
        parentPort.on('message', (data: RuntimeCommand | RuntimeResponse) => {
          handler(data);
        });
      },
      close() {
        parentPort.close();
      },
    };
  }

  throw new Error('getWorkerMessagePort() must be called from a worker context');
}
