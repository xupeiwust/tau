/**
 * ZenFS Configuration Module
 *
 * Provides filesystem configuration for different backends:
 * - IndexedDB: Used in production for persistent browser storage
 * - InMemory: Used in tests for fast, isolated filesystem operations
 */
import { configure, InMemory, fs as zenfs } from '@zenfs/core';
import { IndexedDB } from '@zenfs/dom';
import { metaConfig } from '#constants/meta.constants.js';

/**
 * Available filesystem backend types.
 */
export type FilesystemBackend = 'indexeddb' | 'memory';

/**
 * Track if filesystem has been configured to avoid re-initialization.
 */
let currentBackend: FilesystemBackend | undefined;
let configurationPromise: Promise<void> | undefined;

/**
 * Configure ZenFS with the specified backend.
 * Safe to call multiple times - will only configure once unless reset.
 *
 * @param backend - The backend type to use ('indexeddb' for production, 'memory' for tests)
 */
export async function configureFilesystem(backend: FilesystemBackend = 'indexeddb'): Promise<void> {
  // If already configured with the same backend, return the existing promise
  if (currentBackend === backend && configurationPromise) {
    return configurationPromise;
  }

  // If there's an existing configuration in progress, await it before starting a new one
  // This prevents concurrent reconfiguration races
  if (configurationPromise) {
    try {
      await configurationPromise;
    } catch {
      // Previous configuration failed, proceed with new configuration
    }

    // After awaiting, check again if we're now configured with the desired backend
    if (currentBackend === backend) {
      return;
    }
  }

  // Create a new configuration promise with error handling to allow retries
  configurationPromise = (async (): Promise<void> => {
    try {
      if (backend === 'memory') {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
        await configure({ mounts: { '/': InMemory } });
      } else {
        await configure({
          mounts: {
            // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
            '/': { backend: IndexedDB, storeName: `${metaConfig.databasePrefix}fs` },
          },
        });
      }

      // Only set currentBackend after successful configure() completes
      currentBackend = backend;
    } catch (error) {
      // Clear the promise on failure so retries are possible
      configurationPromise = undefined;
      throw error;
    }
  })();

  return configurationPromise;
}

/**
 * Ensure filesystem is configured before performing operations.
 * This is idempotent - if already configured, it will wait for completion
 * without reconfiguring (first caller's backend wins).
 *
 * @param backend - The backend type to configure if not already configured
 */
export async function ensureFilesystemConfigured(backend: FilesystemBackend): Promise<void> {
  if (configurationPromise) {
    // Already configured or configuring - just wait, ignore passed backend
    await configurationPromise;
    return;
  }

  // Not configured yet - configure with the specified backend
  await configureFilesystem(backend);
}

/**
 * Reset the filesystem configuration.
 * Used in tests to start with a fresh InMemory filesystem.
 */
export async function resetFilesystem(): Promise<void> {
  currentBackend = undefined;
  configurationPromise = undefined;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
  await configure({ mounts: { '/': InMemory } });
  currentBackend = 'memory';
  configurationPromise = Promise.resolve();
}

/**
 * Get whether the filesystem has been configured.
 */
export function isFilesystemConfigured(): boolean {
  return currentBackend !== undefined;
}

/**
 * Get the current backend type.
 */
export function getCurrentBackend(): FilesystemBackend | undefined {
  return currentBackend;
}

/**
 * ZenFS filesystem instance.
 * Provides Node.js-compatible filesystem API across all backends.
 */
// eslint-disable-next-line unicorn/prefer-export-from -- Aliased export for cleaner imports throughout app
export const fs = zenfs;
