---
title: 'Runtime Transport Callable Plugin Pattern'
description: '`TransportPlugin` callables (`webWorkerTransport({...})`, …) let `RuntimeClient` materialise a fat handle once per lifetime; sibling `webWorkerHost` / `nodeWorkerHost` exports own worker/host entries.'
status: active
created: '2026-05-01'
updated: '2026-05-01'
category: architecture
related:
  - docs/research/runtime-transport-architecture-v6.md
  - docs/research/runtime-transport-authoring-simplification.md
  - docs/research/runtime-worker-bundling-strategy.md
  - docs/research/runtime-zero-config-bundling.md
  - docs/policy/library-api-policy.md
---

# Runtime Transport Callable Plugin Pattern

Callable **`TransportPlugin`** shape for bundled transports (`webWorkerTransport({ ... })`, `inProcessTransport({ ... })`, …): consumers pass the **wired plugin** to `createRuntimeClient`, construction calls **`transportPlugin.materialize()`** exactly once per `RuntimeClient`, and **`terminate()` always invokes `transport.close()`**. Worker/host entry code imports **`webWorkerHost`** / **`nodeWorkerHost`** / **`electronUtilityHost`** directly instead of **`transport.host()`** accessors.

## Executive Summary (**implemented**)

Bundled transports mirror kernels/middleware: a **callable plugin factory** returns `{ id, describe, materialize }`. **Consumer plane:** `createRuntimeClient({ transport: webWorkerTransport({ ... }) })`. **Worker plane:** static-import **`webWorkerHost({ worker }).open()`** (same chunk-graph rule as R1/R2 authoring simplification docs). **`webWorkerClient` / `nodeWorkerClient` / `inProcessClient`** remain standalone named exports for tests and bespoke dispatch wiring.

Problems from the interim **dual-surface API** (.client accessors + mismatched **`terminate`** ownership):

1. **StrictMode reuse** dead wire — fixed by **`materialize`** per **`RuntimeClient`**, not memoising **`RuntimeTransportClient`** handles across lifetimes.
2. **CLI / Node factories** leaked **`MessageChannel`** — fixed because **`terminate()` unconditionally closes** the materialised **`RuntimeTransportClient`**.
3. **Split brains on who owns `close`** — deleted; **`RuntimeClient`** always owns **`materialize`** + **`close`**.

Historical note — prior interim patches that skipped **`transport.close()`** inside **`RuntimeWorkerClient`** (and any **call-site-shaped** ownership branching) are **obsolete** alongside **`.client` / `.host` carriers**.

The chunk-emit cycle that motivated [`runtime-transport-authoring-simplification.md`](./runtime-transport-authoring-simplification.md) (R1) stays broken: **`worker/web.ts`** static-imports only **`web-worker-host.ts`**; composition **`web-worker-transport.ts`** may import **`web-worker-client.ts`** safely.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Methodology](#methodology)
3. [Findings](#findings)
4. [Recommendations](#recommendations)
5. [`webWorkerTransport` Worked Example — Before / After](#webworkertransport-worked-example--before--after)
6. [Bundler Safety Analysis](#bundler-safety-analysis)
7. [Trade-offs](#trade-offs)
8. [Open Questions](#open-questions)
9. [References](#references)

## Problem Statement

StrictMode, CLI hangs, and ad-hoc transport disposal hacks traced every failure to **reusing a `RuntimeTransportClient` across two `RuntimeClient` lifetimes**. The v6 contract is one fresh handle per construction after **`materialize()`**, cleared by **`terminate()`** — this research doc records the **`TransportPlugin` callable migration** that enforces that invariant.

## Methodology

- Re-read [`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md) eigenquestions around consumer vs worker surfaces.
- Re-read [`runtime-transport-authoring-simplification.md`](./runtime-transport-authoring-simplification.md) (R1) — files that emit worker chunks via **`new URL(..., import.meta.url)`** must stay outside the emitted chunk’s transitive import graph.
- Migrated bundled transports, UI/CLI/electron examples, policies, and MDX guides to callable plugins + named host exports; added materialisation + chunk-graph regression tests.

## Findings

### Finding 1 — Callable plugin + sibling host restores the documented split

| Plane                                            | Canonical call                                                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer / CLI / npm consumer                    | **`webWorkerTransport({ fileSystem })`**, **`nodeWorkerTransport({ fileSystem })`**, **`inProcessTransport({ fileSystem })`**, **`electronUtilityTransport({ port })`** |
| **`worker/web.ts` bootstrap**                    | **`webWorkerHost({ worker }).open()`**                                                                                                                                  |
| **`worker/node.ts` bootstrap**                   | **`nodeWorkerHost({ worker }).open()`**                                                                                                                                 |
| **`createRuntimeHost` (Electron utility, etc.)** | **`electronUtilityHost({ fileSystem })`**                                                                                                                               |

The interim **`.client` / `.host` accessor carriers** are deleted; host/client factories are **named exports** only.

### Finding 2 — Symptoms 1–3 collapse into a single shape mismatch

| Symptom                     | What the consumer holds                                              | What the runtime expects to own                               | Resulting bug                                                                       |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| StrictMode hang             | A live `RuntimeTransportClient` (memoised)                           | The same instance across two `RuntimeClient` lifetimes        | Second `RuntimeClient` reuses a closed channel                                      |
| CLI hang                    | A live `RuntimeTransportClient` (built inside `createNodeClient`)    | Disposed by whoever constructed it (the factory wrapper)      | `client.terminate()` doesn't close the transport; Node event loop stays alive       |
| Object.assign wrapper smell | A live `RuntimeTransportClient` returned from a higher-level factory | A clean disposal hook the factory can attach to `terminate()` | API has no expression slot for "I built this transport for you, dispose it with me" |

All three originated at the same edge: **memoising a live `RuntimeTransportClient` handle** across StrictMode or factory wrappers. **Callable `TransportPlugin` + `materialize()` at `createRuntimeClient` construction** removes that edge — consumers keep only the lightweight plugin.

### Finding 3 — The spec/instance split is the v6 lifecycle contract

[`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md) §"`defineRuntimeTransport` Concrete TypeScript" line 601-602 states the lifecycle contract bluntly:

> **Close the wire, terminate the host. After `close()` resolves, the transport is unusable; callers must construct a new instance.**

**`TransportPlugin`** is the declarative side (`describe()` stays pure). **`materialize()`** produces the fat handle. **`RuntimeClient`** owns **`close()`** unconditionally on **`terminate()`**, matching kernels/transcoders where the runtime core materialises plugin work per lifetime.

### Finding 4 — The chunk-emit cycle is structural to the worker entry's import graph, not to who calls the spec

The cycle that hung `pnpm nx build ui` (per [`runtime-transport-authoring-simplification.md`](./runtime-transport-authoring-simplification.md) Findings 1–3) was a Rolldown emit-pipeline cycle with one root cause:

> A file that emits a chunk via `new URL(..., import.meta.url)` must not be reachable from the emitted chunk's transitive graph.

The fix was to split `web-worker-transport.ts` into client + host + thin composition so that `worker/web.ts` (the chunk being emitted by `web-worker-client.ts`'s `new URL` literal) only static-imports `web-worker-host.ts`. The current layout:

```
worker/web.ts            ← chunk being emitted
   └─ static import: web-worker-host.ts                (host factory, NO `new URL`)

web-worker-client.ts     ← chunk-emitter (DEFAULT_WEB_WORKER_URL lives here)
   └─ static import: nothing reachable from worker/web.ts

web-worker-transport.ts  ← composition (defineRuntimeTransport({ id, client, host }))
   ├─ import: web-worker-client.ts                     (consumer-side carrier)
   └─ import: web-worker-host.ts                       (consumer-side carrier)
```

Making `webWorkerTransport(options)` callable does NOT change which file imports which:

- The composition file (`web-worker-transport.ts`) **already** static-imports `web-worker-client.ts` for the existing `webWorkerTransport = webWorkerClient` field. Adding a callable signature that internally references `webWorkerClient` adds no new import edges.
- The worker entry (`worker/web.ts`) **does not** import the composition file. It imports `web-worker-host.ts` directly. Whether the composition file is callable or not is irrelevant to the worker chunk's transitive graph.
- The spec returned by `webWorkerTransport(options)` is a closure over options + a reference to `webWorkerClient`. The closure's body is plain JavaScript, not a `new URL` literal, and is not subject to the chunk-planner cycle.

The structural rule from R1 stays satisfied: **`worker/web.ts` reaches only `web-worker-host.ts`; `web-worker-host.ts` does not import `web-worker-client.ts`**. The cycle remains structurally impossible.

### Finding 5 — `transport.describe()` must remain synchronous; SAB allocation can defer to `open()`

`RuntimeClient.transport.descriptor` is exposed synchronously at construction time (`runtime-client.ts:1120-1124`), before `connect()`. The current `webWorkerClient.describe()` reads `pools` (allocated by `allocatePools()` at instance construction). For the spec/materialization split to preserve the existing public surface:

- The spec must expose `describe()` synchronously, computed from options alone (no live channel, no allocated SAB).
- SAB allocation moves from instance-construction time into the spec's materializer (or, equivalently, into the materialized client's `open()` — which is where the channel and worker instantiation already live).

This is a strictly orthogonal cleanup but ships in the same PR because the two cuts compose cleanly. The current `allocatePools` call inside `webWorkerClient` happens synchronously at `client()` construction; moving it inside `open()` is a one-line change with no semantic effect (no consumer reads pool memory before `open()` resolves).

### Finding 6 — The author-side surface stays — for transport authors and worker entries

Even with the callable consumer surface, two real consumers continue to need direct access to `webWorkerHost(...)` and (rarely) `webWorkerClient(...)`:

| Consumer                                                                               | What it imports                                                  | Why it can't go through the callable plugin                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/web.ts` (bundled worker entry)                                                 | `webWorkerHost` from `#transport/web-worker-host.js`             | Must not import the composition file (chunk-emit cycle)                                                                                 |
| `worker/node.ts` (bundled node-worker entry)                                           | `nodeWorkerHost` from `#transport/node-worker-host.js`           | Same                                                                                                                                    |
| Electron utility-process kernel host (`examples/electron-tau/src/main/kernel-host.ts`) | `electronUtilityHost` from the consumer's plugin                 | The Electron transport requires a consumer-supplied bootstrap (per v6 line 1430); the host script is application code, not runtime code |
| Custom transport authors                                                               | `webWorkerClient` / `webWorkerHost` (for inheritance / wrapping) | Authoring composition is what `defineRuntimeTransport` exists for                                                                       |

These keep their existing `webWorkerTransport` / `webWorkerHost` access. **The callable plugin pattern adds a third surface (the call form), it does not remove either of the two existing surfaces.** v6 §"Files to Add" / §"Files to Delete" stays unchanged.

### Finding 7 — Spillover audit: every "factory wrapper" site benefits

Eight sites in the workspace currently construct a transport instance to pass to `createRuntimeClient`. The callable plugin pattern simplifies all of them:

| Site                                                                 | Today                                                                                           | After                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/node.ts` `createNodeClient`                    | Builds `inProcessTransport({fileSystem})`, returns wrapped client                               | Returns `createRuntimeClient({ transport: inProcessTransport({fileSystem}) })`; no wrapping; CLI hang fixed |
| `packages/runtime/src/benchmarks/benchmark-runner.ts`                | Builds in-process transport, manually disposes                                                  | Pass spec; runtime owns lifetime                                                                            |
| `apps/ui/app/routes/_index/hero-viewer.tsx`                          | `useMemo(() => inProcessTransport({fileSystem}), [])` + ceremony comment about hydration timing | `transport: inProcessTransport({fileSystem})` inline; no memo, no ceremony                                  |
| `apps/ui/app/components/docs/kernel-model-view.tsx`                  | Same                                                                                            | Same                                                                                                        |
| `apps/ui/app/machines/kernel.integration.test.ts`                    | Same                                                                                            | Same                                                                                                        |
| `apps/ui/app/routes/auth.$/splashback/auth-splashback.tsx`           | Same                                                                                            | Same                                                                                                        |
| `examples/electron-tau/src/main/index.ts`                            | Builds `electronUtilityTransport(...)`                                                          | `transport: electronUtilityTransport({...})`                                                                |
| Documentation snippets in `apps/ui/content/docs/(runtime)/api/*.mdx` | Show `webWorkerTransport({...})` everywhere                                                     | Show `webWorkerTransport({...})` — consistent with `replicad()` / `openscad()` kernel calls                 |

Mechanical migration. No new disposal logic at any site. No `Object.assign` wrappers anywhere.

## Recommendations

| #       | Action                                                                                                                                                                                                                                                                                                                          | Priority | Effort | Impact                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------- |
| **R1**  | Add a callable signature to `RuntimeTransportPlugin<...>` so `webWorkerTransport(options)` returns a `RuntimeTransportSpec<...>`. Synthesise the call form inside `defineRuntimeTransport` / `definePassthroughTransport` so author-facing factories don't change.                                                              | P0       | M      | High — closes the consumer/author seam        |
| **R2**  | Add `RuntimeTransportSpec<P, BE, Id>` type to `runtime-transport.types.ts`: `{ id, describe(): TransportDescriptor<Id>, materialize(): RuntimeTransportClient<P, BE, Id> }`. Spec is plain data plus closures; safe to reference across renders, pass through React deps, persist in spec maps.                                 | P0       | S      | High — names the lifetime contract            |
| **R3**  | **Done** — **`createRuntimeClient`/`TransportPlugin`** materialisation + unconditional **`terminate()` → `transport.close()`**                                                                                                                                                                                                  | P0       | M      | High                                          |
| **R4**  | Move `allocatePools(...)` and other side-effectful work from instance-construction (`webWorkerClient` / `nodeWorkerClient` / inProcess client bodies) into the materialized handle's `open()` call so `describe()` stays pure / sync per Finding 5.                                                                             | P0       | S      | Med — preserves descriptor sync semantics     |
| **R5**  | Migrate the 8 consumer call sites in Finding 7 from `transport.client({...})` to `transport({...})`. Mechanical replacement. Drop the React `useMemo` ceremony at hero-viewer / kernel-model-view / auth-splashback.                                                                                                            | P0       | S      | High — removes leaked transports + ceremony   |
| **R6**  | Delete `createNodeClient`'s wrapper plumbing (no `Object.assign`, no manual transport tracking). Make it a 4-line passthrough that builds the spec and forwards options to `createRuntimeClient`.                                                                                                                               | P0       | XS     | High — removes the smell                      |
| **R7**  | Update every doc snippet in `apps/ui/content/docs/(runtime)/{api,guides,getting-started}/*.mdx` to use the call form. Add a one-paragraph callout naming the spec/handle distinction so future contributors don't reintroduce instance-passing.                                                                                 | P1       | S      | Med — prevents regression                     |
| **R8**  | Add a TDD test in `transport-conformance.test.ts` that asserts each transport plugin is callable, returns a spec with the correct `describe()` snapshot, and that the spec materializes a fresh handle each call (`spec.materialize() !== spec.materialize()`).                                                                 | P0       | S      | High — locks in the contract                  |
| **R9**  | Add a regression test in `runtime-client.lifecycle.test.ts` that creates two sequential `RuntimeClient`s from the **same** spec, terminates each, asserts both materialized handles received `close()` and that the spec stayed reusable across both. Replaces the misleading "StrictMode surrogate" test from the Option A PR. | P0       | S      | High — pins the StrictMode contract correctly |
| **R10** | Drop the `fileSystem` top-level option proposal that surfaced as a stop-gap for `createNodeClient` — it's no longer needed because the spec form already accepts options.                                                                                                                                                       | P0       | XS     | Trivial — keeps `RuntimeClientOptions` lean   |

## `webWorkerTransport` Worked Example — Before / After

### Type shapes

```typescript
// runtime-transport.types.ts — new

/**
 * Materialization-deferred handle to a transport. Returned by calling
 * a `RuntimeTransportPlugin` directly (`webWorkerTransport({ ... })`).
 *
 * Specs are pure data plus closures. They are safe to reference across
 * React renders, persist in option bags, pass through `useMemo` deps,
 * and serialize for diagnostics. The runtime calls `materialize()`
 * exactly once per `RuntimeClient` lifetime (at `connect()`) and the
 * `RuntimeClient` calls `close()` on the materialized handle at
 * `terminate()`.
 *
 * @public
 */
export type RuntimeTransportSpec<
  Protocol extends RpcProtocol = RuntimeProtocol,
  BindingsExtra extends Readonly<Record<string, unknown>> = Readonly<Record<never, never>>,
  Id extends string = string,
> = {
  readonly id: Id;
  /**
   * Sync descriptor projection. Computed from options alone — no
   * channel, no SAB allocation, no worker construction. Available
   * before `connect()` so `RuntimeClient.transport.descriptor`
   * keeps its current sync access semantics.
   */
  describe(): TransportDescriptor<Id>;
  /**
   * Materializes a fresh, single-use {@link RuntimeTransportClient}.
   * Called by `createRuntimeClient` at `connect()` time. Each call
   * returns an independent instance; specs are not caches.
   *
   * @internal — consumer code never invokes this directly
   */
  materialize(): RuntimeTransportClient<Protocol, BindingsExtra, Id>;
};

/**
 * The runtime transport plugin object. Three coexisting surfaces:
 *
 * - **Callable form** `plugin(options)` — consumer entry, returns a
 *   spec. This is the documented call site for every `createRuntimeClient`
 *   user.
 * - `plugin.client(options)` — author entry, returns a live handle.
 *   Used by transport implementers and worker entries that bypass
 *   the spec layer.
 * - `plugin.host(options)` — host-side factory, used inside the
 *   bundled worker entry chunks (`worker/web.ts`, `worker/node.ts`)
 *   and in consumer-supplied Electron utility-process scripts.
 *
 * @public
 */
export type RuntimeTransportPlugin<
  Protocol extends RpcProtocol = RuntimeProtocol,
  BindingsExtra extends Readonly<Record<string, unknown>> = Readonly<Record<never, never>>,
  Id extends string = string,
  ClientOptions = Readonly<Record<string, unknown>>,
  HostOptions = Readonly<Record<string, unknown>>,
> = {
  readonly id: Id;

  /** Consumer entry: returns a {@link RuntimeTransportSpec}. */
  (options: ClientOptions): RuntimeTransportSpec<Protocol, BindingsExtra, Id>;

  /** Author entry: returns a live {@link RuntimeTransportClient}. */
  readonly client: (options: ClientOptions) => RuntimeTransportClient<Protocol, BindingsExtra, Id>;

  /** Host entry: returns a {@link RuntimeTransportHost} for the worker chunk. */
  readonly host: (options: HostOptions) => RuntimeTransportHost<Protocol, BindingsExtra, Id>;

  // ...phantom carriers (__transportId, __transportClientOptions, ...) unchanged
};
```

### `defineRuntimeTransport` — synthesises the call form

The factory wraps `client` so the returned object is callable. No author-facing change:

```typescript
// transport/define-runtime-transport.ts — implementation excerpt

export function defineRuntimeTransport(definition: any): any {
  const { clientOptionsSchema: _cs, hostOptionsSchema: _hs, protocol: _p, client, host, id } = definition;

  // The callable plugin object: invoke it with options to get a spec.
  const plugin = (options: unknown) => {
    // Eagerly compute the descriptor snapshot. `client.describe(options)` is
    // the new opt-in pure projection; falls back to materializing-and-asking
    // for transports that don't yet implement the static projection.
    return {
      id,
      describe: () => (typeof client.describe === 'function' ? client.describe(options) : client(options).describe()), // legacy fallback (R4 removes this branch)
      materialize: () => client(options),
    } satisfies RuntimeTransportSpec;
  };

  // Pin the author surface as own properties so `plugin.client` / `plugin.host`
  // keep working for worker entries and transport implementers.
  Object.defineProperties(plugin, {
    id: { value: id, enumerable: true },
    client: { value: client, enumerable: true },
    host: { value: host, enumerable: true },
  });

  return plugin;
}
```

### `web-worker-client.ts` — split: pure `describe`, deferred SAB allocation

Today `webWorkerClient` allocates SAB pools at construction and exposes `describe()` reading them. Per R4 we hoist a pure `webWorkerClientDescribe(options)` function and defer pool allocation into `open()`:

```typescript
// transport/web-worker-client.ts — proposed

const defaultWebWorkerUrl = new URL('../worker/web.js', import.meta.url);

/** Sync, pure descriptor projection. Used by both `client()` and the spec form. */
export const webWorkerClientDescribe = (options: WebWorkerClientOptions): TransportDescriptor<WebWorkerId> => ({
  id: webWorkerId,
  wire: 'web-worker',
  memory: {
    geometryDelivery: options.sharedMemory?.geometry ? 'pool' : 'transfer',
    fileDelivery: options.filePoolBuffer ? 'pool' : 'transfer',
    abortSignal: options.sharedMemory?.geometry || options.filePoolBuffer ? 'sab-atomics' : 'wire-notify',
  },
  fileSystem: options.fileSystem ? 'inline' : 'unbound',
});

export const webWorkerClient = (
  options: WebWorkerClientOptions,
): RuntimeTransportClient<RuntimeProtocol, Readonly<Record<never, never>>, WebWorkerId> => {
  // ...validation unchanged

  let pools: ReturnType<typeof allocatePools> | undefined;
  let openPromise: Promise<TransportClientReady> | undefined;
  // ...

  const open = async (): Promise<TransportClientReady> => {
    if (openPromise) return openPromise;
    openPromise = (async () => {
      // SAB allocation moved here from construction time.
      pools ??= allocatePools({
        geometry: options.sharedMemory?.geometry,
        filePoolBuffer: options.filePoolBuffer,
      });
      // ...rest unchanged
    })();
    return openPromise;
  };

  return {
    id: webWorkerId,
    describe: () => webWorkerClientDescribe(options),
    open,
    initialize,
    abort,
    resolveGeometry,
    close,
    closed,
  };
};

// Tag the static projection so `defineRuntimeTransport` can find it.
webWorkerClient.describe = webWorkerClientDescribe;
```

### `web-worker-transport.ts` — composition file gains a callable surface for free

```typescript
// transport/web-worker-transport.ts — unchanged source-line-count

import { defineRuntimeTransport } from '#transport/define-runtime-transport.js';
import { webWorkerClientOptionsSchema, webWorkerHostOptionsSchema } from '#transport/web-worker-transport.schemas.js';
import { webWorkerId } from '#transport/_internal/web-worker-id.js';
import { webWorkerClient } from '#transport/web-worker-client.js';
import { webWorkerHost } from '#transport/web-worker-host.js';

export type { WebWorkerLike, WebWorkerClientOptions } from '#transport/web-worker-client.js';
export type { WebWorkerHostOptions } from '#transport/web-worker-host.js';

/**
 * Bundled web-worker transport plugin. Three surfaces share one object:
 *
 *   - `webWorkerTransport({ ... })`        consumer call (returns spec)
 *   - `webWorkerTransport({ ... })` author entry (returns live handle)
 *   - `webWorkerHost({ ... })`   host entry (worker chunk)
 *
 * @public
 */
export const webWorkerTransport = defineRuntimeTransport({
  id: webWorkerId,
  clientOptionsSchema: webWorkerClientOptionsSchema,
  hostOptionsSchema: webWorkerHostOptionsSchema,
  client: webWorkerClient,
  host: webWorkerHost,
});
```

### Consumer call sites — before / after

```typescript
// hero-viewer.tsx — BEFORE
const heroOptions = useMemo(
  () =>
    createRuntimeClientOptions({
      transport: inProcessTransport({ fileSystem: fromMemoryFs() }),
      kernels: [openscad()],
      // ...
    }),
  [],
);

// hero-viewer.tsx — AFTER
const heroOptions = createRuntimeClientOptions({
  transport: inProcessTransport({ fileSystem: fromMemoryFs() }),
  kernels: [openscad()],
  // ...
});
```

```typescript
// node.ts — BEFORE
export async function createNodeClient(
  projectPath?: string,
  options?: Partial<Omit<RuntimeClientOptions, 'transport'>>,
): Promise<RuntimeClient> {
  const fileSystem = projectPath ? fromNodeFs(projectPath) : fromMemoryFs();
  const transport = inProcessTransport({ fileSystem }); // INSTANCE
  return createRuntimeClient({
    ...presets.all(),
    ...options,
    transport,
  });
}

// node.ts — AFTER
export function createNodeClient(
  projectPath?: string,
  options?: Partial<Omit<RuntimeClientOptions, 'transport'>>,
): RuntimeClient {
  const fileSystem = projectPath ? fromNodeFs(projectPath) : fromMemoryFs();
  return createRuntimeClient({
    ...presets.all(),
    ...options,
    transport: inProcessTransport({ fileSystem }), // SPEC
  });
}
```

```typescript
// CLI export.ts — UNCHANGED
const client = await createNodeClient(inputDirectory); // hangs no more
try {
  /* ... */
} finally {
  client.terminate(); // RuntimeClient closes its materialised transport
}
```

### Worker entry — UNCHANGED

```typescript
// worker/web.ts — already correct, stays exactly as-is

import '#framework/worker-preload-polyfill.js';
import { KernelRuntimeWorker } from '#framework/kernel-runtime-worker.js';
import { webWorkerHost } from '#transport/web-worker-host.js';

const worker = new KernelRuntimeWorker();
await webWorkerHost({ worker }).open();
```

The chunk-emitter file (`web-worker-client.ts`) stays unreachable from this entry. The cycle stays broken.

## Bundler Safety Analysis

The risk addressed by [`runtime-transport-authoring-simplification.md`](./runtime-transport-authoring-simplification.md) (R1) was Rolldown's `emitFile()` deadlocking when the chunk being emitted has a static path back to the file currently in `transform()`. The structural rule:

> **A file that emits a chunk via `new URL(..., import.meta.url)` must not be reachable from the emitted chunk's transitive graph.**

The proposed callable plugin pattern is evaluated against this rule below. There are three import edges to verify:

| Edge                                               | Today                        | After callable plugin                                   | Hazard?                                                    |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `worker/web.ts` → `web-worker-host.ts`             | static                       | static                                                  | None — host has no `new URL`                               |
| `worker/web.ts` → `web-worker-client.ts`           | none                         | none                                                    | None — entry never reaches the chunk-emitter               |
| `web-worker-transport.ts` → `web-worker-client.ts` | static (for `.client` field) | static (for both `.client` field and call-form closure) | None — composition file is not in the worker chunk's graph |

The composition file (`web-worker-transport.ts`) is consumed by:

- Consumer code (`createRuntimeClient` callers) — same as today.
- The runtime barrel (`@taucad/runtime/transport/web`) — same as today.
- **Not** the worker entry — worker entry imports the host file directly (the cycle-break invariant).

Adding a callable surface to the composition file changes nothing about which files reach which. The Rolldown cycle hazard is not reintroduced.

### Comparison against [`runtime-worker-bundling-strategy.md`](./runtime-worker-bundling-strategy.md) Finding 1

That document warns that `new URL(..., import.meta.url)` only works at the layer the bundler is actively building — once the literal crosses an `npm publish` boundary or a workspace boundary, every bundler reinterprets `import.meta.url` against its own output position. The current architecture uses the inverted pattern recommended in Finding 2: the runtime publishes a `./worker/web.js` subpath export, and `webWorkerClient` constructs the default URL via a `new URL(..., import.meta.url)` literal that the consumer's bundler resolves against the runtime's source location at the consumer's build layer.

The callable plugin pattern is a closure shape change at the consumer call site. The `new URL` literal in `web-worker-client.ts` is unaffected. The published `./worker/web.js` subpath is unaffected. None of the bundler-matrix cases in Finding 3 are touched.

### Comparison against [`runtime-zero-config-bundling.md`](./runtime-zero-config-bundling.md) Finding 3

That document warns that Vite's `optimizeDeps.exclude` must be set so the runtime is not pre-bundled past its `import.meta.url` boundary. The callable plugin pattern adds no new pre-bundling pressure: the same files import the same files; only the runtime closure shape changes.

### Verifiable invariant

A regression test that pins the cycle-break invariant — independent of the callable plugin work — already exists in spirit but should be made explicit:

```typescript
// transport/chunk-emit-cycle-break.test.ts — proposed
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('worker entry chunk-emit cycle break', () => {
  it('worker/web.ts must not import web-worker-client.ts (chunk-emitter)', () => {
    const source = readFileSync('packages/runtime/src/worker/web.ts', 'utf8');
    expect(source).not.toMatch(/web-worker-client/);
    expect(source).not.toMatch(/web-worker-transport/);
  });

  it('web-worker-host.ts must not contain `new URL(..., import.meta.url)`', () => {
    const source = readFileSync('packages/runtime/src/transport/web-worker-host.ts', 'utf8');
    expect(source).not.toMatch(/new URL\([^)]+import\.meta\.url/);
  });
});
```

Two-line guard. Catches any future contributor accidentally adding an import that re-creates the cycle.

## Trade-offs

| Concern                                          | Status quo                                                      | After R1–R10                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Author-facing API entry points                   | 1 (`defineRuntimeTransport`) + 1 (`definePassthroughTransport`) | Same — no new author symbols                                                                                                       |
| Consumer-facing call site                        | `webWorkerTransport({...})`                                     | `webWorkerTransport({...})`                                                                                                        |
| Lifetime ownership rules                         | 2 (consumer-built vs runtime-built)                             | 1 (runtime always owns the materialized handle)                                                                                    |
| Source-line cost                                 | —                                                               | +~30 lines for `RuntimeTransportSpec` type + callable wrapper in `defineRuntimeTransport`                                          |
| Source-line saving                               | —                                                               | −~80 lines across `node.ts` wrapper, hero-viewer / kernel-model-view useMemo ceremonies, ownership branch in `createRuntimeClient` |
| `RuntimeClient.transport.descriptor` sync access | Preserved (instance built eagerly)                              | Preserved (R4 hoists `describe` to a pure function)                                                                                |
| Worker chunk-emit cycle                          | Broken (per R1 split)                                           | Still broken (no new edges added)                                                                                                  |
| Author back-compat (`webWorkerTransport`)        | Available                                                       | Available — author surface is intact                                                                                               |
| Test coverage                                    | Conformance tests for live `client()` surface                   | Same tests + new spec/materialize tests + cycle-break invariant test                                                               |
| Migration cost                                   | —                                                               | 8 mechanical call-site changes; 1 doc pass                                                                                         |

The primary cost is the migration pass across consumer call sites. The primary saving is removing all bespoke transport-disposal logic from higher-level factories. Net structural complexity drops sharply.

## Open Questions

| #   | Question                                                                                                                                         | Recommendation                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Should the callable plugin form return a spec carrying its own `Symbol.dispose` / `Symbol.asyncDispose`?                                         | No — runtime owns disposal; consumers don't `using` the spec. The spec is plain data with a materializer closure, no resource.                                                                   |
| Q2  | Should `RuntimeClient` continue to accept a live `RuntimeTransportClient` instance (in addition to a spec) for an escape-hatch grace period?     | One release window with a runtime warning, then remove. Per AGENTS.md "no backwards-compat for unreleased APIs", a hard cutover is acceptable; a soft period is a courtesy for downstream forks. |
| Q3  | Where does the spec layer live for transport authors writing custom transports outside the runtime package?                                      | Same as today — they call `defineRuntimeTransport({...})` and the factory automatically synthesises the callable form. No author-side change required.                                           |
| Q4  | Should `inProcessTransport({ fileSystem })` accept the spec inputs that `inProcessTransport(options)` accepts today, with no other shape change? | Yes — the spec form is a thin wrapper. Options shape is identical.                                                                                                                               |
| Q5  | Does the Electron utility transport (`examples/electron-tau`) need anything special?                                                             | No — `electronUtilityTransport({...})` works the same as the others. The `host` factory continues to live in the consumer's `kernel-host.ts` script (per v6 line 1430), unchanged.               |
| Q6  | Does `definePassthroughTransport` need separate treatment?                                                                                       | No — it already returns a `RuntimeTransportPlugin` shape; the wrapper synthesises the call form for it identically.                                                                              |

## References

- [`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md) — v6 blueprint; the call-form was always specified, this proposal lands it.
- [`runtime-transport-authoring-simplification.md`](./runtime-transport-authoring-simplification.md) — the chunk-emit cycle that any structural change must preserve. R1 file split is the foundation this builds on.
- [`runtime-worker-bundling-strategy.md`](./runtime-worker-bundling-strategy.md) — bundler-matrix constraints around `new URL(..., import.meta.url)` that the published `./worker/{web,node}` subpath exports satisfy. Unchanged by this work.
- [`runtime-zero-config-bundling.md`](./runtime-zero-config-bundling.md) — `optimizeDeps.exclude` requirements for the runtime; unaffected.
- [`library-api-policy.md`](../policy/library-api-policy.md) §6 (Subpath Exports), §10 (High-Level Wrappers + Low-Level Escape Hatches) — the callable plugin pattern is the high-level wrapper; `transport.client(...)` / `transport.host(...)` remain the low-level escape hatches.

## Findings & Recommendations Cheat Sheet — for forward planning

A condensed list to carry into the implementation plan and future audits:

### Findings

1. **F1 — v6 documents two factory surfaces (`plugin(options)` and `plugin.client(options)`); the runtime exposes only the latter**, which is why every consumer call site reaches the author API by default.
2. **F2 — Three recent bugs (StrictMode hang, CLI hang, Object.assign smell) collapse into one shape mismatch**: the consumer holds a live wire instance, but v6 says transports are 1:1 with `RuntimeClient` lifetimes.
3. **F3 — The 1:1 contract is canonical** (v6 line 601-602: "after `close()` resolves, the transport is unusable; callers must construct a new instance"). Specs are reusable, instances are not.
4. **F4 — The chunk-emit cycle break (R1 in `runtime-transport-authoring-simplification.md`) is structural to which file `worker/web.ts` reaches; the spec/materialization split adds no new import edges.**
5. **F5 — `transport.describe()` must remain synchronous**; SAB allocation can defer to `open()` without affecting any consumer surface.
6. **F6 — Author-side `transport.client(...)` / `transport.host(...)` stays** — required by worker entries (cycle-break) and by transport authors / Electron utility scripts.
7. **F7 — Eight consumer call sites across the workspace are simplified by the migration**; none are broken by it.
8. **`RuntimeClient` owns one materialised transport handle per lifetime** (`materialize()` at construction). No call-site-shape branching.

### Recommendations

| #   | Priority | Effort | Action                                                                                                                        |
| --- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| R1  | P0       | M      | Add callable signature to `RuntimeTransportPlugin`; synthesise inside `defineRuntimeTransport` / `definePassthroughTransport` |
| R2  | P0       | S      | Add `RuntimeTransportSpec<P, BE, Id>` to `runtime-transport.types.ts`                                                         |
| R3  | P0       | M      | ✅ `TransportPlugin.materialize()` + unconditional `terminate()` close                                                        |
| R4  | P0       | S      | Hoist `describe()` to a pure function; defer SAB allocation to `open()`                                                       |
| R5  | P0       | S      | Migrate 8 consumer call sites from `.client({...})` to `({...})`                                                              |
| R6  | P0       | XS     | Collapse `createNodeClient` to a 4-line passthrough                                                                           |
| R7  | P1       | S      | Update `apps/ui/content/docs/(runtime)/**/*.mdx` snippets                                                                     |
| R8  | P0       | S      | Conformance test: plugin is callable, returns spec, materializes fresh handles                                                |
| R9  | P0       | S      | Lifecycle test: same spec materializes per `RuntimeClient`; replaces flawed Option A "StrictMode surrogate"                   |
| R10 | P0       | XS     | Drop the proposed `fileSystem` top-level option (no longer needed)                                                            |

### Forward-planning rules

These are the durable lessons to encode into design reviews and policy:

1. **Plugin objects intended for `createRuntimeClient` should be callable; the call returns a spec, not a live resource.** Mirrors `replicad()` / `openscad()` (kernels) and `converterTranscoder()` (transcoders). Transport is the only primitive that broke this pattern.
2. **Resource lifetime tracks `RuntimeClient` lifetime, 1:1.** Any time a higher-level factory feels compelled to wrap `terminate()` or attach a custom dispose hook, the underlying API has the wrong shape. Push the resource construction into the runtime.
3. **The chunk-emit cycle rule is permanent**: a file that emits a chunk via `new URL(..., import.meta.url)` must not be reachable from the emitted chunk's transitive graph. Validated by `chunk-emit-cycle-break.test.ts` (proposed); applies to every transport, every kernel-worker entry, and any future asset-emitting runtime file.
4. **Sync descriptors are a public contract.** Anything `RuntimeClient.transport.descriptor` exposes must be projectable from options alone (no SAB, no channel, no worker construction). Side-effectful initialization moves into the materialized handle's `open()`.
5. **Author surface vs consumer surface are different things even when they share an object.** Naming and documentation must keep them distinct: `webWorkerTransport(opts)` for consumers, `webWorkerTransport(opts)` / `.host(opts)` for transport authors and worker entries.
6. **Workspace-wide migrations of consumer call sites should be mechanical, not bespoke.** When a structural change requires a wrapper at every call site (the Object.assign trap), the structural change is wrong. Find the API affordance instead.
