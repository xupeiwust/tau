---
title: 'OpenSCAD → 3MF Coordinate Orientation Smoking Gun'
description: 'Root cause of the OpenSCAD → 3MF wrong-orientation defect: kernel-side honoring of `coordinateSystem` produces a non-spec GLB that the converter then double-rotates. Replicad escapes by always emitting spec-compliant Y-up GLB.'
status: active
created: '2026-04-16'
updated: '2026-04-16'
category: investigation
related:
  - docs/research/3mf-export-scale-orientation-manifold.md
  - docs/research/3mf-assimp-audit.md
  - docs/research/3mf-export-rendering-artifacts.md
  - docs/research/import-test-geometry-deviation-audit.md
  - docs/research/export-options-kernel-mismatch.md
  - docs/research/converter-runtime-consolidation.md
---

# OpenSCAD → 3MF Coordinate Orientation Smoking Gun

Why a Z-up OpenSCAD model exported to 3MF lands on its side in Bambu Studio while the same Z-up Replicad model lands flat on the build plate, and what to fix in `convertOffToGltf` and the `coordinateSystem` schema to align the two paths.

## Executive Summary

The user-facing defect — an OpenSCAD QR-code plate (image 3) standing upright in Bambu Studio (image 4) when "z-up" is selected for 3MF export, while the same UI selection on a Replicad hollow box (images 1, 2) is correct — has a single, asymmetric root cause:

- **Replicad's GLB writer (`convertReplicadGeometriesToGltf`) is hard-coded to emit spec-compliant Y-up GLB**: it always calls `transformVerticesGltf` (Z→Y rotation + mm→m scale) regardless of the user's `coordinateSystem` choice. The intermediate GLB sent to the converter is therefore always glTF-2.0-compliant, and the Lib3MFBridge's Y→Z bake produces the correct +Z 3MF.
- **OpenSCAD's GLB writer (`convertOffToGltf`) honors the user's `coordinateSystem` choice**: when "z-up" is selected it skips the Z→Y rotation (using `transformVerticesZup`, which only scales mm→m). The resulting GLB carries Z-up vertex data while the GLB _container_ is still labelled Y-up per glTF spec. Assimp's glTF2 importer stamps `(unit=1.0, upAxis=Y)` unconditionally, and Lib3MFBridge then bakes a spurious Y→Z rotation, mapping OpenSCAD's height axis (`Z_o`) onto the 3MF horizontal plane. The model arrives standing on its side.
- **The y-up case works for OpenSCAD by coincidence**: with "y-up" the OFF→GLB step uses `transformVerticesGltf`, producing a _correct_ spec-compliant GLB; the converter's Y→Z bake then lands the model flat on the build plate (image 6).

The smoking gun is **`convertOffToGltf` honoring a parameter that the downstream converter cannot see**. The fix is to make the OpenSCAD→GLB intermediate spec-compliant Y-up regardless of the user-facing `coordinateSystem` value, mirroring `convertReplicadGeometriesToGltf`. Coordinate-system semantics for 3MF (and other Assimp-routed formats) belong on the _transcoder_ edge schema, not the kernel GLB schema, where they can be wired into Assimp's `3MF_EXPORT_UPAXIS` property.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Methodology](#methodology)
3. [Findings](#findings)
   - [Finding 1: Asymmetric GLB writers between kernels](#finding-1-asymmetric-glb-writers-between-kernels)
   - [Finding 2: glTF2 importer hard-codes Y-up + meters into scene metadata](#finding-2-gltf2-importer-hard-codes-y-up--meters-into-scene-metadata)
   - [Finding 3: Lib3MFBridge bakes source-Y → target-Z unconditionally](#finding-3-lib3mfbridge-bakes-source-y--target-z-unconditionally)
   - [Finding 4: Algebraic derivation of all four observed cases](#finding-4-algebraic-derivation-of-all-four-observed-cases)
   - [Finding 5: `coordinateSystem` is silently dropped at the converter edge](#finding-5-coordinatesystem-is-silently-dropped-at-the-converter-edge)
4. [Recommendations](#recommendations)
5. [Trade-offs](#trade-offs)
6. [Code References](#code-references)

## Problem Statement

A user exports two projects to 3MF from the Tau editor and re-opens both in Bambu Studio:

| #   | Source kernel | UI `coordinateSystem` | Bambu Studio observation                                | Image    |
| --- | ------------- | --------------------- | ------------------------------------------------------- | -------- |
| 1   | Replicad      | z-up                  | Hollow box flat on plate, correct dimensions            | img 1, 2 |
| 2   | OpenSCAD      | z-up                  | QR-code plate **standing vertically** on its short edge | img 3, 4 |
| 3   | OpenSCAD      | y-up                  | QR-code plate flat on plate, correctly oriented         | img 5, 6 |

The 3MF Core Spec §3.3 mandates +Z = build direction, and Bambu Studio honors that. The Replicad path agrees with the spec; OpenSCAD's "z-up" selection contradicts it. Identifying _why_ the same UI control produces opposite behavior between two kernels is the goal of this investigation.

## Methodology

1. Read the kernel-side export paths for both kernels (`replicad.kernel.ts`, `openscad.kernel.ts`).
2. Read the OFF→GLB and Replicad-mesh→GLB conversion utilities (`off-to-gltf.ts`, `replicad-to-gltf.ts`, `framework/common.ts`).
3. Read the converter transcoder and its export-option schemas (`converter.transcoder.ts`, `converter-export-options.ts`).
4. Read the Assimp glTF2 importer and Lib3MF bridge in the `repos/assimpjs/assimp` fork to confirm what scene metadata is stamped on import and what bake the 3MF exporter applies.
5. Compose the per-axis transforms symbolically for each of the four cases (Replicad×{z-up,y-up}, OpenSCAD×{z-up,y-up}) and compare against the visual evidence.
6. Cross-reference against the prior `3mf-export-scale-orientation-manifold.md` audit (Replicad-only) to confirm this is a previously undiagnosed asymmetry, not a duplicate report.

## Findings

### Finding 1: Asymmetric GLB writers between kernels

The two kernels' GLB writers behave fundamentally differently with respect to the user's `coordinateSystem` choice.

**Replicad** — `convertReplicadGeometriesToGltf` always calls `transformVertexArray`, which always invokes `transformVerticesGltf` (Z-up mm → Y-up m). The function's JSDoc explicitly commits to this:

```113:116:packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts
export function convertReplicadGeometriesToGltf(
  geometries: GeometryReplicad[],
  format: 'glb' | 'gltf' = 'glb',
): Uint8Array<ArrayBuffer> {
```

The kernel's `coordinateSystem === 'y-up'` branch pre-rotates the _replicad shape_ before meshing (`shape.clone().rotate(-90, [0, 0, 0], [1, 0, 0])`), but the GLB writer's downstream Z→Y rotation is _unconditional_. Net effect: regardless of UI selection, the GLB on the wire is glTF-2.0 compliant Y-up.

**OpenSCAD** — `convertOffToGltf` branches on `coordinateSystem`, picking `transformVerticesGltf` (Z→Y + scale) for `'y-up'` and `transformVerticesZup` (scale only, **no rotation**) for `'z-up'`:

```13:26:packages/runtime/src/utils/off-to-gltf.ts
export async function convertOffToGltf(
  offContent: string,
  format: 'glb' | 'gltf' = 'glb',
  coordinateSystem: 'y-up' | 'z-up' = 'z-up',
): Promise<Uint8Array<ArrayBuffer>> {
  const offData = parseOff(offContent);
  const transform = coordinateSystem === 'y-up' ? transformVerticesGltf : transformVerticesZup;

  if (format === 'gltf') {
    return createGltf(offData, transform);
  }

  return createGlb(offData, transform);
}
```

`transformVerticesZup` is intentionally axis-preserving:

```174:180:packages/runtime/src/framework/common.ts
export function transformVerticesZup(vertex: readonly [number, number, number]): [number, number, number] {
  const x = vertex[0] / 1000;
  const y = vertex[1] / 1000;
  const z = vertex[2] / 1000;

  return [x === 0 ? 0 : x, y === 0 ? 0 : y, z === 0 ? 0 : z];
}
```

OpenSCAD is natively Z-up, so when the user picks "z-up" the resulting GLB carries Z-up coordinates inside a container that the glTF spec mandates be Y-up. **The GLB is non-spec.** Any consumer that respects the glTF 2.0 spec (Assimp, three.js, Babylon, every other glTF runtime) will render this GLB sideways.

### Finding 2: glTF2 importer hard-codes Y-up + meters into scene metadata

When the converter receives the (potentially mis-coordinated) GLB, the Assimp glTF2 importer in the fork unconditionally stamps the scene with the spec values:

```1948:1954:repos/assimpjs/assimp/code/AssetLib/glTF2/glTF2Importer.cpp
    // Always allocate the metadata block — the glTF 2.0 spec mandates meters and
    // +Y up (glTF 2.0 §3.1, §3.5) so the cross-importer contract values are
    // statically known. Writing them unconditionally lets downstream exporters
    // (e.g. 3MF) rescale and re-axis correctly without per-format lookup tables.
    mScene->mMetaData = new aiMetadata;
    mScene->mMetaData->Add(AI_METADATA_UNIT_SCALE_TO_METERS, 1.0);
    mScene->mMetaData->Add(AI_METADATA_UP_AXIS, static_cast<int32_t>(1));
```

The contract is a static promise about the GLB _spec_, not a measurement of the byte stream — there is no field in glTF that lets an importer report "this GLB is secretly Z-up." The only way to keep the contract valid is for every producer to honor the spec at the source. OpenSCAD currently breaks that promise.

### Finding 3: Lib3MFBridge bakes source-Y → target-Z unconditionally

The 3MF exporter reads the contract metadata and bakes a per-vertex rotation from source up-axis (1 = Y, per Finding 2) to target up-axis (default 2 = Z, per 3MF Core Spec §3.3):

```327:354:repos/assimpjs/assimp/code/AssetLib/3MF/Lib3MFBridge.cpp
    // ---- TARGET UP-AXIS (3MF coordinate system) ----
    // Resolver: ExportProperty `3MF_EXPORT_UPAXIS` (int32, 0=X, 1=Y, 2=Z) → 3MF
    // Core Spec §3.3 default of +Z. Out-of-range values throw DeadlyExportError.
    int32_t targetUpAxis = 2;
    if (pProperties) {
        targetUpAxis = pProperties->GetPropertyInteger("3MF_EXPORT_UPAXIS", 2);
        targetUpAxis = validateUpAxisInt(targetUpAxis, "3MF_EXPORT_UPAXIS");
    }
    ...
    aiMatrix4x4 axisRotation; // identity by default
    if (sourceUpAxis >= 0) {
        validateUpAxisInt(sourceUpAxis, AI_METADATA_UP_AXIS " (scene metadata)");
        axisRotation = buildAxisRotationMatrix(sourceUpAxis, targetUpAxis);
    }
```

`buildAxisRotationMatrix(1, 2)` is `(x, y, z) → (x, -z, y)`:

```96:107:repos/assimpjs/assimp/code/Common/UnitAxisContract.cpp
aiMatrix4x4 buildAxisRotationMatrix(int32_t fromAxis, int32_t toAxis) {
    aiMatrix4x4 m; // identity
    if (fromAxis == toAxis) {
        return m;
    }
    // Common CAD case: Y-up to Z-up — rotate -90 about +X (so +Y maps to +Z, +Z to -Y).
    if (fromAxis == 1 && toAxis == 2) {
        m.a1 = 1; m.a2 = 0; m.a3 = 0;
        m.b1 = 0; m.b2 = 0; m.b3 = -1;
        m.c1 = 0; m.c2 = 1; m.c3 = 0;
        return m;
    }
```

The bake is correct _only when_ the GLB it is reading from actually obeys the glTF spec.

### Finding 4: Algebraic derivation of all four observed cases

Let the kernel-native vertex be `(x_o, y_o, z_o)` in millimetres in the kernel's native frame (Z-up for both Replicad and OpenSCAD). Compose the GLB-writer transform with the Lib3MFBridge bake (3MF target-Z default, no `3MF_EXPORT_UPAXIS` property is wired through Tau's transcoder).

| #   | Kernel   | UI selection | GLB transform applied                                       | GLB vertex content (m)     | Lib3MF bake (Y→Z)                       | 3MF vertex (m)            | Height axis | 3MF Z = ?      | Outcome                        |
| --- | -------- | ------------ | ----------------------------------------------------------- | -------------------------- | --------------------------------------- | ------------------------- | ----------- | -------------- | ------------------------------ |
| 1   | Replicad | z-up         | shape: identity → writer `transformVerticesGltf` (Z→Y)      | `(x_o, z_o, −y_o) / 1000`  | `(x, −z, y)` ⇒ `(x_o, y_o, z_o) / 1000` | `(x_o, y_o, z_o) / 1000`  | `z_o`       | original `z_o` | ✓ flat on plate (img 2)        |
| 2   | Replicad | y-up         | shape: rotate −90°X (Z→Y) → writer (Z→Y again)              | `(x_o, −y_o, −z_o) / 1000` | `(x_o, z_o, −y_o) / 1000`               | `(x_o, z_o, −y_o) / 1000` | `z_o`       | `z_o`          | ✓ (untested by user but works) |
| 3   | OpenSCAD | z-up         | writer `transformVerticesZup` (scale only, **no rotation**) | `(x_o, y_o, z_o) / 1000`   | `(x_o, −z_o, y_o) / 1000`               | `(x_o, −z_o, y_o) / 1000` | `z_o`       | `y_o`          | ✗ on its side (img 4)          |
| 4   | OpenSCAD | y-up         | writer `transformVerticesGltf` (Z→Y)                        | `(x_o, z_o, −y_o) / 1000`  | `(x_o, y_o, z_o) / 1000`                | `(x_o, y_o, z_o) / 1000`  | `z_o`       | `z_o`          | ✓ flat on plate (img 6)        |

The Y-up OpenSCAD path (case 4) lands the model in Bambu Studio with its original Z-up coordinates — a perfect round-trip — only because the GLB→3MF chain happens to compose to the identity. The Z-up OpenSCAD path (case 3) introduces exactly one un-wanted rotation: source-`z_o` lands in the 3MF Y-axis, so what was "vertical" in OpenSCAD becomes "depth" in the slicer and the QR plate stands on its short edge.

### Finding 5: `coordinateSystem` is silently dropped at the converter edge

Even if the user-facing `coordinateSystem` selection meant something at the _converter_ boundary, the schema does not expose it.

```43:54:packages/runtime/src/transcoders/converter/converter-export-options.ts
const threeMfSchema = z.object({
  unit: z
    .enum(['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'])
    .default('millimeter')
    .describe('Unit of measurement for the 3MF model coordinates'),
  application: z.string().optional().describe('Creating application metadata (e.g. slicer name and version)'),
});

const threeMfKeyMap = {
  unit: '3MF_EXPORT_UNIT',
  application: '3MF_EXPORT_APPLICATION',
} as const;
```

There is no `coordinateSystem` (or equivalent) field on the 3MF edge, and the key map does not include `3MF_EXPORT_UPAXIS`. The dropdown the user sees in image 3 ("Coordinate System: z-up") is composed into the 3MF panel via `MergeExportMap` from the _kernel's GLB schema_ (`coordinateSystemSchema` shape is `.extend()`-ed onto every GLB and GLTF kernel schema in `replicad.schemas.ts` and `openscad.schemas.ts`). It exclusively controls the kernel→GLB transform. The Lib3MFBridge already defaults `3MF_EXPORT_UPAXIS = 2` and is therefore always producing spec-compliant Z-up 3MF (which is the only thing the 3MF spec allows anyway). The dropdown is mis-attributed — it appears next to "3MF Options" but actually controls the upstream GLB intermediate.

This is the same defect category as **Smoking Gun 2** in `3mf-export-scale-orientation-manifold.md`, but presented from the OpenSCAD side: the prior audit noted the field is "silently dropped"; this audit shows the consequence is that the dropdown becomes an _active foot-gun_ on kernels whose GLB writer honors it.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                               | Priority | Effort | Impact                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Make `convertOffToGltf` always emit spec-compliant Y-up GLB. Drop the `coordinateSystem` parameter (or accept it but ignore for the transform — useful only as a back-compat shim during migration). Update OpenSCAD `createGeometry` and `exportGeometry` callers accordingly.                                                                                                                                                                      | P0       | Low    | High — fixes the user-visible defect and aligns OpenSCAD with Replicad's invariant                                                                      |
| R2  | Remove `coordinateSystem` from `openscadExportSchemas.glb` / `.gltf`. The intermediate GLB is a transport, not a user-facing convention; offering a knob that produces non-spec output is a foot-gun.                                                                                                                                                                                                                                                | P0       | Low    | High — eliminates the dropdown that mis-led the user; also clears the defect for direct-GLB consumers (three.js, Babylon, etc.)                         |
| R3  | Move 3MF axis selection to the _transcoder edge_ schema: add `coordinateSystem: z.enum(['y-up', 'z-up']).default('z-up')` to `threeMfSchema` in `converter-export-options.ts`, map it to Assimp's `3MF_EXPORT_UPAXIS` (`y-up` → 1, `z-up` → 2) in `threeMfKeyMap`. Although 3MF Core Spec §3.3 mandates +Z, lib3mf will accept other axes for non-printing workflows.                                                                                | P1       | Med    | Med — restores the intent of the dropdown without leaking GLB-intermediate semantics; needed before R1 lands so the UI does not lose a control silently |
| R4  | Audit Replicad's `coordinateSystem === 'y-up'` branch in `replicad.kernel.ts` (lines 567–626). The shape pre-rotation followed by the unconditional Z→Y in `convertReplicadGeometriesToGltf` produces a _double_ rotation — case 2 in Finding 4 has the model rotated 180° about X relative to source. Fix to a single rotation (drop the pre-rotation when `coordinateSystem === 'y-up'`, or short-circuit the writer when source is already Y-up). | P1       | Low    | Med — keeps Replicad's direct-GLB y-up output sensible; today it is broken in the same family even though no one has filed a bug                        |
| R5  | Add a regression test in `packages/runtime/src/utils/off-to-gltf.test.ts` that asserts the GLB byte stream is Y-up (e.g. parse the GLB back, sample a vertex, check the rotation) for any input. Add a parallel test in `packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.test.ts`. Both should encode the spec invariant explicitly.                                                                                                    | P1       | Low    | Med — prevents this exact regression from re-appearing in either kernel                                                                                 |
| R6  | Add an end-to-end test that round-trips an OpenSCAD `cube([20, 30, 10]);` (height = 10) through the converter to 3MF, parses the resulting `3D/3dmodel.model`, and asserts the bounding-box height lies along Z. Today there is no test that crosses the kernel/converter seam for OpenSCAD.                                                                                                                                                         | P2       | Med    | Med — locks the seam in CI                                                                                                                              |
| R7  | Document the GLB-intermediate invariant ("kernel → converter GLB MUST be glTF-2.0-compliant Y-up + meters") in `docs/policy/library-api-policy.md` or a new `runtime-export-pipeline-policy.md`. Cite the Lib3MFBridge bake as the canonical consumer.                                                                                                                                                                                               | P2       | Low    | Low — codifies the contract for future kernel implementors                                                                                              |

## Trade-offs

| Option                                                                          | Pros                                                                                                                                                | Cons                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 + R2 (drop `coordinateSystem` from kernel GLB schema)**                    | Spec-compliant by construction; matches Replicad; eliminates the foot-gun for _all_ downstream Assimp routes (3MF, OBJ, PLY, FBX, …) in one change. | Removes a user-facing knob. Direct-GLB consumers who relied on the (broken) Z-up GLB will see a behavior change — but they were already getting non-spec output, so any consumer relying on it was implicitly buggy. |
| **Plumb `coordinateSystem` through to converter and apply at GLB→3MF boundary** | Preserves the dropdown semantics intact (user controls the _target_ axis, not the intermediate).                                                    | More wiring; requires `3MF_EXPORT_UPAXIS` round-trip; only solves it for 3MF, not for the other Assimp-routed formats that share the same plumbing.                                                                  |
| **Detect non-spec GLB inside the converter and rotate**                         | Backwards-compatible with both kernels' current outputs.                                                                                            | Heuristic detection is unreliable (a Y-up GLB with all-positive Z values is indistinguishable from a Z-up one); silently corrupts genuine Y-up content; violates the glTF contract Assimp's importer relies on.      |

Recommendation: **R1 + R2 + R3** as a coherent package. R1/R2 fix the kernel boundary; R3 restores the user-controllable axis at the layer where it semantically belongs (the 3MF target), so the UI dropdown can stay (now with correct semantics) and other Assimp-routed targets inherit the same control.

## Code References

- `packages/runtime/src/utils/off-to-gltf.ts` — the OpenSCAD GLB writer that branches on `coordinateSystem` (the smoking gun).
- `packages/runtime/src/framework/common.ts` (lines 158–180) — `transformVerticesGltf` (Z→Y) vs `transformVerticesZup` (no rotation).
- `packages/runtime/src/kernels/openscad/openscad.kernel.ts` (lines 670–759) — `createGeometry` calls `convertOffToGltf(offData, 'glb', 'y-up')` for the in-process preview (correct), but `exportGeometry` passes `coordinateSystem` through (broken for 3MF).
- `packages/runtime/src/kernels/openscad/openscad.schemas.ts` (lines 81–84) — `coordinateSystem` schema entry on GLB/GLTF export.
- `packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts` (lines 99–133) — Replicad's always-Y-up GLB writer (the correct invariant).
- `packages/runtime/src/kernels/replicad/replicad.kernel.ts` (lines 561–648) — Replicad's `exportGeometry` GLB branch (note the pre-rotation that causes the latent y-up double-rotation, see R4).
- `packages/runtime/src/transcoders/converter/converter-export-options.ts` (lines 43–54) — `threeMfSchema` (no `coordinateSystem` field; no `3MF_EXPORT_UPAXIS` key map).
- `packages/runtime/src/transcoders/converter/converter.transcoder.ts` (lines 26–40) — transcoder edges for 3MF and other Assimp-routed formats.
- `repos/assimpjs/assimp/code/AssetLib/glTF2/glTF2Importer.cpp` (lines 1948–1954) — unconditional `(unit=1.0, upAxis=Y)` stamp.
- `repos/assimpjs/assimp/code/AssetLib/3MF/Lib3MFBridge.cpp` (lines 309–354) — Lib3MF target-axis default `2` and source→target bake call.
- `repos/assimpjs/assimp/code/Common/UnitAxisContract.cpp` (lines 96–112) — `buildAxisRotationMatrix(1, 2)` matrix definition.
- Related: `docs/research/3mf-export-scale-orientation-manifold.md` §4 (Smoking Gun 2 — Coordinate System Drop) — the prior Replicad-only formulation of the same root cause; this audit extends it to OpenSCAD where the kernel-side asymmetry surfaces as a visible defect.
- Related: `docs/research/3mf-export-rendering-artifacts.md` — the follow-up investigation into Bambu Studio rendering artifacts (holes, missing fragments) on multi-mesh 3MF output. Resolved via `lib3mf` precision bump to 9 digits, `aiProcess_Triangulate | aiProcess_JoinIdenticalVertices` enforcement, and a `Lib3MFBridge` degenerate-face fix; ships in `taucad-assimpjs-0.0.18`.
