# ES Module Asset Injection Policy

Standard practice for loading heavy assets (WASM binaries, Emscripten JS glue, large modules) in a way that enables code-splitting, tree-shaking, and runtime injection.

## Problem

Static top-level imports of variant modules force all variants into the bundle, regardless of which is actually used at runtime:

```typescript
// BAD: both variants always bundled (~225KB total)
import single from 'replicad-opencascadejs/src/replicad_single.js';          // ~112KB
import exceptions from 'replicad-opencascadejs/src/replicad_with_exceptions.js'; // ~113KB
```

This pattern prevents consumers from shipping a minimal bundle when they only need one variant.

## The Two-Tier Dynamic Import Pattern

### Tier 1: Static-string dynamic imports (presets)

For known, build-time-resolvable variants, use `import()` with a **static string literal**. All major bundlers (Vite/Rollup, webpack, esbuild) recognize this pattern and create a **code-split chunk** that is loaded on-demand:

```typescript
async function loadBindings(preset: 'single' | 'single-exceptions') {
  if (preset === 'single-exceptions') {
    return import('replicad-opencascadejs/src/replicad_with_exceptions.js');
  }
  return import('replicad-opencascadejs/src/replicad_single.js');
}
```

**Why this works**: The bundler statically detects each `import()` target at build time, creates separate chunks, and handles CJS-to-ESM transformation automatically. Only the selected chunk is downloaded at runtime.

### Tier 2: Variable dynamic imports (custom URLs)

For runtime-provided URLs (benchmarking, CI, custom WASM builds), use `import()` with a runtime variable and a bundler-ignore comment:

```typescript
async function loadCustomBindings(url: string) {
  return import(/* @vite-ignore */ url);
}
```

**Bundler compatibility for ignore comments**:

| Bundler | Comment | Behavior |
|---|---|---|
| Vite | `/* @vite-ignore */` | Suppresses warning, preserves as runtime import |
| Rollup | _(none needed)_ | Warns, preserves as-is (suppress via `onwarn`) |
| esbuild | _(none needed)_ | Warns, preserves as-is |
| webpack | `/* webpackIgnore: true */` | Suppresses warning, preserves as runtime import |

**CJS limitation**: Runtime `import(url)` in browsers requires the target to be an ES module. CJS-to-ESM transformation only happens for static-string imports that bundlers process at build time. In Node.js, `import()` handles CJS files natively. Custom URL injection is therefore primarily a **Node.js-first** capability (benchmarks, CI, testing).

## WASM Binary URL Pattern

For WASM binaries loaded via `fetch()` / `WebAssembly.compileStreaming()`, use the universal `new URL()` pattern with a static string literal:

```typescript
const wasmUrl = new URL('wasm/replicad_single.wasm', import.meta.url).href;
```

This pattern is recognized by all major bundlers ([web.dev reference](https://web.dev/articles/bundling-non-js-resources#universal_pattern_for_browsers_and_bundlers)). The bundler copies the asset to the output directory and rewrites the URL at build time.

**Key constraint**: The path must be a static string literal, not a variable. Variables prevent the bundler from detecting and copying the asset.

## Serialization Constraint

When options cross a `postMessage` boundary (e.g., main thread to Web Worker), they are serialized via the structured clone algorithm. This means:

- Strings (URLs) survive serialization
- Functions, URL objects, and module references do **not**

Therefore, WASM configuration must be expressed as plain strings (URL strings), not as functions or object references. Preset resolution (mapping a preset name to URLs and module imports) must happen on the worker side where `import.meta.url` resolves correctly relative to the kernel module.

## Putting It Together

The recommended architecture for factory options that select between heavy asset variants:

1. **Consumer API**: Union type of preset strings and a custom config object
   ```typescript
   type WasmOption = 'single' | 'single-exceptions' | { wasmUrl: string; wasmBindingsUrl: string };
   ```

2. **Factory**: Passes the raw option through as a serializable value (string or plain object)

3. **Worker-side resolution**: Maps presets to URLs using `new URL()` and loads modules via static-string `import()`. Custom configs use variable `import()` with ignore comments.

4. **Pure initialization function**: Receives the already-resolved URL and loaded module factory. Zero module-level state, zero static imports of variant modules.

## Anti-patterns

- **Top-level static imports of variant modules** -- forces all variants into the bundle
- **Module-level URL constants for unused variants** -- references assets that may never be needed
- **Passing functions through `postMessage`** -- functions are not structured-cloneable
- **Dynamic `import(variable)` without ignore comments** -- produces bundler warnings in CI/CD
- **Assuming CJS works with browser `import()`** -- it does not; only Node.js handles CJS via `import()`
