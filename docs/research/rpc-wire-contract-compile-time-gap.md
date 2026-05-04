---
title: 'RPC Wire-Contract Compile-Time Gap'
description: 'Root-cause investigation of `get_kernel_result` runtime validation failures and the structural type-system gap that allows handler implementations to drift from the wire schema.'
status: active
created: '2026-05-02'
updated: '2026-05-03'
category: investigation
related:
  - docs/policy/chat-rpc-error-handling-policy.md
  - docs/research/rpc-best-practices.md
  - docs/research/runtime-event-driven-api-blueprint-v5.md
---

# RPC Wire-Contract Compile-Time Gap

**R1–R6 are resolved in-tree** (see [Implementation status](#implementation-status)). R4, R7, R8 remain open recommendations.

Investigation of the `get_kernel_result` "Validation Failed — `errorCode: Invalid option`" runtime failure observed in staging, and the architectural reasons it cannot be caught by `tsgo --noEmit`.

## Executive Summary

The chat agent renders a `Validation Failed get_kernel_result` card whenever the server-side Zod parse of `RpcResponse.result` rejects the payload returned by `apps/ui/app/hooks/rpc-handlers.ts`. The screenshot shows the parse failing at path `errorCode` because the value the browser sent is not in `rpcClientErrorCodeSchema`'s enum.

The proximate trigger is a **deploy-skew window** between Netlify (UI) and Fly.io (API): the UI's hand-curated set of `errorCode` literals is allowed to extend the wire schema without forcing a coordinated server release. The structural reason this is even possible is that **the entire RPC wire boundary is typed as `unknown`** — `RpcDispatcher.dispatch`, `RpcHandlers.executeRpcCall`, and `RpcResponse.result` all collapse the per-RPC result types to `unknown`, severing the compile-time link between handler implementations and the schema.

I confirmed the gap is real and historically exploited: commit `a4e00d6b6` introduced `errorCode: 'RENDER_TIMEOUT'` to `rpc-handlers.ts`, and commit `e3b7fcc7b` added `'RENDER_TIMEOUT'` to `rpcClientErrorCodeSchema` 31 minutes later. Checking out `a4e00d6b6` alone and running `pnpm nx typecheck ui` reproduces TS2322 errors — yet the commit landed.

Recommended fixes: (R1) replace the inlined `errorCode: 'UNKNOWN' | 'RENDER_TIMEOUT'` literal unions with `RpcClientErrorCode`-derived narrowings so any wire-schema change forces a follow-up at every call site; (R2) make the dispatcher generic (`dispatch<T extends RpcCall>(call: T): Promise<RpcResult<T['rpcName']>>`) so handlers cannot return the wrong shape for a given `rpcName`; (R3) add a build-time contract test that fails CI when the UI's literal `errorCode:` set drifts from the schema enum.

## Problem Statement

A staging chat session running on `taucad.dev` reproducibly renders this error card after the agent calls `get_kernel_result`:

> **Validation Failed `get_kernel_result`**
> RPC "get_kernel_result" returned invalid result. The client may have returned malformed data.
>
> **Validation Errors:**
> `errorCode`: Invalid option: expected one of `"FILE_NOT_FOUND"|"NO_TOP_LEVEL_GEOMETRY"|"PERMISSI…`

The truncated enum tail matches `rpcClientErrorCodeSchema` exactly (`libs/chat/src/schemas/rpc.schema.ts:28`):

```28:37:libs/chat/src/schemas/rpc.schema.ts
export const rpcClientErrorCodeSchema = zod.enum([
  'FILE_NOT_FOUND',
  'NO_TOP_LEVEL_GEOMETRY',
  'PERMISSION_DENIED',
  'IO_ERROR',
  'PARSE_ERROR',
  'RENDER_TIMEOUT',
  'UNKNOWN',
  'UNKNOWN_GEOMETRY_UNIT',
]);
```

Because the issue is reported at path `errorCode` (top-level field), Zod successfully discriminated on `success: false` and entered the error variant — the result therefore had the shape `{ success: false, errorCode: <not-in-enum>, message: <string> }`. The user's question is twofold:

1. **Smoking gun** — what concrete value of `errorCode` is leaking through, and from where?
2. **Structural fix** — why isn't this caught at compile time, and how should it be?

## Methodology

1. Walked the request path end-to-end: `tool-get-kernel-result.ts` → `chatRpcService.sendRpcRequest` → `socket.emitWithAck('rpc_request', ...)` → browser `ChatRpcSocketService.handleRpcRequest` → `useChatRpcConnection.handleRpcRequest` → `createRpcHandlers().executeRpcCall` → `createRpcDispatcher().dispatch` → `handleGetKernelResult` → `kernelClient.getKernelResult` (the `rpc-handlers.ts` adapter).
2. Enumerated every literal `errorCode:` in `apps/ui` and `libs/chat` (`rg "errorCode:\s*['\"]"`).
3. Compared `KernelIssueCode` (`packages/runtime/src/types/runtime.types.ts:99`) against `RpcClientErrorCode` to identify wire-incompatible values.
4. Checked git history of paired files (`apps/ui/app/hooks/rpc-handlers.ts` ↔ `libs/chat/src/schemas/rpc.schema.ts`) for cross-app drift.
5. Reproduced the historical drift by `git checkout a4e00d6b6 -- apps/ui/app/hooks/rpc-handlers.ts libs/chat/src/schemas/rpc.schema.ts` and running `pnpm nx typecheck ui`.

## Findings

### Finding 1: The wire boundary is `unknown` end-to-end

The leaf method types are correct — `RpcRuntimeClient.getKernelResult` returns `Promise<GetKernelResultRpcResult>`, derived from the Zod result schema. But every layer above the leaf erases that type to `unknown`:

| Layer                                               | File                                            | Return type                      |
| --------------------------------------------------- | ----------------------------------------------- | -------------------------------- |
| `RpcDispatcher.dispatch`                            | `libs/chat/src/rpc/rpc-dispatcher.ts:18-19`     | `Promise<unknown>`               |
| `RpcHandlers.executeRpcCall`                        | `apps/ui/app/hooks/rpc-handlers.ts:461-463`     | `Promise<unknown>`               |
| `RpcResponse.result`                                | `libs/chat/src/types/websocket.types.ts:38-50`  | `unknown`                        |
| Browser ack payload (`use-chat-rpc-socket.tsx:198`) | `apps/ui/app/hooks/use-chat-rpc-socket.tsx:153` | `RpcResponse` (result `unknown`) |

```17:20:libs/chat/src/rpc/rpc-dispatcher.ts
export type RpcDispatcher = {
  dispatch(rpcCall: RpcCall): Promise<unknown>;
};
```

Consequence: a handler can return any shape — or be silently re-shaped by a future refactor — and the only thing that catches the drift is the API-side Zod `safeParse` at `apps/api/app/api/chat/chat-rpc.service.ts:397`, **at runtime**, **per-message**.

### Finding 2: Hardcoded literal-string `errorCode` unions drift from the schema

`apps/ui/app/hooks/rpc-handlers.ts` declares its narrower error sub-union as a hand-typed string literal:

```197:201:apps/ui/app/hooks/rpc-handlers.ts
  | {
      ok: false;
      errorCode: 'UNKNOWN' | 'RENDER_TIMEOUT';
      message: string;
    };
```

There are **9 hardcoded `errorCode:` literals** in this single file:

| Line | Literal                   | In `rpcClientErrorCodeSchema`? |
| ---- | ------------------------- | ------------------------------ |
| 199  | `'UNKNOWN'`               | ✅                             |
| 199  | `'RENDER_TIMEOUT'`        | ✅                             |
| 224  | `'UNKNOWN'`               | ✅                             |
| 236  | `'RENDER_TIMEOUT'`        | ✅                             |
| 242  | `'UNKNOWN'`               | ✅                             |
| 307  | `'FILE_NOT_FOUND'`        | ✅                             |
| 315  | `'NO_TOP_LEVEL_GEOMETRY'` | ✅                             |
| 322  | `'UNKNOWN'`               | ✅                             |
| 335  | `'UNKNOWN_GEOMETRY_UNIT'` | ✅                             |
| 383  | `'IO_ERROR'`/`'UNKNOWN'`  | ✅                             |
| 394  | `'UNKNOWN_GEOMETRY_UNIT'` | ✅                             |
| 450  | `'IO_ERROR'`/`'UNKNOWN'`  | ✅                             |

Each literal is a future drift point: a typo (`'RENDER_TIMOUT'`), a stale name (`'COMPILATION_UNIT_MISSING'` left over from the geometry-unit rename), or a value pulled from the wrong enum (`KernelIssueCode` vs `RpcClientErrorCode`) is caught **only** by the eventual schema-conformance assignment at the return statement.

That assignment is the load-bearing check. It works — but only because the helper return type still has to flow into `Promise<GetKernelResultRpcResult>`. Any helper that `as`-casts or routes through a `Record<string, unknown>` (e.g. via the `unknown` dispatcher) loses the check.

### Finding 3: `KernelIssueCode` overlaps `RpcClientErrorCode` only on two values

The runtime kernel's diagnostic code (`packages/runtime/src/types/runtime.types.ts:99`):

```typescript
type KernelIssueCode =
  | 'RENDER_TIMEOUT'
  | 'RENDER_ABORTED'
  | 'KERNEL_BINDING_FAILED'
  | 'KERNEL_CAPABILITY_MISSING'
  | 'BUNDLER_FAILED'
  | 'MIDDLEWARE_FAILED'
  | 'RUNTIME'
  | 'UNKNOWN';
```

The RPC client error code:

```typescript
type RpcClientErrorCode =
  | 'FILE_NOT_FOUND'
  | 'NO_TOP_LEVEL_GEOMETRY'
  | 'PERMISSION_DENIED'
  | 'IO_ERROR'
  | 'PARSE_ERROR'
  | 'RENDER_TIMEOUT'
  | 'UNKNOWN'
  | 'UNKNOWN_GEOMETRY_UNIT';
```

The **overlap** is `RENDER_TIMEOUT` and `UNKNOWN`. Six values from `KernelIssueCode` are **not** in `RpcClientErrorCode` (`RENDER_ABORTED`, `KERNEL_BINDING_FAILED`, `KERNEL_CAPABILITY_MISSING`, `BUNDLER_FAILED`, `MIDDLEWARE_FAILED`, `RUNTIME`). If any future refactor accidentally surfaces a `KernelIssueCode` as the top-level `errorCode` (e.g. by spreading an issue into the response), the bug looks identical to the screenshot — Zod fails at `errorCode` with `Invalid option`.

The reverse drift is also real: six `RpcClientErrorCode` values (`FILE_NOT_FOUND`, `NO_TOP_LEVEL_GEOMETRY`, `PERMISSION_DENIED`, `IO_ERROR`, `PARSE_ERROR`, `UNKNOWN_GEOMETRY_UNIT`) are not in `KernelIssueCode`. Today these are kept in sync only by `chat-rpc-error-handling-policy.md` prose and reviewer discipline.

### Finding 4: The historical exploit — `a4e00d6b6` landed without typechecking

git history shows the fault has already been triggered once:

| Commit      | Date (NZT)              | Subject                                                            |
| ----------- | ----------------------- | ------------------------------------------------------------------ |
| `a4e00d6b6` | 2026-04-24 12:34        | feat(ui): add RENDER_TIMEOUT error handling for fresh render waits |
| `e3b7fcc7b` | 2026-04-24 13:05 (+31m) | feat(chat): add RENDER_TIMEOUT error code to RPC schema            |

I reproduced this by checking out `a4e00d6b6` for both files in isolation and running `pnpm nx typecheck ui`:

```
app/hooks/rpc-handlers.ts(264,34): error TS2322:
  Type '"RENDER_TIMEOUT" | "UNKNOWN"' is not assignable to type
  '"FILE_NOT_FOUND" | "IO_ERROR" | "NO_TOP_LEVEL_GEOMETRY" | "PARSE_ERROR" |
   "PERMISSION_DENIED" | "UNKNOWN" | "UNKNOWN_GEOMETRY_UNIT"'.
  Type '"RENDER_TIMEOUT"' is not assignable to ...
app/hooks/rpc-handlers.ts(290,34): error TS2322: <same shape>
```

The intra-PR view always typechecks (the schema commit was almost certainly drafted alongside), but the `main` history records two non-atomic commits. Any deploy that hits the UI before the API in this 31-minute window — or any branch deploy that includes `a4e00d6b6` without `e3b7fcc7b` — produces the screenshot's failure verbatim.

### Finding 5: Deploy topology guarantees recurring drift

UI and API ship via independent CD:

| Path          | Trigger                                       | File                        |
| ------------- | --------------------------------------------- | --------------------------- |
| UI (staging)  | Netlify auto-deploy on `main` push            | `apps/ui/netlify.toml`      |
| UI (preview)  | Netlify auto-deploy on every branch push      | `apps/ui/netlify.toml`      |
| API (staging) | `.github/workflows/deploy.yml` on `main` push | `apps/api/fly.staging.toml` |
| API (prod)    | Manual via `prod-deploy-ui.yml`               | `apps/api/fly.prod.toml`    |

Even when a commit is atomic and typechecks, the deploys are not atomic. Symptoms in production are indistinguishable from a stale browser tab: the UI bundle the user runs may be newer or older than the API server it talks to. Without a wire protocol version negotiation or schema fingerprint check, the only failure mode is a runtime Zod parse error — exactly what the screenshot shows.

### Finding 6: No handler in current `main` returns an out-of-enum `errorCode`

I exhaustively traced every `errorCode:` assignment in `getKernelResult`'s call graph (`ensureGeometryUnit`, the per-branch returns at lines 224/236/242/266) and confirmed all paths return values inside `rpcClientErrorCodeSchema`. Static reads of `apps/ui/app/hooks/rpc-handlers.test.ts` (assertions at lines 441, 467, 485, 518, 655, 672, 688, 695, 821, 837) cover the same set.

The screenshot's failure must therefore be caused by **stateful drift across the wire boundary**, not a bug visible in `HEAD`:

- Stale browser bundle (long-running tab, Service Worker cache, mobile Safari cache)
- Branch deploy where UI/API are at different commits
- Schema or handler change merged without a coordinated deploy

This is exactly the failure mode the user wants prevented at compile time — a perfectly typechecked `main` is not sufficient when adjacent commits can diverge across deploys.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                    | Priority | Effort | Impact                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Replace inlined `'UNKNOWN' \| 'RENDER_TIMEOUT'` literal unions with `Extract<RpcClientErrorCode, 'UNKNOWN' \| 'RENDER_TIMEOUT'>` (or a named subtype `EnsureGeometryUnitErrorCode = Extract<RpcClientErrorCode, ...>`)                                                                                                                    | P0       | Low    | High — schema removal of an enum value forces a localised TS2322 at every call site, instead of a silent runtime failure               |
| R2  | Make `RpcDispatcher.dispatch` generic: `dispatch<C extends RpcCall>(call: C): Promise<RpcResult<C['rpcName']>>`. Update `executeRpcCall` and `RpcResponse.result` accordingly                                                                                                                                                             | P0       | Medium | High — removes three layers of `unknown` so any handler returning the wrong shape is caught at the leaf assignment, not at API runtime |
| R3  | Add a contract test (`libs/chat/src/schemas/rpc.schema.contract.test.ts`) that imports the literal string set from `rpc-handlers.ts` (e.g. via a re-exported `const errorCodeUnion = 'UNKNOWN' \| 'RENDER_TIMEOUT'` typed via `satisfies readonly RpcClientErrorCode[]`) and asserts it is a subset of `rpcClientErrorCodeSchema.options` | P1       | Low    | High — catches drift in the same workspace `lint` target before merge                                                                  |
| R4  | Add a `wire-protocol-version` exchange on Socket.IO `connect` that compares a build-time hash of `rpcSchemasRegistry` (sha256 of sorted `JSON.stringify(toJsonSchema(registry))`). On mismatch, return `WsErrorMessage { code: 'PROTOCOL_VERSION_MISMATCH' }` and instruct the UI to hard-reload                                          | P1       | Medium | High — closes the deploy-skew window for stale browser tabs without coupling Netlify and Fly.io deploys                                |
| R5  | Tighten `RpcResponse.result` from `unknown` to `RpcResult<T>` keyed by `rpcName`, using `RpcResponse` as a discriminated union over `rpcName` (mirror of `RpcCall`). Update the ack typing in `chat-rpc-socket.service.ts:307`                                                                                                            | P1       | Medium | Medium — makes wire shape self-documenting and surfaces cross-package mismatches at compile time                                       |
| R6  | When deriving narrower union helpers like `EnsureGeometryUnitResult`, prefer `satisfies` over annotations: `} satisfies { ok: false; errorCode: RpcClientErrorCode; message: string }`. This preserves literal narrowing while pinning the upper bound to the schema enum                                                                 | P2       | Low    | Medium — a cheaper mid-step before R1                                                                                                  |
| R7  | Add an `eslint`/`oxlint` rule that flags string literals matching `errorCode\s*:\s*['"][A-Z_]+['"]` outside of `rpc.schema.ts` and `tool.types.ts`, suggesting `RpcClientErrorCode` import + named constant                                                                                                                               | P2       | Low    | Low — back-stop for R1, helps reviewers                                                                                                |
| R8  | After R2 lands, delete the runtime Zod `validateRpcResult` parse from the **happy path** (keep it as a debug-mode guard) — the type system replaces it. Retain only `safeParse` for client-supplied `unknown` envelopes (e.g. malformed manual sockets)                                                                                   | P3       | Medium | Low — simplifies hot path; only after R2 has bedded in                                                                                 |

## Implementation status

**R1, R2, R3, R5, R6 are implemented and resolved in-tree** (R4, R7, R8 remain recommendations only).

| #      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | `EnsureGeometryUnitErrorCode = Extract<RpcClientErrorCode, 'UNKNOWN' \| 'RENDER_TIMEOUT'>` in [`apps/ui/app/hooks/rpc-handlers.ts`](apps/ui/app/hooks/rpc-handlers.ts); failure-branch `errorCode` values use [`rpcClientErrorCode`](libs/chat/src/schemas/rpc.schema.ts) from `@taucad/chat`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **R2** | `RpcDispatcher.dispatch<K extends keyof RpcSchemasRegistry>(call: RpcCall<K>): Promise<RpcResult<K>>` in [`libs/chat/src/rpc/rpc-dispatcher.ts`](libs/chat/src/rpc/rpc-dispatcher.ts); implementation uses a typed `RpcHandlerMap` (correlated records pattern per [TypeScript PR #47109](https://github.com/microsoft/TypeScript/pull/47109)) plus a minimal `as` on the indexed handler — `tsgo` does not prove `handlers[call.rpcName](call.args)` for generic `K` the way reference `tsc` does; the cast pins `rpcName` ↔ args/result. [`RpcCall<K>`](libs/chat/src/schemas/rpc.schema.ts) is parameterized so headless generic `T` correlates without widening. `RpcHandlers.executeRpcCall` in [`apps/ui/app/hooks/rpc-handlers.ts`](apps/ui/app/hooks/rpc-handlers.ts) uses one adapter `as RpcCall<C['rpcName']>` when rebuilding `{ rpcName, args }` from wire `RpcRequest`/`RpcCallInput` (fresh object loses pairing under `tsgo`). Type tests: [`libs/chat/src/rpc/rpc-dispatcher.test-d.ts`](libs/chat/src/rpc/rpc-dispatcher.test-d.ts), [`apps/ui/app/hooks/rpc-handlers.test-d.ts`](apps/ui/app/hooks/rpc-handlers.test-d.ts). |
| **R3** | **Superseded** by [`rpc.schema.test.ts`](libs/chat/src/schemas/rpc.schema.test.ts) (`rpcClientErrorCode` exhaustively matches `rpcClientErrorCodeSchema.options`). The prior UI-only contract test was removed when `rpcClientErrorCode` became the single named-identifier catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **R5** | `RpcRequest<K>` is parameterized in [`libs/chat/src/types/websocket.types.ts`](libs/chat/src/types/websocket.types.ts) (default `K = RpcName` for the full wire union). `RpcResponseFor<T>`, discriminated `RpcResponse`; [`rpcWireSuccessResponse`](libs/chat/src/types/websocket.types.ts) returns `RpcResponse` with a single `as RpcResponse` for Socket.IO ack typing. Browser passes the full `RpcRequest` into `executeRpcCall` (the prior `rpcRequestToCallInput` exhaustive switch in `rpc-wire.utils.ts` was deleted). Browser echoes `rpcName` on every ack in [`apps/ui/app/hooks/use-chat-rpc-socket.tsx`](apps/ui/app/hooks/use-chat-rpc-socket.tsx) and [`apps/ui/app/services/chat-rpc-socket.service.ts`](apps/ui/app/services/chat-rpc-socket.service.ts); server builds `RpcRequest<T>` without assertion after Zod input validation and validates `response.rpcName === rpcName` before result parse in [`apps/api/app/api/chat/chat-rpc.service.ts`](apps/api/app/api/chat/chat-rpc.service.ts). Type tests: [`libs/chat/src/types/websocket.types.test-d.ts`](libs/chat/src/types/websocket.types.test-d.ts).            |
| **R6** | `rpcClientErrorCode` pinned with `as const satisfies Record<string, RpcClientErrorCode>` in [`libs/chat/src/schemas/rpc.schema.ts`](libs/chat/src/schemas/rpc.schema.ts); UI and leaf handlers import the same object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Remaining sanctioned assertions:** Zod `safeParse` branches in [`apps/api/app/api/chat/chat-rpc.service.ts`](apps/api/app/api/chat/chat-rpc.service.ts) (`parseResult.data as RpcInput<T>` / `as RpcResult<T>`); `as RpcResponse` in [`rpcWireSuccessResponse`](libs/chat/src/types/websocket.types.ts); indexed-handler `as` in [`createRpcDispatcher`](libs/chat/src/rpc/rpc-dispatcher.ts); adapter `as RpcCall<C['rpcName']>` in [`rpc-handlers.ts`](apps/ui/app/hooks/rpc-handlers.ts).

**R4, R7, R8** remain future work.

### R2 (generic dispatcher) vs runtime Zod check

| Dimension                                  | R2 generics                                | Today's `unknown` + Zod                 |
| ------------------------------------------ | ------------------------------------------ | --------------------------------------- |
| Catches handler-shape regressions at build | ✅ at leaf assignment                      | ❌ only at API ingress at runtime       |
| Catches deploy-skew (UI ≠ API schema)      | ❌ — different bundles, no shared TS check | ⚠️ caught lazily, after the user clicks |
| Bundle size                                | Identical (types erased)                   | Identical                               |
| Latency                                    | Saves Zod parse on hot path                | Adds Zod parse (small but non-zero)     |

R2 alone does **not** solve deploy skew (Finding 5). It must be paired with R4 (protocol version exchange) or the `rpcClientErrorCode` exhaustiveness test in `rpc.schema.test.ts` to make naming drift fail-fast in CI.

### Atomic UI+API deploys (out of scope here)

Forcing UI and API to deploy together is the most robust fix but breaks Tau's current Netlify-on-main + Fly.io-on-main split. A version handshake (R4) is strictly cheaper and decouples the schemas from the deploy topology.

## Code Examples

### Smoking-gun reproduction

```bash
# Restore commit a4e00d6b6 in isolation and run typecheck
git checkout a4e00d6b6 -- \
  apps/ui/app/hooks/rpc-handlers.ts \
  libs/chat/src/schemas/rpc.schema.ts
pnpm nx typecheck ui
# →
# app/hooks/rpc-handlers.ts(264,34): error TS2322:
#   Type '"RENDER_TIMEOUT" | "UNKNOWN"' is not assignable to type
#   '"FILE_NOT_FOUND" | "IO_ERROR" | "NO_TOP_LEVEL_GEOMETRY" | "PARSE_ERROR" |
#    "PERMISSION_DENIED" | "UNKNOWN" | "UNKNOWN_GEOMETRY_UNIT"'.
git checkout HEAD -- \
  apps/ui/app/hooks/rpc-handlers.ts \
  libs/chat/src/schemas/rpc.schema.ts
```

The commit landed despite this error — the fix shipped 31 minutes later in `e3b7fcc7b`. Any deploy that bundled the UI commit before the schema commit would surface the screenshot's failure verbatim.

### R1 fix (drop-in)

```typescript
// libs/chat/src/schemas/rpc.schema.ts (already exists)
export type RpcClientErrorCode = z.infer<typeof rpcClientErrorCodeSchema>;

// apps/ui/app/hooks/rpc-handlers.ts
import type { RpcClientErrorCode } from '@taucad/chat';

type EnsureGeometryUnitResult =
  | { ok: true; cadUnit: ActorRefFrom<typeof cadMachine>; cadSnapshot: SnapshotFrom<typeof cadMachine> }
  | {
      ok: false;
      errorCode: Extract<RpcClientErrorCode, 'UNKNOWN' | 'RENDER_TIMEOUT'>;
      message: string;
    };
```

If `RENDER_TIMEOUT` is ever removed from the schema enum, every `errorCode: 'RENDER_TIMEOUT'` assignment in the helper now fails to compile, instead of compiling locally and failing only at server-side Zod parse.

### R2 fix sketch

```typescript
// libs/chat/src/rpc/rpc-dispatcher.ts
export type RpcDispatcher = {
  dispatch<C extends RpcCall>(call: C): Promise<RpcResult<C['rpcName']>>;
};

// apps/ui/app/hooks/rpc-handlers.ts
export type RpcHandlers = {
  executeRpcCall<C extends RpcCallInput>(call: C): Promise<RpcResult<C['rpcName']>>;
};

// libs/chat/src/types/websocket.types.ts
export type RpcResponse =
  | { type: 'rpc_response'; requestId: string; toolCallId: string; result: RpcResult<RpcName>; traceContext?: ... }
  | { type: 'rpc_response'; requestId: string; toolCallId: string; result: undefined; error: string; traceContext?: ... };
```

Caveat: `RpcResult<RpcName>` is the union of all per-RPC results. To get a fully discriminated wire type, lift `rpcName` onto `RpcResponse` itself (mirror of `RpcCall`) so callers can narrow on `response.rpcName` rather than `requestId`. That's a larger refactor.

### R3 drift check (in-tree)

```typescript
// libs/chat/src/schemas/rpc.schema.test.ts
import { rpcClientErrorCode, rpcClientErrorCodeSchema } from '#schemas/rpc.schema.js';

describe('rpcClientErrorCode', () => {
  it('should enumerate every schema enum member exactly once', () => {
    const fromObject = new Set(Object.values(rpcClientErrorCode));
    expect(fromObject.size).toBe(rpcClientErrorCodeSchema.options.length);
    for (const code of rpcClientErrorCodeSchema.options) {
      expect(fromObject.has(code)).toBe(true);
    }
  });
});
```

## Diagrams

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Compile-time (tsgo)                              │
│                                                                          │
│   rpcClientErrorCodeSchema (Zod)                                         │
│          │                                                               │
│          ▼  z.infer                                                      │
│   RpcClientErrorCode                                                     │
│          │                                                               │
│          ▼  used in                                                      │
│   GetKernelResultRpcResult.errorCode  ◄─── single source of truth        │
│          │                                                               │
│          │  flows through                                                │
│          ▼                                                               │
│   RpcRuntimeClient.getKernelResult: Promise<GetKernelResultRpcResult>    │
│          │                                                               │
│          ▼  (rpc-handlers.ts impl)                                       │
│   { errorCode: 'UNKNOWN' | 'RENDER_TIMEOUT' }  ◄── Finding 2: drift here │
│                                                                          │
│   ────────────────────────────────────────────────────  unknown wall ────│
│                                                                          │
│   RpcDispatcher.dispatch        ─► Promise<unknown>     Finding 1        │
│   RpcHandlers.executeRpcCall    ─► Promise<unknown>     Finding 1        │
│   RpcResponse.result            ─► unknown              Finding 1        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼  socket.io wire (JSON)
┌──────────────────────────────────────────────────────────────────────────┐
│                  Runtime (apps/api/.../chat-rpc.service.ts)              │
│                                                                          │
│   validateRpcResult(rpcName, response.result)                            │
│          │                                                               │
│          ▼  Zod safeParse                                                │
│   ✅ pass → tool sees typed result                                        │
│   ❌ fail → "Validation Failed get_kernel_result" card  ◄── screenshot   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The recommendations in R1/R2/R3 push the failure left of the "unknown wall" so compile time, not runtime, catches the drift; R4 is the only mitigation for cross-deploy skew.

## References

- Policy: `docs/policy/chat-rpc-error-handling-policy.md`
- Research: `docs/research/rpc-best-practices.md`
- Research: `docs/research/runtime-event-driven-api-blueprint-v5.md`
- Source: `apps/ui/app/hooks/rpc-handlers.ts`
- Source: `libs/chat/src/schemas/rpc.schema.ts`
- Source: `libs/chat/src/rpc/rpc-dispatcher.ts`
- Source: `apps/api/app/api/chat/chat-rpc.service.ts`
- Commit: `a4e00d6b6` (UI introduces `RENDER_TIMEOUT` errorCode)
- Commit: `e3b7fcc7b` (schema adds `RENDER_TIMEOUT` 31 min later)

## Appendix A — Full `errorCode:` literal inventory in `apps/ui/app/hooks/rpc-handlers.ts`

| Line | Function/branch                                       | Literal                         | Validates? |
| ---- | ----------------------------------------------------- | ------------------------------- | ---------- |
| 199  | `EnsureGeometryUnitResult.errorCode` (type)           | `'UNKNOWN' \| 'RENDER_TIMEOUT'` | ✅         |
| 224  | `ensureGeometryUnit` — geometry-unit creation failure | `'UNKNOWN'`                     | ✅         |
| 236  | `ensureGeometryUnit` — `AwaitFreshRenderTimeoutError` | `'RENDER_TIMEOUT'`              | ✅         |
| 242  | `ensureGeometryUnit` — generic catch                  | `'UNKNOWN'`                     | ✅         |
| 266  | `getKernelResult` — propagates `resolved.errorCode`   | (forwarded)                     | ✅         |
| 292  | `fetchGeometry` — propagates `resolved.errorCode`     | (forwarded)                     | ✅         |
| 307  | `fetchGeometry` — ENOENT-class kernel issue           | `'FILE_NOT_FOUND'`              | ✅         |
| 315  | `fetchGeometry` — settled idle, no top-level geometry | `'NO_TOP_LEVEL_GEOMETRY'`       | ✅         |
| 322  | `fetchGeometry` — fallback                            | `'UNKNOWN'`                     | ✅         |
| 335  | `captureScreenshot` — no panel for targetFile         | `'UNKNOWN_GEOMETRY_UNIT'`       | ✅         |
| 383  | `captureScreenshot` — caught error                    | `'IO_ERROR' \| 'UNKNOWN'`       | ✅         |
| 394  | `captureObservations` — no panel for targetFile       | `'UNKNOWN_GEOMETRY_UNIT'`       | ✅         |
| 450  | `captureObservations` — caught error                  | `'IO_ERROR' \| 'UNKNOWN'`       | ✅         |

Today every literal is in-enum — the file is structurally correct against `HEAD`. R1/R3 ensure it stays that way under future edits.

## Appendix B — Why the screenshot failure persists despite `HEAD` being clean

The user is on `taucad.dev` (staging) in mobile Safari. Three plausible mechanisms:

1. **Long-lived browser bundle**: Safari aggressively caches JS modules behind the COOP/COEP isolation headers. A tab opened before a deploy continues to run an older `rpc-handlers.ts` while the API schema has advanced.
2. **Branch preview deploy**: Netlify branch deploys ship UI on every push; the API on `main` only updates when the branch merges. A branch that adds a new `errorCode` literal will surface this exact failure when targeted directly.
3. **Service Worker / CDN cache**: `apps/ui/netlify.toml` does not currently set per-route revalidation headers for `_app/*` chunks, leaving Netlify's default LRU. Combined with mobile Safari's HTTP cache, a several-day-old chunk is plausible.

R4 (version handshake) is the only mitigation that addresses all three — UI and API can disagree at runtime, but the disagreement is detected on the very first `connect` event, not 60 seconds later when the user clicks a Tool button.
