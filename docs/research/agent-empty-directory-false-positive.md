---
title: 'Agent Empty-Directory False Positive on New Chats'
description: 'Root cause investigation into agent reporting "no files exist" for filesystem tools immediately after a new chat is opened.'
status: active
created: '2026-05-03'
updated: '2026-05-03'
category: investigation
related:
  - docs/research/agent-filesystem-stale-cache-audit.md
  - docs/policy/filesystem-policy.md
  - docs/policy/context-engineering-policy.md
---

# Agent Empty-Directory False Positive on New Chats

Why `list_directory`, `glob_search`, and `grep_search` sometimes report `0` results immediately after a new chat is created in an existing project — even though the project has files on disk.

## Executive Summary

The "sometimes 0 items, sometimes 3 items" pattern is not (primarily) a warm-up race. It is a **path-resolution logic bug** that turns any agent input other than the literal empty string `""` into a path the worker silently resolves to `[]`. Three layers of the stack independently mask the bug:

1. **`joinPath('/projects/abc', '.')` produces `/projects/abc/.`** and **`joinPath('/projects/abc', '/')` produces `/`** (the leading-slash reset clause clobbers the project prefix). The "relative to the project root" contract in the schema is silently violated for every input the LLM is most likely to try (`'.'`, `'./'`, `'/'`).
2. **`WorkspaceFileService.readDirectory` swallows every provider error and returns `[]`** (`packages/filesystem/src/workspace-file-service.ts:662-664`). The `ENOENT` that should surface for `/projects/abc/.` becomes a clean empty success.
3. **`createBrowserRpcFileSystem.readdir` returns `[]` when `treeService === undefined`** (`apps/ui/app/hooks/rpc-handlers.ts:120`) — the original race window, now a defence-in-depth concern rather than the primary cause.

All three layers produce the same wire-shape — `{ success: true, entries: [] }` — that the LLM trusts. Fix is two-pronged: (R1) canonicalize the agent-supplied path _before_ `joinPath`, and (R2) stop swallowing provider errors at the worker boundary so `ENOENT` is loud, not silent.

## Problem Statement

User-supplied screenshots, three separate prompts in the same project (`.tau/`, `main.ts`, `test.json` on disk):

| Prompt                     | Tool row label         | Outcome                                                   |
| -------------------------- | ---------------------- | --------------------------------------------------------- |
| `export`                   | "Listed (0 items)"     | "No project files exist. Create a model first…"           |
| `update to using syntax …` | "Listed (0 items)"     | "The project is empty. … I need to see an existing file." |
| `read filesystem`          | "Listed `/` (3 items)" | `.tau`, `main.ts`, `test.json` — correct                  |

The chip header label is `${path || '/'} (${entries.length} items)` (`apps/ui/app/routes/projects_.$id/chat-message-tool-list-directory.tsx:72`), so both `path === ''` and `path === '/'` render visually as `/`. The 0-vs-3 split must be coming from _what the LLM passed_, not from a stochastic backend error.

## Methodology

- Read both layers of the path-resolution chain: `FileTreeService.readDirectoryEntriesWithStats` (`packages/filesystem/src/client/file-tree-service.ts:278-298`) and the underlying `joinPath`/`normalizePath` (`libs/utils/src/path.utils.ts`).
- Read the worker's `WorkspaceFileService.readDirectory` (`packages/filesystem/src/workspace-file-service.ts:620-676`) and the IDB provider's `readdir` (`packages/filesystem/src/backend/direct-idb-provider.ts:108-145`).
- Read every dependent RPC handler (`libs/chat/src/rpc/handlers/handle-list-directory.ts`, `handle-glob-search.ts`, `handle-grep.ts`) and the browser RPC adapter (`apps/ui/app/hooks/rpc-handlers.ts:97-189`).
- Inspected the Zod schema description (`libs/chat/src/schemas/tools/list-directory.tool.schema.ts:7`) — only signal the LLM gets about input convention.
- Re-ran `joinPath` over the inputs LLMs commonly choose (`''`, `'/'`, `'.'`, `'./'`, `'/projects/<id>'`, `'/src'`) to confirm the resolution table below.

## Findings

### Finding 1: `joinPath` quietly violates the "relative to project root" contract

`libs/utils/src/path.utils.ts:36-54` — any segment that starts with `/` resets the accumulator:

```36:54:libs/utils/src/path.utils.ts
export function joinPath(...paths: string[]): string {
  let result = '';

  for (const path of paths) {
    if (path === '') {
      continue;
    }

    // If path is absolute, reset result to this path
    if (path.startsWith('/')) {
      result = path;
    } else if (result === '' || result === '/') {
      // If result is empty or just root, set to path with leading slash
      result = '/' + path;
    } else {
      // Append path to result
      result = result + '/' + path;
    }
  }
```

Combined with `FileTreeService.readDirectoryEntriesWithStats` (`packages/filesystem/src/client/file-tree-service.ts:278-279`):

```278:279:packages/filesystem/src/client/file-tree-service.ts
  public async readDirectoryEntriesWithStats(path: string): Promise<DirectoryEntryWithStat[]> {
    const absolutePath = path === '' ? normalizePath(this.paths.root) : joinPath(this.paths.root, path);
```

Resolution table for project `/projects/abc`, verified by running `joinPath` directly:

| Agent input       | Resolved absolute path       | Sandbox?                  | Result                                      |
| ----------------- | ---------------------------- | ------------------------- | ------------------------------------------- |
| `""`              | `/projects/abc`              | inside                    | 3 items ✓                                   |
| `"/"`             | `/`                          | **outside** (reset)       | MountTable throws → tool error              |
| `"."`             | `/projects/abc/.`            | inside but not in `_dirs` | provider `ENOENT` → swallowed → **0 items** |
| `"./"`            | `/projects/abc/.`            | inside but not in `_dirs` | provider `ENOENT` → swallowed → **0 items** |
| `"./src"`         | `/projects/abc/./src`        | inside but not in `_dirs` | provider `ENOENT` → swallowed → **0 items** |
| `"/src"`          | `/src`                       | **outside** (reset)       | MountTable throws → tool error              |
| `"src"`           | `/projects/abc/src`          | inside                    | works if `src/` exists                      |
| `"/projects/abc"` | `/projects/abc`              | inside (accidentally)     | 3 items ✓                                   |
| `"projects/abc"`  | `/projects/abc/projects/abc` | inside but does not exist | `ENOENT` → swallowed → 0 items              |

The schema description is the only signal the LLM gets about which form to use:

```5:8:libs/chat/src/schemas/tools/list-directory.tool.schema.ts
  path: z
    .string()
    .describe('The path of the directory to list, relative to the project root. Use empty string for root.'),
```

"Use empty string for root" is contradicted by every prior tool the LLM has been trained on. POSIX `ls`, Node.js `readdir`, every conventional filesystem API treats `'.'` or `'/'` as the canonical "current directory" / "root" forms. The LLM that occasionally substitutes `'.'` (the most natural relative-root token) is doing exactly what the description nominally allows ("relative to the project root") — and gets `0 items` instead of an error.

### Finding 2: The worker swallows every provider error and returns `[]`

`packages/filesystem/src/workspace-file-service.ts:620-676`:

```630:664:packages/filesystem/src/workspace-file-service.ts
    const { provider, path: resolvedPath } = this._resolveProvider(path);
    const entryMap = new Map<string, TreeEntry>();

    try {
      if (provider.readdirWithStats) {
        const statsEntries = await provider.readdirWithStats(resolvedPath);
        for (const entry of statsEntries) {
          entryMap.set(entry.name, { /* ... */ });
        }
      } else {
        const entries = await provider.readdir(resolvedPath);
        for (const entry of entries) {
          /* ... */
        }
      }
    } catch {
      return [];
    }
```

The IndexedDB provider correctly throws `ENOENT` when the path is not in `_dirs` (`packages/filesystem/src/backend/direct-idb-provider.ts:110-112`). The worker swallows it and returns `[]`. This is the layer that converts "wrong path" into "looks like an empty directory." Without this swallow, every Finding 1 row marked **0 items** would instead surface as a tool error the LLM could react to.

Note the asymmetry with `_resolveProvider` itself (line 630, _outside_ the `try` block). When the path escapes every mount (e.g. agent passes `'/'`), `MountTable.resolve` throws and the error _does_ propagate — which is why `path: '/'` produces a visible tool error rather than the silent empty. The swallow is selective: it converts "valid path, missing directory" into a lie, but leaves "no mount at all" as truth.

### Finding 3: Three tools share the silent-empty fallback in the RPC adapter

`apps/ui/app/hooks/rpc-handlers.ts:117-136`:

```117:136:apps/ui/app/hooks/rpc-handlers.ts
    async readdir(
      path: string,
    ): Promise<Array<{ name: string; type: 'file' | 'dir'; size: number; modifiedAt?: string }>> {
      if (!treeService) {
        return [];
      }
      const entries = await treeService.readDirectoryEntriesWithStats(path);
      /* ... */
    },
    async exists(path: string): Promise<boolean> {
      if (!treeService) {
        return false;
      }
      return treeService.exists(path);
    },
```

This is the third layer where a _missing service_ turns into a fake empty success. It only triggers during the file-manager warm-up window (`connectingWorker → initializingServices → ready`) but is real and reachable, especially on cold-start of the project route or after HMR. Compare with the UI-facing equivalents on the same hook (`apps/ui/app/hooks/use-file-manager.tsx:216-234`) which throw `'Tree service not initialized'` instead — the agent surface and the UI surface disagree on the contract.

### Finding 4: The bug surface is three tools, not one

| Tool             | Wraps `readdir`                        | Output when path resolves to nothing                                |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `list_directory` | direct                                 | `{ success: true, entries: [] }`                                    |
| `glob_search`    | recursive (`handle-glob-search.ts:14`) | `{ success: true, files: [], entries: [], totalFiles: 0 }`          |
| `grep_search`    | recursive (`handle-grep.ts:9`)         | `{ success: true, matches: [], totalMatches: 0, truncated: false }` |

Every tool that walks the workspace via `fileSystem.readdir` inherits Findings 1, 2, and 3. `read_file`, `create_file`, `edit_file`, `delete_file` are unaffected because `useFileManager.readFile`/`writeFile`/`deleteFile` correctly throw on missing services and the worker propagates `ENOENT` for individual file reads.

### Finding 5: Warm-up race is real but secondary

`useChatRpcConnection` joins the socket room as soon as `!isLoadingChat` (`apps/ui/app/routes/projects_.$id/project-chat-rpc-bindings.tsx:46-51`) — the chat persistence load — with no gate on the file-manager state machine reaching `ready`. The handler is ready to receive RPCs while `treeService` is still `undefined` for ~150 ms–2 s on cold-start, and again whenever `setRoot` reinitialises the FM (project switch, HMR, backend cookie change — `apps/ui/app/machines/file-manager.machine.ts:366-371, 484-557`). During that window Finding 3 fires and the agent sees the same fake empty.

This is _one_ of three independent ways to get the false-positive shape. Fixing only the race (e.g. by gating `joinChat` on FM ready) leaves Findings 1 and 2 untouched and the bug reproducible whenever the LLM types `'.'`.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                             | Priority | Effort  | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------- | ------ |
| R1  | **Canonicalize the agent-supplied path inside `FileTreeService.readDirectoryEntriesWithStats`** (and any sibling tool-facing helpers): treat `''`, `'.'`, `'./'`, `'/'`, `this.paths.root`, and `this.paths.root + '/'` all as the project root. Strip leading `/` from the input _before_ `joinPath` so the schema's "relative to the project root" contract holds for every plausible LLM input.                 | P0       | Low     | High   |
| R2  | **Stop swallowing provider errors in `WorkspaceFileService.readDirectory`** — propagate `ENOENT` as a typed `FileNotFoundError`, let `handleListDirectory` map it to a real RPC error, let the agent see "directory does not exist" instead of "directory is empty". The "deleted between readdir and stat" race the swallow was intended to absorb is already handled per-entry in the inner loop (line 657-659). | P0       | Low     | High   |
| R3  | **Tighten the schema description** to either (a) accept `'.'` / `'/'` as canonical aliases (then implementing R1 makes both legal) or (b) state explicitly that the path is _workspace-relative_, never starts with `/`, and `'.'` is not accepted. Option (a) is more forgiving of LLM variance.                                                                                                                  | P0       | Trivial | High   |
| R4  | **Replace the silent fallbacks in `createBrowserRpcFileSystem.readdir` / `exists`** with `throw` (parity with `useFileManager`). Eliminates the warm-up race as a silent-empty source.                                                                                                                                                                                                                             | P1       | Trivial | High   |
| R5  | **Gate `useChatRpcConnection({ enabled })` on the file manager reaching `ready`.** Until then the API gets `NO_CONNECTION` (typed retryable). Layered defence with R4.                                                                                                                                                                                                                                             | P1       | Low     | Medium |
| R6  | **Audit `joinPath` for the leading-slash reset.** The "absolute resets" semantics is borrowed from `path.posix.join` but used here in a workspace-resolver context where the input should always be relative. Either introduce a `joinWorkspacePath(root, relative)` that ignores leading slashes, or document the footgun and migrate every workspace-relative call site.                                         | P1       | Medium  | Medium |
| R7  | **Regression tests** in `apps/ui/app/hooks/rpc-handlers.test.ts` and `packages/filesystem/src/client/file-tree-service.test.ts` covering each row of the resolution table in Finding 1. Asserting `'.'` and `'./'` succeed (not silent-empty) protects R1; asserting `'/escape'` errors loudly protects R2/R3.                                                                                                     | P1       | Low     | Medium |

Recommended sequencing: ship R1 + R2 + R3 together — they cover the same attack surface from three different layers and any one alone leaves at least one row of the resolution table broken. R4–R7 follow.

## Trade-offs

| Approach                                        | Pros                                                       | Cons                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **R1 only** (canonicalize at the client facade) | Single edit point, surface-level fix                       | Worker still swallows errors for all _other_ invalid paths; future tool surface that bypasses `FileTreeService` reintroduces the bug |
| **R2 only** (stop swallowing in worker)         | Universal — every consumer benefits                        | Tool error rate rises whenever the LLM passes `'.'` until R1/R3 land; LLM may not know how to recover                                |
| **R3 only** (rewrite description)               | Cheapest change                                            | Relies on every model getting it right every time — not credible                                                                     |
| **R1 + R2 + R3** (recommended)                  | Wire-format honest, schema honest, client-facade defensive | Three small changes                                                                                                                  |
| **R4 + R5 only** (fix the race, leave path bug) | Closes the racy window                                     | Doesn't fix the per-prompt logic bug — user keeps seeing 0 items in long-running sessions                                            |

## Code Examples

### Reproducing Finding 1 from a Node REPL

```bash
node --input-type=module -e "
import { joinPath, normalizePath } from './libs/utils/src/path.utils.ts';

const root = '/projects/abc';
for (const input of ['', '/', '.', './', '/src', './src', 'src']) {
  const resolved = input === '' ? normalizePath(root) : joinPath(root, input);
  console.log(JSON.stringify(input).padEnd(10), '→', resolved);
}
"
```

Output (verified):

```text
""         → /projects/abc
"/"        → /
"."        → /projects/abc/.
"./"       → /projects/abc/.
"/src"     → /src
"./src"    → /projects/abc/./src
"src"      → /projects/abc/src
```

### Sketch of the R1 + R2 fix

```typescript
// packages/filesystem/src/client/file-tree-service.ts
public async readDirectoryEntriesWithStats(path: string): Promise<DirectoryEntryWithStat[]> {
  const absolutePath = this.paths.toAbsoluteWorkspacePath(path); // canonicalize '', '.', '/', './', '/projects/<id>'
  const nodes = await this.proxy.readDirectory(absolutePath);
  /* ... */
}

// packages/filesystem/src/workspace-file-service.ts
public async readDirectory(path: string, options?: { signal?: AbortSignal }): Promise<FileTreeNode[]> {
  /* ... */
  const { provider, path: resolvedPath } = this._resolveProvider(path);
  const entryMap = new Map<string, TreeEntry>();

  // No outer try/catch: let ENOENT propagate. The inner per-entry try at
  // line 648 still absorbs the genuine "deleted between readdir and stat"
  // race for individual children.
  if (provider.readdirWithStats) {
    /* ... */
  } else {
    /* ... */
  }

  /* ... */
}
```

## Diagrams

### Three independent layers, one shared empty wire-shape

```text
                               agent supplies path
                                       │
                                       ▼
                  ┌──────── FileTreeService.readDirectoryEntriesWithStats ─────────┐
                  │     joinPath(root, path)                                       │
                  │       ── '/'  → loses prefix → MountTable error (loud)         │
                  │       ── '.'  → /projects/abc/.   ◄── Finding 1 silent-bug   │
                  │       ── '/x' → loses prefix → MountTable error (loud)        │
                  │       ── ''   → /projects/abc (correct)                       │
                  └────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                  ┌──────── WorkspaceFileService.readDirectory ────────────────────┐
                  │     try { provider.readdir(resolvedPath) }                     │
                  │     catch { return []; }   ◄── Finding 2 silent-swallow       │
                  └────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                  ┌──────── createBrowserRpcFileSystem.readdir ────────────────────┐
                  │     if (!treeService) return [];   ◄── Finding 3 race-gap     │
                  └────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                          { success: true, entries: [] }
                                       │
                                       ▼
                       LLM concludes "no files exist"
```

## References

- Path utils: `libs/utils/src/path.utils.ts`
- Client facade: `packages/filesystem/src/client/file-tree-service.ts`
- Worker error swallow: `packages/filesystem/src/workspace-file-service.ts`
- IDB provider error contract: `packages/filesystem/src/backend/direct-idb-provider.ts`
- Browser RPC adapter (silent fallback): `apps/ui/app/hooks/rpc-handlers.ts`
- Tool handlers: `libs/chat/src/rpc/handlers/handle-list-directory.ts`, `handle-glob-search.ts`, `handle-grep.ts`
- Tool input schema: `libs/chat/src/schemas/tools/list-directory.tool.schema.ts`
- Chat-room join, no FM gate: `apps/ui/app/routes/projects_.$id/project-chat-rpc-bindings.tsx`, `apps/ui/app/hooks/use-chat-rpc-socket.tsx`
- File manager state machine: `apps/ui/app/machines/file-manager.machine.ts`
- Tool rendering (path display): `apps/ui/app/routes/projects_.$id/chat-message-tool-list-directory.tsx`
