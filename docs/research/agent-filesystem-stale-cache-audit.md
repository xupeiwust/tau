---
title: 'Agent Filesystem Stale-Cache Audit: Smoking Gun and Eigenquestion'
description: 'Root-cause investigation of why the chat agent saw a 0-byte size for a 118-line main.scad and the broader class of stale-data hazards spanning the FileTreeService → FileContentService → RPC adapter → chat tool boundary.'
status: active
created: '2026-05-02'
updated: '2026-05-02'
category: investigation
related:
  - docs/policy/filesystem-policy.md
  - docs/policy/context-engineering-policy.md
  - docs/research/cache-strategy-analysis.md
  - docs/research/filesystem-runtime-strategy.md
---

# Agent Filesystem Stale-Cache Audit: Smoking Gun and Eigenquestion

Root-cause investigation of the agent-side report "the file size was showing as zero but the actual code has 118 lines, so that must be a stale cache issue", and the broader class of stale-data hazards across the filesystem layer that feeds the chat agent's tool surface.

## Executive Summary

The agent's hypothesis is **wrong**. The 0-byte size is not a stale cache — it is a value that is **never computed** anywhere in the pipeline. A second, unrelated, _real_ stale-cache class exists in the `FileContentService` content cache (used by `read_file`, `grep`, and `edit_file`), which never invalidates on out-of-band file changes (worker push events, cross-tab writes, OS-level edits on Node FS backends). Three findings cover both the smoking gun and the eigenquestion; six numbered recommendations resolve them.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [The Eigenquestion](#the-eigenquestion)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [Appendix](#appendix)

## Problem Statement

A chat session shows the agent reasoning:

> I notice the file size was showing as zero but the actual code has 118 lines, so
> that must be a stale cache issue.

The screenshot also shows a `Tool Error: glob_search` and a successful `Read main.scad`. The agent then began guessing at a "stale cache" failure mode and burned tokens trying to work around it. The user-reported question:

> What is causing this stale cache issue in the filesystem layer connecting to the
> chat layer in `apps/ui/app/hooks/use-chat.tsx`? What do we need to do to resolve
> all stale filesystem issues?

`use-chat.tsx` itself is not on the read path for any filesystem tool — it is a thin selector/actions surface over `ChatSessionStore` (no file reads, no caches). The actual filesystem boundary the agent reaches sits in:

- `apps/ui/app/hooks/use-chat-rpc-socket.tsx` — joins the chat room, registers the RPC handler.
- `apps/ui/app/hooks/rpc-handlers.ts` — adapts browser deps (`fileManager`, `treeService`) into the abstract `RpcFileSystem` consumed by `libs/chat/src/rpc/handlers/*`.
- `apps/ui/app/lib/file-content-service.ts` — content cache + read pipeline.
- `apps/ui/app/lib/file-tree-service.ts` — lazy directory tree.

This is where the investigation lives.

## Methodology

1. Traced the four agent-facing filesystem RPCs (`read_file`, `list_directory`, `glob_search`, `grep`) from the API tool definition (`apps/api/app/api/tools/tools/tool-*.ts`) to the browser RPC adapter (`createBrowserRpcFileSystem` in `rpc-handlers.ts`) to the underlying services.
2. Checked the data shape at each transformation boundary (`FileTreeNode`, `FileEntry`, `FileStatEntry`, `TreeEntry`, the `RpcFileSystem.readdir` return type, and the `listDirectoryOutputSchema` that reaches the LLM).
3. Audited `FileContentService` for cache-invalidation paths against every external mutation source (internal write/delete/rename, worker push events, cross-tab events, OS-level edits, SharedPool fast path).
4. Cross-checked against the lazy-tree migration audit and existing cache-strategy research to ensure the findings line up with the architectural intent.

## Findings

### Finding 1 (Smoking Gun): `readdir` adapter hard-codes `size: 0`

The agent's `list_directory` tool, the LLM-visible `entries[].size` field, and (via `glob_search` recursion) the size returned for every walked file all originate from this five-line adapter:

```86:116:apps/ui/app/hooks/rpc-handlers.ts
function createBrowserRpcFileSystem(
  fileManager: RpcHandlerDependencies['fileManager'],
  treeService: RpcHandlerDependencies['treeService'],
): RpcFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      const data = await fileManager.readFile(path);
      return decodeTextFile(data);
    },
    // ... write/edit/exists/etc ...
    async readdir(
      path: string,
    ): Promise<Array<{ name: string; type: 'file' | 'dir'; size: number; modifiedAt?: string }>> {
      if (!treeService) {
        return [];
      }
      const nodes = await treeService.readDirectoryEntries(path);
      return nodes.map((node) => ({
        name: node.name,
        type: node.children === undefined ? 'file' : 'dir',
        size: 0,
      }));
    },
```

`treeService.readDirectoryEntries` returns `FileTreeNode[]`, and `FileTreeNode` is intentionally minimal:

```67:76:packages/filesystem/src/types.ts
/**
 * Node in a standalone backend file tree.
 * Used by the /files route to display all backends side-by-side.
 * @public
 */
export type FileTreeNode = {
  id: string;
  name: string;
  children?: FileTreeNode[];
};
```

There is no `size` on the node, so the adapter cannot recover one — and rather than calling `stat` for each child or routing through `getDirectoryStat`/`readdirWithStats`, it picks the constant `0`.

The schema that reaches the LLM advertises this field as authoritative bytes:

```10:20:libs/chat/src/schemas/tools/list-directory.tool.schema.ts
const directoryEntrySchema = z.object({
  name: z.string().describe('The name of the file or directory.'),
  type: z.enum(['file', 'dir']).describe('Whether this entry is a file or directory.'),
  size: z.number().describe('The size in bytes (for files) or number of entries (for directories).'),
});
```

The handler dutifully forwards the lie:

```10:22:libs/chat/src/rpc/handlers/handle-list-directory.ts
    const rawEntries = await fileSystem.readdir(input.path);
    const entries = rawEntries.map(
      (entry) =>
        ({
          name: entry.name,
          type: entry.type,
          size: entry.size,
          ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}),
        }) as const,
    );
```

The agent saw `main.scad` with `size: 0` from `list_directory`, then `read_file` returned 118 lines of real content. The contradiction is real, but the cause is **a hard-coded zero**, not a stale cache. The agent's working hypothesis was a hallucination prompted by the schema's `bytes` claim plus the visible content disagreement.

A second, parallel hard-coded `0` lives upstream in `FileTreeService.patchDirectoryEntries`, so even if the adapter were "fixed" to read sizes from `treeService.getTreeSnapshot()` directly, the lazy tree would still be lying:

```686:696:apps/ui/app/lib/file-tree-service.ts
    for (const entry of entries) {
      const entryPath = prefix ? `${prefix}${entry.name}` : entry.name;
      newTree.set(entryPath, {
        path: entryPath,
        name: entry.name,
        type: entry.children === undefined ? 'file' : 'dir',
        size: 0,
        mtimeMs: Date.now(),
        isLoaded: false,
      });
    }
```

The lazy `FileEntry` shape _has_ `size` and `mtimeMs` fields, and a separate proxy method (`getDirectoryStat → FileStatEntry[]`) and an optional provider capability (`readdirWithStats`) exist precisely to populate them, but the lazy tree never invokes either when it patches entries.

### Finding 2 (Eigenquestion): `FileContentService` cache has no invalidation path for out-of-band mutations

`read_file` and (via `grep`) per-file content reads route through `fileManager.readFile`:

```172:180:apps/ui/app/hooks/use-file-manager.tsx
  const readFile = useCallback(
    async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      return contentService.resolveBytes(path);
    },
    [contentService],
  );
```

`resolveBytes` short-circuits on cache:

```113:138:apps/ui/app/lib/file-content-service.ts
  public async resolve(path: string, options?: ResolveOptions): Promise<FileContentResult> {
    const cached = this.cache.get(path);
    if (cached !== undefined && !this.shouldRecompute(options)) {
      const existing = this.outcomes.get(path);
      if (existing?.kind === 'text') {
        return existing;
      }
      const refreshed: FileContentResult = { kind: 'text', content: cached };
      this.publishOutcome(path, refreshed);
      return refreshed;
    }
```

```387:389:apps/ui/app/lib/file-content-service.ts
  private shouldRecompute(options?: ResolveOptions): boolean {
    return Boolean(options?.forceText) || options?.sizeLimit !== undefined;
  }
```

Neither the chat tool nor any consumer of `fileManager.readFile` passes `forceText` or `sizeLimit`, so the cache **always wins** on hit. The cache is invalidated only by:

| Source                             | Invalidates `FileContentService` cache?                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `contentService.write` (editor)    | Yes — sets new bytes                                                       |
| `contentService.write` (agent)     | Yes — sets new bytes                                                       |
| `contentService.delete`            | Yes — `cache.delete`                                                       |
| `contentService.rename`            | Yes — `cache.rename`                                                       |
| `contentService.reset` / `dispose` | Yes — `cache.clear`                                                        |
| **Worker `fileChanged` events**    | **No** — only `treeService` listens                                        |
| **Cross-tab `BroadcastChannel`**   | **No** — not wired                                                         |
| **OS-level edits (Node FS)**       | **No** — filesystem observer goes to tree only                             |
| **SharedPool population**          | **No** — pool is consulted before cache, but no eviction signal flows back |

The smoking-gun wiring is in `initializeServicesActor`:

```263:267:apps/ui/app/machines/file-manager.machine.ts
    treeService.connectToContentService(contentService);

    proxy.listen?.('fileChanged', (event) => {
      treeService.handleWorkerFileChanged(event as ChangeEvent);
    });
```

The arrow goes one way: content writes notify the tree (via `connectToContentService`), but worker file-change events notify only the tree (`handleWorkerFileChanged`) and never reach the content service. So:

- A different tab edits `main.scad` → `BroadcastChannel` fires → worker emits `fileWritten` → `treeService` refreshes → `FileContentService` still holds the old bytes → next `read_file` returns stale text.
- A user edits `main.scad` in their OS editor against a Node FS backend → `FilesystemObserverBridge` fires → same outcome.
- The runtime kernel writes a generated `.tau/parameters/*.json` snapshot → same outcome unless the write went through `FileContentService.write`.

`BoundedFileCache` itself is keyed only on `path` — there is no `mtimeMs` or `etag` stored alongside the bytes, so even an _opportunistic_ freshness check against a fresh `stat` would require an explicit metadata column the cache does not track today.

### Finding 3: `glob_search` and `grep` traverse the same lossy `readdir`, multiplying both bugs

`handle-glob-search` and `handle-grep` both call `fileSystem.readdir` recursively to collect entries:

```12:33:libs/chat/src/rpc/handlers/handle-glob-search.ts
async function collectFileEntries(fileSystem: RpcFileSystem, basePath: string): Promise<CollectedEntry[]> {
  const result: CollectedEntry[] = [];
  const entries = await fileSystem.readdir(basePath);

  for (const entry of entries) {
    const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.type === 'file') {
      result.push({
        path: fullPath,
        isDirectory: false,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      });
    } else {
      const subEntries = await collectFileEntries(fileSystem, fullPath);
      result.push(...subEntries);
    }
  }

  return result;
}
```

Two consequences:

1. The recursion compounds Finding 1: every walked file inherits `size: 0`, so even though `globSearchOutputSchema` does not surface size to the LLM today, any future addition of a per-entry size field will be silently zero across thousands of paths.
2. `handle-grep` then calls `fileSystem.readFile(filePath)` for each candidate — and that read goes through the same `FileContentService` cache hit path, so Finding 2 applies to grep too. A grep run after an out-of-band write returns matches against the stale cached text.

The image's `Tool Error: glob_search` is unrelated to either bug (likely the recursion failing on a non-existent base path or a transient backend error during init), but the tool's _output_ shape is silently affected by both.

## The Eigenquestion

**The unifying class is "the chat-RPC filesystem boundary lacks a single stat-aware authority"**:

- The lazy `FileTreeService` carries a typed `size`/`mtimeMs` on `FileEntry` but never populates them from the worker side, so every UI-side stat-flavoured read is `0` + `Date.now()`.
- The `FileContentService` cache only invalidates on operations that originate _inside_ the service, so any change that arrives via the worker's push channel or a sibling tab is invisible to the cache.
- The `RpcFileSystem` adapter that bridges these services to the agent picks the most cache-friendly source (`treeService.readDirectoryEntries` → `FileTreeNode`) instead of the freshest one (`getDirectoryStat`/`readdirWithStats`), then forwards a synthesised zero into a schema field that promises bytes.

Resolving the agent's reported symptom requires fixing the synthetic `0`. Resolving "all stale filesystem issues" requires lifting the worker push channel into a first-class invalidation source for the content cache, and treating the LLM-visible `size`/`modifiedAt` fields as a contract that must be filled from authoritative stats.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Priority | Effort | Impact                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Fix `createBrowserRpcFileSystem.readdir` to return real `size`/`modifiedAt` from `proxy.readdirWithStats` (or fall back to a single `getDirectoryStat` shallow walk + per-entry derivation). Keep the response synchronous w.r.t. the LLM contract. ✅ **RESOLVED** — `FileTreeService.readDirectoryEntriesWithStats` (`readDirectory` + per-child `proxy.stat` fan-out) now backs the adapter; `modifiedAt` is omitted when the stat fan-out fell back to `mtimeMs: 0`.                                                                                                                                                                                 | **P0**   | Low    | High — eliminates the agent's primary hallucination source for `list_directory`/`glob_search`.                                                        |
| R2  | Subscribe `FileContentService` to the worker's `fileChanged` push channel. On `fileWritten` / `fileRenamed` / `fileDeleted` / `directoryChanged` / `backendChanged`, evict the matching cache entries and republish the affected outcomes (mirror `treeService.handleWorkerFileChanged`). Keep `editor`-source events suppressed only if the editor's own writes round-trip through the service (they do). ✅ **RESOLVED** — `FileContentService.handleWorkerFileChanged` evicts cache + outcomes, flips the orphaned flag, and notifies path subscribers; `file-manager.machine.ts` fans the `proxy.listen('fileChanged', …)` event into both services. | **P0**   | Medium | High — closes the "stale `read_file` after out-of-band edit" class.                                                                                   |
| R3  | Stop hard-coding `size: 0` / `mtimeMs: Date.now()` in `FileTreeService.patchDirectoryEntries` and the optimistic-add path. Patch entries from `readdirWithStats` when the provider supports it; otherwise mark `size`/`mtimeMs` as `undefined` on `FileEntry` and propagate the option through the type system rather than synthesising a falsy stat.                                                                                                                                                                                                                                                                                                    | **P1**   | Medium | Medium — removes the upstream lie so any future consumer (RPC adapter, file picker, agent context) gets `undefined` instead of `0`, which fails loud. |
| R4  | Add a `readdirWithStats` capability check in `WorkspaceFileService.readDirectory` and use it when present. For backends without it (rare — both `DirectIdbProvider` and `FsAccessProvider` already surface stats), fall back to a parallel `stat` fan-out, batched.                                                                                                                                                                                                                                                                                                                                                                                      | **P1**   | Medium | Medium — feeds R1/R3 with real data instead of zeros.                                                                                                 |
| R5  | Introduce an `mtimeMs`-aware `BoundedFileCache` entry shape, so post-invalidation we can do an _opportunistic_ `stat` + `mtime` mismatch check on re-resolve (defence in depth even if R2 is in place). Ship behind a single config flag so we can A/B against pure invalidation.                                                                                                                                                                                                                                                                                                                                                                        | **P2**   | Medium | Medium — safety net for any push-event drop, plus useful telemetry.                                                                                   |
| R6  | Extend the chat tool descriptions and tool-input schemas to use a `bytes` (number, optional) + `humanSize` (string, optional) split, and only emit the field when the underlying provider can actually answer. This fails closed instead of advertising a value the runtime cannot produce, and matches the `modifiedAt` pattern that the existing schema already treats as optional.                                                                                                                                                                                                                                                                    | **P2**   | Low    | Low — context-engineering hygiene; stops the LLM from inventing "stale cache" stories around 0-byte schema fields.                                    |

## Trade-offs

| Approach                      | Pros                                                       | Cons                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 only (fix the symptom)** | One-file change, agent stops hallucinating zeros           | Real stale-cache bugs in `read_file`/`grep` survive                                                                                     |
| **R2 only (fix the cache)**   | Closes the actual stale-data class for content reads       | `list_directory` still emits zeros; agent still wastes tokens on phantom diagnoses                                                      |
| **R1 + R2 + R3**              | Eliminates both classes; types stay honest                 | ~3 files, requires a follow-up sweep of `FileEntry.size` consumers (`getTreeSnapshot()` callers in chat-history-selector, file pickers) |
| **R1 + R2 + R3 + R4 + R5**    | Belt-and-braces, with telemetry on stale-cache near-misses | Largest blast radius; needs a rolling deploy to confirm `readdirWithStats` parity across IDB/OPFS/Node backends                         |
| **R6 alone (schema-only)**    | Removes the `0`-byte misrepresentation cheaply             | Doesn't fix `read_file` staleness; only addresses the directory listing surface                                                         |

Recommended sequencing: **R1 + R2 first** (one PR each, both P0). R3 + R4 in a follow-up that consolidates the lazy-tree stat story. R5 + R6 as separate hygiene PRs once R1–R4 land and we have telemetry to size the residual risk.

## Code Examples

### R1 sketch — `readdir` adapter wired to real stats

```typescript
async readdir(path: string) {
  if (!treeService) {
    return [];
  }
  // Prefer the batched stat path when the provider supports it; the
  // proxy already exposes this on FileSystemProvider.readdirWithStats.
  const entries = await treeService.readDirectoryEntriesWithStats(path);
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.type,
    size: entry.size,
    modifiedAt: new Date(entry.mtimeMs).toISOString(),
  }));
},
```

`FileTreeService` adds a `readDirectoryEntriesWithStats` that prefers `proxy.readdirWithStats` and falls back to `getDirectoryStat` on the same prefix.

### R2 sketch — content cache subscribes to worker push events

```typescript
// inside FileManager initializeServicesActor, alongside the existing
// proxy.listen?.('fileChanged', …) wiring:
proxy.listen?.('fileChanged', (event) => {
  treeService.handleWorkerFileChanged(event as ChangeEvent);
  contentService.handleWorkerFileChanged(event as ChangeEvent);
});

// FileContentService:
public handleWorkerFileChanged(event: ChangeEvent): void {
  switch (event.type) {
    case 'fileWritten':
    case 'fileDeleted': {
      this.cache.delete(event.path);
      this.outcomes.delete(event.path);
      this.notifyPathSubscribers(event.path);
      return;
    }
    case 'fileRenamed': {
      this.cache.rename(event.oldPath, event.newPath);
      this.outcomes.delete(event.oldPath);
      this.notifyPathSubscribers(event.oldPath);
      this.notifyPathSubscribers(event.newPath);
      return;
    }
    case 'directoryChanged':
    case 'backendChanged': {
      this.cache.clear();
      this.outcomes.clear();
      // Notify everything; subscribers re-resolve on next render.
      for (const path of this.pathSubscribers.keys()) {
        this.notifyPathSubscribers(path);
      }
      return;
    }
  }
}
```

Suppression rule: writes already round-trip through `contentService.write`, so by the time the worker echoes the `fileWritten` event back, the cache holds the _new_ bytes — the eviction is a no-op refresh. To avoid a needless re-publish, gate eviction by a short "writes I just made" set keyed on `(path, byteLength)` (or by the existing `FileWriteSource === 'editor'` heuristic that the tree service already uses).

## Diagrams

Current data flow (the smoking gun is the `size: 0` short-circuit; the eigenquestion is the missing arrow from `proxy.fileChanged` to `FileContentService`):

```
┌──────────────────┐  read_file         ┌──────────────────────┐
│ list_directory   │  glob_search       │ Chat Tool (libs/api) │
│ tool (LLM-side)  │  grep              └─────────┬────────────┘
└──────┬───────────┘                              │
       │                                          │ RPC over Socket.IO
       ▼                                          ▼
┌──────────────────────────────────────────────────────────────┐
│ createBrowserRpcFileSystem  (apps/ui/.../rpc-handlers.ts)    │
│   readdir   →  treeService.readDirectoryEntries (no size)    │
│            →  size: 0  ◄── SMOKING GUN                       │
│   readFile →  fileManager.readFile                           │
│   editFile →  fileManager.writeFile                          │
└──────────────┬──────────────────────────────────┬────────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│ FileTreeService          │       │ FileContentService       │
│  - lazy FileEntry tree   │       │  - BoundedFileCache      │
│  - listens to proxy      │       │  - resolves bytes        │
│    fileChanged events  ──┼──┐    │  - listens for…          │
│  - patches entries with  │  │    │      …NOTHING from worker│
│    size: 0  ◄── R3       │  │    │  ◄── EIGENQUESTION (R2)  │
└──────────┬───────────────┘  │    └──────────────────────────┘
           │                   │
           ▼                   │
   ┌─────────────────┐         │
   │ FileSystem      │ ◄───────┘ proxy.listen('fileChanged', …)
   │ Worker (proxy)  │
   │  - readDirectory│
   │  - readdirWithStats? (unused on this path)
   │  - watch / fs   │
   │    observer     │
   └─────────────────┘
```

## References

- `apps/ui/app/hooks/use-chat.tsx` — chat hooks (no FS reads; entry point named in the user query).
- `apps/ui/app/hooks/use-chat-rpc-socket.tsx` — RPC handler registration.
- `apps/ui/app/hooks/rpc-handlers.ts` — `createBrowserRpcFileSystem`, the smoking-gun adapter.
- `apps/ui/app/lib/file-content-service.ts` — content cache + outcome pipeline.
- `apps/ui/app/lib/file-tree-service.ts` — lazy tree, `patchDirectoryEntries`, `handleWorkerFileChanged`.
- `apps/ui/app/machines/file-manager.machine.ts` — services bootstrap and worker event wiring.
- `packages/filesystem/src/types.ts` — `FileTreeNode`, `TreeEntry`, capability flags.
- `packages/filesystem/src/bounded-file-cache.ts` — path-only cache key (no mtime).
- `libs/chat/src/schemas/tools/list-directory.tool.schema.ts` — schema field that promises bytes.
- `libs/chat/src/rpc/handlers/handle-list-directory.ts`, `handle-glob-search.ts`, `handle-grep.ts`, `handle-read-file.ts`.
- Related: `docs/research/cache-strategy-analysis.md`, `docs/research/filesystem-runtime-strategy.md`, `docs/research/lazy-tree-migration-audit.md`.

## Appendix

### A1. Tools whose LLM-visible output depends on the smoking-gun field

| Tool             | Reads `entries[].size`?      | Reads file content from cache? |
| ---------------- | ---------------------------- | ------------------------------ |
| `list_directory` | Yes (forwarded as-is)        | No                             |
| `glob_search`    | No (output schema strips it) | No                             |
| `grep`           | No                           | Yes (per match candidate)      |
| `read_file`      | No                           | Yes                            |
| `edit_file`      | No                           | Yes (read before write)        |
| `create_file`    | No                           | No                             |
| `append_file`    | No                           | Yes (read before append)       |
| `delete_file`    | No                           | No (write path)                |

R1 fixes `list_directory` directly. R2 fixes the cached-read path that affects `grep`, `read_file`, `edit_file`, `append_file`.

### A2. Why `use-chat.tsx` itself was not the culprit

`use-chat.tsx` only resolves the live `Chat` instance + draft binding from the `ChatSessionStore`. Filesystem reads originate from RPC requests delivered over the Socket.IO channel registered in `useChatRpcConnection`, which constructs `createRpcHandlers(deps)` per request — not from anything inside `use-chat.tsx`. The hook is a red herring; the boundary it visually represents (chat ↔ filesystem) is correctly identified, but the actual seam is one file deeper at `rpc-handlers.ts` + the two services it adapts.

### A3. Verification plan after R1 + R2 land

1. `pnpm nx test ui app/hooks/rpc-handlers.test.ts --watch=false` — exercise the new `readdir` shape.
2. Add a `FileContentService` test that primes the cache, dispatches a synthetic `proxy.listen('fileChanged', …)` event, and asserts the next `resolveBytes` re-reads.
3. Manual: open two tabs on the same project, edit `main.scad` in tab A, ask the agent in tab B to `read_file main.scad` — assert the agent sees the new content without an explicit refresh.
4. Manual: run `list_directory` on a directory with files of varied sizes — assert reported `size` matches `wc -c` on disk.
