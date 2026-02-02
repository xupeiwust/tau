/**
 * Filesystem Backend Constants
 *
 * Defines available filesystem backends and their metadata.
 */

/**
 * Available filesystem backend names.
 */
export const filesystemBackends = ['indexeddb', 'opfs', 'memory'] as const;

/**
 * Filesystem backend metadata.
 * Descriptions are used in UI for user-facing backend selection.
 */
export const filesystemBackendMeta = {
  indexeddb: {
    label: 'IndexedDB',
    description: 'Persistent browser storage using IndexedDB. Most compatible across browsers.',
  },
  opfs: {
    label: 'OPFS',
    description: 'Origin Private File System. Faster performance, requires modern browser.',
  },
  memory: {
    label: 'Memory',
    description: 'Temporary in-memory storage. Data is cleared on page reload.',
  },
} as const satisfies Record<(typeof filesystemBackends)[number], { label: string; description: string }>;
