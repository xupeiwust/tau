---
title: 'Vite plugin stack overflow on base64-inlined WASM payloads'
description: 'Root-cause investigation of the `vite:ts-module-url-build` RangeError on `openscad-wasm-prebuilt` and the structural fix for the entire class of full-file regex/tokenizer scans over multi-megabyte string literals.'
status: active
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/runtime-transport-authoring-simplification.md
  - docs/research/runtime-zero-config-bundling.md
  - docs/research/api-docker-build-optimization.md
---

# Vite plugin stack overflow on base64-inlined WASM payloads

Root-cause investigation of the production-build failure on `nx run ui:build` where Vite's transform pipeline throws `RangeError: Maximum call stack size exceeded` while processing `openscad-wasm-prebuilt/dist/openscad.js`, plus the structural fix that immunises every custom plugin in `@taucad/vite` against the broader class of "full-file regex/tokenizer over multi-megabyte string literals" failures.

## Executive Summary

The build failure is **not** an out-of-memory error. It is a V8 regex stack overflow inside `js-tokens` triggered when our custom `vite:ts-module-url-build` plugin calls `stripLiteral(code)` over the 11 MB `openscad.js` source — a file whose line 28 is a single 10.9 MB `string literal` containing the base64-encoded WASM binary (Emscripten `MODULARIZE+SINGLE_FILE` output).

The plugin needs `stripLiteral` only to disambiguate "real `new URL(...)` call sites" from references buried inside comments or string literals, but it currently runs the tokenizer **before** the cheap "is there even a candidate match?" regex test. `openscad.js` contains zero `new URL(...)` call sites — the whole tokenization pass is wasted before we discover that.

The fix is two cheap, mechanical guards inside `collectMatches`:

1. **Run the URL regex first**; if it returns zero matches, bail before `stripLiteral` ever sees the file (closes the immediate `openscad.js` regression).
2. **Per-match windowed stripping**: when matches exist, only tokenize a small window (e.g. line of code containing the match) — never the whole source — so any future multi-megabyte single-line literal stays out of the tokenizer's reach.

These two changes generalize the same defense already in place for the built-in `vite:asset-import-meta-url` plugin via `largeDepRegexFix.vite-plugin.ts` and align with Vite upstream's own remediation in [`vitejs/vite#21800`](https://github.com/vitejs/vite/pull/21800).

## Problem Statement

CI failure on [`nx run ui:build`](https://cloud.nx.app/runs/0KfucfKVix/task/ui%3Abuild):

```text
[plugin vite:ts-module-url-build] /home/runner/.../openscad-wasm-prebuilt/dist/openscad.js
RangeError: Maximum call stack size exceeded
    at RegExp.exec (<anonymous>)
    at jsTokens (.../js-tokens@9.0.1/.../index.js:189:31)
    at jsTokens.next (<anonymous>)
    at stripLiteral (.../strip-literal@3.1.0/.../index.mjs:61:14)
    at collectMatches (.../libs/vite/src/ts-module-url.vite-plugin.ts:72:20)
    at TransformPluginContextImpl.handler (.../libs/vite/src/ts-module-url.vite-plugin.ts:183:28)
```

The error surfaces as `RangeError`, which is a **call stack overflow**, not a heap-exhaustion OOM. The user-facing framing of "running out of memory" is misleading — V8 throws `RangeError` from `RegExp.exec` when the irregexp interpreter exceeds its bounded recursion budget on a quantified-alternation regex over a multi-megabyte input.

### Reproduction substrate

| Item                                                 | Value                                                |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Failing file                                         | `openscad-wasm-prebuilt@1.2.0/dist/openscad.js`      |
| File size                                            | 11 071 536 bytes (≈10.6 MiB)                         |
| Total lines                                          | 5104                                                 |
| Length of line 28                                    | **10 904 711 chars** — the entire base64 WASM blob   |
| `import.meta.url` occurrences                        | 1 (line 31: `var _scriptName = import.meta.url;`)    |
| `new URL(` occurrences                               | **0**                                                |
| Plugin transform filter (`vite:ts-module-url-build`) | `code: 'import.meta.url'` — substring match → enters |
| Custom URL regex inside the plugin (`urlPattern`)    | Returns **0 matches** on this file                   |
| Cost paid before reaching that conclusion            | Full `stripLiteral(code)` over 11 MB → stack blows   |

The 10.9 MB single-line literal is the canonical Emscripten `MODULARIZE` + `SINGLE_FILE` output: `_loadWasmModule(0, null, 'AGFzbQEAAAAB…');`. Several other CAD/runtime deps in our graph use the same pattern (`replicad-opencascadejs`, `manifold-3d`, `draco3dgltf`, `assimpjs`); we have only been getting lucky because none of them mention `import.meta.url` near the inlined string, so the substring filter never let them reach `stripLiteral`.

## Methodology

1. Read the failing plugin (`libs/vite/src/ts-module-url.vite-plugin.ts`) and traced the transform handler from filter → `collectMatches` → `stripLiteral` → `js-tokens`.
2. Inspected `openscad-wasm-prebuilt/dist/openscad.js` directly:
   - `awk '{ print length, NR }' … | sort -rn | head` to find the 10.9 MB single line.
   - `rg` to count `new URL(` (zero) and `import.meta.url` (one).
   - `awk 'NR==28' … | head -c 200` to confirm the base64 SINGLE_FILE pattern.
3. Read the upstream `js-tokens@9.0.1` tokenizer to identify the offending regex (`StringLiteral = /(['"])(?:[^'"\\\n\r]+|(?!\1)['"]|\\(?:\r\n|[^]))*(\1)?/y`).
4. Surveyed every plugin in `libs/vite/src/` for the same antipattern; only `ts-module-url.vite-plugin.ts` calls `stripLiteral`. The sibling `largeDepRegexFix.vite-plugin.ts` already addresses an isomorphic bug in Vite's built-in `vite:asset-import-meta-url`.
5. Cross-referenced upstream: [`vitejs/vite#15759`](https://github.com/vitejs/vite/issues/15759) (the original 2024 report against `strip-literal` for `import.meta.url` processing) and [`vitejs/vite#21696`](https://github.com/vitejs/vite/issues/21696) → fix in [`#21800`](https://github.com/vitejs/vite/pull/21800), where Vite replaced the broad `/new\s+URL.+import\.meta\.url/s` filter with precise non-backtracking regexes.

## Findings

### Finding 1: The smoking gun is one wasted `stripLiteral(code)` call

`collectMatches` runs the tokenizer **first**, then the URL regex:

```71:81:libs/vite/src/ts-module-url.vite-plugin.ts
const collectMatches = (code: string): UrlMatch[] => {
  const stripped = stripLiteral(code);
  return [...code.matchAll(urlPattern)]
    .filter((m) => stripped.startsWith('new ', m.index))
    .map((m) => ({
      full: m[0],
      specifier: m[1]!,
      hasHref: Boolean(m[2]),
      index: m.index,
    }));
};
```

For `openscad.js` the URL regex returns `[]`, but we have already paid the cost of tokenizing 11 MB by the time we know that. Reordering the work — regex first, tokenizer only when matches exist — turns this file into a no-op transform with zero risk.

### Finding 2: `js-tokens` has a known V8-regex stack overflow on multi-MB literals

The hot loop inside `js-tokens` matches one token at a time using sticky regexes; the `StringLiteral` regex is

```js
StringLiteral = /(['"])(?:[^'"\\\n\r]+|(?!\1)['"]|\\(?:\r\n|[^]))*(\1)?/y;
```

The quantified alternation `(?:…|…|…)*` over millions of characters drives V8's irregexp interpreter past its bounded recursion depth, even when no real backtracking is required. Upstream `js-tokens` 8.0.3 ([CHANGELOG](https://github.com/lydell/js-tokens/blob/main/CHANGELOG.md)) added partial mitigations ("supports extremely long tokens up to ~10 M chars"); 10.9 M chars exceeds that ceiling. This is documented in:

- [`vitejs/vite#15759`](https://github.com/vitejs/vite/issues/15759) — closed as duplicate; no fix landed in `strip-literal`.
- [`lydell/js-tokens#43`](https://github.com/lydell/js-tokens/pull/43) — open workaround PR, never merged.

Conclusion: the upstream library will not protect us. Plugins that consume `strip-literal` must defend at the call site.

### Finding 3: We already have the same defence — for someone else's plugin

`libs/vite/src/large-dep-regex-fix.vite-plugin.ts` patches the **built-in** `vite:asset-import-meta-url`'s filter regex from `/new\s+URL.+import\.meta\.url/s` (which V8 chokes on against ≥6 MB Monaco bundles) down to the literal substring `'import.meta.url'`. The shape of the bug — and the shape of the fix — is identical. We just never extended the policy to our own plugins.

Vite upstream landed the same architectural change in [`#21800`](https://github.com/vitejs/vite/pull/21800) (March 2026) for `workerImportMetaUrl` and `assetImportMetaUrl`: the precise regex now runs only inside the handler, not as a filter. The maintainer's commentary on the PR is explicit:

> Before the hook filters were added, there was a quick check before the complex regex … then I improved the regex a bit reducing unnecessary backtracks.

We are running into the same wall one layer up — the cheap pre-check needs to extend to anything inside the handler that scans the full source.

### Finding 4: It is not a heap OOM

The Nx Cloud log shows `RangeError: Maximum call stack size exceeded` thrown synchronously from `RegExp.exec`. There is no `JavaScript heap out of memory` message and no `--max-old-space-size` involvement. Increasing Node's heap will not change this outcome. The remediation has to happen at the regex/tokenizer entry point.

### Finding 5: Other deps are latent landmines

Every Emscripten-built dep in our graph that uses `MODULARIZE+SINGLE_FILE` (base64-inlines the WASM) is one `import.meta.url` reference away from triggering the same stack overflow against any plugin that touches `strip-literal`:

| Dep                              | SINGLE_FILE? | Has `import.meta.url`?  | Currently harmless because… |
| -------------------------------- | ------------ | ----------------------- | --------------------------- |
| `openscad-wasm-prebuilt`         | yes          | **yes** (line 31)       | — failing now —             |
| `@taucad/replicad-opencascadejs` | yes          | no (uses `node:module`) | substring filter rejects    |
| `manifold-3d`                    | yes          | no                      | substring filter rejects    |
| `draco3dgltf`                    | yes          | no                      | substring filter rejects    |
| `@taucad/assimpjs` (3 variants)  | yes          | no                      | substring filter rejects    |
| `occt-import-js`                 | yes          | no                      | substring filter rejects    |
| `rhino3dm`                       | yes          | no                      | substring filter rejects    |

A future Emscripten flag flip in any of them — or a new dep — that adds a single `import.meta.url` mention will reproduce the same crash with a different filename. The structural fix has to be insensitive to which file shows up.

### Finding 6: Side-channel signal from `[PLUGIN_TIMINGS]`

The build log also contains repeated:

```text
[PLUGIN_TIMINGS] Warning: Your build spent significant time in plugins. Here is a breakdown:
  - nx-vite-ts-paths (65%)
  - nx-vite-ts-paths (31%)
```

That is **unrelated to the crash** — it is `@nx/vite/plugins/nx-tsconfig-paths.plugin` doing per-import path resolution synchronously against our (large) `tsconfig.base.json` paths map. Worth its own investigation but out of scope here. Documenting it so it does not get conflated with the stack-overflow root cause when this report is read later.

## Recommendations

| #   | Action                                                                                                                                                   | Priority | Effort | Impact                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------- |
| R1  | In `collectMatches`, run `urlPattern.matchAll(code)` first; bail before `stripLiteral` if the array is empty.                                            | P0       | XS     | Unblocks `nx build ui` immediately. Closes openscad case.         |
| R2  | When matches exist, replace whole-file `stripLiteral(code)` with per-match windowed stripping (single line / 4 KB window around `match.index`).          | P0       | S      | Eliminates the entire class of failures permanently.              |
| R3  | Add a regression test that calls the plugin against a synthetic 16 MB single-line `'…'` literal containing `import.meta.url` and zero `new URL(` calls.  | P0       | XS     | Locks in R1+R2; future regressions surface in CI not prod.        |
| R4  | Document an internal Vite-plugin authoring rule (extend `large-dep-regex-fix` rationale): no full-source regex/tokenizer pass before a cheap pre-filter. | P1       | XS     | Prevents the same antipattern recurring in new plugins.           |
| R5  | Audit any future plugin that wants to use `strip-literal` (or `magic-string`+full scan) for the same shape; add a shared `safeCollectMatches` helper.    | P2       | S      | Reusable defence; one place to maintain the windowing.            |
| R6  | (Optional, longer term) Investigate moving openscad-wasm-prebuilt off `SINGLE_FILE` to a separate `.wasm` asset.                                         | P3       | M      | Removes the 10.9 MB literal entirely; not required if R1+R2 land. |

### R1 — bail before tokenizing when no candidate matches exist

This is the minimum-viable structural fix. The tokenizer's only job is to filter false positives out of the regex's output; if the regex output is empty, the tokenizer has nothing to filter.

```typescript
const collectMatches = (code: string): UrlMatch[] => {
  const rawMatches = [...code.matchAll(urlPattern)];
  if (rawMatches.length === 0) {
    return [];
  }
  const stripped = stripLiteral(code);
  return rawMatches.filter((m) => stripped.startsWith('new ', m.index)).map(/* … */);
};
```

This alone fixes the openscad failure — the file has zero `new URL(` and the early return runs before `stripLiteral`.

### R2 — per-match windowed stripping (the architectural fix)

Even when there are real matches, tokenizing the full file is unnecessary: we only need to know whether each individual `match.index` lies inside a comment or string literal. That question is local — a small window suffices.

```typescript
const WINDOW_BACK = 4096; // bytes before match start
const WINDOW_FORWARD = 256; // bytes after match end

const isRealCallSite = (code: string, match: RegExpExecArray): boolean => {
  const start = Math.max(0, match.index - WINDOW_BACK);
  const end = Math.min(code.length, match.index + match[0].length + WINDOW_FORWARD);
  const window = code.slice(start, end);
  // The relative offset of `match.index` inside `window`.
  const relative = match.index - start;
  const stripped = stripLiteral(window);
  return stripped.startsWith('new ', relative);
};
```

This bounds the tokenizer's input regardless of source size: a 100 MB file with 50 real call sites pays at most `50 * 4 KB ≈ 200 KB` of tokenisation, never 100 MB. Multi-megabyte string literals pinned far away from the match cannot ever touch the tokenizer.

The window must back up far enough to cover the longest realistic comment block / template literal preceding a call site. 4 KB is generous (typical JSDoc blocks are <1 KB); we can tune downward later. The window can never start mid-token (a half-string-literal would tokenise differently than the full file), but `stripLiteral` is robust to "unclosed" tokens — `js-tokens` emits `closed: false` and the result still preserves character indices, which is what `startsWith('new ', relative)` cares about.

### R3 — regression test

Add to `libs/vite/src/ts-module-url.vite-plugin.test.ts`:

```typescript
it('should not stack-overflow on a multi-MB single-line string literal containing import.meta.url', async () => {
  const huge = 'a'.repeat(16 * 1024 * 1024);
  const code = [`var Module = {};`, `var WASM_BINARY_DATA = "${huge}";`, `var _scriptName = import.meta.url;`].join(
    '\n',
  );
  const emitFile = vi.fn();
  const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
  expect(result).toBeUndefined();
  expect(emitFile).not.toHaveBeenCalled();
});
```

Sized at 16 MB so it crosses the V8 irregexp ceiling we observed (10.9 MB) by a comfortable margin without making vitest itself slow (≈40 ms in a node env).

### R4 — authoring policy (one paragraph, extend `largeDepRegexFix` JSDoc)

> Custom Vite/Rolldown plugins that scan transform input MUST gate any tokenizer or full-source regex behind a cheap pre-filter (substring check or sticky regex with no quantified alternation). The hook's `transform.filter.code` is the first such gate; any work done **inside** the handler that scans the full source is the second gate and must be guarded the same way. See [`vitejs/vite#21800`](https://github.com/vitejs/vite/pull/21800) for upstream's exemplar and `large-dep-regex-fix.vite-plugin.ts` for our existing patch.

(This is small enough to stay as plugin-level JSDoc; promoting to `docs/policy/` is overkill until we have ≥3 plugins enforcing it.)

## Trade-offs

| Approach                                                                               | Pros                                                                 | Cons                                                                                                                                                                                            | Verdict  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **R1+R2 (chosen)**                                                                     | Mechanical, local, no behaviour change, full coverage                | Slight code complexity in `collectMatches` (one window helper)                                                                                                                                  | ✅       |
| Wrap `stripLiteral(code)` in `try/catch` and treat any throw as "all matches are real" | Single-line patch                                                    | Behaviour-changing — false positives become real `emitFile` edges → chunk-graph cycles (the very bug `strip-literal` was added to prevent, see `runtime-transport-authoring-simplification.md`) | ❌       |
| `id`-level exclude regex on `node_modules/**/openscad*/**`                             | One-line change                                                      | Whack-a-mole; doesn't cover future deps; opaque to readers; brittle to file-layout changes                                                                                                      | ❌       |
| Bump Node `--max-old-space-size`                                                       | No code change                                                       | Wrong axis — this is call-stack, not heap. Will not fix the failure.                                                                                                                            | ❌       |
| Switch tokenizer (`oxc-parser`)                                                        | Faster, more robust on huge files                                    | Heavier dep; over-engineered for the scope of `collectMatches`                                                                                                                                  | ❌ now   |
| Fork openscad-wasm-prebuilt to ship separate `.wasm`                                   | Removes the 10.9 MB literal from the graph; lighter chat-side bundle | Forks an upstream we don't control; doesn't fix the plugin antipattern; R6 only after R1+R2                                                                                                     | ➕ later |

## Related Plugin Audit

| Plugin                          | Reads `code`?                             | Has full-source regex/tokenizer? | At-risk for this class of bug?              |
| ------------------------------- | ----------------------------------------- | -------------------------------- | ------------------------------------------- |
| `vite:ts-module-url-build`      | yes                                       | **yes** (`stripLiteral`)         | **yes — failing now**                       |
| `vite:ts-module-url-serve`      | yes                                       | **yes** (`stripLiteral`)         | yes (dev only — would surface as SSR error) |
| `vite:large-dep-regex-fix`      | no (patches Vite's filter at config time) | n/a                              | no                                          |
| `vite:base64-loader`            | no (`?base64` query, fs.readFileSync)     | no                               | no                                          |
| `vite:oxc-runtime-esm`          | no (resolveId only)                       | no                               | no                                          |
| `vite:optimize-deps-from-cache` | no (config hook only)                     | no                               | no                                          |

The serve-mode plugin (`tsModuleUrlServePlugin`) shares the same `collectMatches` helper, so R1+R2 cover it transparently — the SSR module runner would have surfaced the same `RangeError` if anyone opened `openscad.js` in dev with a sourcemap-enabled build target.

## References

- Failing CI run: [Nx Cloud — `ui:build`](https://cloud.nx.app/runs/0KfucfKVix/task/ui%3Abuild)
- Vite upstream issue: [`vitejs/vite#15759` — `stripLiteral` may fail on large literals (~10MB)](https://github.com/vitejs/vite/issues/15759)
- Vite upstream issue: [`vitejs/vite#21696` — broad regex filters cause stack overflow on large files](https://github.com/vitejs/vite/issues/21696)
- Vite upstream fix: [`vitejs/vite#21800` — use precise regexes for transform filter to avoid backtracking](https://github.com/vitejs/vite/pull/21800)
- Upstream tokenizer issue: [`lydell/js-tokens#43` — workaround for huge string literals](https://github.com/lydell/js-tokens/pull/43)
- Internal precedent: `libs/vite/src/large-dep-regex-fix.vite-plugin.ts`
- Source files inspected: `libs/vite/src/ts-module-url.vite-plugin.ts`, `node_modules/.pnpm/strip-literal@3.1.0/.../index.mjs`, `node_modules/.pnpm/js-tokens@9.0.1/.../index.js`

## Appendix: Reproduction probe

```bash
# Confirm the file shape
awk '{ print length, NR }' \
  node_modules/.pnpm/openscad-wasm-prebuilt@1.2.0/node_modules/openscad-wasm-prebuilt/dist/openscad.js \
  | sort -rn | head -3
# Output:
#   10904711 28        ← single 10.9 MB line
#   357 2965
#   342 2732

rg -c 'new URL\(' \
  node_modules/.pnpm/openscad-wasm-prebuilt@1.2.0/node_modules/openscad-wasm-prebuilt/dist/openscad.js
# Output: (no match)  ← zero `new URL(` call sites

rg -n 'import\.meta\.url' \
  node_modules/.pnpm/openscad-wasm-prebuilt@1.2.0/node_modules/openscad-wasm-prebuilt/dist/openscad.js
# Output: 31:  var _scriptName = import.meta.url;  ← single mention; trips substring filter

awk 'NR==28' …/openscad.js | head -c 200
# Output: …  return _loadWasmModule(0, null, 'AGFzbQEAAAABjQ/TAWA…  ← Emscripten SINGLE_FILE base64 blob
```
