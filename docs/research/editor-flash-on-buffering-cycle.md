---
title: 'Editor flash and focus loss after every buffering cycle'
description: 'Root-cause investigation of why the code editor briefly mounts the LogoLoader after each cad.machine buffering→idle cycle, dropping focus and disrupting typing.'
status: active
created: '2026-05-02'
updated: '2026-05-02'
category: investigation
related:
  - docs/research/binary-file-open-perpetual-loading.md
  - docs/research/agent-filesystem-stale-cache-audit.md
  - docs/policy/filesystem-policy.md
---

# Editor flash and focus loss after every buffering cycle

Investigation into why every keystroke in `apps/ui/app/components/code/code-editor.client.tsx` produces a brief `LogoLoader` flash after the `cad.machine` buffering cycle ends, accompanied by a complete remount of the Monaco editor that drops keyboard focus and cursor selection.

## Executive Summary

The smoking gun is in `FileContentService.handleWorkerFileChanged` (`apps/ui/app/lib/file-content-service.ts`), introduced **today** by commit `fc548205b` ("feat(ui): add file change event handler to FileContentService for cache invalidation", Sat May 2 02:15:03 2026 +1200) — the very same commit that added the method, its wiring in `file-manager.machine.ts`, and the test (`file-content-service.test.ts:664-678`) that codifies the broken contract. The change implemented R2 from `agent-filesystem-stale-cache-audit.md` (closing the "stale `read_file` after out-of-band edit" hole for the chat agent) but did not consider the React render-layer impact for open editors. When the user types in Monaco, `FileEditor.handleCodeChange` round-trips the bytes through `fileManager.writeFile → contentService.write`. That call publishes a fresh `text` outcome optimistically (no flash), but the FM worker also emits its own `fileWritten` event back to the main thread via the throttled change-event pipeline (`packages/filesystem/src/throttled-worker.ts`, ~200 ms coalescing window). The handler treats the echo as an out-of-band invalidation and runs `cache.delete(path) → outcomes.delete(path) → notifyPathSubscribers(path)`. React's `useSyncExternalStore` consumer (`useFileContent`) then sees `peekOutcome(path)` fall back to the shared `loadingOutcome` sentinel, the `FileEditor` switch lands on `case 'loading'`, the `Loader` (LogoLoader) is mounted, the entire `ChatEditorCodeViewer` subtree (including `<CodeEditor>`) is unmounted, and the subsequent `useEffect` triggers a fresh `resolve()` that re-publishes the same bytes one IPC roundtrip later. Monaco gets a brand-new editor instance on remount; the model survives via `keepCurrentModel`, but focus, cursor position, scroll, and IME state do not.

The behaviour appears "tied to the buffering cycle" only because the kernel worker's 500 ms file debounce and the FM worker's 200 ms event throttle coincidentally land in the same window the user perceives as "render finished". The flash is structurally independent of the kernel — it would happen identically with the kernel disconnected.

The contract that needs to change: **once a file's outcome has reached `text`, it must never transition back to `loading` for the lifetime of the open editor.** External writes should swap to a new `text` outcome (with the new bytes) in-place; self-write echoes should be suppressed entirely. The reference implementation already exists 200 lines away — `FileTreeService.handleWorkerFileChanged` patches the tree in place via `optimisticAdd`/`optimisticDelete`/`optimisticRename` and `MonacoModelService.handleContentChange` filters self-write echoes via `if (event.source === 'editor') { return; }`. `fc548205b` adopted the dispatch shape from the tree service but neither of the protections that make it safe for live consumers.

## Problem Statement

Symptom (reproducible by typing any character in `main.scad`, `main.ts`, etc.):

1. User types one or more characters in the Monaco editor.
2. The kernel `buffering` state begins (worker debounce window).
3. `buffering → rendering → idle` completes.
4. **The entire editor pane briefly renders the `LogoLoader` glyph** (perceptibly one frame plus an IPC roundtrip).
5. The editor remounts. Keyboard focus is lost; the user must click back into the textarea to resume typing. Cursor position, selection, and IME composition state are reset.

Smoking-gun visual: the same `LogoLoader` SVG (`apps/ui/app/components/logo-loader.tsx`) that appears on first-time file open is shown — confirming the editor is going through a full `loading` render branch, not a Monaco-internal redraw.

## Regression Provenance

| Commit      | Date                 | Subject                                                                              |
| ----------- | -------------------- | ------------------------------------------------------------------------------------ |
| `fc548205b` | 2026-05-02 02:15 +12 | feat(ui): add file change event handler to FileContentService for cache invalidation |

That single commit introduced (1) the `handleWorkerFileChanged` method on `FileContentService` with the `outcomes.delete` semantics, (2) the fan-out in `apps/ui/app/machines/file-manager.machine.ts:265-269` that drives every FM-worker `fileChanged` event into both `treeService` and `contentService`, and (3) the test that locks in the `peekOutcome → { kind: 'loading' }` contract. Before this commit, only `treeService` consumed the channel and the content cache held bytes across self-write echoes, so open editors never observed an outcome rollback. The user-visible flash appeared the first time anyone typed in Monaco after merging `fc548205b`.

The intent of `fc548205b` was correct (it implemented R2 from `agent-filesystem-stale-cache-audit.md` — closing the "stale `read_file` after an out-of-band edit" hole for chat-agent tools, which had been a P0 finding). The regression is a missing branch on the same change: external mutations should drop the cached bytes; self-write echoes should not, and either path should swap-in-place rather than transition through `loading`.

## Methodology

1. Traced `CodeEditor` → `ChatEditorCodeViewer` → `FileEditor` (`chat-editor-dockview.tsx:79-212`) and verified that `<Loader variant='logo'>` (== `LogoLoader`) is only mounted on `result.kind === 'loading'`.
2. Walked `useFileContent` (`apps/ui/app/hooks/use-file-content.ts:23-44`) and confirmed it routes through `FileContentService.peekOutcome` + a `useSyncExternalStore` subscription.
3. Read `FileContentService` end-to-end (`apps/ui/app/lib/file-content-service.ts`):
   - `write(path, data, source)` (`190-198`) — publishes a fresh `text` outcome and clones into the cache.
   - `handleWorkerFileChanged(event)` (`379-435`) — `case 'fileWritten'` evicts cache **and** outcome, then notifies subscribers.
   - `peekOutcome(path)` (`183-185`) — returns the shared `loadingOutcome` sentinel when `outcomes` has no entry.
4. Confirmed the wiring at `apps/ui/app/machines/file-manager.machine.ts:265-269` — every `fileChanged` push from the FM worker is fanned into both `treeService.handleWorkerFileChanged` and `contentService.handleWorkerFileChanged`.
5. Confirmed the FM worker emits `fileWritten` on every successful `writeFile` (`packages/filesystem/src/file-system-service.ts:231-233` via `ChangeEventBus.emit`; `packages/filesystem/src/backend/filesystem-observer-bridge.ts:51-58` for OPFS/FS-Access; the `WorkspaceFileService.writeFile` self-publish path tested in `packages/filesystem/src/workspace-file-service.test.ts:782` and `1197`).
6. Verified the echo timing — events flow through `EventCoalescer` + `ThrottledWorker` (`maxWorkChunkSize: 100`, `throttleDelay: ~200 ms` per AGENTS) before crossing back to the main thread.
7. Checked the existing test `apps/ui/app/lib/file-content-service.test.ts:663-678`. It explicitly asserts the bug behaviour: after `handleWorkerFileChanged({ type: 'fileWritten', … })`, `peekOutcome` returns `{ kind: 'loading' }`. This is the contract that needs to be inverted.

## Findings

### Finding 1: `handleWorkerFileChanged` collapses the `text` outcome to `loading` on every echo

`apps/ui/app/lib/file-content-service.ts:382-393`:

```379:393:apps/ui/app/lib/file-content-service.ts
  public handleWorkerFileChanged(event: ChangeEvent): void {
    const rootPrefix = this.rootDirectory.endsWith('/') ? this.rootDirectory : `${this.rootDirectory}/`;

    switch (event.type) {
      case 'fileWritten': {
        const relative = this.toRelativePath(event.path, rootPrefix);
        if (relative === undefined) {
          return;
        }
        this.cache.delete(relative);
        this.outcomes.delete(relative);
        this.setOrphaned(relative, false);
        this.notifyPathSubscribers(relative);
        return;
      }
```

Two consequences:

1. `outcomes.delete(relative)` removes the entry the React subscriber was reading, so the next `peekOutcome` call falls back to the shared `loadingOutcome` sentinel (`apps/ui/app/lib/file-content-service.ts:67`, `183-185`).
2. `notifyPathSubscribers(relative)` immediately fires the subscriber, so React reads the now-`loading` snapshot and re-renders before the bytes are re-fetched.

The JSDoc above the method (`365-378`) acknowledges that "events that originate from internal `write` / `delete` / `rename` calls are echoed back to us too", but characterises the cost as "one extra `proxy.readFile` and re-publishes the same outcome — the cost is bounded". That cost analysis is **wrong about the React render layer**: the transient `loading` outcome unmounts every consumer that was reading the path, and `keepCurrentModel` does not save Monaco's editor instance — only the model.

### Finding 2: `FileEditor` renders `LogoLoader` whenever `result.kind === 'loading'`

`apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx:156-163`:

```156:163:apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx
  switch (result.kind) {
    case 'loading': {
      return (
        <div className='flex h-full items-center justify-center'>
          <Loader className='size-8 stroke-1 text-muted-foreground' />
        </div>
      );
    }
```

`Loader` defaults to `variant='logo'`, which renders `LogoLoader` (`apps/ui/app/components/ui/loader.tsx:9-15`). The branch is unguarded — it fires every time `result.kind` is `'loading'`, including transient transitions that revert to `'text'` one tick later.

### Finding 3: The shared `loadingOutcome` sentinel is reached only via `outcomes.delete`

`apps/ui/app/lib/file-content-service.ts:61-67`:

```61:67:apps/ui/app/lib/file-content-service.ts
/**
 * Shared sentinel for unresolved paths. `peekOutcome` MUST return a
 * referentially-stable value when nothing has changed, otherwise
 * `useSyncExternalStore` consumers re-render in a loop and the
 * surrounding error boundary remounts the project tree (crash-loop).
 */
const loadingOutcome: FileContentResult = { kind: 'loading' };
```

The sentinel exists for the genuine "never resolved" case. The bug is that we re-enter that case on every echo, even though the file has been resolved many times and the cache held bytes a microtask ago. The `outcomes` map is the _only_ source of truth `peekOutcome` consults — once we delete the entry, the consumer cannot tell the difference between "first-time open" and "echo of a write that already published the new bytes".

### Finding 4: `useFileContent`'s recovery effect costs one full IPC roundtrip

`apps/ui/app/hooks/use-file-content.ts:37-42`:

```37:42:apps/ui/app/hooks/use-file-content.ts
  useEffect(() => {
    if (path && contentService && result.kind === 'loading') {
      void contentService.resolve(path);
    }
  }, [contentService, path, result.kind]);
```

After the synchronous flash, the recovery is a `proxy.readFile(absolutePath)` over the FM-worker channel. Even on a hot path that's tens of milliseconds — long enough for the `LogoLoader` to render at least one animation frame and for Monaco's `cursorSmoothCaretAnimation: 'on'` state to be lost.

### Finding 5: Existing self-write echo wiring already labels the source

`FileContentService.write` accepts a `source: FileWriteSource` (`apps/ui/app/lib/file-content-service.ts:190`) and propagates it on the `ContentChangeEvent` (`9-14`). FM-worker `proxy.listen('fileChanged', …)` events do **not** carry the source today (`packages/filesystem/src/types.ts` `ChangeEvent` shape is `{ type, path, backend }` only), but the writer side — `WorkspaceFileService.writeFile` and the `IndirectionProvider` wrapper — knows whether the write came from a main-thread proxy call vs. an external observer (`FilesystemObserverBridge`). The information needed to discriminate "self-echo" vs "external mutation" exists upstream; it is just not threaded through.

### Finding 6: Monaco focus does not survive the unmount even with `keepCurrentModel`

`code-editor.client.tsx:277` sets `keepCurrentModel`. That preserves the `monaco.editor.ITextModel` (so undo history and content survive), but `@monaco-editor/react` still tears down the `IStandaloneCodeEditor` instance whenever its host component unmounts. Focus, cursor position, scroll offset, and IME composition all live on the editor instance. Remounting necessarily resets them.

### Finding 7a: The reference implementation already exists in `FileTreeService`

The peer service that `fc548205b` copy-pasted from — `FileTreeService` (`apps/ui/app/lib/file-tree-service.ts`) — handles the same `fileChanged` channel **correctly**, and was extracted in commit `309292451` weeks before the regression:

```559:605:apps/ui/app/lib/file-tree-service.ts
  private handleFileWrittenEvent(absolutePath: string, rootPrefix: string): void {
    if (!absolutePath.startsWith(rootPrefix)) {
      return;
    }
    const relativePath = absolutePath.slice(rootPrefix.length);
    const parentPath = this.getParentPath(relativePath);
    if (this._resolvedDirectories.has(parentPath)) {
      this.optimisticAdd(relativePath, 0);
    }
  }
  …
  private handleDirectoryChangedEvent(absolutePath: string, rootPrefix: string): void {
    if (!absolutePath.startsWith(rootPrefix) && absolutePath !== this.rootDirectory) {
      return;
    }
    const relativePath = absolutePath === this.rootDirectory ? '' : absolutePath.slice(rootPrefix.length);
    if (this._resolvedDirectories.has(relativePath)) {
      this.scheduleRefresh(relativePath);
    }
  }
```

Three protections the tree service has that the content service lacks:

| Protection                            | `FileTreeService`                                             | `FileContentService` (`fc548205b`)                                       |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Patch-in-place on file events**     | `optimisticAdd` / `optimisticDelete` / `optimisticRename`     | `outcomes.delete` then `notifyPathSubscribers` — readers see `loading`   |
| **Skip events for unloaded subtrees** | `if (this._resolvedDirectories.has(parentPath))` guard        | Unconditionally runs `cache.delete` + `outcomes.delete` for every event  |
| **Debounce directory refresh**        | `scheduleRefresh` coalesces multiple events into one re-fetch | `invalidateUnderPrefix` evicts every entry then notifies each subscriber |

The implementer of `fc548205b` adopted only the dispatch shape (`switch (event.type) { case 'fileWritten': … }`) but not the swap-in-place semantics that make the tree service safe for live consumers.

### Finding 7b: Source-based echo suppression is the dominant pattern in the codebase — at a different channel layer

Two existing consumers of the _content_ channel (`onDidContentChange`) use the same one-line filter:

```280:285:apps/ui/app/lib/monaco-model-service.ts
      case 'written': {
        if (event.source === 'editor') {
          return;
        }
        this.applyWritten(event.path, event.data, event.source);
```

```617:631:apps/ui/app/lib/file-tree-service.ts
      case 'written': {
        if (event.source === 'editor') {
          return;
        }
        this.optimisticAdd(event.path, event.data.byteLength);
        this.scheduleRefreshForParent(event.path);
        break;
      }
      case 'deleted': {
        if (event.source === 'editor') {
          return;
        }
        this.optimisticDelete(event.path);
        this.scheduleRefreshForParent(event.path);
        break;
      }
```

The pattern is established. The reason `FileContentService.handleWorkerFileChanged` cannot adopt it directly is that it subscribes to the **worker channel** (`proxy.listen('fileChanged', …)`), which carries no `source` field — only the in-process `onDidContentChange` channel does. This makes R4 (plumb `origin` onto `ChangeEvent`) the structurally correct fix, with R2 (TTL suppression set) as the tactical bridge until R4 lands.

### Finding 7c: The same anti-pattern affects three more event types, not just `fileWritten`

`fileWritten` is the most user-visible because it fires on every keystroke, but the destructive `outcomes.delete + notifyPathSubscribers` pattern is repeated across the file:

| Event type         | Destructive operation                                                             | User-visible effect                                                                       |
| ------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `fileWritten`      | `outcomes.delete(relative)`                                                       | Editor flashes on every keystroke (the reported bug).                                     |
| `fileRenamed`      | `outcomes.delete(oldRelative)` _and_ `outcomes.delete(newRelative)`               | Renaming a file via the file tree flashes any editor open on either path before settling. |
| `directoryChanged` | `invalidateUnderPrefix` deletes outcomes for **every** path under the prefix      | One directory event near the root flashes every open editor simultaneously.               |
| `backendChanged`   | Clears the entire `outcomes` Map and notifies every subscriber                    | Backend swap (project change) flashes every open editor; defensible but still avoidable.  |
| `fileDeleted`      | Calls `publishOutcome(path, { kind: 'orphaned' })` — defined transition, no flash | ✅ correct — only branch that uses the swap-in-place pattern.                             |

`fileDeleted` proves the swap-in-place fix is a one-line change per branch (`publishOutcome(path, newOutcome)` instead of `outcomes.delete + notifyPathSubscribers`).

### Finding 7d: System writes (`.tau/cache/*`, `.tau/parameters/*.json`) pass through unfiltered

Every geometry-cache middleware write (`packages/runtime/src/middleware/geometry-cache.middleware.ts`) and every parameter-file write triggered by `parametersParsed` (`apps/ui/app/machines/project.machine.ts:980-985`) round-trips through the FM worker, generates a `fileWritten` echo, and lands in `contentService.handleWorkerFileChanged`. The work is bounded per call (no-op when nothing is cached/subscribed for that path), but it scales linearly with FS-event volume during render storms and chat-agent activity. `FileTreeService` filters this class with the `_resolvedDirectories.has(parentPath)` guard; `FileContentService` does not.

### Finding 7e: Test name advertises a contract the implementation does not meet

`apps/ui/app/lib/file-content-service.test.ts:664` is titled:

> `should evict cache and notify subscribers when a watched file is written out-of-band`

The implementation has no notion of "out-of-band" — every `fileWritten` event flows through the same path, including self-write echoes from `FileContentService.write()`. The test name describes a specification the code does not enforce, which makes the regression invisible during code review (a reader would assume the test ensures the behavior only fires on out-of-band writes).

### Finding 8: The behaviour is tested into place

`apps/ui/app/lib/file-content-service.test.ts:664-678` codifies the broken contract:

```664:678:apps/ui/app/lib/file-content-service.test.ts
    it('should evict cache and notify subscribers when a watched file is written out-of-band', async () => {
      const initialBytes = new Uint8Array([1, 2, 3]);
      vi.mocked(proxy.readFile).mockResolvedValue(initialBytes);
      await service.resolve('main.ts');
      expect(service.has('main.ts')).toBe(true);

      const callback = vi.fn();
      service.subscribe('main.ts', callback);

      service.handleWorkerFileChanged({ type: 'fileWritten', path: '/project/main.ts', backend: 'indexeddb' });

      expect(service.has('main.ts')).toBe(false);
      expect(service.peekOutcome('main.ts')).toEqual({ kind: 'loading' });
      expect(callback).toHaveBeenCalledOnce();
    });
```

The expectation `peekOutcome('main.ts')).toEqual({ kind: 'loading' })` is precisely the regression vector. The unit tests and the React render contract disagree: the cache layer treats "freshly invalidated" as "unknown", but the render layer treats "unknown" as "blank slate, mount the loader".

## Sequence Diagram (timing of one keystroke)

```
T=0      User keystroke
         │
         ├─► Monaco onChange
         │   └─► handleCodeChange (chat-editor-dockview.tsx:134)
         │       └─► fileManager.writeFile(path, encoded, { source: 'editor' })
         │           └─► FileContentService.write(path, data, 'editor')
         │               ├─► proxy.writeFile(absolutePath, data)         ─┐
         │               ├─► cache.set(path, localCopy)                   │ (sync, pre-flush)
         │               ├─► publishOutcome(path, { kind: 'text', … })    │
         │               └─► notifyGlobalSubscribers({ type: 'written' }) ─┘
         │                   └─► useFileContent re-reads → kind: 'text'  ✓ no flash here
         │
         ├─► FM worker receives writeFile
         │   ├─► fileSystem.writeFile()  → IndexedDB / OPFS / FS-Access
         │   └─► ChangeEventBus.emit({ type: 'fileWritten', path, backend })
         │       └─► WatchRegistry → EventCoalescer → ThrottledWorker
         │
T≈100ms  ThrottledWorker drains chunk to bridge.emit('watch:…', event)
         │
T≈200ms  proxy.listen('fileChanged', cb) on main thread fires
         └─► contentService.handleWorkerFileChanged({ type: 'fileWritten', path })
             ├─► cache.delete(relative)        ◀── evicts the bytes we just wrote
             ├─► outcomes.delete(relative)     ◀── evicts the 'text' outcome
             └─► notifyPathSubscribers(relative)
                 └─► useFileContent re-reads via peekOutcome
                     └─► returns shared loadingOutcome
                         └─► React renders <FileEditor> with kind: 'loading'
                             └─► <Loader variant='logo'> mounts  ⚡ FLASH ⚡
                                 (<ChatEditorCodeViewer> + <CodeEditor> unmounted)
                             │
                             ├─► useEffect fires resolve(path)
                             │   └─► proxy.readFile(absolutePath)        (~10–30ms IPC)
                             │
T≈230ms  computeOutcome publishes { kind: 'text', content: freshBytes }
         └─► useFileContent re-reads → kind: 'text'
             └─► <FileEditor> mounts <ChatEditorCodeViewer> → fresh <CodeEditor>
                 └─► Monaco model reused (keepCurrentModel) but new editor instance
                     └─► focus / cursor / selection / scroll lost
```

The "after every buffering cycle" framing is incidental: the FM-worker's ~200 ms throttle and the kernel-worker's 500 ms file debounce land in the same window users associate with "render finished". The flash is downstream of the FS echo, not of the buffering state.

## Architectural Stance: open files don't go back to "loading"

Once a file's outcome has reached `text` (or `binary` / `too-large` / `error` / `orphaned`), the contract for the _open editor_ should be:

1. **External writes** → swap to a new `text` outcome with the fresh bytes once they've been read. The previous outcome stays observable until the swap; consumers see one transition, `text(old) → text(new)`. They never see `text → loading → text`.
2. **Self-write echoes** → suppress entirely. The cache and outcome already hold the canonical post-mutation bytes.
3. **Out-of-band deletes** → publish `orphaned` directly (existing behaviour for `case 'fileDeleted'` is correct).
4. **Backend swap** → the `backendChanged` invalidation is a legitimate full reset; consumers can transition through `loading` here because the project root has changed.

VS Code follows the same rule: `TextFileEditorModel` resolves bytes once, then accepts external `change` events by reloading-in-place. The editor pane is never replaced by a placeholder during a refresh.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Priority | Effort | Impact                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------- |
| R1  | **Stop transitioning open files to `loading` on `fileWritten` echoes.** In `FileContentService.handleWorkerFileChanged`'s `case 'fileWritten'`, do not call `outcomes.delete(relative)` or `notifyPathSubscribers(relative)` synchronously. Instead, kick off `void this.resolve(relative, { force: true })` which re-reads the bytes and `publishOutcome`s the new `text` outcome on completion.                                                                                            | **P0**   | Low    | Eliminates the flash and focus loss for both self-writes and external writes.         |
| R2  | **Add a self-write echo suppression window.** Track in-flight write paths in `FileContentService` with a small TTL (≤500 ms). When `handleWorkerFileChanged` sees a `fileWritten` for a path inside that window, skip the re-read entirely (the cache already holds the canonical bytes from `write()`).                                                                                                                                                                                     | **P0**   | Low    | Removes the redundant `proxy.readFile` IPC roundtrip for every keystroke.             |
| R3  | **Invert the failing test.** `apps/ui/app/lib/file-content-service.test.ts:664-678` asserts `peekOutcome` returns `{ kind: 'loading' }` after a `fileWritten` echo. Rewrite it to assert the new contract: outcome stays `text`, optionally swapping to fresh bytes on external writes (TDD per workspace policy — do this first, then implement R1/R2).                                                                                                                                     | **P0**   | Low    | Locks the new contract in place; prevents regression.                                 |
| R4  | **Plumb a write source onto `ChangeEvent`.** Extend `ChangeEvent` (`libs/types/src/types/filesystem.types.ts`) with an optional `origin: 'self' \| 'external'` field. The FM worker tags events as `'self'` when they originate from a `proxy.write*` call and `'external'` when they originate from `FilesystemObserverBridge` or a cross-tab `BroadcastChannel`. R2 then becomes a one-line check rather than a TTL heuristic.                                                             | **P1**   | Medium | Makes the suppression contract explicit and removes the timing-based heuristic.       |
| R5  | **Apply the same "no-loading-after-resolved" rule to `fileRenamed`, `directoryChanged`, and `backendChanged`.** All three branches use `outcomes.delete + notifyPathSubscribers` and produce the same flash for any consumer that happens to be subscribed. `fileDeleted` already proves the fix is one-line per branch (`publishOutcome` instead of `outcomes.delete + notify`).                                                                                                            | **P1**   | Low    | Closes the same flash class for renames, directory invalidations, and backend swaps.  |
| R6  | **Document the contract.** Add a section to `docs/policy/filesystem-policy.md` (or split into a new `editor-content-policy.md`) stating: "After the first successful resolve, an open path's outcome must transition only between `text(a) → text(b)` or `text → orphaned/error`. It must never revert to `loading`." Reference this research from the policy.                                                                                                                               | **P2**   | Low    | Prevents the next contributor from reintroducing the bug under a different code path. |
| R7  | **Audit other `useSyncExternalStore` consumers for the same anti-pattern.** Any subscriber whose snapshot can revert to a sentinel "loading" value mid-session is a candidate. `FileTreeService` is already correct (verified — it patches in place and skips events for unloaded subtrees); `MonacoModelService` is correct (filters self-events at the content channel). Remaining candidates: graphics providers, parameter UI subscribers under `.tau/parameters/`, kernel-state stores. | **P2**   | Medium | Defence in depth — same root cause may exist elsewhere.                               |
| R8  | **Mirror `FileTreeService`'s reference implementation directly.** The patch-in-place semantics, source-suppressed content channel, and unloaded-subtree skip already exist 200 lines down the same `lib/` directory. Port the three patterns into `FileContentService.handleWorkerFileChanged` rather than designing fresh ones. Reference: `file-tree-service.ts:559-605` (worker channel) + `file-tree-service.ts:617-637` (content channel filter).                                       | **P0**   | Low    | Removes the design risk — the answer is already in-tree and battle-tested.            |
| R9  | **Skip `fileWritten` events for paths whose parent directory has no live subscribers.** Mirror `FileTreeService.handleFileWrittenEvent`'s `_resolvedDirectories.has(parentPath)` guard with the analogous "any path subscriber on this path or its ancestors" check. Cuts the per-call work for `.tau/cache/*` storms during chat-agent renders down to a no-op.                                                                                                                             | **P1**   | Low    | Bounds CPU cost during render storms; defence-in-depth even after R1 lands.           |
| R10 | **Rename and rewrite the misleading test.** `'should evict cache and notify subscribers when a watched file is written out-of-band'` (`file-content-service.test.ts:664`) advertises a spec the code doesn't enforce. Rewrite as two tests — one for verified-external writes (the spec the name implies, expects swap-in-place to fresh bytes) and one for self-echoes (expects suppression).                                                                                               | **P0**   | Low    | Aligns test names with the new contract; surfaces the regression in code review.      |
| R11 | **Add telemetry counters.** `handleWorkerFileChanged` invocations per type, self-echo suppressions, outcome rollbacks, and recovery-resolve roundtrips. Without these, the regression's footprint at scale (and the impact of the fix) is invisible. Wire through the existing `@taucad/telemetry` definitions used by the API/runtime.                                                                                                                                                      | **P2**   | Medium | Makes future regressions of this class observable rather than user-reported.          |

## Trade-offs

| Approach                                                  | Pros                                                                       | Cons                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **R1 only (re-resolve on echo, never delete outcome)**    | Minimal change; keeps echo flow intact; works without protocol changes     | Still costs one `proxy.readFile` per keystroke (no flash, but redundant IPC). Tolerable on hot paths but wasteful at scale.   |
| **R1 + R2 (TTL suppression)**                             | Eliminates flash _and_ the redundant IPC; no protocol change               | TTL is a heuristic — long writes (large files) could fall outside the window. Needs careful sizing.                           |
| **R1 + R4 (typed origin field)**                          | Principled; self-vs-external is a first-class signal; no timing dependency | Touches `ChangeEvent` shape across `packages/filesystem`, `apps/ui`, runtime — coordinated change required.                   |
| **Render-layer fix (don't unmount on transient loading)** | No service-layer change                                                    | Wrong layer of responsibility — render-side debouncing of the loading state masks the underlying outcome thrashing. Rejected. |

The recommended path is **R3 → R1 → R2 → R4** in that order: TDD the new contract first, ship the minimal correctness fix (R1), then optimise the IPC away (R2), then upgrade to the principled discrimination (R4) when convenient.

## Code Examples

### Current (broken) self-echo handler

```379:393:apps/ui/app/lib/file-content-service.ts
  public handleWorkerFileChanged(event: ChangeEvent): void {
    const rootPrefix = this.rootDirectory.endsWith('/') ? this.rootDirectory : `${this.rootDirectory}/`;

    switch (event.type) {
      case 'fileWritten': {
        const relative = this.toRelativePath(event.path, rootPrefix);
        if (relative === undefined) {
          return;
        }
        this.cache.delete(relative);
        this.outcomes.delete(relative);
        this.setOrphaned(relative, false);
        this.notifyPathSubscribers(relative);
        return;
      }
```

### Proposed shape (R1 + R2)

```typescript
case 'fileWritten': {
  const relative = this.toRelativePath(event.path, rootPrefix);
  if (relative === undefined) {
    return;
  }

  // R2: suppress echoes of writes initiated through this service. The cache
  // and outcome already hold the canonical post-mutation bytes; nothing to
  // do until either the TTL elapses or an external mutation arrives.
  if (this.recentSelfWrites.has(relative)) {
    return;
  }

  // R1: external mutation. Re-read in the background and swap to the new
  // text outcome on completion. The current outcome stays observable until
  // the swap, so React subscribers never see a `loading` transition for an
  // already-open file.
  this.setOrphaned(relative, false);
  void this.resolve(relative, { force: true });
  return;
}
```

(The `force` option needs to be added to `ResolveOptions` and threaded through `shouldRecompute`; trivial, ~5 LOC.)

### TDD spec (R3)

```typescript
it('should keep an open file on a text outcome across fileWritten echoes', async () => {
  vi.mocked(proxy.readFile).mockResolvedValueOnce(new Uint8Array([1]));
  await service.resolve('main.ts');
  expect(service.peekOutcome('main.ts')).toMatchObject({ kind: 'text' });

  // Self-write echo (path was just written via service.write earlier).
  service.handleWorkerFileChanged({ type: 'fileWritten', path: '/project/main.ts', backend: 'indexeddb' });

  // Outcome must remain text — never transition through 'loading'.
  expect(service.peekOutcome('main.ts').kind).toBe('text');
});

it('should swap to fresh bytes on an external fileWritten without flashing loading', async () => {
  const before = new Uint8Array([1]);
  const after = new Uint8Array([2, 3, 4]);
  vi.mocked(proxy.readFile).mockResolvedValueOnce(before);
  await service.resolve('main.ts');

  vi.mocked(proxy.readFile).mockResolvedValueOnce(after);
  service.handleWorkerFileChanged({ type: 'fileWritten', path: '/project/main.ts', backend: 'indexeddb' });

  // Subscriber must observe text→text only, never text→loading→text.
  const observed: string[] = [];
  const unsub = service.subscribe('main.ts', () => observed.push(service.peekOutcome('main.ts').kind));
  await vi.waitFor(() => expect(observed.at(-1)).toBe('text'));
  expect(observed).not.toContain('loading');
  unsub();
});
```

## References

- `apps/ui/app/lib/file-content-service.ts` — content cache, outcome pipeline, echo handler.
- `apps/ui/app/hooks/use-file-content.ts` — `useSyncExternalStore` consumer.
- `apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx:79-212` — `FileEditor` switch + LogoLoader render branch.
- `apps/ui/app/routes/projects_.$id/chat-editor-code-viewer.tsx` — passes `LogoLoader` as Monaco `loading` slot (separate concern; not the bug source).
- `apps/ui/app/components/code/code-editor.client.tsx` — Monaco wrapper; `keepCurrentModel` is set but does not save focus.
- `apps/ui/app/machines/file-manager.machine.ts:265-269` — wires `proxy.listen('fileChanged', …)` into both tree and content services.
- `packages/filesystem/src/file-system-service.ts:231-233` — every `writeFile` self-publishes a `fileWritten` event.
- `packages/filesystem/src/throttled-worker.ts` — coalescing/throttle window that determines echo timing.
- `apps/ui/app/lib/file-content-service.test.ts:664-678` — test that codifies the broken contract.
- Related research: `binary-file-open-perpetual-loading.md` (introduced the discriminated outcome pattern), `agent-filesystem-stale-cache-audit.md` (R2 added the worker→content echo wiring that this investigation now needs to refine).
