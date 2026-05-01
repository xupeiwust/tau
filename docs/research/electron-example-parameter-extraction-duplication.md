---
title: 'Electron example parameter extraction duplication'
description: 'Why examples/electron-tau ships a local OpenSCAD parameter regex alongside the runtime parametersResolved event, and the path back to runtime ownership.'
status: active
created: '2026-05-01'
updated: '2026-05-01'
category: investigation
related:
  - docs/research/runtime-transport-implementation-gap-analysis.md
---

# Electron example parameter extraction duplication

Investigates why `examples/electron-tau` carries `renderer/openscad-parameters.ts` (regex-based OpenSCAD parameter extractor) and its sibling test even though `App.tsx` already drives the parameter UI from the kernel's `parametersResolved` event, and recommends a cleanup path that returns full parameter ownership to the runtime client.

## Executive Summary

The local `extractParameters` regex is **dead code**: nothing in `App.tsx` (or anywhere else in the workspace) calls it. The renderer already subscribes to `client.on('parametersResolved', …)` and converts the kernel-supplied `GetParametersResult` into the form's `ScadParameter[]` via `parametersFromResult` — exactly the pattern used by `packages/react/src/hooks/use-render.ts`. The only live tie to the local module is the `ScadParameter` _type_ that `parameters-form.tsx` imports. The regex and its test file are scaffolding left over from the original PoC commit that has been overtaken by the runtime wiring. Delete the regex + test, lift the form's prop type into `parameters-form.tsx` (or import the runtime's `GetParametersResult` shape directly), and optionally factor the `parametersResolved`/`geometry`/`error` subscription block into a shared hook mirroring `useRender`.

## Problem Statement

`examples/electron-tau/src/renderer/openscad-parameters.ts` exposes `extractParameters(source: string)` — a regex over `^[\t ]*<ident>[\t ]*=[\t ]*<literal>;` lines — plus a `ScadParameter` type. A companion `openscad-parameters.test.ts` exercises the regex against synthetic SCAD source strings.

This duplicates work the `@taucad/openscad` kernel already performs (`processOpenScadParameters` + `flattenParametersForInjection` in `kernels/openscad/src/parse-parameters.ts`) and that the `RuntimeClient` already surfaces over the wire as the `parametersResolved` event with a typed `GetParametersResult` payload.

The user question is two-fold:

1. **Why does this duplication exist?** What was the original intent, and why has it survived after the runtime path was wired?
2. **What is the migration path** so the renderer fully relies on `RuntimeClient` events for parameter discovery, mirroring `packages/react/src/hooks/use-render.ts`?

## Methodology

1. Read every renderer source file under `examples/electron-tau/src/renderer/` (`app.tsx`, `parameters-form.tsx`, `openscad-parameters.{ts,test.ts}`, `parameter-override-sync.ts`).
2. `git log --all -- examples/electron-tau/src/renderer/openscad-params.ts` to recover the file's lineage (it predates the rename to `openscad-parameters.ts`).
3. Inspected the original PoC commit `b4772c875` (`feat(tau-examples): add Electron transport poc`) and the follow-up commit `43e55ce5d` (`feat(tau-examples): add Electron Topology C filesystem supply and disk persistence`) to verify when the regex was added and how the renderer's parameter pipeline evolved.
4. `rg`-audited every occurrence of `extractParameters`, `ScadParameter`, `openscad-parameters`, and `parametersFromResult` across the workspace to confirm whether the regex is still called from production code.
5. Cross-referenced `packages/react/src/hooks/use-render.ts` and `packages/runtime/src/client/runtime-client.ts` (`on(event: 'parametersResolved', …)` overload) to confirm the canonical event-driven pattern the example should follow.
6. Re-read `docs/research/runtime-transport-implementation-gap-analysis.md` Findings 1, 2 and Recommendation R1, which already flagged the regex as a P0 deletion candidate at the time the PoC landed.

## Findings

### Finding 1: `extractParameters` is dead code in production paths ✅ CONFIRMED

`rg "extractParameters"` across the workspace returns exactly two locations inside `examples/electron-tau`:

```7:8:examples/electron-tau/src/renderer/openscad-parameters.test.ts
import { extractParameters } from './openscad-parameters.js';
```

```22:22:examples/electron-tau/src/renderer/openscad-parameters.ts
export function extractParameters(source: string): ScadParameter[] {
```

The function is invoked **only** from its own test file. `App.tsx` does not import it. `parameters-form.tsx` does not import it. No other workspace file imports it.

What `App.tsx` actually uses from the module is the _type_:

```37:37:examples/electron-tau/src/renderer/app.tsx
import type { ScadParameter } from './openscad-parameters.js';
```

…and `parameters-form.tsx` imports the same type:

```1:1:examples/electron-tau/src/renderer/parameters-form.tsx
import type { ScadParameter } from './openscad-parameters.js';
```

Both consumers use it as the row shape for the form (`{ name, defaultValue }`). Neither one needs the regex extractor that ships alongside the type.

### Finding 2: Live parameter resolution already flows through the runtime client ✅ CONFIRMED

`App.tsx` subscribes to `parametersResolved` on the `RuntimeClient` and converts the kernel-supplied schema directly into the form's row shape:

```122:144:examples/electron-tau/src/renderer/app.tsx
const parametersFromResult = (result: GetParametersResult): readonly ScadParameter[] => {
  if (!result.success) {
    return [];
  }
  const { defaultParameters, jsonSchema } = result.data;
  const properties = (jsonSchema as { properties?: SchemaProperties } | undefined)?.properties ?? {};
  const seen = new Set<string>();
  const out: ScadParameter[] = [];
  for (const [name, descriptor] of Object.entries(properties)) {
    seen.add(name);
    out.push({
      name,
      defaultValue: (defaultParameters[name] ?? descriptor?.default ?? 0) as ScadParameter['defaultValue'],
    });
  }
  for (const [name, value] of Object.entries(defaultParameters)) {
    if (seen.has(name)) {
      continue;
    }
    out.push({ name, defaultValue: value as ScadParameter['defaultValue'] });
  }
  return out;
};
```

```298:305:examples/electron-tau/src/renderer/app.tsx
const offParameters = client.on('parametersResolved', (result: GetParametersResult) => {
  if (cancelled) {
    return;
  }
  debugLog('event', 'parametersResolved', { success: result.success });
  setParameters(parametersFromResult(result));
});
cleanups.push(offParameters);
```

This is exactly the pattern `packages/react/src/hooks/use-render.ts` uses:

```143:149:packages/react/src/hooks/use-render.ts
unsubscribers.push(
  client.on('parametersResolved', (result) => {
    if (result.success) {
      setDefaultParameters(result.data.defaultParameters);
      setJsonSchema(result.data.jsonSchema as JSONSchema7);
    }
  }),
```

The Electron example differs from `useRender` only in that it _reshapes_ the schema into a flat row list before storing it in component state, rather than handing the raw `defaultParameters` + `jsonSchema` to consumers. Both implementations are runtime-driven; neither needs a regex.

### Finding 3: The regex was historical scaffolding, not a deliberate fallback

The PoC's first commit (`b4772c875`, 2026-04-29) introduced **both** the regex extractor _and_ the `parametersFromResult` helper that consumes the runtime event. Looking at `git show b4772c875 -- examples/electron-tau/src/renderer/app.tsx`, the original `app.tsx` already contained the `parametersResolved` subscription and the `parametersFromResult` converter — the regex extractor was never wired into the live data flow at any point in the file's history.

The regex's own JSDoc reveals the original intent:

```1:9:examples/electron-tau/src/renderer/openscad-parameters.ts
/**
 * Tiny OpenSCAD top-level parameter extractor used by the PoC renderer.
 *
 * Scans the source for `name = literal;` declarations and produces a list
 * of `{ name, defaultValue }` records. The OpenSCAD kernel does the same
 * thing internally — re-implementing it locally keeps the renderer free
 * of the kernel-runtime worker for the parameters-form unit tests, while
 * the real kernel still drives renders over IPC.
 */
```

The motivation was to let `parameters-form.tsx` be unit-testable without spinning up a kernel worker. In practice, however:

- The form takes the parameter list as a prop. It has no dependency on the extractor at runtime — only on the row shape type.
- A unit test of the form does not need the regex; it can hand-roll a `ScadParameter[]` fixture or import the runtime's `GetParametersResult` type and synthesise a payload.
- The follow-up commit `43e55ce5d` (2026-05-01) renamed `openscad-params.ts` → `openscad-parameters.ts` as part of an identifier-clarity sweep but did not revisit whether the file should still exist.

`docs/research/runtime-transport-implementation-gap-analysis.md` Finding 2 already flagged this in its initial audit:

> The module's own JSDoc admits "the OpenSCAD kernel does the same thing internally — re-implementing it locally keeps the renderer free of the kernel-runtime worker for the parameters-form unit tests." That exact tradeoff is what plan execution principle 1 forbids.

…and recommendation R1 in that doc directs an explicit deletion of `openscad-params.ts`. The deletion was never performed; only the wiring half of R1 (subscribing to `parametersResolved`) landed.

### Finding 4: `RuntimeClient` does not expose a synchronous `getParameters()` method

`rg` confirms there is **no** `client.getParameters()` API on the public client surface today — only the `parametersResolved` event:

```671:671:packages/runtime/src/client/runtime-client.ts
on(event: 'parametersResolved', handler: (result: GetParametersResult) => void): () => void;
```

This matters for the migration: any cleanup must use the event channel (the same channel `useRender` uses), not a request/response method. The kernel worker emits the event after every successful parameter resolve cycle (`KernelWorker.getParameters` → `onParametersResolved` notify), so the listener is guaranteed to fire once `client.openFile({ code, file })` settles.

This also matches the workspace policy bullet that "`parametersResolved` and `exported` notifications were collapsed into the `render`/`export` call results in the channel model, so they no longer exist as separate notifies (autonomous renders still emit notify events for live UI updates)." The Electron PoC is on the autonomous-render path (the kernel host runs `KernelRuntimeWorker` which auto-renders on every `openFile`), so `parametersResolved` is the canonical surface.

### Finding 5: The form's `ScadParameter` shape is already a thin projection over `GetParametersResult`

Looking at the form's actual usage:

```20:42:examples/electron-tau/src/renderer/parameters-form.tsx
{params.map((parameter) => {
  const numericDefault = typeof parameter.defaultValue === 'number' ? parameter.defaultValue : 0;
  const value = override?.name === parameter.name ? override.value : numericDefault;
  return (
    <li key={parameter.name} style={rowStyles}>
      <label
        htmlFor={`param-${parameter.name}`}
        data-testid={`param-label-${parameter.name}`}
        style={labelStyles}
      >
        {parameter.name}
      </label>
      <input
        id={`param-${parameter.name}`}
        data-testid={`param-input-${parameter.name}`}
        type='number'
        value={value}
        onChange={(event) => {
          onChange(parameter.name, Number(event.target.value));
        }}
        style={inputStyles}
      />
    </li>
  );
})}
```

The form needs only `{ name: string; defaultValue: number | string }` per row. That shape can live next to the form (it is the form's prop contract), or callers can pass `Object.entries(result.data.defaultParameters)` directly. There is no architectural reason to keep `ScadParameter` in a separate "extractor" module.

### Finding 6: The Playwright e2e validates the runtime path, not the regex

`e2e/render.spec.ts` drives the rename validation by typing `length=200;` into the editor and asserting `param-label-length` appears in the DOM. The label is sourced from `parameters` state, which is set exclusively by the `parametersResolved` listener (see Finding 2). The test would still pass if `openscad-parameters.ts` were deleted — the regex never participates.

The supporting `parameter-override-sync.test.ts` exercises `resolveElectronNumericParameterOverride`, a small state-machine helper that decides when to refresh a slider value based on _kernel-supplied_ defaults. It also does not depend on the regex.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                         | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | Delete `examples/electron-tau/src/renderer/openscad-parameters.ts` and `openscad-parameters.test.ts`. Move the `ScadParameter` type to `parameters-form.tsx` (export it from there) so the form remains the source of truth for its own prop shape. Update `app.tsx` to import the type from `./parameters-form.js`.                                                                                                           | P0       | S      | High   |
| R2  | Inline `parametersFromResult` next to the `parametersResolved` subscription in `app.tsx` (or hoist it into the form module if it is reused). Drop the now-unused intermediate file. The function is the only consumer of the kernel `GetParametersResult` → form-row mapping.                                                                                                                                                  | P0       | XS     | Medium |
| R3  | Co-locate the form's prop type with the runtime's authoritative shape: change `ParametersFormProperties.params` to `readonly { name: string; defaultValue: number \| string }[]` (no extractor-module type). This keeps the form decoupled from any specific kernel and from `GetParametersResult`, while removing the only structural reason `openscad-parameters.ts` survived as a "shared types" module.                    | P0       | XS     | Medium |
| R4  | Optionally extract the `parametersResolved` + `geometry` + `error` subscription block in `app.tsx` into a small example-local hook (`useElectronRuntimeClient` or similar) modelled on `packages/react/src/hooks/use-render.ts`. Keeps the example readable and demonstrates the canonical pattern for downstream consumers building Electron renderers. Do **not** add a hard `@taucad/react` dependency to the Electron PoC. | P1       | M      | Medium |
| R5  | Add a one-line note to `docs/research/runtime-transport-implementation-gap-analysis.md` Finding 2 marking the regex deletion as RESOLVED once R1 lands, and remove the `openscad-params.ts` reference from the Recommendation R1 bullet (line 485). Keeps the gap analysis honest about what has actually shipped.                                                                                                             | P2       | XS     | Low    |
| R6  | Once R4 lands, consider whether `@taucad/react`'s `useRender` should be re-exported under a Node/Electron-friendly entry point (it currently has a peer dependency on React). If yes, this would let the example simply consume `useRender` instead of carrying its own variant. Out of scope for the immediate cleanup; track separately.                                                                                     | P3       | M      | Low    |

## Trade-offs

### Should the form's row type live in the form file, or come from the runtime?

| Option                                                                            | Pros                                                                                      | Cons                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Form owns its prop shape** (`{ name, defaultValue }`).                       | Form stays decoupled from kernel/runtime types. App.tsx maps `GetParametersResult` to it. | One small mapping function per consumer.                                                                                                                        |
| **B. Form consumes `GetParametersResult['data']` directly.**                      | Zero mapping; the renderer hands the raw runtime payload to the form.                     | Couples a UI primitive to the runtime protocol; the form has to traverse `jsonSchema.properties` itself; harder to unit-test the form against arbitrary shapes. |
| **C. Form consumes `JSONSchema7` + `defaultParameters` (the `useRender` shape).** | Mirrors the React hook exactly; most direct adoption path if `useRender` is added later.  | The form would have to walk JSON Schema to render rows; more code in the form for no win in the PoC.                                                            |

**Recommendation**: A. Lightest change, keeps the form's prop contract simple, leaves the door open for either B or C if a future iteration pulls the form into a shared package.

### Inline the subscription block, or extract a hook?

| Option                                            | Pros                                                                                                                                  | Cons                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Inline (current)**                           | Keeps the example single-file-readable; new readers see the full lifecycle (port handshake → client → events → cleanup) in one place. | Duplicates the `useRender` pattern with no shared abstraction; harder to evolve if more renderers are added.                                                                       |
| **B. Local hook (`useElectronRuntimeClient`)**    | Demonstrates the canonical hook pattern; shrinks `app.tsx`; easier to test in isolation.                                              | One more file to navigate; PoC gains a layer of indirection.                                                                                                                       |
| **C. Use `@taucad/react`'s `useRender` directly** | Zero local hook code; identical lifecycle as the web app uses.                                                                        | Adds a React hook dependency to the Electron PoC; `useRender` does not currently surface the rgen/diagnostic plumbing the PoC e2e relies on (`__taucadTransportDescriptor`, etc.). |

**Recommendation**: B for the next iteration once R1–R3 land. Defer C until `useRender` is generalised to support custom transport handshakes (the Electron PoC's `awaitRelayedPort` step is bespoke).

## Code Examples

### Target shape after R1–R3

```typescript
// examples/electron-tau/src/renderer/parameters-form.tsx
export type ParametersFormRow = {
  readonly name: string;
  readonly defaultValue: number | string;
};

export type ParametersFormProperties = {
  readonly params: readonly ParametersFormRow[];
  readonly override?: { name: string; value: number };
  readonly onChange: (name: string, value: number) => void;
};

export function ParametersForm({ params, override, onChange }: ParametersFormProperties): React.ReactElement {
  /* …unchanged body… */
}
```

```typescript
// examples/electron-tau/src/renderer/app.tsx
import type { ParametersFormRow } from './parameters-form.js';

const parametersFromResult = (result: GetParametersResult): readonly ParametersFormRow[] => {
  if (!result.success) {
    return [];
  }
  const { defaultParameters, jsonSchema } = result.data;
  const properties = (jsonSchema as { properties?: SchemaProperties } | undefined)?.properties ?? {};
  const rows: ParametersFormRow[] = [];
  const seen = new Set<string>();
  for (const [name, descriptor] of Object.entries(properties)) {
    seen.add(name);
    rows.push({
      name,
      defaultValue: (defaultParameters[name] ?? descriptor?.default ?? 0) as ParametersFormRow['defaultValue'],
    });
  }
  for (const [name, value] of Object.entries(defaultParameters)) {
    if (!seen.has(name)) {
      rows.push({ name, defaultValue: value as ParametersFormRow['defaultValue'] });
    }
  }
  return rows;
};
```

`openscad-parameters.ts` and `openscad-parameters.test.ts` are deleted in the same change.

### Optional R4 hook sketch

```typescript
// examples/electron-tau/src/renderer/use-electron-runtime-client.ts
export function useElectronRuntimeClient(opts: {
  readonly relayTag: string;
  readonly initialFile: string;
  readonly initialSource: string;
}): {
  readonly client: RuntimeClient | undefined;
  readonly parameters: readonly ParametersFormRow[];
  readonly geometryGlbBuffer: ArrayBuffer | undefined;
  readonly inspection: GltfInspection;
  readonly connectionState: 'idle' | 'connecting' | 'ready' | 'error';
  readonly errorMessage: string | undefined;
} {
  /* Encapsulates the awaitRelayedPort → createRuntimeClient → client.on(…)
   * lifecycle today inlined in App.tsx. Mirrors useRender's structure. */
}
```

This is purely a consolidation; no new behaviour. It keeps the diagnostic seams (`__taucadTransportDescriptor`, `recordError`, debug logs) the e2e relies on.

## References

- `examples/electron-tau/src/renderer/openscad-parameters.ts` — the regex module to delete.
- `examples/electron-tau/src/renderer/openscad-parameters.test.ts` — its only consumer.
- `examples/electron-tau/src/renderer/app.tsx` — already wires `parametersResolved`; needs the type import + helper updated.
- `examples/electron-tau/src/renderer/parameters-form.tsx` — should own its prop row type.
- `packages/react/src/hooks/use-render.ts` — canonical event-driven pattern to mirror.
- `packages/runtime/src/client/runtime-client.ts` lines 666–674 — the `on(event, handler)` overload set, including `parametersResolved`.
- `kernels/openscad/src/parse-parameters.ts` — kernel-side `processOpenScadParameters` the renderer would otherwise be re-implementing.
- `docs/research/runtime-transport-implementation-gap-analysis.md` Findings 1–2, R1 — prior audit that already called for this deletion.
