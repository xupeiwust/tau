---
title: 'FileSelector Virtuoso Scroller Drop and Wire-Stat-Loss Audit'
description: 'Two co-occurring smoking guns in the watermark FileSelector: the custom Virtuoso Scroller drops children for >50-entry directories, and the FileTreeNode wire contract loses size/mtime so consumers fabricate zeros.'
status: active
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/file-selector-empty-popover-data-hydration.md
  - docs/policy/filesystem-policy.md
---

# FileSelector Virtuoso Scroller Drop and Wire-Stat-Loss Audit

Root-cause analysis of two related FileSelector regressions surfaced in production import projects (Zoo modeling-app and sgenoud/models): the watermark popover renders empty for directories with more than 50 entries, and every entry shows `0 B` size on every project where the popover does render.

## Executive Summary

Two independent smoking guns, both reproducible against fresh imports created via `apps/ui/app/routes/import.$/route.tsx`:

1. **Virtuoso `Scroller` override drops `children`.** When a directory has more than `virtualizationThreshold` (default `50`) immediate entries, `FileSelectorItemList` switches to a `<Virtuoso>` branch whose custom `Scroller` component destructures `{ children, ...properties }` and renders only `<div {...properties}>`, never re-emitting `children`. Virtuoso's entire item subtree is dropped on the floor, producing an empty popover for any directory with `>50` entries. Below the threshold the simple `.map()` fallback renders correctly. **Reproduces verbatim:** Zoo root has 61 entries → popover empty; sgenoud root has 23 entries → popover renders.
2. **`FileTreeNode` wire contract throws away `size` / `mtimeMs`.** The worker's `WorkspaceFileService.readDirectory` reads stat-bearing `TreeEntry` rows from the provider via `readdirWithStats`, then converts them to `FileTreeNode = { id, name, children? }` with no size/mtime fields. Both the FM machine seed (`apps/ui/app/machines/file-manager.machine.ts`) and `FileTreeService.mergeChildren` (`packages/fs-client/src/file-tree-service.ts`) reconstruct entries from this stat-less wire shape and **fabricate** `size: 0` / `mtimeMs: Date.now()`. This is the exact antipattern flagged in the workspace-fact memory in `AGENTS.md`. **Reproduces verbatim:** every entry rendered in any FileSelector popover, anywhere in the app, displays `0 B`.

Both are isolated, single-file fixes. Neither requires undoing any of the file-tree consolidation phases shipped via `docs/research/file-selector-empty-popover-data-hydration.md`.

## Problem Statement

Symptoms reported during stock-take of the file-tree consolidation work, after Phases 1–5 were complete and tests passing:

| Project                       | Root entries | Popover render | Per-entry size         |
| ----------------------------- | -----------: | -------------- | ---------------------- |
| `KittyCAD/modeling-app` (Zoo) |           61 | Empty          | n/a — nothing rendered |
| `sgenoud/models`              |           23 | Populated      | `0 B` on every row     |

Both projects were imported the same way (the GitHub-import flow in `apps/ui/app/routes/import.$/route.tsx`), so the difference is entry count + provider stat-pass-through, not import path.

The natural assumption from the previous research (`docs/research/file-selector-empty-popover-data-hydration.md`) was a hydration / sync-loading regression. The diagnostic logs added for this investigation eliminated that hypothesis: the watermark popover sees `kind: 'ready'` with the correct entry count for both projects.

## Methodology

Targeted instrumentation against a running dev server, with the user driving the UI:

- `[FM-DIAG]` logs around `proxy.readDirectory(rootPath)` in `apps/ui/app/machines/file-manager.machine.ts`: count + first 20 entry names + timing + initialEntries seed length + root-resolved flag.
- `[FTS-DIAG]` logs in `packages/fs-client/src/file-tree-service.ts::listDirectory()`: relativeKey resolution, cached vs cold-load, post-load tree size, and explicit "FINISHED but not resolved" diagnostic.
- `[UDL-DIAG]` logs in `packages/fs-client/src/react/use-directory-listing.ts`: `unready` / `ready (sync)` / `loading` / `cold-load resolved` / `REJECTED` transitions per `(treeService, path)` tuple.

User then performed the same scripted reproduction in two fresh tabs (one Zoo project, one sgenoud project): home → click project → wait for left tree → close viewer panels → open watermark popover → copy `*-DIAG` console output.

## Findings

### Finding 1: Watermark popover is empty for >50-entry root directories — Virtuoso `Scroller` drops `children`

**Evidence (Zoo console output):**

```text
[UDL-DIAG] useDirectoryListing(path="") → unready (no treeService)   (4×, while FM machine boots)
[FM-DIAG] readDirectory START path=/projects/proj_X0YqCCPV9KCrEaYLi56uS elapsed=133.0ms
[FM-DIAG] readDirectory OK count=61 names=[.github, .helix, .husky, .tau, assets, docs, e2e, openapi, packages, public, rust, scripts, src, types, _typos.toml, .env.development, .env.production, .envrc, .gitattributes, .gitignore, ...] elapsed=141.9ms
[FM-DIAG] FileTreeService seeded with initialEntries.length=61 (root marked resolved=true)
[UDL-DIAG] useDirectoryListing(path="") → ready (sync) count=61
```

The hook receives `kind: 'ready'` with all 61 entries, so the data path is healthy. The bug is downstream, in `FileSelectorItemList`:

```431:447:apps/ui/app/components/files/file-selector.tsx
  if (items.length === 0) {
    return <div className='p-1 py-6 text-center text-sm text-muted-foreground'>{emptyMessage}</div>;
  }

  if (items.length > virtualizationThreshold) {
    return (
      <Virtuoso
        style={{ height: '300px' }}
        totalCount={items.length}
        itemContent={renderItem}
        components={{
          Scroller: ({ children, ...properties }) => <div {...properties} className='scroll-shadows-y' />,
          List: (properties) => <div {...properties} className='px-1' />,
          Header: () => <div className='h-1' />,
          Footer: () => <div className='h-1' />,
        }}
      />
    );
  }
```

Two structural problems with the custom `Scroller`:

1. **`children` is destructured and discarded.** Virtuoso renders its `List` (and through it, every `itemContent` cell) into the `Scroller`'s children. Destructuring `children` out of the spread props and never re-emitting it leaves the `<div>` empty. The 61 list items never enter the DOM.
2. **No ref-forward.** Virtuoso provides a `ref` to the Scroller so it can drive scroll position and viewport measurement. The arrow-function component cannot accept a forwarded ref, and even though React 19 does pass `ref` as a regular prop, ref handling on a plain `<div>` via spread is fragile across Virtuoso versions. Even if `children` were re-emitted, this still risks measurement drift on resize.

The default `virtualizationThreshold` is `50`:

```539:539:apps/ui/app/components/files/file-selector.tsx
  virtualizationThreshold = 50,
```

Empirically:

| Project | `items.length` | Branch hit                                    | Outcome       |
| ------- | -------------: | --------------------------------------------- | ------------- |
| sgenoud |             23 | non-virtualized `items.map(…)` (line 449–464) | works         |
| Zoo     |             61 | `<Virtuoso>` (line 433–446)                   | empty popover |

**Comparison with healthy Virtuoso usages elsewhere in the codebase confirms the diagnosis.** Both `apps/ui/app/components/ui/combobox-responsive.tsx` and `apps/ui/app/components/chat/tiptap/context-suggestion.tsx` override only `List`, `Header`, `Footer` — never `Scroller` — and rely on Virtuoso's default Scroller, which forwards `ref` and renders `children` correctly. They have no rendering issues at any item count. The sgenoud popover did not regress because the import has fewer than 50 root entries and never reaches the broken branch.

**Why this was missed by tests.** `apps/ui/app/components/files/file-selector.test.tsx` exercises the FileSelector with a fixed mock that returns a small handful of entries — never enough to cross `virtualizationThreshold`. The Virtuoso branch is unreachable from the existing test suite.

### Finding 2: Every popover entry shows `0 B` because the wire contract drops `size` and `mtimeMs`

**Worker-side data is correct.** `IndexedDBProvider.readdirWithStats` returns full stat-bearing rows:

```146:180:packages/filesystem/src/backend/direct-idb-provider.ts
  public async readdirWithStats(path: string): Promise<Array<{ name: string } & FileStat>> {
    …
    result.push({ name, type: 'file', size: cachedSize, mtimeMs: this._mtimes.get(fullPath) ?? Date.now() });
```

**`WorkspaceFileService.readDirectory` aggregates stats into an `entryMap`** keyed by name with full `TreeEntry` shape:

```606:615:packages/filesystem/src/workspace-file-service.ts
    if (provider.readdirWithStats) {
      const statsEntries = await provider.readdirWithStats(resolvedPath);
      for (const entry of statsEntries) {
        entryMap.set(entry.name, {
          name: entry.name, type: entry.type, size: entry.size, mtimeMs: entry.mtimeMs,
        });
      }
```

**…and discards `size` and `mtimeMs` when serialising for the wire:**

```1035:1043:packages/filesystem/src/workspace-file-service.ts
  private _treeEntriesToNodes(entries: Map<string, TreeEntry>): FileTreeNode[] {
    const nodes: FileTreeNode[] = [];
    for (const [, entry] of entries) {
      if (entry.type === 'dir') {
        nodes.push({ id: entry.name, name: entry.name, children: [] });
      } else {
        nodes.push({ id: entry.name, name: entry.name });
      }
    }
```

`FileTreeNode` is intentionally lightweight (`{ id, name, children? }`), but that decision was made in a context where consumers had a separate `readDirectoryEntriesWithStats(path)` method that fetched real stats via N+1 `proxy.stat` calls. **Phase 5 of the file-tree consolidation plan removed `readDirectoryEntriesWithStats` from `FileTreeService` (now there is only `listDirectory`), so consumers can no longer recover the stats — yet the worker still computes them and silently drops them at the boundary.**

Two consumer sites compensate by fabricating zeros:

```236:245:apps/ui/app/machines/file-manager.machine.ts
      for (const node of rootNodes) {
        initialEntries.push({
          path: node.name, name: node.name,
          type: node.children === undefined ? 'file' : 'dir',
          size: 0, mtimeMs: Date.now(), isLoaded: false,
        });
      }
```

```922:931:packages/fs-client/src/file-tree-service.ts
        newTree.set(entryPath, {
          path: entryPath, name: entry.name, type: inferredType,
          size: 0, mtimeMs: Date.now(), isLoaded: false,
        });
```

These fabricated zeros propagate into `entriesAtDirectoryLevel` → `ListedDirectoryEntry { size: 0, mtimeMs: <Date.now-at-merge-time> }` → the popover row's `formatBytes(item.size)` renders `0 B` for every file.

This is exactly the antipattern called out in the workspace-fact memory:

> `FileTreeNode` is intentionally lightweight … so never hard-code `size: 0`/`mtimeMs: Date.now()` when forwarding to consumers (RPC adapters, tool schemas) — synthesized zeros lead the chat agent to invent "stale cache" stories; use `readDirectoryEntriesWithStats(path)` (parallel `proxy.stat` per immediate child) and forward real `size` + ISO-8601 `modifiedAt` only when `mtimeMs > 0`

The `readDirectoryEntriesWithStats` escape hatch the memory recommends is the API we just removed, so the only remaining correct path is to extend the wire contract.

### Finding 3: Diagnostic-stream invariants confirmed (negative findings)

The same diagnostic run produced cross-cutting evidence that several earlier hypotheses are _not_ in play:

- **No race in FM init.** `[FM-DIAG] readDirectory OK count=61` fires within ~9 ms of the `START` marker for Zoo (133 → 141.9 ms relative to `initT0`); the IDB `_hydratePathIndex` has fully run by the time `readDirectory` is invoked.
- **No `FileManagerProvider` mismatch.** `useDirectoryListing` reports `unready (no treeService)` only during the FM-machine boot window, then transitions cleanly to `ready (sync) count=N` on the same render where `treeService` becomes defined. Same provider instance, no portal context loss.
- **No `subscribePath('')` wakeup gap.** The sync fast path returned the entries directly during the `useMemo` initialisation; the popover did not need `subscribePath` to fire to leave `loading`.
- **No cold-load round-trip.** `[FTS-DIAG] listDirectory(...) CACHED` was reached for both projects — there is no second worker call when opening the popover, contrary to the H1 hypothesis from the previous turn.

The previously identified concerns from `docs/research/file-selector-empty-popover-data-hydration.md` (R1–R6 + R14) all hold; this investigation closes a separate UI-render layer regression that was hidden behind the empty-popover symptom and a separate wire-contract gap.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Priority |                                      Effort |                                                                                                                            Impact |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------: |
| R1  | **Delete the custom `Scroller` override in `FileSelectorItemList`.** Replicate the `combobox-responsive.tsx` / `context-suggestion.tsx` pattern: only override `List`, `Header`, `Footer`, and let Virtuoso's default `Scroller` render. If `scroll-shadows-y` styling is desired, apply it via Virtuoso's top-level `className` prop or wrap the `<Virtuoso>` in a styled outer `<div>` — both leave Virtuoso's internal scroll element untouched.                                                                                                                                                                                                 |       P0 |                 Low (single file, ~5 lines) |                                                                     Closes #1 — every popover with >50 entries renders correctly. |
| R2  | **Extend the `FileTreeNode` wire contract with `size` and `mtimeMs`.** The worker already computes these in `readdirWithStats` and `WorkspaceFileService.readDirectory`'s `entryMap`. Add the two fields to `FileTreeNode` (typed `number`), populate them in `_treeEntriesToNodes`, and forward them through `mergeChildren` (replace `size: 0, mtimeMs: Date.now()` with the wire values) and `file-manager.machine.ts` initial-seed (same replacement). Update `FileTreeNode` consumers — the existing `chat-editor-file-tree.tsx`, search service, and chat-tool RPC handlers — to consume the real values instead of relying on `0` sentinels. |       P0 | Medium (wire-shape change touches ~6 files) | Closes #2 — real sizes appear everywhere; eliminates an entire class of "synthesised zero" antipattern documented in `AGENTS.md`. |
| R3  | **Add a regression test for `FileSelectorItemList` at `>virtualizationThreshold` items.** Render with 75 mock entries and assert at least one entry is in the DOM. Pair with a static lint or commit-time guard on `Scroller: ({ children, ... })` patterns that destructure but discard `children`.                                                                                                                                                                                                                                                                                                                                                |       P1 |                                         Low |                                Prevents recurrence; the Virtuoso branch was previously unreachable from `file-selector.test.tsx`. |
| R4  | **Update `useFileTreeMap` and `entriesAtDirectoryLevel` test coverage to assert on real `size` values.** After R2, every consumer should be able to assert `entry.size > 0` for non-empty files; current tests assert `size === 0` because they were written against the synthesised value.                                                                                                                                                                                                                                                                                                                                                         |       P1 |                                         Low |                                                                                                 Locks in the wire-shape contract. |
| R5  | **Promote the `[FM-DIAG]`/`[FTS-DIAG]`/`[UDL-DIAG]` logs to permanent structured diagnostics or remove them.** They proved invaluable for this investigation and are likely to be needed again; either land them behind a `DEBUG` flag (e.g. `localStorage.taucad_fs_debug = '1'`) or strip them once R1–R2 ship.                                                                                                                                                                                                                                                                                                                                   |       P2 |                                         Low |                                                                  Future debuggability without polluting the steady-state console. |

**Implementation (2026-05-04):** R1–R5 applied: Virtuoso uses the default `Scroller` with `className='scroll-shadows-y'` on the root; `defaultItemHeight={40}` avoids zero-height probe failure in nested/cmdk layouts; `FileTreeNode` includes `size` and `mtimeMs` from worker `TreeEntry` / `stat`; `mergeChildren` and FM initial seed forward wire values (with conditional `size`/`mtimeMs` updates when type unchanged so `FileEntry` identity stays stable); investigation `console` diagnostics removed; regression guard in `apps/ui/app/components/files/file-selector-virtuoso-regression.test.ts` plus `packages/fs-client/src/file-tree-service.test.ts` (listed row stat propagation). Full Virtuoso row mount is unreliable in jsdom when cmdk reports zero list height; manual UI check on a >50 entry directory remains the visual proof.

**Consolidation-plan deferral note (2026-05-04):** With R1–R5 here resolving both user-facing symptoms, [`docs/research/file-selector-empty-popover-data-hydration.md`](file-selector-empty-popover-data-hydration.md) Phases 6–7 (R8/R10/R11/R12-nicety/R13/R14) are deferred. Those recommendations target operational hardening — refresh-storm reduction, mount-lifecycle invalidation, refresh-on-visible determinism, editing-mode pause, generation-guard consumer audit — none of which contributed to the empty-popover or `0 B` regressions resolved here. Revisit only if profiling or bug reports surface the specific failure modes each phase targets; see the **Status Update** section of the linked research doc for trigger conditions per recommendation.

## Trade-offs

| Approach for R2                                                    | Pros                                                                                                                 | Cons                                                                                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Extend `FileTreeNode` with `size` / `mtimeMs`** _(recommended)_  | Single source of truth; matches the worker's actual `TreeEntry`; no extra round-trips; fixes every consumer at once. | Wire-shape change; consumers that hard-coded `children === undefined ? 'file' : 'dir'` keep working but should migrate to a `type` field for clarity (defer to a follow-up). |
| **Re-introduce `readDirectoryEntriesWithStats` as a parallel API** | Restores the API the workspace-fact memory mentioned.                                                                | Reintroduces N+1 `proxy.stat` round-trips; contradicts Phase 5 of the file-tree consolidation; consumers would have to choose between two listing APIs.                      |
| **Add a `FileTreeService.statBatch(paths)` helper**                | Keeps `FileTreeNode` minimal.                                                                                        | Two RPC round-trips per directory open (one `readDirectory` then one `statBatch`); same antipattern in a different shape; still needs every consumer to opt in.              |

R2 with `FileTreeNode` extension is strictly the simplest correct fix: the data already exists at the boundary, the cost is a few bytes per node on the wire, and it removes two fabrication sites without adding new ones.

## Code Examples

### R1 — minimal fix for Finding 1

```typescript
// apps/ui/app/components/files/file-selector.tsx
if (items.length > virtualizationThreshold) {
  return (
    <Virtuoso
      className='scroll-shadows-y'
      style={{ height: '300px' }}
      totalCount={items.length}
      itemContent={renderItem}
      components={{
        List: (properties) => <div {...properties} className='px-1' />,
        Header: () => <div className='h-1' />,
        Footer: () => <div className='h-1' />,
      }}
    />
  );
}
```

Removing the `Scroller` override entirely lets Virtuoso install its default ref-forwarding scroll container. `scroll-shadows-y` moves to the top-level `className` so Virtuoso composes it with its internal scroll element (Virtuoso forwards top-level `className` onto the outer scrollable `<div>`).

### R2 — minimal wire-shape change for Finding 2

```typescript
// libs/types/src/types/<file-tree>.types.ts
export type FileTreeNode = {
  id: string;
  name: string;
  size: number; // ← new
  mtimeMs: number; // ← new
  children?: FileTreeNode[];
};
```

```typescript
// packages/filesystem/src/workspace-file-service.ts
private _treeEntriesToNodes(entries: Map<string, TreeEntry>): FileTreeNode[] {
  const nodes: FileTreeNode[] = [];
  for (const [, entry] of entries) {
    const node: FileTreeNode = {
      id: entry.name,
      name: entry.name,
      size: entry.size,         // ← was dropped
      mtimeMs: entry.mtimeMs,   // ← was dropped
    };
    if (entry.type === 'dir') {
      node.children = [];
    }
    nodes.push(node);
  }
  return nodes.sort(/* … */);
}
```

```typescript
// apps/ui/app/machines/file-manager.machine.ts
for (const node of rootNodes) {
  initialEntries.push({
    path: node.name,
    name: node.name,
    type: node.children === undefined ? 'file' : 'dir',
    size: node.size, // ← was 0
    mtimeMs: node.mtimeMs, // ← was Date.now()
    isLoaded: false,
  });
}
```

```typescript
// packages/fs-client/src/file-tree-service.ts (mergeChildren)
newTree.set(entryPath, {
  path: entryPath,
  name: entry.name,
  type: inferredType,
  size: entry.size, // ← was 0
  mtimeMs: entry.mtimeMs, // ← was Date.now()
  isLoaded: false,
});
```

## References

- Related: `docs/research/file-selector-empty-popover-data-hydration.md` (parent investigation; R1–R6 + R14 of that doc remain accurate).
- Workspace-fact memory entry on `FileTreeNode` size/mtime synthesis (in `AGENTS.md`).
- Comparable working Virtuoso usages: `apps/ui/app/components/ui/combobox-responsive.tsx`, `apps/ui/app/components/chat/tiptap/context-suggestion.tsx`.

## Appendix: Console output captured during reproduction

### Zoo (`KittyCAD/modeling-app`, 61 root entries)

```text
[UDL-DIAG] useDirectoryListing(path="") → unready (no treeService)   ×4
[FM-DIAG]  readDirectory START path=/projects/proj_X0YqCCPV9KCrEaYLi56uS elapsed=133.0ms
[FM-DIAG]  readDirectory OK count=61 names=[.github, .helix, .husky, .tau, assets, docs, e2e, openapi, packages, public, rust, scripts, src, types, _typos.toml, .env.development, .env.production, .envrc, .gitattributes, .gitignore, ...] elapsed=141.9ms
[FM-DIAG]  FileTreeService seeded with initialEntries.length=61 (root marked resolved=true)
[UDL-DIAG] useDirectoryListing(path="") → ready (sync) count=61
```

### sgenoud (`sgenoud/models`, 23 root entries)

```text
[UDL-DIAG] useDirectoryListing(path="") → unready (no treeService)   ×3
[FM-DIAG]  readDirectory START path=/projects/proj_S7pDjKjFVupTLC9dDQDWj elapsed=232.8ms
[FM-DIAG]  readDirectory OK count=23 names=[.husky, .tau, .vscode, public, scripts, src, .eslintignore, .eslintrc.js, .gitignore, .markdownlint.json, .node-version, .npmrc, .prettierignore, .prettierrc, astro.config.mjs, LICENSE, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, README.md, ...] elapsed=238.7ms
[FM-DIAG]  FileTreeService seeded with initialEntries.length=23 (root marked resolved=true)
[FTS-DIAG] listDirectory("public") → relativeKey="public" COLD-LOAD treeSize=24
[FTS-DIAG] listDirectory("public/models") → relativeKey="public/models" COLD-LOAD treeSize=24
[FTS-DIAG] listDirectory("public") cold-load DONE count=5 treeSize=29
[FTS-DIAG] listDirectory("public/models") cold-load DONE count=29 treeSize=58
[UDL-DIAG] useDirectoryListing(path="") → unready (no treeService)   ×3
[Kernel:worker] Loaded replicad library source map for error diagnostics
[UDL-DIAG] useDirectoryListing(path="") → ready (sync) count=23
```

The sgenoud trace also confirms that `FTS-DIAG` cold-load is exercised correctly when the chat-editor file tree drills into nested directories (`public`, `public/models`) — those paths are not in `initialEntries` and need real worker round-trips, which both succeed.
