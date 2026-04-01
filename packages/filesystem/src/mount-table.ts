/**
 * Virtual mount-point table that routes absolute filesystem paths to their
 * backing {@link FileSystemProvider} based on longest-prefix matching.
 *
 * Enables transparent multi-backend composition: e.g. project files on IDB
 * at `/`, CDN modules on OPFS at `/node_modules/`.
 *
 * @public
 * @see docs/research/filesystem-mount-overlay-architecture.md
 */

import type { FileSystemProvider } from '#types.js';

/**
 * A single mount entry mapping a path prefix to a provider.
 * @public
 */
export type MountEntry = {
  readonly prefix: string;
  readonly provider: FileSystemProvider;
};

/**
 * Result of resolving an absolute path against the mount table.
 * @public
 */
export type MountResolution = {
  readonly provider: FileSystemProvider;
  /** Path relative to the mount point (always starts with `/`). */
  readonly path: string;
};

/**
 * Mount table for routing filesystem paths to providers via longest-prefix matching.
 *
 * @public
 * @example <caption>Multi-backend routing</caption>
 * ```typescript
 * import { MountTable } from '@taucad/filesystem';
 * import type { FileSystemProvider } from '@taucad/filesystem';
 *
 * declare const projectProvider: FileSystemProvider;
 * declare const opfsProvider: FileSystemProvider;
 *
 * const table = new MountTable();
 * table.mount('/', projectProvider);
 * table.mount('/node_modules', opfsProvider);
 *
 * const { provider, path } = table.resolve('/node_modules/lodash/index.js');
 * // provider === opfsProvider, path === '/lodash/index.js'
 * ```
 */
export class MountTable {
  private _mounts: MountEntry[] = [];

  /**
   * Add a mount point. Re-sorts the table by prefix length (longest first).
   *
   * @param prefix - Absolute path prefix (e.g. `/`, `/node_modules`).
   * @param provider - Provider to handle paths under this prefix.
   */
  public mount(prefix: string, provider: FileSystemProvider): void {
    const normalized = this._normalizePrefix(prefix);
    this.unmount(normalized);
    this._mounts.push({ prefix: normalized, provider });
    this._mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /**
   * Remove a mount point.
   *
   * @param prefix - Mount prefix to remove.
   */
  public unmount(prefix: string): void {
    const normalized = this._normalizePrefix(prefix);
    this._mounts = this._mounts.filter((m) => m.prefix !== normalized);
  }

  /**
   * Resolve an absolute path to the appropriate provider and provider-relative path.
   *
   * @param absolutePath - Absolute virtual path (e.g. `/node_modules/lodash/index.js`).
   * @returns Provider and provider-relative path.
   * @throws When no mount matches the path.
   */
  public resolve(absolutePath: string): MountResolution {
    const normalized = absolutePath.endsWith('/') && absolutePath.length > 1 ? absolutePath.slice(0, -1) : absolutePath;

    for (const entry of this._mounts) {
      if (entry.prefix === '/') {
        return { provider: entry.provider, path: normalized };
      }

      if (normalized === entry.prefix) {
        return { provider: entry.provider, path: '/' };
      }

      if (normalized.startsWith(entry.prefix + '/')) {
        const relativePath = normalized.slice(entry.prefix.length);
        return { provider: entry.provider, path: relativePath || '/' };
      }
    }

    throw new Error(`[MountTable] No mount matches path: ${absolutePath}`);
  }

  /**
   * Get child mounts under a given path (for readdir merge).
   *
   * @param path - Parent path to check for child mounts.
   * @returns Mount entries whose prefix is a direct child of the given path.
   */
  public getMountsUnder(path: string): MountEntry[] {
    const normalized = this._normalizePrefix(path);
    const parentPrefix = normalized === '/' ? '/' : normalized + '/';

    return this._mounts.filter((m) => {
      if (m.prefix === normalized) {
        return false;
      }
      if (normalized === '/') {
        const rest = m.prefix.slice(1);
        return !rest.includes('/');
      }
      if (!m.prefix.startsWith(parentPrefix)) {
        return false;
      }
      const rest = m.prefix.slice(parentPrefix.length);
      return !rest.includes('/');
    });
  }

  /** Clear all mount points. */
  public dispose(): void {
    this._mounts = [];
  }

  private _normalizePrefix(prefix: string): string {
    if (prefix === '/') {
      return '/';
    }
    return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  }
}
