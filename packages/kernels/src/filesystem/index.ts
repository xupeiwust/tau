/**
 * @taucad/kernels/filesystem -- advanced filesystem bridge primitives.
 *
 * Low-level primitives for custom filesystem bridge setups, plus high-level
 * wrappers for zero-config worker-to-worker communication.
 *
 * Most consumers should use `fromNodeFS`, `fromMemoryFS`, or `fromZenFS`
 * from the main `@taucad/kernels` entry instead.
 */

// High-level wrappers
export { exposeFileSystem, createFileSystemBridge } from '#filesystem/filesystem-bridge.js';
export type { FileSystemBridgeOptions } from '#filesystem/filesystem-bridge.js';

// Low-level bridge primitives
export {
  createFileSystemServer,
  createFileSystemPort,
  createFileSystemProxy,
} from '#framework/kernel-filesystem-bridge.js';

// Proxy constructor (advanced)
export { fromProxy } from '#filesystem/from-proxy.js';
