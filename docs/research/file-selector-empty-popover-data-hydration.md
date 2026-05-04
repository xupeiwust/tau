---
title: 'FileSelector Empty Popover Data Hydration Failure'
description: 'Root-cause investigation into the watermark FileSelector showing zero files for valid projects whose editor file tree is fully populated.'
status: active
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/agent-empty-directory-false-positive.md
  - docs/research/agent-filesystem-stale-cache-audit.md
  - docs/research/file-services-architecture-blueprint.md
  - docs/research/origin-client-id-propagation-audit.md
  - docs/policy/filesystem-policy.md
---

# FileSelector Empty Popover Data Hydration Failure

Why the "Select file to render…" popover in `chat-viewer-dockview.tsx` (and the
twin "Select file to edit…" popover in `chat-editor-dockview.tsx`) sometimes
opens empty for projects whose editor file tree visibly lists hundreds of
entries — a jarring "this project has no files" lie surfaced on top of a
fully populated workspace.

## Status Update (2026-05-04)

**Phases 1–5 shipped; Phases 6–7 deferred.** Tracked in
[`/Users/rifont/.cursor/plans/file-tree-listing-consolidation_bad50ee8.plan.md`](../../.cursor/plans/file-tree-listing-consolidation_bad50ee8.plan.md).

The follow-up audit
[`docs/research/file-selector-virtuoso-scroller-and-wire-stat-loss.md`](file-selector-virtuoso-scroller-and-wire-stat-loss.md)
established that the **user-facing empty-popover symptom on Zoo's
modeling-app** was **not** caused by the divergent worker-side cache
described below. With the FastAndSlow / `useDirectoryListing`
consolidation in place (R1–R6), `kind: 'ready'` carried all 61 entries to
the UI; the empty popover came from `FileSelectorItemList`'s custom
Virtuoso `Scroller` dropping `children`, and the universal `0 B` came
from `FileTreeNode` losing `size`/`mtimeMs` on the wire. Both were fixed
in the audit follow-up — independent of any consolidation phase.

What this means for the remaining recommendations:

- **R8 / R10 (visibility-gated selective refresh) — deferred.** Profile-
  driven; no measured refresh-storm or jank today. Revisit if traces
  show kernel-write amplification re-resolving visible directories, or
  if the chat-agent RPC handlers exhibit avoidable churn.
- **R11 (mount-lifecycle invalidation) — deferred.** Cross-tab /
  multi-mount stale-tree windows have not been reported since Phase 4
  (the divergent worker `_treeCache` is gone). Revisit if a stale tree
  re-appears after a project switch / shared-worker mount change.
- **R12 (deterministic refresh-on-visible nicety) — deferred.** The
  visibility-aware polling already shipped covers the practical
  staleness cases; revisit if "tree stuck after sleep" is reported.
- **R13 (editing-mode pause during inline rename) — deferred.** No
  reports of rename-vs-refresh interleaving. Revisit if the chat-editor
  file-tree rename UX surfaces flakes.
- **R14 (consumer wiring of `RefreshGenerationGuard`) — deferred.**
  Phase 2's `listDirectory` already consumes the guard internally;
  Phase 7c was an audit-only todo. Revisit when refactoring the listing
  call graph or before adding new concurrent `listDirectory` callers.

Phases 1–5 stay justified on their own merits: typed listing contract,
identity-stable `mergeChildren`, single worker read path, and removal of
divergent caches. The deferred phases are operational hardening, not
prerequisites for the closed user-facing bugs.

## Executive Summary

The empty-popover bug is the visible symptom of a single structural
defect: **the workspace exposes two parallel directory-listing caches
with independent invalidation semantics, and nothing reconciles them**.
The main-thread `FileTreeService._tree` is reactive, lazy, and patched
through the change channel. The worker-side `WorkspaceFileService._treeCache`
is eager, per-path, and invalidated only by writes that go _through_ the
worker. Every read path that bypasses `_tree` (the watermark
`FileSelector`, the chat-agent RPC stat helpers, the dockview "open
file" empty-state) takes the worker round-trip, hits the divergent
cache, and inherits a chain of silent failure modes (uncaught
rejections, fire-and-forget loads, no fallback to the in-memory
snapshot).

The architecturally correct fix is to **collapse the two caches into one
single source of truth on the main thread, and let the change channel be
the only thing that updates it.** Concretely: delete
`WorkspaceFileService._treeCache`, make `FileTreeService._tree` the
canonical workspace listing, expose a single typed read API
(`listDirectory` / `listDirectorySync`) returning a discriminated union,
and have every consumer subscribe through one reactive hook
(`useDirectoryListing`). All six findings below disappear as
consequences of that consolidation; the layered patches discussed in
prior drafts (and in `agent-empty-directory-false-positive.md`) are
either subsumed or rendered unnecessary.

**This is exactly the architecture VSCode has shipped for years.**
A deep read of `repos/vscode/src/vs/platform/files/common/fileService.ts`

- `workbench/contrib/files/{common,browser}/explorer*.ts` (Finding 7)
  maps every Tau primitive (`FileTreeService`, `WorkspaceFileService`,
  `MountTable`, `ChangeEventBus`, the `FileSelector` popover) onto a
  matching VSCode primitive (`ExplorerModel`, `FileService`,
  `FileSystemProvider` registration, `onDidFilesChange` /
  `onDidRunOperation`, `FastAndSlowPicks`) — and reveals seven additional
  patterns (per-node resolved state, identity-preserving merges, errors-
  on-node, two event streams, correlation IDs, selective refresh, fast-
  and-slow rendering, cancellation tokens) that further harden the
  architecture against the same class of bug. The recommendations below
  incorporate every one.

**Parallel work has already shipped most of the supporting
primitives.** Commit `f96462665` (concurrent with this investigation)
extracted `packages/fs-client/`, introduced a WeakMap-backed
origin-aware dispatch system documented in
[`origin-client-id-propagation-audit.md`](origin-client-id-propagation-audit.md),
and landed five primitives that exactly fit this fix:
`event-origin-registry` (✅ R9 — correlation IDs), `VisibilityProvider`

- visibility-aware polling (✅ R12 — window-focus refresh),
  `WorkerChangeChannel.interestedIn` predicate (◐ R10 partial — selective
  refresh), `RefreshGenerationGuard` (primitive for R14 — in-flight
  dedup), `PathSubscriberRegistry` (primitive for R3 — reactive
  subscriptions). The smoking-gun fix (R5: delete
  `WorkspaceFileService._treeCache`) and the consumer-side consolidation
  (R1 + R2 + R3 — single read API, typed result, FileSelector cut-over)
  remain the core unshipped work; **Finding 8** inventories the shipped
  pieces and the recommendations below are refined to consume them
  rather than re-introduce parallel mechanisms.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: Two read paths for the same data](#finding-1-two-read-paths-for-the-same-data)
  - [Finding 2: FileSelector silently swallows every rejection](#finding-2-fileselector-silently-swallows-every-rejection)
  - [Finding 3: Non-reactive load — open once, never retry](#finding-3-non-reactive-load--open-once-never-retry)
  - [Finding 4: `_treeCache` invalidation cascades reach the project root](#finding-4-_treecache-invalidation-cascades-reach-the-project-root)
  - [Finding 5: No fallback to the synchronous tree snapshot](#finding-5-no-fallback-to-the-synchronous-tree-snapshot)
  - [Finding 6: Cross-tab worker sharing widens the failure window](#finding-6-cross-tab-worker-sharing-widens-the-failure-window)
  - [Finding 7: VSCode reference architecture](#finding-7-vscode-reference-architecture)
  - [Finding 8: Primitives already shipped in the parallel refactor](#finding-8-primitives-already-shipped-in-the-parallel-refactor)
- [Target Architecture](#target-architecture)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)

## Problem Statement

User-supplied screenshots (single session, two projects):

| Project                 | File tree on left                                                                                                                            | Watermark popover                                                 | Outcome                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `sgenoud/models`        | not rendered                                                                                                                                 | populated correctly                                               | User clicks `.husky / .tau / .vscode / public / src / ...` |
| `KittyCAD/modeling-app` | hundreds of entries (`.github`, `.helix`, `.husky`, `.tau`, `assets`, `docs`, `e2e`, `openapi`, `packages`, `public/...`, `kcl-samples/...`) | empty — only "Files" breadcrumb and "Search files…" input visible | User cannot select a file to render                        |

Both projects load with the project route's `<FileManagerProvider
projectId={id} rootDirectory={'/projects/' + id}>` mounted, both share the
same `<SharedWorkerGate>`/worker, and both display `<ViewerWatermark>`
under `<DockviewReact watermarkComponent={ViewerWatermark}>`. The popover
trigger is the same `<FileSelector selectedFile={undefined} ... />`, and
the data source is resolved through the same `useContextDataSource` hook.

The KittyCAD project demonstrably has files (the editor file tree shows
them and the user has been navigating them). The popover renders
`emptyMessage='No files found.'` (or the loader briefly, then nothing) —
a UX state that never auto-recovers.

## Methodology

- Read the watermark render path:
  `apps/ui/app/routes/projects_.$id/chat-viewer-dockview.tsx:56-116` and
  the twin in
  `apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx:217-258`.
- Read the FileSelector data resolution chain:
  `apps/ui/app/components/files/file-selector.tsx:466-509`
  (`useContextDataSource`),
  `apps/ui/app/components/files/file-selector.tsx:541-565` (`loadDirectory`),
  `apps/ui/app/components/files/file-selector.tsx:593-611` (`handleOpenChange`).
- Read the parallel synchronous read path used by the editor file tree:
  `apps/ui/app/hooks/use-file-tree.ts` (`useFileTreeMap`),
  `apps/ui/app/routes/projects_.$id/chat-editor-file-tree.tsx:287-301`
  (`fileTree` derived via `useMemo` on `fileTreeMap`).
- Read the worker round-trip path:
  `packages/fs-client/src/file-tree-service.ts:276-279`
  (`readDirectoryEntries` → `proxy.readDirectory`),
  `packages/filesystem/src/workspace-file-service.ts:622-674`
  (`readDirectory` cache + provider read),
  `packages/filesystem/src/backend/direct-idb-provider.ts:108-138`
  (`readdir` enforcing `_dirs.has`).
- Re-read the prior research
  `docs/research/agent-empty-directory-false-positive.md` to confirm the
  outer worker-side error swallow has already been removed (R2 landed),
  meaning provider errors now propagate and any silent-empty in 2026-05-04
  code must be coming from a layer above the worker.
- Audit the FM machine init flow:
  `apps/ui/app/machines/file-manager.machine.ts:184-292`
  (`initializeServicesActor`) — the call that populates both `_tree` _and_
  `_treeCache['/projects/<id>']` from the same `proxy.readDirectory(rootPath)`.
- Audit the cache-invalidation surface:
  `packages/filesystem/src/workspace-file-service.ts:295-526`
  (every write/mkdir/rename/unlink/copy site that touches `_treeCache`),
  cross-referenced against
  `packages/filesystem/src/directory-tree-cache.ts:46-63`
  (`invalidateSubtree` / `invalidateAncestors` semantics).
- Confirm context propagation through Dockview portals:
  `node_modules/.pnpm/dockview-react@4.13.1_react@19.2.4/.../dockview-react.esm.js:11354-11369`
  uses `ReactDOM.createPortal` with the user component wrapped in
  `ReactPartContext.Provider` — context flows through React tree, so
  `useOptionalFileManager()` inside `ViewerWatermark` resolves to the
  project-route `FileManagerProvider`. (Eliminates the "wrong provider"
  hypothesis.)

## Findings

### Finding 1: Two read paths for the same data

The editor file tree and the FileSelector read the same workspace through
two structurally different stores:

| Consumer                         | Read API                                                                 | Backing store                                                                                                | Sync vs async | Reactive?                                      |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------- |
| `chat-editor-file-tree.tsx`      | `useFileTreeMap()` → `treeService.getTreeSnapshot()`                     | `FileTreeService._tree` (main-thread `Map<string, FileEntry>`)                                               | sync          | yes (`subscribeTree` + `useSyncExternalStore`) |
| `FileSelector` watermark popover | `treeService.readDirectoryEntries('')` → `proxy.readDirectory(rootPath)` | `WorkspaceFileService._treeCache` (worker-side `Map<string, Map<string, TreeEntry>>`) → IDB provider on miss | async         | no (one-shot)                                  |

Both stores are populated from the same `proxy.readDirectory(rootPath)`
call at FM init (`apps/ui/app/machines/file-manager.machine.ts:225-249,
274-280`), but their lifetimes diverge afterwards:

- `_tree` is patched in place by `optimisticAdd` / `optimisticDelete` /
  `optimisticRename` and by `patchDirectoryEntries` after explicit
  `loadDirectory` calls (file-tree-service.ts:601-712). Top-level entries
  added at construction (`_resolvedDirectories.add('')`) survive
  indefinitely.
- `_treeCache` is invalidated **per directory key** by every write,
  mkdir, rename, unlink, and copy that touches a child path — see
  Finding 4. The cache is populated lazily, so the cached value for
  `/projects/<id>` ages out far more aggressively than the in-memory
  `_tree` snapshot.

When a `_treeCache` miss is followed by a provider read that throws (or
that an interleaved `setRoot`/`unmount` makes inconsistent), the
FileSelector reaches `setItems([])` while the editor file tree continues
to display the original snapshot unchanged. That is the divergence the
user sees in img2.

### Finding 2: FileSelector silently swallows every rejection

`apps/ui/app/components/files/file-selector.tsx:541-565`:

```541:565:apps/ui/app/components/files/file-selector.tsx
const loadDirectory = useCallback(
  async (path: string) => {
    if (!dataSource) {
      return;
    }
    setIsLoadingItems(true);
    try {
      const entries = await dataSource.loadDirectory(path);
      setItems(
        entries
          .map((entry) => ({
            name: entry.name,
            path: entry.path,
            isFolder: entry.isFolder,
            size: entry.size,
            children: new Map<string, TreeNode>(),
          }))
          .sort(sortNodes),
      );
    } finally {
      setIsLoadingItems(false);
    }
  },
  [dataSource],
);
```

There is no `catch`. The three call sites all invoke it as
`void loadDirectory(path)` (lines 607, 625, 634), so any rejection is
discarded silently by the JS runtime. The exact failure modes that get
swallowed:

| Layer                                  | Possible rejection                                                           | Rendered as         |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| `useContextDataSource.loadDirectory`   | `dataSource === undefined` (FM not ready)                                    | early return → `[]` |
| `FileTreeService.readDirectoryEntries` | `paths.toAbsoluteWorkspacePath` throws `WorkspacePathEscapeError`            | uncaught → `[]`     |
| `WorkspaceFileService.readDirectory`   | `MountTable.resolve` throws (no mount matches)                               | uncaught → `[]`     |
| `DirectIdbProvider.readdir(WithStats)` | `_dirs.has(path)` is false → `ENOENT`                                        | uncaught → `[]`     |
| Channel transport                      | `AbortError` from a prior pending request after `setRoot` reset              | uncaught → `[]`     |
| Channel transport                      | Worker disposed mid-call (HMR, `destroyWorkerAndServices` during navigation) | uncaught → `[]`     |

The `emptyMessage='No files found.'` rendered downstream collapses every
one of these into a single user-facing string. The user has no way to
distinguish "directory genuinely empty" from "the call rejected" from "FM
not ready yet."

This is the same anti-pattern flagged in
`docs/research/agent-empty-directory-false-positive.md` — the worker-side
swallow has been removed (R2 landed), but a structurally identical
swallow still lives in the FileSelector UI layer.

### Finding 3: Non-reactive load — open once, never retry

`handleOpenChange` (file-selector.tsx:593-611) is the only entry point
that calls `loadDirectory`. It fires when Radix toggles `open` to `true`.
Once items have been set (or remained `[]`), no React effect re-runs the
call. `dataSource` becoming defined later, `treeService` swapping after
an FM re-init, or a filesystem `directoryChanged` event arriving for the
project root — none of them retry the load.

This means a single transient failure produces a permanently empty
popover for the lifetime of the open state. Closing and reopening the
popover triggers another `handleOpenChange(true)`, which is the only
recovery path.

`useContextDataSource` itself does not subscribe to the change channel
either — even though `FileTreeService` already exposes
`channel.onDirectoryChanged` and the `_tree` map is already kept fresh
through that subscription. The watermark popover is structurally
deafer than the file tree it sits next to.

### Finding 4: `_treeCache` invalidation cascades reach the project root

`packages/filesystem/src/workspace-file-service.ts` invalidates
`_treeCache` from every mutation site:

| Operation                          | Lines   | Invalidation surface                                       |
| ---------------------------------- | ------- | ---------------------------------------------------------- |
| `writeFile` (single)               | 305     | `invalidate(parentDirectory(path))`                        |
| `writeFiles` (batch)               | 352     | `invalidate(directory)` for each parent dir touched        |
| `mkdir(path, { recursive: true })` | 380     | **`invalidateAncestors(path)` — root included**            |
| `mkdir(path)` non-recursive        | 382     | `invalidate(parentDirectory(path))`                        |
| `rename(from, to)`                 | 421-423 | parent of `from`, parent of `to`, **subtree under `from`** |
| `unlink(path)`                     | 450     | `invalidate(parentDirectory(path))`                        |
| `rmdir(path)`                      | 475-476 | `invalidateSubtree(path)`, parent of `path`                |
| `copyFile`                         | 526     | parent of destination                                      |
| `copyDirectory`                    | 566-567 | parent of destination, subtree under destination           |
| `dispose()`                        | 899     | `clear()` (all entries)                                    |

`invalidateAncestors` (`packages/filesystem/src/directory-tree-cache.ts:63-75`)
walks up to `/`, deleting the cache entry at every level. So a single
`mkdir('/projects/proj_X/.tau/cache/<hash>', { recursive: true })` call
unconditionally evicts:

```
/projects/proj_X/.tau/cache/<hash>
/projects/proj_X/.tau/cache
/projects/proj_X/.tau
/projects/proj_X            ← project root cache evicted
/projects
/                            ← root mount cache evicted
```

The kernel worker writes `.tau/cache/*` files routinely (geometry
bundling, parameter caching, GLB outputs) and the chat agent's
`edit_file` / `create_file` tools pass `recursive: true` whenever a new
nested path is created. The project root cache is therefore in a near-
permanent miss state once a chat session is active.

This is not, by itself, a bug — provider re-reads are the right answer.
The bug is that every miss is a fresh opportunity for any of the
Finding 2 failure modes to surface, with no upper layer reacting.

### Finding 5: No fallback to the synchronous tree snapshot

The exact same `treeService` instance the FileSelector consults already
holds a perfectly serviceable in-memory snapshot of the project root
under `_resolvedDirectories.add('')` (file-tree-service.ts:106-111). The
editor file tree iterates that snapshot as `[...fileTreeMap.values()]`
and renders it instantly with no async hop.

`useContextDataSource` ignores it entirely — `loadDirectory` always
forwards to `treeService.readDirectoryEntries`. When the worker
round-trip fails, the popover renders zero entries even though the same
component tree is already showing the populated `_tree` to the
user a few hundred pixels away.

The asymmetry is purely architectural: there is no reason
`FileSelector` should not draw from the synchronous snapshot when the
target path is known to be resolved (`treeService.hasChildrenLoaded(path)`),
falling back to `readDirectoryEntries` only for unloaded subdirectories.

### Finding 6: Cross-tab worker sharing widens the failure window

`apps/ui/app/routes/projects_.$id/route.tsx:30-31` mounts the project FM
inside `<SharedWorkerGate>`. Every route mount reuses the root FM's
worker (`apps/ui/app/hooks/use-file-manager.tsx:113-121`), so a single
worker instance owns:

- The mount table (one entry per `/projects/<id>` ever mounted in this
  tab's lifetime, plus `/` and `/node_modules`).
- The `_treeCache` (one map shared across every mount).
- Every `DirectIdbProvider` that backs an active mount.

`MountTable.mount` (`packages/filesystem/src/mount-table.ts:92-103`)
disposes a previously registered provider when a new mount is registered
at the same prefix, but **never invalidates `_treeCache`** for that
prefix. The FM machine's `destroyWorkerAndServices` action
(`apps/ui/app/machines/file-manager.machine.ts:348-353`) calls
`proxy.unmount(projectPrefix)`, which disposes the provider — but the
cached entries from the prior session linger in `_treeCache` until they
are explicitly evicted by a write, a recursive mkdir, or a dispose.

Project navigation (A → B → A) therefore produces this sequence on the
worker:

1. FM-A mounts `/projects/A`, populates `_treeCache['/projects/A']` with
   N entries.
2. User navigates to B. FM-A exit calls `proxy.unmount('/projects/A')` →
   provider disposed, `_treeCache['/projects/A']` lingers.
3. FM-B mounts `/projects/B`, runs `proxy.readDirectory('/projects/B')`.
4. User navigates back to A. FM-A re-mounts, runs
   `proxy.readDirectory('/projects/A')` — **cache hit on stale data**
   (the provider that produced those entries has been disposed; the
   replacement provider has not been read yet).

Stale data here is usually harmless because the IDB content is the same.
But any writes performed on B that happen to invalidate
`/projects/A`'s entry (e.g. `writeFile('/projects/A/...')` from another
tab via the change channel — note `onBackendChanged` calls
`scheduleRefresh('')`) put the project root cache into a "missing,
provider freshly hydrated, no entries yet" state. That window is exactly
when a popover open call sees `[]`.

This is consistent with the user observation that the bug is
intermittent and tends to trigger after navigating between projects.

### Finding 7: VSCode reference architecture

The architectural pattern Tau is heading towards is exactly the one
VSCode has shipped for years. Reading
`repos/vscode/src/vs/platform/files/common/fileService.ts` and
`repos/vscode/src/vs/workbench/contrib/files/{common,browser}/explorer*.ts`
in full reveals a tightly designed solution to the same class of bugs
this research surfaces. Patterns directly applicable to Tau:

| #    | VSCode pattern                                                                                                                                                                                                                                                                                                                                                                                            | Source                                                                                                                              | Tau equivalent / divergence                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1  | **`FileService.resolve` has no directory cache.** Every `resolve()` calls `provider.stat` + `provider.readdir` afresh. The cache is owned by the consumer (`ExplorerModel`), not the transport.                                                                                                                                                                                                           | `platform/files/common/fileService.ts:192-244`                                                                                      | Validates Tau's R5: delete `WorkspaceFileService._treeCache`. The transport stays a thin pass-through; caching is the model's job.                                                                                                                                                                     |
| 7.2  | **Per-node `_isDirectoryResolved` flag** travels with the model node. No global "resolved directories" Set. Each `ExplorerItem` knows whether its own children have been fetched.                                                                                                                                                                                                                         | `workbench/contrib/files/common/explorerModel.ts:111-143, 219-221, 408-413`                                                         | Replaces Tau's `FileTreeService._resolvedDirectories: Set<string>` with a per-`FileEntry` flag. Forgetting a subtree becomes `node.forgetChildren()` instead of `_resolvedDirectories.delete(...)`-by-prefix.                                                                                          |
| 7.3  | **`fetchChildren(sortOrder)` is THE single async read API**, with a sync fast-path return when nested children are already known. It encapsulates the tree-through cache (resolve-once-then-merge) inside the model.                                                                                                                                                                                      | `workbench/contrib/files/common/explorerModel.ts:312-379`                                                                           | Direct precedent for Tau's proposed `listDirectory` + `listDirectorySync` consolidation in R1/R6.                                                                                                                                                                                                      |
| 7.4  | **`mergeLocalWithDisk` preserves identity** on re-resolve. New disk children that match existing local resources are merged into the existing item; only genuinely new children are added; in-flight `NewExplorerItem`s are preserved.                                                                                                                                                                    | `workbench/contrib/files/common/explorerModel.ts:240-296`                                                                           | Tau's current `patchDirectoryEntries` rebuilds entries from scratch, breaking React keys / render identity on every refresh. R1 must adopt VSCode's merge semantics so refreshes don't unmount/remount the visible tree.                                                                               |
| 7.5  | **Errors live on the tree node** (`ExplorerItem.error: Error \| undefined`), not in a separate hook state. The renderer reads `element.error` and decorates the node accordingly.                                                                                                                                                                                                                         | `workbench/contrib/files/common/explorerModel.ts:91, 325-333` and `workbench/contrib/files/browser/views/explorerViewer.ts:120-169` | Strengthens Tau's R2: errors don't just live in `useDirectoryListing` state — they live on the `FileEntry` itself, so any consumer querying that node sees the error, and a single error can decorate multiple views simultaneously.                                                                   |
| 7.6  | **`[]` is reserved for "directory genuinely empty."** On error, the renderer either inserts a placeholder ExplorerItem with `error: e` (for single-folder workspaces), fires `explorerRootErrorEmitter` for root-level error decorations, or surfaces a notification toast. **The user is never misled by an empty list.**                                                                                | `workbench/contrib/files/browser/views/explorerViewer.ts:144-161`                                                                   | Tau's "No files found." for an error case is exactly the lie this pattern forbids. R2/R3 must enforce the same invariant: `kind: 'ready'` implies the load succeeded; emptiness only reachable through that branch.                                                                                    |
| 7.7  | **Two distinct event streams.** `onDidRunOperation` fires synchronously after writes/moves/deletes through the `FileService` — used for direct, immediate, authoritative model updates (`ExplorerService.onDidRunOperation` mutates the tree in place). `onDidFilesChange` fires from external file-system watchers — debounced through a `RunOnceScheduler` (500 ms) and selectively triggers refreshes. | `platform/files/common/fileService.ts:183-184, 1149-1152` and `workbench/contrib/files/browser/explorerService.ts:35-112, 345-442`  | Tau collapses both into one undifferentiated `ChangeEvent` stream. Splitting them lets internal writes update the model synchronously (no re-resolve round-trip) while external changes use the debounced selective-refresh path.                                                                      |
| 7.8  | **`correlationId` for event origin tracking.** A watcher can pass `correlationId` to receive only its own events; uncorrelated events go through the global stream. Per-watcher emitter, ref-counted, deduplicated.                                                                                                                                                                                       | `platform/files/common/fileService.ts:1161-1216, 1218-1249`                                                                         | Tau's planned `origin: 'self' \| 'external'` field on `ChangeEvent` (per `agent-filesystem-stale-cache-audit.md`) is the same idea but binary. VSCode's correlation ID generalizes it: each requestor receives only its own events, removing the self-write-echo-suppression TTL hack entirely.        |
| 7.9  | **Selective refresh** (`doesFileEventAffect`). When external changes arrive, walk the model checking visibility before scheduling a refresh. ADDED events skip refresh if the parent is unresolved (won't be displayed) OR the child is already in the model (already displayed). UPDATED only triggers when `sortOrder === Modified`. DELETED is always relevant if the resource is visible.             | `workbench/contrib/files/browser/explorerService.ts:65-101, 506-521`                                                                | Tau currently kicks off a re-fetch on every `directoryChanged` event for any resolved directory. Adopting the visibility check eliminates the "every kernel `.tau/cache/<hash>` write triggers a project-root re-resolve" amplification.                                                               |
| 7.10 | **Window-focus refresh as a defensive backstop.** "Refresh explorer when window gets focus to compensate for missing file events" — even with the watcher running, VSCode acknowledges that filesystem events can be missed and refreshes on tab focus.                                                                                                                                                   | `workbench/contrib/files/browser/explorerService.ts:132-137`                                                                        | Tau has no equivalent. Adding a `document.visibilityState === 'visible'` listener that triggers a root-level refresh closes the silent-staleness window after tab switch / OS sleep / network reconnect.                                                                                               |
| 7.11 | **Editing-mode pause.** While a rename or new-file input is open in the tree, file-change scheduler is suppressed so external events don't rip the rug out from under the user.                                                                                                                                                                                                                           | `workbench/contrib/files/browser/explorerService.ts:105-108, 250-253`                                                               | Applies to Tau's chat-editor file-tree rename UX. Not the FileSelector's bug, but it's free correctness once the same refresh primitive is shared.                                                                                                                                                     |
| 7.12 | **Provider-registration changes trigger `forgetChildren` + re-input.** When a `FileSystemProvider` for a scheme is registered or its capabilities change, every root with that scheme calls `forgetChildren()` and the view is re-fed.                                                                                                                                                                    | `workbench/contrib/files/browser/explorerService.ts:114-127`                                                                        | Tau's mount-table changes (project navigation A → B → A) currently leave stale `_treeCache` entries (Finding 6). Wiring `MountTable.mount/unmount` to fire a model-level `forgetChildren(prefix)` removes that entire failure mode.                                                                    |
| 7.13 | **Typed error ladder.** `FileSystemProviderErrorCode` (provider level: `FileNotFound`, `FileExists`, `NoPermissions`, `FileTooLarge`, `Unavailable`, …) → `FileOperationResult` (operation level: `FILE_NOT_FOUND`, `FILE_PERMISSION_DENIED`, …). `FileService.resolve` translates raw provider errors into `FileOperationError` carrying `fileOperationResult`.                                          | `platform/files/common/files.ts:851-920, 1453-1472, 1485-1497`                                                                      | More granular than the `enoent \| aborted \| transport \| unknown` union sketched in R2. Tau should adopt the two-level ladder: provider-level codes for filesystem providers + operation-level codes for `FileTreeService` consumers, with `classifyDirectoryListingError` translating between them.  |
| 7.14 | **`FastAndSlowPicks` pattern for the file picker.** The QuickAccess (Cmd-P) picker can return `{ picks, additionalPicks: Promise<Picks>, mergeDelay }` — fast picks (editor history) appear instantly while slow picks (file search) race against `mergeDelay` to reduce flicker.                                                                                                                         | `platform/quickinput/browser/pickerQuickAccess.ts:97-117, 213-280`                                                                  | Direct application to `FileSelector`: render `listDirectorySync(path)` instantly as the fast picks, await `listDirectory(path)` for the slow picks, merge with a small `mergeDelay` to avoid a flash on already-loaded paths.                                                                          |
| 7.15 | **`CancellationToken` propagated through every async layer.** Every async operation accepts a token. Token is checked after every `await` (`if (token.isCancellationRequested) return [];`). The picker's `ThrottledDelayer` cancels in-flight queries when the user types another character.                                                                                                             | `workbench/contrib/search/browser/anythingQuickAccess.ts:282-345, 552, 565-617`                                                     | Replaces Tau's silent `AbortError` swallow (Finding 2). `listDirectory(path, { signal })` propagates a signal end-to-end; the consumer hook owns the `AbortController` and aborts on path change / unmount. Aborted loads are a typed `kind: 'aborted'` outcome, not a thrown rejection.               |
| 7.16 | **In-flight watcher dedup.** `doWatch` hashes `(resource, options)` and ref-counts identical requests so multiple consumers of the same path share one underlying provider watch.                                                                                                                                                                                                                         | `platform/files/common/fileService.ts:1218-1249`                                                                                    | Same pattern applies to in-flight `listDirectory(path)` requests: dedup by `relativeKey` so concurrent callers (e.g., editor file tree + watermark popover both opening at once) share one resolve. The sketch in `## Code Examples` already includes `_inFlightLoads`, validated by VSCode's pattern. |

The cumulative weight of this evidence: every pattern Tau needs to
adopt to fix this bug exists in VSCode's source, has been battle-tested
across millions of users, and has stable semantics that map cleanly
onto Tau's existing primitives (`FileTreeService`, `WorkspaceFileService`,
`MountTable`, `ChangeEventBus`). The recommendations below are refined
to track VSCode's design where Tau's primitives diverge.

### Finding 8: Primitives already shipped in the parallel refactor

Commit `f96462665` (`refactor(fs-client): extract filesystem client
package with origin-aware event dispatch`, landed concurrent with this
investigation) extracted `packages/fs-client/` from the worker package
and introduced an origin-aware dispatch system whose design rationale
is captured in
[`origin-client-id-propagation-audit.md`](origin-client-id-propagation-audit.md).
Five of the recommendations in earlier drafts of this document map
directly onto primitives that already exist on disk; the remaining
recommendations consume those primitives rather than re-introduce
parallel mechanisms.

| #   | Primitive (file)                                                                                                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Maps to      | Status                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------- |
| 8.1 | [`packages/filesystem/src/event-origin-registry.ts`](../../packages/filesystem/src/event-origin-registry.ts) — WeakMap origin store              | `tagEventOrigin(event, portId)` / `getEventOrigin(event)`. Origin attaches at the **author boundary** (`WorkspaceFileService` mutating methods, via `WorkspaceMutationContext.originClientId`) and is read at the **consumer boundaries** (`EventCoalescer` merge rule + `filesystem-bridge.deliverToHandles` skip-originator filter). Forwarder layers (`ChangeEventBus`, `EventCoalescer.push` transit, `ThrottledWorker`) carry no origin parameter at all.                                 | R9           | ✅ Done                               |
| 8.2 | [`packages/fs-client/src/visibility-provider.ts`](../../packages/fs-client/src/visibility-provider.ts) + `FileTreeService.startPolling`          | `createDomVisibilityProvider()` wraps `document.visibilityState` + `visibilitychange`. `FileTreeService` flips polling between `2000ms` (focused) and `10000ms` (blurred) and restarts polling on visibility-change events. `headlessVisibilityProvider` covers test/non-browser hosts.                                                                                                                                                                                                        | R12          | ✅ Done                               |
| 8.3 | [`packages/fs-client/src/worker-change-channel.ts`](../../packages/fs-client/src/worker-change-channel.ts) — `interestedIn` predicate            | Typed per-event subscriptions (`onFileWritten`, `onFileDeleted`, `onFileRenamed`, `onDirectoryChanged`, `onBackendChanged`) each accept `(relativePath: string) => boolean`. `FileTreeService` uses `_resolvedDirectories.has(...)` as the predicate, so events for unresolved directories never reach subscribers. Implements VSCode's `doesFileEventAffect` path-existence check (Finding 7.9), but the **visibility check** (only refresh if a consumer renders the path) is not yet wired. | R10          | ◐ Partial                             |
| 8.4 | [`packages/fs-client/src/refresh-generation-guard.ts`](../../packages/fs-client/src/refresh-generation-guard.ts) — per-path monotonic counter    | `begin(path)` allocates the next generation; `isCurrent(path, gen)` returns `true` only if no newer `begin` has fired. Solves the "stale async refresh overwrites newer result" problem more sharply than a `_inFlightLoads` map (which only deduplicates concurrent calls — generations also reject late completions when the path was reset/forgotten between `begin` and resolution).                                                                                                       | R14          | ◐ Primitive shipped, consumer pending |
| 8.5 | [`packages/fs-client/src/path-subscriber-registry.ts`](../../packages/fs-client/src/path-subscriber-registry.ts) — path-scoped + global registry | `subscribePath(path, cb)` / `subscribeGlobal(cb)` / `notifyPath(path, evt)` / `notifyGlobal(evt)` with snapshot iteration so callbacks added during delivery don't run in the same pass. `subscribedPaths()` and `hasPathSubscribers(path)` enable the "only refresh paths someone is rendering" predicate the visibility-gated portion of R10 needs.                                                                                                                                          | R1, R3       | ◐ Primitive shipped, consumer pending |
| 8.6 | [`packages/fs-client/src/file-system-client.ts`](../../packages/fs-client/src/file-system-client.ts) — typed RPC surface                         | The thin transport interface consumed by `FileTreeService` and `FileContentService`, distinct from the cache layer. Establishes the stateless-transport split (Finding 7.1) at the type level, ahead of R5's structural deletion of `_treeCache`.                                                                                                                                                                                                                                              | R5           | ◐ Foundation; cache deletion pending  |
| 8.7 | `WorkspaceMutationContext.originClientId` author-boundary parameter on every `WorkspaceFileService` mutating method                              | The single typed parameter that survives at the author boundary after the audit doc's R3–R7 collapsed origin out of forwarder layers.                                                                                                                                                                                                                                                                                                                                                          | R9           | ✅ Done                               |
| 8.8 | `FileSystemObserverBridge` integration in `FileTreeService.startObserving(handle)`                                                               | Native `FileSystemObserver` wrapped behind a graceful-fallback API (`startChangeDetection` tries observe, falls back to polling). Adjacent to R12 — when the observer is active, polling is stopped to avoid double-work.                                                                                                                                                                                                                                                                      | adjacent R12 | ✅ Done                               |

The smoking-gun fix and the consumer-side consolidation remain
unshipped:

| Item                                                                                          | Status         | Notes                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkspaceFileService._treeCache` (worker-side directory cache)                               | ❌ Outstanding | 13 invalidation call sites confirmed by grep on `2026-05-04` (`workspace-file-service.ts:62, 305, 352, 380, 382, 421-423, 450, 475-476, 526, 566-567, 627, 672, 899`). `mkdir(recursive)` still walks ancestors all the way to `/` (Finding 4 unchanged). The smoking-gun fix. |
| `FileTreeService._resolvedDirectories: Set<string>` (global resolved-state set, not per-node) | ❌ Outstanding | Per-`FileEntry` `_isDirectoryResolved` flag (Finding 7.2) not yet introduced.                                                                                                                                                                                                  |
| `FileTreeService.patchDirectoryEntries` (rebuilds entries from scratch)                       | ❌ Outstanding | Identity-preserving `mergeChildren` (Finding 7.4) not yet introduced.                                                                                                                                                                                                          |
| Single `listDirectory` / `listDirectorySync` read API on `FileTreeService`                    | ❌ Outstanding | Four parallel read methods still exist (`readDirectoryEntries`, `readDirectoryEntriesWithStats`, `loadDirectory`, `readdir`).                                                                                                                                                  |
| `useDirectoryListing` hook + `DirectoryListing` discriminated union + two-level error ladder  | ❌ Outstanding | Consumer-facing API not yet introduced; `FileSelector.loadDirectory` still has the silent `try/finally` swallow with `void loadDirectory(path)` at all three call sites.                                                                                                       |
| Errors on `FileEntry`                                                                         | ❌ Outstanding | `FileEntry` has no `error` field; errors only surface as thrown rejections.                                                                                                                                                                                                    |
| Two-stream split (`onDidRunOperation` vs `onDidFilesChange`)                                  | ◐ Partial      | `WorkerChangeChannel` already exposes typed per-event subscriptions on the consumer side, but `WorkspaceFileService` still emits one undifferentiated `fileChanged` stream — internal operations and external watcher events share the same pipe.                              |
| Mount-lifecycle invalidation (`MountTable.{mount,unmount}` → `forgetSubtree(prefix)`)         | ❌ Outstanding | `onBackendChanged` triggers a coarse global `scheduleRefresh('')` rather than a prefix-scoped forget.                                                                                                                                                                          |
| Editing-mode pause                                                                            | ❌ Outstanding | Finding 7.11 not yet implemented; free correctness once R8 lands.                                                                                                                                                                                                              |

The interpretation: **the parallel refactor built the foundation but
has not yet wired the consumer side.** The user-visible bug
(FileSelector empty popover) remains because no consumer reads through
a single typed surface that exhausts the discriminated union — even
though every primitive needed to build that surface is on disk.

## Target Architecture

The architectural defect underlying all six findings is the same: the
workspace exposes **two stores** of "what is in this directory"
(`FileTreeService._tree` on the main thread and
`WorkspaceFileService._treeCache` in the worker), with **independent
populate / invalidate / lifetime semantics**, and **multiple read APIs**
that route different consumers down different sides of that split. The
band-aids enumerated as R1–R7 in earlier drafts each tighten one
divergence path without removing the divergence.

A correct architecture has exactly one cache, with exactly one update
pipe, exposed through exactly one read API.

### Single source of truth

`FileTreeService._tree` becomes the canonical workspace listing for
every consumer that runs against a `FileManagerProvider` — UI, chat
agent RPC tools, headless tests, Electron renderer. The worker's
`WorkspaceFileService` reverts to a thin transport: each
`proxy.readDirectory` call resolves a provider via `MountTable` and
forwards the entries straight to the caller, with no internal cache and
no internal invalidation. The change channel becomes the only mechanism
that mutates `_tree`.

This is exactly VSCode's split: `FileService` is a stateless transport
(no directory cache anywhere — `fileService.resolve` calls
`provider.stat` + `provider.readdir` afresh every time), and the
consumer-side `ExplorerModel` owns the canonical tree (Finding 7.1).

```text
┌─────────────────────────────────────────────────────────────────┐
│ Main thread                                                     │
│                                                                 │
│   ┌──────────────────────────┐   useDirectoryListing(path)      │
│   │ FileTreeService          │◀────────────────────────────────┐│
│   │  _tree (canonical Map)   │                                 ││
│   │  _resolvedDirectories    │                       UI / RPC  ││
│   │  subscribeTree()         │                       consumers ││
│   │  listDirectory(path)     │                                 ││
│   │  listDirectorySync(path) │                                 ││
│   └──────────────┬───────────┘                                  │
│                  │ proxy.readDirectory(absPath) (cold-load only)│
└──────────────────┼──────────────────────────────────────────────┘
                   │              ▲
                   ▼              │ change events (fileWritten,
┌─────────────────────────────────┴───────────────────────────────┐
│ Worker                                                          │
│   ┌──────────────────────────┐   ┌──────────────────────────┐   │
│   │ WorkspaceFileService     │──▶│ ChangeEventBus           │   │
│   │  (thin transport)        │   │ (single update pipe)     │   │
│   │   readDirectory: forward │   └──────────────────────────┘   │
│   │   no _treeCache          │                                  │
│   └──────────┬───────────────┘                                  │
│              │ provider.readdirWithStats(path)                  │
│              ▼                                                  │
│   ┌──────────────────────────┐                                  │
│   │ MountTable → Provider    │                                  │
│   │  (DirectIdb / OPFS / …)  │                                  │
│   └──────────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Single read API with per-node resolved state

`FileTreeService` exposes exactly two methods for directory listings,
plus a reactive subscription. The four parallel async methods that
exist today (`readDirectoryEntries`, `readDirectoryEntriesWithStats`,
`loadDirectory`, plus the worker proxy's `readDirectory`) collapse into
one tree-through cache that mirrors VSCode's
`ExplorerItem.fetchChildren` (Finding 7.3):

```typescript
class FileTreeService {
  /**
   * Canonical async read. Hits `_tree` if the directory has been
   * resolved before; otherwise calls `proxy.readDirectory` exactly
   * once, merges the result into the tree (preserving identity for
   * existing entries), returns the entries from the tree.
   *
   * Rejects with a typed error on failure — never returns `[]` for
   * a missing path or a transport fault. The error is also stored
   * on the `FileEntry` itself so any consumer can read it.
   */
  listDirectory(path: string, options?: { signal?: AbortSignal }): Promise<readonly DirectoryEntry[]>;

  /**
   * Canonical sync read. Returns `undefined` when the directory has
   * not been resolved yet — never `[]`. Consumers that get
   * `undefined` schedule an async `listDirectory` and re-render via
   * `subscribeTree`.
   */
  listDirectorySync(path: string): readonly DirectoryEntry[] | undefined;

  /** Existing reactive subscription (unchanged). */
  subscribeTree(callback: () => void): () => void;
  get completeTreeVersion(): number;
}
```

`DirectoryEntry` carries `name`, `path`, `isFolder`, `size`, `mtimeMs`,
plus an optional `error: DirectoryListingError | undefined` for the
node itself (Finding 7.5). Stat-aware and stat-free consumers share one
shape, killing the `readDirectoryEntries` vs
`readDirectoryEntriesWithStats` fork.

**Per-node resolved state** (Finding 7.2): replace
`FileTreeService._resolvedDirectories: Set<string>` with a per-`FileEntry`
flag (`_isDirectoryResolved: boolean`). The flag travels with the node,
so `forgetChildren(node)` becomes a single mutation on the node instead
of a prefix-walk over a global Set, and re-resolves merge into the
existing node tree without breaking React identity.

**Identity-preserving merge** (Finding 7.4): re-resolves use a
`mergeChildren(diskNodes, localNode)` step that maps disk children by
resource URI, reuses existing local items, and only adds genuinely new
children. This is VSCode's `ExplorerItem.mergeLocalWithDisk`. Tau's
current `patchDirectoryEntries` rebuilds entries from scratch, which
discards stable identity and forces React to remount every visible row
on every refresh — a hidden cost the architectural cleanup also fixes.

### Typed discriminated union for consumers

Every consumer reads through a single hook that surfaces every outcome
explicitly. There is no path that collapses an error or a not-yet-ready
state into `[]`.

```typescript
type DirectoryListing =
  | { kind: 'unready' } // FM not mounted yet
  | { kind: 'loading'; path: string } // first load in flight
  | { kind: 'ready'; path: string; entries: readonly DirectoryEntry[] }
  | { kind: 'error'; path: string; cause: DirectoryListingError };

/**
 * Two-level error ladder mirroring VSCode's
 * `FileSystemProviderErrorCode` → `FileOperationResult` (Finding 7.13).
 * Provider-level codes are the raw errors thrown by `DirectIdbProvider`,
 * `OpfsProvider`, `MemoryProvider`, etc.; operation-level codes are
 * what consumers switch on.
 */
type DirectoryListingError = {
  code: DirectoryListingErrorCode;
  message: string;
  path: string;
  original?: unknown;
};

const enum DirectoryListingErrorCode {
  NotFound, // ENOENT — path does not exist
  NotADirectory, // path exists but is a file
  PermissionDenied, // provider rejected the read
  Aborted, // AbortSignal fired before completion
  Unavailable, // worker/transport down
  Unknown,
}

function useDirectoryListing(path: string): DirectoryListing;
```

`FileSelector`, `chat-editor-file-tree`, `chat-converter`,
`export-selector`, the watermark popover, and any future workspace
listing UI exhaust the discriminated union — the type system makes
"render `[]` on error" structurally unreachable. **`{ kind: 'ready', entries: [] }`
is reserved exclusively for "directory genuinely empty"** (Finding 7.6);
errors are non-empty `kind: 'error'` branches with a typed cause.

The two-level code ladder mirrors VSCode's
`FileSystemProviderErrorCode` → `FileOperationResult` translation, so
consumers can switch on a small enum (`NotFound` / `PermissionDenied`)
instead of inspecting `Error` instances.

### Fast-and-slow render strategy for the FileSelector

The watermark popover (and any future picker) follows VSCode's
`FastAndSlowPicks` pattern (Finding 7.14):

| Step | Source                    | When                                           | UI state                         |
| ---- | ------------------------- | ---------------------------------------------- | -------------------------------- |
| 1    | `listDirectorySync(path)` | Synchronous on `useDirectoryListing` first run | `kind: 'ready'` instantly        |
| 2    | `listDirectory(path)`     | Async on first render or path change           | `kind: 'loading'` if no sync hit |
| 3    | merged result             | Promise resolves                               | `kind: 'ready'` (re-render)      |
| 4    | `directoryChanged` event  | External change while open                     | `kind: 'ready'` (merged update)  |

If the path is already in `_tree` (the common case for the project
root), step 1 produces a `kind: 'ready'` outcome with no loading flicker.
If not, step 2 fires with a small `mergeDelay` to avoid a flash for
near-instant resolves.

### Cancellation

Every `listDirectory(path, { signal })` call propagates the signal end-
to-end (Finding 7.15). `useDirectoryListing` owns the `AbortController`
and aborts on `path` change or component unmount. Aborts surface as
`{ kind: 'error', cause: { code: Aborted, … } }` — never thrown, never
silently swallowed.

### Two update pipes (operation events vs file-change events)

VSCode separates internal operations from external file-system events
(Finding 7.7); Tau adopts the same split:

| Stream              | Trigger                                                                | Semantics                                                 | Tau handler                                                                                |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `onDidRunOperation` | `WorkspaceFileService.{writeFile,mkdir,rename,unlink,copy}` completion | **Authoritative**. Synchronous, immediate model update.   | `FileTreeService.applyOperation(event)` — direct mutation, no re-resolve.                  |
| `onDidFilesChange`  | External filesystem observer / cross-tab broadcast / native watcher    | **Hint**. Debounced through `RunOnceScheduler` (~500 ms). | `FileTreeService.scheduleRefresh()` — selective, only refreshes visible/resolved subtrees. |

Internal writes therefore update the model without a re-resolve round-
trip. External changes go through the debounced selective-refresh path
(Finding 7.9): when the buffered `directoryChanged` events fire,
`FileTreeService` walks the tree and calls
`proxy.readDirectory(path)` only for directories that are both
**resolved** (`_isDirectoryResolved`) and **visible** (subscribed to by
at least one consumer). Tau's current "every kernel `.tau/cache/<hash>`
write triggers a project-root re-resolve" amplification (Finding 4)
disappears.

### Event-origin correlation

Each requestor (file tree, FileSelector, RPC handler, kernel worker)
gets a `correlationId` when it subscribes to changes (Finding 7.8).
Events flow through one of three channels:

```typescript
type ChangeOrigin =
  | { kind: 'self'; correlationId: number } // requestor's own writes
  | { kind: 'peer'; correlationId: number } // a different requestor
  | { kind: 'external' }; // OS/cross-tab/watcher

interface ChangeEvent {
  type: 'fileWritten' | 'fileDeleted' | 'fileRenamed' | 'directoryChanged';
  path: string;
  origin: ChangeOrigin;
}
```

This generalizes the binary `origin: 'self' | 'external'` flag planned
in `agent-filesystem-stale-cache-audit.md`. The TTL self-write-echo-
suppression hack disappears: a requestor filters events by its own
correlation ID. When the kernel worker writes
`/projects/X/.tau/cache/<hash>`, the file-tree subscriber sees a
`{ kind: 'peer', correlationId: KERNEL_WORKER_ID }` event and decides
whether the path is visible (it isn't) before re-resolving.

### Defensive backstops

Two defensive patterns from VSCode close the residual staleness windows:

| Pattern                             | Trigger                                   | Action                                                                                                                            |
| ----------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Window-focus refresh (Finding 7.10) | `document.visibilityState === 'visible'`  | `FileTreeService.refreshVisibleSubtrees()` — re-resolves currently visible/resolved roots.                                        |
| Provider-registration change (7.12) | `MountTable.{mount,unmount}` for a prefix | `FileTreeService.forgetSubtree(prefix)` — clears `_isDirectoryResolved` for the affected nodes; next render triggers a cold load. |

These eliminate the cross-tab worker sharing window in Finding 6 and
the "missed filesystem event" class of bugs.

### Why this resolves the entire class

| Finding                                                 | Resolution under target architecture                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — Two read paths for the same data                   | One store (`_tree`), one API (`listDirectory`/`Sync`), one hook (`useDirectoryListing`). No second path exists.                                             |
| F2 — Silent swallow in `FileSelector.loadDirectory`     | `DirectoryListing` discriminated union + errors-on-`FileEntry` (Finding 7.5). `kind: 'ready', entries: []` reserved for "genuinely empty" (7.6).            |
| F3 — Non-reactive one-shot load                         | `useDirectoryListing` subscribes to `subscribeTree` and re-derives on every tree-version bump and on `path` change. AbortSignal cancels stale loads (7.15). |
| F4 — `_treeCache` ancestor-invalidation cascades        | `_treeCache` no longer exists. Selective refresh (7.9) only re-resolves visible/resolved subtrees.                                                          |
| F5 — No fallback to the synchronous snapshot            | `listDirectorySync` _is_ the snapshot; the `FastAndSlow` strategy (7.14) uses it instantly, async-loads only on miss.                                       |
| F6 — Cross-tab worker sharing widens the failure window | Worker is stateless; `MountTable.unmount` triggers `forgetSubtree(prefix)` (7.12); window-focus refresh (7.10) backstops missed events.                     |

## Recommendations

The recommendation is a single architectural change with discrete,
mergeable milestones. Each milestone is independently shippable and
makes the system measurably better; together they realise the target
architecture above. The **Status** column reflects the parallel
refactor inventory in Finding 8: ✅ shipped, ◐ primitive shipped/
partial, ❌ outstanding.

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Priority | Effort  | Impact                                                                   | Status                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| R1  | **Introduce the canonical read surface on `FileTreeService`.** Add `listDirectory(path, { signal })` (tree-through async with AbortSignal propagation) and `listDirectorySync(path)` (returns `undefined` when not loaded) per the Target Architecture. Adopt VSCode's per-node `_isDirectoryResolved` flag (7.2) on `FileEntry` instead of `_resolvedDirectories: Set<string>`, and replace `patchDirectoryEntries` with an identity-preserving `mergeChildren` (7.4). **Consume `PathSubscriberRegistry` (Finding 8.5)** for the path-scoped notification primitive instead of authoring a new subscriber map. Migrate every internal call site (`readDirectoryEntries`, `readDirectoryEntriesWithStats`, `loadDirectory`, `executeRefresh`) to call `listDirectory` internally.          | P0       | Medium  | Foundation                                                               | ❌                                                                             |
| R2  | **Introduce `useDirectoryListing(path)`, `DirectoryListing`, and the two-level `DirectoryListingError` ladder.** Provider-level codes (`DirectIdbProvider`, `OpfsProvider`, `MemoryProvider`) → operation-level `DirectoryListingErrorCode` enum (`NotFound`, `NotADirectory`, `PermissionDenied`, `Aborted`, `Unavailable`, `Unknown`). Mirrors VSCode's `FileSystemProviderErrorCode` → `FileOperationResult` translation (7.13). Errors live both on the `FileEntry` and in the discriminated-union outcome (7.5).                                                                                                                                                                                                                                                                       | P0       | Low     | Foundation                                                               | ❌                                                                             |
| R3  | **Cut every workspace-listing UI over to `useDirectoryListing` with the FastAndSlow strategy.** `file-selector.tsx`, `chat-editor-file-tree.tsx` empty/loading branches, `chat-converter.tsx`, `export-selector.tsx`, both watermarks. Each consumer renders all four `kind` branches; `kind: 'ready', entries: []` is reserved for "genuinely empty" (7.6) — error states render distinctly with Retry. `listDirectorySync` provides instant first paint; the async load merges with a small `mergeDelay` to avoid flicker (7.14). The hook subscribes through `PathSubscriberRegistry.subscribePath` (Finding 8.5).                                                                                                                                                                       | P0       | Medium  | Closes the user-facing bug                                               | ❌                                                                             |
| R4  | **Cut every workspace-listing RPC handler over to the canonical surface.** `handle-list-directory.ts`, `handle-grep.ts`, `handle-glob-search.ts`, `use-context-payload.ts` use the same `listDirectory` API and propagate `CancellationToken` / `AbortSignal` end-to-end (7.15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P0       | Low     | Closes the agent-facing twin of the bug                                  | ❌                                                                             |
| R5  | **Delete `WorkspaceFileService._treeCache` and `DirectoryTreeCache`.** Remove every `_treeCache.invalidate{,Subtree,Ancestors}` call site (13 in `workspace-file-service.ts` confirmed by grep on `2026-05-04`). `readDirectory(path)` becomes `provider.readdirWithStats(path)` plus the existing child-mount aggregation pass — VSCode's `FileService.resolve` is exactly this thin (7.1). Drop `_treeCache` from `dispose()`. **The smoking gun.**                                                                                                                                                                                                                                                                                                                                       | P0       | Medium  | Eliminates the source of divergence                                      | ❌                                                                             |
| R6  | **Drop the legacy read API.** Once R3 + R4 land, remove `readDirectoryEntries`, `readDirectoryEntriesWithStats`, `loadDirectory` from `FileTreeService`. (No deprecation phase — internal API, roll forward.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | P1       | Trivial | Single API contract                                                      | ❌                                                                             |
| R7  | **Regression coverage at the architectural seam.** New tests in `packages/fs-client/src/file-tree-service.test.ts`: (a) `listDirectory` populates `_tree` and a subsequent `listDirectorySync` returns the same entries, (b) `listDirectory` rejects with `NotFound` when the path is missing — never resolves to `[]`, (c) a `directoryChanged` event triggers selective refresh and the next `listDirectory` re-fetches, (d) re-resolves preserve `FileEntry` identity (`mergeChildren`). New tests in `apps/ui/app/components/files/file-selector.test.tsx`: (e) every `DirectoryListing.kind` branch renders the right UI, (f) Retry on the error branch transitions back to `loading`, (g) `AbortSignal` triggered by path change surfaces as `kind: 'error', cause.code === Aborted`. | P0       | Low     | Prevents regression                                                      | ❌                                                                             |
| R8  | **Split the change channel into `onDidRunOperation` + `onDidFilesChange` streams (7.7).** `WorkspaceFileService.{writeFile,mkdir,rename,unlink,copy}` complete → fire `onDidRunOperation` synchronously; `FileTreeService.applyOperation(event)` mutates the model directly (no re-resolve round-trip). `FileSystemObserver` / cross-tab broadcasts continue to fire `onDidFilesChange` (debounced via `RunOnceScheduler`, ~500 ms). Two separate handlers, two separate event types. The consumer-side fan-out can reuse the typed per-event subscriptions on `WorkerChangeChannel`; the worker-side split (one stream → two streams) is the new work.                                                                                                                                     | P1       | Medium  | Removes write-loop re-resolve cost; preserves UX during external changes | ◐ Consumer-side fan-out shipped (Finding 8.3); worker-side split outstanding   |
| R9  | **Origin-aware dispatch via `event-origin-registry` (Finding 8.1, 8.7).** Already shipped — see [`origin-client-id-propagation-audit.md`](origin-client-id-propagation-audit.md) for the design rationale. Future consumers that need to filter by origin call `getEventOrigin(event)` rather than reading a typed parameter. The audit doc explicitly chose the WeakMap-backed registry over a wire-shape change for the same reasons VSCode keeps `correlationId` intra-process: no consumer-facing `suppressSelf?` flag, no cross-package payload widening. The TTL self-write-echo hack discussed in `agent-filesystem-stale-cache-audit.md` is replaced by the bridge skip-originator filter that already consumes the registry.                                                       | —        | —       | Done                                                                     | ✅                                                                             |
| R10 | **Selective refresh — visibility-gated extension.** The path-existence gate is shipped: `WorkerChangeChannel`'s `interestedIn` predicate on `onFileWritten` / `onFileRenamed` / `onDirectoryChanged` already drops events for unresolved directories (Finding 8.3). The remaining slice is the **visibility check** (Finding 7.9): extend the predicate from `_resolvedDirectories.has(relativePath)` to `_resolvedDirectories.has(relativePath) && pathSubscriberRegistry.hasPathSubscribers(relativePath)`, and split UPDATED vs ADDED vs DELETED handling so UPDATED only triggers when sort-by-modified is on. Removes the kernel-write-storm amplification flagged in F4.                                                                                                              | P1       | Low     | Drastically reduces re-resolve churn                                     | ◐ Path-interest gate done; visibility/event-kind branching outstanding         |
| R11 | **Mount-lifecycle invalidation (7.12).** `MountTable.mount/unmount` for a prefix triggers `FileTreeService.forgetSubtree(prefix)` — the affected `FileEntry` nodes have `_isDirectoryResolved = false`; next render or first consumer cold-loads. Replaces the current coarse global `scheduleRefresh('')` triggered by `onBackendChanged`. Closes F6 directly.                                                                                                                                                                                                                                                                                                                                                                                                                             | P1       | Low     | Eliminates cross-tab stale-cache window                                  | ❌                                                                             |
| R12 | **Window-focus refresh (7.10).** Already shipped as `VisibilityProvider` + visibility-aware polling intervals (Finding 8.2). `FileTreeService.startPolling` flips between `2000ms` (focused) and `10000ms` (blurred) and restarts polling on visibility-change events. The remaining nicety is a single deterministic refresh on tab-becomes-visible (rather than waiting for the next polling interval) — a one-line addition to `createDomVisibilityProvider`'s subscription handler.                                                                                                                                                                                                                                                                                                     | P2       | Trivial | Closes residual staleness windows                                        | ✅ Polling intervals done; deterministic refresh-on-visible nicety outstanding |
| R13 | **Editing-mode pause (7.11).** While a rename input is open in any tree view, suppress the file-change scheduler so external events don't rip the rug from under the user. Free correctness once R8 lands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P2       | Trivial | Avoids tree disruption during inline rename                              | ❌                                                                             |
| R14 | **Consume `RefreshGenerationGuard` for in-flight load semantics (Finding 8.4).** Drop the `_inFlightLoads: Map<string, Promise<void>>` sketch in `## Code Examples` in favour of the shipped `RefreshGenerationGuard`. The guard is strictly stronger than dedup: `begin(path)` allocates a generation token; the cold-load awaits the proxy read; `isCurrent(path, gen)` rejects late completions whose path was reset, forgotten, or re-resolved between begin and resolution. Concurrent `listDirectory(path)` callers (editor file tree + watermark popover opening simultaneously) share the latest generation rather than racing against a stale one.                                                                                                                                 | P1       | Low     | Avoids redundant provider reads + stale-overwrite                        | ◐ Primitive shipped; consumer pending                                          |

Recommended sequencing (anchored on what is already shipped):

0. **Already shipped** — R9 (origin-aware dispatch), R12
   (visibility-aware polling), and the foundational primitives for R1
   (`PathSubscriberRegistry`), R3 (`PathSubscriberRegistry`), R10
   (`WorkerChangeChannel.interestedIn`), and R14
   (`RefreshGenerationGuard`). No further work to start the migration
   from scratch — the building blocks are on disk.
1. **R1 + R2 (foundation)** — additive; no consumer changes yet. Per-
   node `_isDirectoryResolved`, `mergeChildren`, typed error ladder,
   `useDirectoryListing` hook all land here. R1 consumes
   `PathSubscriberRegistry` (8.5) and `RefreshGenerationGuard` (8.4)
   internally; the hook also subscribes through them.
2. **R3 + R4 (cut-over)** — every consumer migrates to the canonical
   surface; the user-facing bug is fixed when this milestone lands.
3. **R5 (worker simplification)** — safe to land once R3+R4 are in
   because no consumer is reading through the worker cache anymore.
4. **R6 (cleanup)** — delete the legacy methods; lint guards against
   reintroduction.
5. **R8 + R10 (event-pipeline cleanup)** — split streams (worker side),
   visibility-gated selective refresh. R9 already done; R10's
   path-interest gate already done. Drops the re-resolve churn from
   F4.
6. **R11 + R12 (delta) + R13 (defensive hardening)** — mount-lifecycle
   invalidation, deterministic refresh-on-visible (R12 nicety),
   editing-mode pause. Each is small and additive.
7. **R7 (regression coverage)** — added incrementally alongside each
   milestone.

## Trade-offs

The decision space is narrower than it appears. There are essentially
three tiers of fix: **band-aids**, **partial structural cleanup**, and
**full single-source-of-truth**. They are not three options — they are
three depths of the same fix, and the user's preference for source-level
correctness over pragmatic shortcuts selects the deepest tier.

| Approach                                                                                             | Eliminates F1 (divergence)?                               | Eliminates F2 (silent swallow)?          | Eliminates F4 (cache cascades)? | Long-term cost                                                      |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| **Band-aid** — add `catch` + Retry button to `FileSelector`                                          | No — empty success cases still surface intermittently     | Yes (locally)                            | No                              | Two stores remain; same class of bug recurs in next consumer        |
| **Partial** — make `FileSelector` consume `_tree` snapshot, keep `_treeCache`                        | Yes for the popover; not for sub-paths or other consumers | Only if errors are typed in the consumer | No                              | Worker still has divergent cache; chat-agent RPC tools still hit it |
| **Full target architecture** — single source of truth, single API, typed union, channel-only updates | Yes — by construction                                     | Yes — type system enforces it            | Yes — `_treeCache` deleted      | One store, one API, one update pipe; no recurrence vector           |

The full target architecture is also the _smallest_ code surface in
steady state: `FileTreeService` ends up with one read method instead of
four, `WorkspaceFileService` loses ~30 invalidation call sites and a
~250-line `DirectoryTreeCache`, and every UI consumer ends up shorter
because the `try/finally`/`void promise()` boilerplate disappears in
favour of an exhaustive switch over `DirectoryListing.kind`.

Net change in source surface — re-baselined for the parallel
refactor (lines already shipped are excluded so this estimate
reflects only the remaining migration):

| Change                                                                                                 | Lines                                     | Status                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Delete `DirectoryTreeCache` + tests (R5)                                                               | −250                                      | Outstanding                                                                                                                        |
| Delete `_treeCache` invalidation call sites (R5; 13 sites)                                             | −80                                       | Outstanding                                                                                                                        |
| Delete redundant `readDirectoryEntries*` APIs (R6)                                                     | −60                                       | Outstanding                                                                                                                        |
| Delete blanket `scheduleRefresh` on every `directoryChanged` (R10 visibility-gate)                     | −30                                       | Outstanding                                                                                                                        |
| Add `listDirectory`/`listDirectorySync` + `mergeChildren` (R1)                                         | +90                                       | Outstanding                                                                                                                        |
| Add `useDirectoryListing` + typed error ladder (R2) — consumes shipped `PathSubscriberRegistry`        | +90                                       | Outstanding (smaller than prior estimate: registry already provides path-scoped subscription)                                      |
| Add `applyOperation` direct-update path (R8 worker-side split)                                         | +40                                       | Outstanding                                                                                                                        |
| Add visibility-gated `doesFileEventAffect` extension on `WorkerChangeChannel` predicates (R10)         | +20                                       | Outstanding (path-interest gate already shipped)                                                                                   |
| Add mount-lifecycle invalidation + editing-mode pause (R11 + R13)                                      | +40                                       | Outstanding                                                                                                                        |
| `event-origin-registry` + `WorkspaceMutationContext` plumbing (R9)                                     | 0 (≈+50 already on disk)                  | ✅ Shipped — no further additions on this axis                                                                                     |
| `VisibilityProvider` + visibility-aware polling (R12)                                                  | 0 (≈+70 already on disk)                  | ✅ Shipped — `+5` for deterministic refresh-on-visible nicety                                                                      |
| `RefreshGenerationGuard` (R14)                                                                         | 0 (≈+45 already on disk; +20 to consume)  | ◐ Primitive shipped; consumer wiring outstanding                                                                                   |
| `PathSubscriberRegistry` (R1, R3)                                                                      | 0 (≈+110 already on disk; +20 to consume) | ◐ Primitive shipped; consumer wiring outstanding                                                                                   |
| `WorkerChangeChannel.interestedIn` typed fan-out (R10 path-interest gate)                              | 0 (≈+200 already on disk)                 | ✅ Shipped                                                                                                                         |
| Migrate consumers (net simplification — `FileSelector`, `chat-editor-file-tree` empties, RPC handlers) | −150                                      | Outstanding                                                                                                                        |
| **Net (remaining migration only)**                                                                     | **−290**                                  |                                                                                                                                    |
| Memo: cumulative net once shipped + remaining is summed                                                | **−195**                                  | (≈ same target as the earlier −200 estimate; the surface is smaller because primitives already shipped reduced the additive total) |

## Code Examples

### Reproducing Finding 2 from Vitest

The current contract:

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileSelector } from '#components/files/file-selector.js';

const failingDataSource = {
  async loadDirectory() {
    throw new Error('ENOENT: provider missing _dirs entry');
  },
  async searchFiles() {
    return [];
  },
};

it('SHOULD surface the error to the user (currently FAILS)', async () => {
  render(
    <FileSelector
      dataSource={failingDataSource}
      selectedFile={undefined}
      onSelect={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole('button'));

  // Today: passes — the lie is rendered.
  expect(screen.getByText('No files found.')).toBeInTheDocument();

  // After R2: should pass instead.
  expect(screen.queryByText('No files found.')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load files/i);
  expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
});
```

### Sketch of the target-architecture fix

`FileTreeService` exposes a single tree-through read API. The cold-
load path consumes the shipped
[`RefreshGenerationGuard`](../../packages/fs-client/src/refresh-generation-guard.ts)
(Finding 8.4) for stale-overwrite protection rather than a bespoke
`_inFlightLoads` map:

```typescript
// packages/fs-client/src/file-tree-service.ts
import { RefreshGenerationGuard } from '#refresh-generation-guard.js';

export class FileTreeService {
  private readonly _refreshGuard = new RefreshGenerationGuard();
  // _isDirectoryResolved travels with each FileEntry (per-node, Finding 7.2)
  // — no global Set<string>.

  public async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const relativeKey = this.relativeDirectoryKeyFromUserPath(path);
    const node = this._tree.get(relativeKey);
    if (node?._isDirectoryResolved) {
      return this.entriesAtLevel(relativeKey);
    }
    const generation = this._refreshGuard.begin(relativeKey);
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    const entries = await this.proxy.readDirectory(absolutePath);
    if (!this._refreshGuard.isCurrent(relativeKey, generation)) {
      // A newer begin() has fired (path was forgotten, mount changed,
      // or a more recent listDirectory superseded us). Discard the
      // stale read; the newer caller's entries will land in the tree.
      return this.entriesAtLevel(relativeKey);
    }
    this.mergeChildren(relativeKey, entries); // identity-preserving (Finding 7.4)
    return this.entriesAtLevel(relativeKey);
  }

  public listDirectorySync(path: string): readonly DirectoryEntry[] | undefined {
    const relativeKey = this.relativeDirectoryKeyFromUserPath(path);
    const node = this._tree.get(relativeKey);
    return node?._isDirectoryResolved ? this.entriesAtLevel(relativeKey) : undefined;
  }

  private async coldLoad(path: string, relativeKey: string): Promise<void> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    const entries = await this.proxy.readDirectory(absolutePath);
    this.mergeChildren(relativeKey, entries);
  }
}
```

The reactive consumer hook surfaces every outcome. Path-scoped
subscription is handled via the shipped
[`PathSubscriberRegistry`](../../packages/fs-client/src/path-subscriber-registry.ts)
(Finding 8.5) so that re-renders fire only when _this_ path is
affected, not on every tree version bump:

```typescript
// packages/fs-client/src/react/use-directory-listing.ts
export function useDirectoryListing(path: string): DirectoryListing {
  const fileManager = useOptionalFileManager();
  const treeService = fileManager?.treeService;

  const subscribe = useCallback(
    (callback: () => void) => treeService?.subscribePath(path, callback) ?? noop,
    [treeService, path],
  );
  const getSnapshot = useCallback(() => treeService?.listDirectorySync(path), [treeService, path]);

  const sync = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  const [error, setError] = useState<DirectoryListingError | undefined>(undefined);

  useEffect(() => {
    if (!treeService) return;
    if (sync !== undefined) return;
    const controller = new AbortController();
    treeService.listDirectory(path, { signal: controller.signal }).then(
      () => setError(undefined),
      (cause) => {
        if (controller.signal.aborted) return;
        setError(classifyDirectoryListingError(cause));
      },
    );
    return () => controller.abort();
  }, [treeService, path, sync !== undefined]);

  if (!treeService) return { kind: 'unready' };
  if (error) return { kind: 'error', path, cause: error };
  if (sync !== undefined) return { kind: 'ready', path, entries: sync };
  return { kind: 'loading', path };
}
```

`treeService.subscribePath(path, callback)` is a thin facade over
`PathSubscriberRegistry.subscribePath` that the new R1 work adds; the
registry is already on disk, fully tested, and uses snapshot
iteration so callbacks added during a notification pass are not
re-entered in the same delivery.

`FileSelector` exhausts the union — the type system makes the
"render `[]` on error" path structurally unreachable:

```typescript
// apps/ui/app/components/files/file-selector.tsx
const listing = useDirectoryListing(currentPath);

switch (listing.kind) {
  case 'unready':
    return <FileSelectorUnready />;
  case 'loading':
    return <FileSelectorLoading />;
  case 'error':
    return <FileSelectorError cause={listing.cause} onRetry={() => bumpRetry()} />;
  case 'ready':
    return <FileSelectorList entries={listing.entries} onSelect={handleSelect} />;
}
```

The worker `WorkspaceFileService.readDirectory` reverts to a thin
forwarder:

```typescript
// packages/filesystem/src/workspace-file-service.ts
public async readDirectory(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<FileTreeNode[]> {
  options?.signal?.throwIfAborted();
  const provider = this._mountTable.resolve(path);
  const entries = await provider.readdirWithStats(path, options);
  options?.signal?.throwIfAborted();
  return this.aggregateChildMounts(path, entries);
}
```

Note the absence of `_treeCache.get(path)`, `_treeCache.set(path, …)`,
and the entire `if (cached) { return cached; }` branch. The worker has
nothing to invalidate, nothing to evict, and nothing to keep in sync
with `_tree`. `mkdir(recursive: true)`, `writeFile`, `rename`, `unlink`,
`copyFile`, and `copyDirectory` lose every `_treeCache.*` call — they
emit change events as before, and `FileTreeService` listens.

### Cache invalidation cascade — illustrating Finding 4

```typescript
// Provider state after kernel writes /projects/X/.tau/cache/<hash>.glb:
treeCache.invalidateAncestors('/projects/X/.tau/cache/<hash>.glb');
// → deletes:
//   /projects/X/.tau/cache/<hash>.glb
//   /projects/X/.tau/cache
//   /projects/X/.tau
//   /projects/X
//   /projects
//   /

// Next FileSelector open:
proxy.readDirectory('/projects/X');
// → cache miss
// → resolveProvider('/projects/X') returns project mount
// → provider.readdirWithStats('/projects/X')
// → if anything in this chain rejects, FileSelector silently shows "No files found."
```

## References

- Prior research: `docs/research/agent-empty-directory-false-positive.md`
  (R1+R2+R3 there fixed the agent surface; this investigation extends the
  same lens to the UI surface).
- Prior research: `docs/research/agent-filesystem-stale-cache-audit.md`
  (background on the change-channel fan-out into both `treeService` and
  `contentService`).
- Prior research: `docs/research/file-services-architecture-blueprint.md`
  (the `FileTreeService` / `FileContentService` split this finding builds
  on; landed alongside the parallel refactor that produced Finding 8).
- Prior research: `docs/research/origin-client-id-propagation-audit.md`
  (the design rationale for the WeakMap-backed `event-origin-registry`
  that satisfies R9; explains why origin is attached at the author and
  consumer boundaries while forwarder layers stay origin-blind).
- Policy: `docs/policy/filesystem-policy.md` (reactive change-channel
  expectations; canonical contracts for tree consumers).
- Tau code under audit:
  - `apps/ui/app/components/files/file-selector.tsx`
  - `apps/ui/app/routes/projects_.$id/chat-viewer-dockview.tsx`
  - `apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx`
  - `apps/ui/app/hooks/use-file-tree.ts`
  - `apps/ui/app/machines/file-manager.machine.ts`
  - `packages/fs-client/src/file-tree-service.ts`
  - `packages/filesystem/src/workspace-file-service.ts`
  - `packages/filesystem/src/directory-tree-cache.ts`
  - `packages/filesystem/src/mount-table.ts`
  - `packages/filesystem/src/backend/direct-idb-provider.ts`
- Parallel-refactor primitives (Finding 8):
  - `packages/filesystem/src/event-origin-registry.ts` — WeakMap
    origin store (R9 ✅).
  - `packages/fs-client/src/visibility-provider.ts` — DOM visibility
    abstraction (R12 ✅).
  - `packages/fs-client/src/worker-change-channel.ts` — typed
    per-event subscriptions with `interestedIn` predicate (R10
    path-interest gate ✅).
  - `packages/fs-client/src/refresh-generation-guard.ts` — per-path
    monotonic generations (R14 ◐).
  - `packages/fs-client/src/path-subscriber-registry.ts` — path-scoped
    - global subscriber registry (R1, R3 ◐).
  - `packages/fs-client/src/file-system-client.ts` — typed RPC surface
    distinct from cache (R5 foundation).
- VSCode reference architecture (read in full from `repos/vscode/` —
  see Finding 7 for the pattern map):
  - `repos/vscode/src/vs/platform/files/common/fileService.ts` —
    stateless transport (`resolve` has no directory cache); two event
    streams (`onDidRunOperation`, `onDidFilesChange`); per-watcher
    correlation IDs; deduplicated watch requests.
  - `repos/vscode/src/vs/platform/files/common/files.ts` — typed error
    ladder (`FileSystemProviderErrorCode`, `FileOperationResult`,
    `FileOperationError`).
  - `repos/vscode/src/vs/workbench/contrib/files/common/explorerModel.ts` —
    canonical workspace model. Per-node `_isDirectoryResolved`,
    `fetchChildren(sortOrder)` tree-through cache, `mergeLocalWithDisk`
    identity-preserving merge, `forgetChildren` invalidation, errors-
    on-node.
  - `repos/vscode/src/vs/workbench/contrib/files/browser/explorerService.ts` —
    debounced `RunOnceScheduler` for external file changes,
    `doesFileEventAffect` selective-refresh helper, mount-/provider-
    registration `forgetChildren` propagation, window-focus refresh,
    editing-mode pause, direct model updates from `onDidRunOperation`.
  - `repos/vscode/src/vs/workbench/contrib/files/browser/views/explorerViewer.ts` —
    error rendering: placeholder error item for single-folder
    workspaces, root-error decoration emitter, notification toast for
    non-root errors. **Never `[]` on error.**
  - `repos/vscode/src/vs/platform/quickinput/browser/pickerQuickAccess.ts` —
    `FastAndSlowPicks` type and merging logic for the file picker.
  - `repos/vscode/src/vs/workbench/contrib/search/browser/anythingQuickAccess.ts` —
    `ThrottledDelayer` for keystroke debouncing, `CancellationToken`
    propagation, fast-and-slow picks integration with editor history
    and file search.
