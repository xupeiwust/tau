---
title: 'Kernel Color Space sRGB→Linear Conversion Audit'
description: 'Root-cause investigation into washed-out colors on OpenSCAD (and JSCAD) kernel renders compared to Replicad — missing sRGB→linear conversion when populating glTF baseColorFactor.'
status: draft
created: '2026-04-21'
updated: '2026-04-21'
category: investigation
related:
  - docs/architecture/runtime-topology.md
---

# Kernel Color Space sRGB→Linear Conversion Audit

Investigates why OpenSCAD-rendered colors look noticeably washed out compared to the Replicad kernel for visually equivalent inputs, and audits every kernel's color path for sRGB→linear correctness when writing glTF `baseColorFactor`.

## Executive Summary

The Replicad kernel correctly performs an **sRGB→linear** conversion before writing CSS hex colors into glTF `pbrMetallicRoughness.baseColorFactor`. The OpenSCAD and JSCAD kernels do **not** — they pass sRGB-encoded values straight into the linear-space slot. When Three.js (which expects glTF `baseColorFactor` to be linear, per the glTF 2.0 spec) re-encodes those values through `outputColorSpace = SRGBColorSpace`, the result is the classic "washed-out" gamma-shifted appearance visible in the screenshot. This is a one-line / per-call fix in two files. The OpenCASCADE kernel is correct via OCCT's `Quantity_TOC_sRGB` tag for the simple-color path, but its PBR `BaseColor` path has a latent bug for the same reason.

## Problem Statement

User-supplied screenshot compares two equivalent toy-car models rendered side-by-side:

| Side  | Kernel   | Body color (intended) | Cabin color (intended) | Visual result                |
| ----- | -------- | --------------------- | ---------------------- | ---------------------------- |
| Left  | Replicad | `#c0392b` (deep red)  | `#3b7dd8` (vivid blue) | Saturated, vivid             |
| Right | OpenSCAD | `#D94F4F` (red)       | `#4F7FD9` (blue)       | Pale, washed out, low-chroma |

The intended colors were chosen to be visually similar between the two snippets, yet the rendered output diverges dramatically in saturation. The user's hypothesis was a missing color-space conversion. This investigation confirms that hypothesis and identifies the exact line.

## Methodology

1. Read both kernel entry points: `replicad.kernel.ts` and `openscad.kernel.ts`.
2. Trace each kernel's path from user-supplied color → glTF `baseColorFactor`:
   - Replicad: `replicad-to-gltf.ts` → `glb-writer.ts`.
   - OpenSCAD: `openscad-wasm OFF output` → `import-off.ts` → `export-glb.ts` → `glb-writer.ts`.
3. Audit every other kernel (`opencascade`, `jscad`, `manifold`, `tau`, `zoo`) for the same `baseColorFactor` write path with `rg`.
4. Cross-reference Three.js renderer settings in `three-context.tsx` and `screenshot-capability.machine.ts` to confirm the renderer's color-space expectations.

## Findings

### Finding 1: Replicad does sRGB→linear; OpenSCAD does not

**Replicad** (`packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts`, lines 14–48):

```14:48:packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts
function srgbToLinear(channel: number): number {
  return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

// ...

    let baseColor: [number, number, number, number] = [...cadMaterialDefaults.baseColorFactor];
    if (geometry.color) {
      try {
        const normalizedColor = normalizeColor(geometry.color);
        const hex = normalizedColor.color;
        const r = srgbToLinear(Number.parseInt(hex.slice(1, 3), 16) / 255);
        const g = srgbToLinear(Number.parseInt(hex.slice(3, 5), 16) / 255);
        const b = srgbToLinear(Number.parseInt(hex.slice(5, 7), 16) / 255);
        const alpha = geometry.opacity ?? normalizedColor.alpha;
        baseColor = [r, g, b, alpha];
      } catch (error) {
```

This is the textbook sRGB EOTF (`0.04045` cutoff, `12.92` linear segment, `2.4` exponent). Output goes into `baseColorFactor` as linear, which is what the glTF 2.0 spec mandates.

**OpenSCAD** (`packages/runtime/src/utils/import-off.ts`, lines 92–106 + `packages/runtime/src/utils/export-glb.ts`, lines 215–232):

```92:106:packages/runtime/src/utils/import-off.ts
    let color: Color = [1, 1, 1, 1]; // Default to opaque white

    if (parts.length >= numberVerts + 4) {
      // Has at least RGB color data
      const r = parts[numberVerts + 1];
      const g = parts[numberVerts + 2];
      const b = parts[numberVerts + 3];

      // Check for alpha channel (4th color component)
      const hasAlpha = parts.length >= numberVerts + 5;
      const a = hasAlpha ? parts[numberVerts + 4] : 255;

      if (r !== undefined && g !== undefined && b !== undefined && a !== undefined) {
        color = [r / 255, g / 255, b / 255, a / 255];
      }
    }
```

```215:233:packages/runtime/src/utils/export-glb.ts
function colorGroupToPrimitive(geometry: ColorGroupGeometry): GlbPrimitive {
  const { color, positions, indices, normals } = geometry;

  const colorString = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3].toFixed(2)})`;

  return {
    mode: 4,
    positions,
    normals,
    indices,
    material: {
      baseColorFactor: color,
      metallicFactor: cadMaterialDefaults.metalnessFactor,
      roughnessFactor: cadMaterialDefaults.roughnessFactor,
      doubleSided: true,
      alphaMode: color[3] < 1 ? 'BLEND' : 'OPAQUE',
      name: colorString,
    },
  };
}
```

OpenSCAD's `color()` directive emits per-face RGB integers (0–255) into the OFF output. The `--backend=manifold` writer (Manifold, called from inside `openscad-wasm`) does **not** do any color-space transform. Tau then divides by 255 and writes the result straight into `baseColorFactor` with no EOTF — the value is sRGB-encoded but the slot is defined as linear.

### Finding 2: Numerical impact matches the screenshot

For the user's intended cabin colors:

| Component | sRGB hex   | sRGB float | Correct linear (Replicad) | What OpenSCAD writes (sRGB-as-linear) | What Three.js displays                                                |
| --------- | ---------- | ---------- | ------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Body R    | `0xD9` 217 | 0.851      | 0.694                     | 0.851 (≈18% too bright in linear)     | 0.935 sRGB → `#EE` ~238 — visibly pinker/lighter than the intended D9 |
| Body G    | `0x4F` 79  | 0.310      | 0.0782                    | 0.310                                 | 0.580 sRGB → `#94` ~148 — major desaturation                          |
| Body B    | `0x4F` 79  | 0.310      | 0.0782                    | 0.310                                 | 0.580 sRGB → `#94` ~148                                               |

A pure-channel value like `0xD9` shifts ~10–20%, but the **dark** channels (`0x4F` ≈ 0.31) shift from 0.078 (linear) to 0.31, a 4× error that lifts the channel floor and crushes saturation. This produces exactly the "washed-out, low-chroma, slightly bleached" appearance in the screenshot.

### Finding 3: Per-kernel audit

| Kernel             | Color entry path                                                              | sRGB→linear?                                                                                 | Status                                                                    |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Replicad**       | `replicad-to-gltf.ts` `buildNodeFromReplicadGeometry`                         | ✅ Yes — explicit `srgbToLinear()` per channel                                               | Correct                                                                   |
| **OpenSCAD**       | `import-off.ts` parses OFF int RGB → `export-glb.ts` `colorGroupToPrimitive`  | ❌ No — raw `[r/255, g/255, b/255, a/255]` straight into `baseColorFactor`                   | **BROKEN** (root cause of reported bug)                                   |
| **JSCAD**          | `jscad-to-gltf.ts` `extractColorFromShape` → `buildNodeFromJscadShape`        | ❌ No — JSCAD's `colorize([r,g,b])` is sRGB by web convention; passed straight in            | **BROKEN** (same shape as OpenSCAD)                                       |
| **OpenCASCADE**    | `opencascade-mesh.ts` `parseHexColor` → `Quantity_Color(..., TOC_sRGB)`       | ✅ Yes via OCCT — `Quantity_TOC_sRGB` tag tells OCCT the input is sRGB                       | Correct for non-PBR path                                                  |
| **OpenCASCADE**    | `opencascade-mesh.ts` PBR `Quantity_ColorRGBA(r, g, b, alpha)` (lines 84–92)  | ❌ No — `Quantity_ColorRGBA(double, double, double, double)` interprets values as **linear** | **LATENT BUG** — fires only when shape carries `metalness` or `roughness` |
| **Manifold**       | Upstream `manifold-3d/lib/gltf-node.js` builds the glTF document              | N/A in Tau code — owned by upstream                                                          | Likely correct (upstream pipeline); not verified end-to-end here          |
| **Tau (importer)** | `importToGlb` returns an existing GLB blob; no synthesis of `baseColorFactor` | N/A — pass-through of imported data                                                          | Not affected                                                              |
| **Zoo (KCL)**      | KCL engine produces a glTF directly via `exportFromMemory({ type: 'gltf' })`  | N/A — color path owned by KCL engine, not by Tau                                             | Not affected by Tau code                                                  |

### Finding 4: Renderer expects linear, encodes sRGB on output

Tau's `Canvas` (R3F) does not override `outputColorSpace` (defaults to `THREE.SRGBColorSpace` since r152) and only sets `toneMappingExposure = 1`:

```118:132:apps/ui/app/components/geometry/graphics/three/three-context.tsx
      frameloop='demand'
      className={cn('bg-background', className)}
      onCreated={({ gl }) => {
        // Neutral ACES exposure -- depth contrast comes from AO and targeted directional lights.
        gl.toneMappingExposure = 1;
```

The screenshot capability also picks up `gl.outputColorSpace` from the live renderer (`screenshot-capability.machine.ts:569`), so screenshots reproduce the same washed-out output that the user sees on screen — i.e. this bug propagates into screenshots used by the agent's `capture_screenshot` tool, which is consequential for evaluation/benchmarks.

The combination is clear: glTF spec says `baseColorFactor` is linear, Three.js reads it as linear, then encodes the framebuffer to sRGB for display. A kernel that writes sRGB into the linear slot effectively double-encodes the EOTF.

### Finding 5: There is no shared color-conversion utility

`srgbToLinear` lives privately inside `packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts`. Every kernel re-implements (or skips) the conversion in its own writer. There is no canonical Tau helper that all kernel-to-glTF paths funnel through, which is exactly why the bug exists in two kernels and lurks in the OpenCASCADE PBR branch.

## Recommendations

| #   | Action                                                                                                                                                                                                                                     | Priority | Effort | Impact                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------------------------------------------------------------- |
| R1  | Extract `srgbToLinear` (and an `sRGBHexTuple`/`sRGBToLinearTuple` helper) into a shared module — e.g. `packages/runtime/src/utils/color-space.ts` — and export it for kernel reuse.                                                        | P0       | XS     | Prevents future drift; one source of truth                    |
| R2  | Apply the helper in `packages/runtime/src/utils/export-glb.ts` `colorGroupToPrimitive` so `baseColorFactor` is always linear (fixes OpenSCAD; also fixes any other future OFF consumer).                                                   | P0       | XS     | **Resolves the user-reported washed-out OpenSCAD colors**     |
| R3  | Apply the helper in `packages/runtime/src/kernels/jscad/jscad-to-gltf.ts` `buildNodeFromJscadShape` for the `baseColorFactor` write.                                                                                                       | P0       | XS     | Fixes JSCAD parity with Replicad                              |
| R4  | Replace Replicad's local `srgbToLinear` with the shared helper.                                                                                                                                                                            | P1       | XS     | DRY; no behavior change                                       |
| R5  | Patch the OpenCASCADE PBR branch (`opencascade-mesh.ts:84–92`) to convert sRGB→linear before constructing `Quantity_ColorRGBA`, since that constructor treats inputs as linear.                                                            | P1       | XS     | Closes latent bug for shapes that set `metalness`/`roughness` |
| R6  | Add a parity test in `packages/runtime/src/kernels/cross-kernel-mesh-parity.test.ts` that asserts identical CSS hex inputs produce identical `baseColorFactor` floats (within ε) across **all** kernels (not just replicad vs. occt).      | P1       | S      | Regression guard against future divergence                    |
| R7  | Update `cad-preview` snapshot/screenshot tests to lock in the corrected colors so the agent's `capture_screenshot` benchmarks aren't anchored on incorrect baselines.                                                                      | P2       | S      | Prevents stale baselines reverting the fix                    |
| R8  | Document the convention ("kernels MUST write linear `baseColorFactor`; CSS hex / OpenSCAD OFF int colors are sRGB; convert at the glTF boundary") in `docs/architecture/runtime-topology.md` or a new `docs/policy/color-space-policy.md`. | P2       | S      | Codifies the rule for future kernel authors                   |

## Trade-offs

The fix is mechanical and uncontroversial — sRGB-encoded inputs going into a linear-space slot is unambiguously a bug per the glTF 2.0 spec. The only consideration is whether to express it as:

| Option                                                                            | Pro                                    | Con                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(A)** Convert at the glTF writer boundary (per-kernel, in each `*-to-gltf.ts`)  | Local, easy to reason about per kernel | Requires fixing 2 kernels and remembering for future ones                                                                                                                                     |
| **(B)** Convert centrally inside `glb-writer.ts` and require kernels to pass sRGB | Single location to fix                 | Inverts the spec contract — `GlbPrimitive.material.baseColorFactor` would no longer mean "the linear baseColorFactor that goes on the wire". Breaks naming and surprises future contributors. |
| **(C)** Add an sRGB color attribute to `GlbPrimitive` that the writer transforms  | Explicit, type-safe                    | Larger surface change; not justified for a 6-line fix                                                                                                                                         |

**Recommendation: Option (A)** with R1's shared helper. Keep the writer's contract honest ("baseColorFactor is the linear value that goes on the wire"), centralize the math in one helper, and fix the two offending kernels.

## Code Examples

### Proposed shared helper

```typescript
// packages/runtime/src/utils/color-space.ts
export function srgbToLinear(channel: number): number {
  return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function srgbTupleToLinear(rgba: readonly [number, number, number, number]): [number, number, number, number] {
  return [srgbToLinear(rgba[0]), srgbToLinear(rgba[1]), srgbToLinear(rgba[2]), rgba[3]];
}
```

### OpenSCAD fix (`export-glb.ts`)

```typescript
// before
material: {
  baseColorFactor: color, // sRGB float — wrong slot
  // ...
}

// after
material: {
  baseColorFactor: srgbTupleToLinear(color),
  // ...
}
```

### JSCAD fix (`jscad-to-gltf.ts`)

```typescript
// before
const baseColor: [number, number, number, number] = color ?? [0.8, 0.8, 0.8, 1];
// ...
material: { baseColorFactor: baseColor, /* ... */ }

// after
const baseColor: [number, number, number, number] = color
  ? srgbTupleToLinear(color)
  : srgbTupleToLinear([0.8, 0.8, 0.8, 1]);
```

### OpenCASCADE PBR fix (`opencascade-mesh.ts`)

```typescript
// before
const [r, g, b] = parseHexColor(entry.color); // sRGB floats
const baseColor = new oc.Quantity_ColorRGBA(r, g, b, entry.opacity ?? 1);

// after — Quantity_ColorRGBA(double,double,double,double) interprets inputs as linear
const [sr, sg, sb] = parseHexColor(entry.color);
const baseColor = new oc.Quantity_ColorRGBA(srgbToLinear(sr), srgbToLinear(sg), srgbToLinear(sb), entry.opacity ?? 1);
```

The non-PBR path on the same file (`Quantity_Color(r, g, b, oc.Quantity_TypeOfColor.Quantity_TOC_sRGB)`) is already correct — OCCT performs the conversion internally based on the `TOC_sRGB` tag.

## References

- glTF 2.0 spec, "Material Properties": `pbrMetallicRoughness.baseColorFactor` is in **linear** space; vertex/texture sRGB inputs require the `KHR_texture_basisu` / `KHR_materials_pbrSpecularGlossiness` style explicit color-space tagging or sampler-side EOTF.
- Three.js renderer notes (r152+): `WebGLRenderer.outputColorSpace` defaults to `SRGBColorSpace`; glTF loader treats `baseColorFactor` as linear.
- OpenCASCADE: `Quantity_TypeOfColor::Quantity_TOC_sRGB` constructor flag triggers OCCT's internal sRGB→linear conversion; the no-flag/`Quantity_ColorRGBA(double, double, double, double)` overload assumes linear input.
- Source: `packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts` (reference correct implementation).
- Source: `packages/runtime/src/utils/export-glb.ts`, `packages/runtime/src/utils/import-off.ts`, `packages/runtime/src/kernels/jscad/jscad-to-gltf.ts`, `packages/runtime/src/kernels/opencascade/opencascade-mesh.ts` (offending sites).
- Renderer config: `apps/ui/app/components/geometry/graphics/three/three-context.tsx`, `apps/ui/app/machines/screenshot-capability.machine.ts`.

## Appendix: Quick numerical sanity check

Using the user's body color `#D94F4F` and the sRGB EOTF:

```
sR = 217/255 = 0.8510  → linear 0.6939
sG = 79/255  = 0.3098  → linear 0.0773
sB = 79/255  = 0.3098  → linear 0.0773
```

| Channel | Replicad writes (correct, linear) | OpenSCAD writes (sRGB-as-linear) | Three.js display via sRGB OETF |
| ------- | --------------------------------- | -------------------------------- | ------------------------------ |
| R       | 0.694                             | 0.851                            | ≈ `#EE` (~238) — too pink      |
| G       | 0.077                             | 0.310                            | ≈ `#94` (~148) — too bright    |
| B       | 0.077                             | 0.310                            | ≈ `#94` (~148) — too bright    |

Original intent `#D94F4F` ≈ R 217, G 79, B 79. OpenSCAD currently displays roughly `#EE9494` — a desaturated, washed-out salmon/pink, exactly matching the screenshot.
