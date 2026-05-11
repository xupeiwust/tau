import type { ReactNode } from 'react';
import { useMemo } from 'react';
import * as THREE from 'three';
import { createPortal, useFrame } from '@react-three/fiber';

type SceneOverlayFrameLoopProps = Readonly<{
  overlayScene: THREE.Scene;
}>;

/**
 * Depth-restore + overlay render at R3F priority `2`.
 * Mounted only when the overlay subtree has geometry to draw so we do not hold a
 * positive-priority subscriber when overlay children are absent (fixes blank CAD when
 * both grid and axes are disabled — see audit R4).
 *
 * Assumes priority `1` has already drawn main-scene colour (`MainSceneFallback` /
 * EffectComposer / `PostProcessingWebGPU`). Performs a lightweight depth-only override
 * pass on the root scene before compositing overlay geometry.
 */
function SceneOverlayFrameLoop({ overlayScene }: SceneOverlayFrameLoopProps): ReactNode {
  const depthOnlyMaterial = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial();
    mat.colorWrite = false;
    return mat;
  }, []);

  useFrame((state) => {
    const { gl, scene, camera } = state;
    const previousAutoClear = gl.autoClear;
    gl.autoClear = false;

    const previousOverrideMaterial = scene.overrideMaterial;
    scene.overrideMaterial = depthOnlyMaterial;
    gl.render(scene, camera);
    scene.overrideMaterial = previousOverrideMaterial;

    gl.render(overlayScene, camera);

    gl.autoClear = previousAutoClear;
  }, 2);

  return null;
}

type SceneOverlayProperties = Readonly<{
  children: ReactNode;
  /**
   * When `false`, omit the priority-2 overlay subscriber entirely. Grid/axes overlays are
   * skipped while the canvas still renders the main scene via priority-**1**
   * (`MainSceneFallback` vs post-processing when enabled).
   */
  overlayActive: boolean;
}>;

/**
 * Renders children in a separate THREE.Scene composited above the viewport output.
 *
 * Keeps overlays (Grid, AxesHelper) outside N8AO / GTAO stacks so ambient occlusion does
 * not darken them.
 *
 * When {@link SceneOverlayProperties.overlayActive} is `true`, registers at R3F
 * **`renderPriority = 2`**, after priority-**1** main-scene shading
 * (`MainSceneFallback` vs **EffectComposer** / **`PostProcessingWebGPU`** — always exactly one
 * subscriber from the **`PostProcessing`** component). Viewport gizmos overlay at
 * priority **3**.
 *
 * `frameloop` / demand-render conventions for the parent `<Canvas>` are policy-bound in
 * **`docs/policy/graphics-backend-policy.md`** §7.
 */
export function SceneOverlay({ children, overlayActive }: SceneOverlayProperties): React.JSX.Element {
  const overlayScene = useMemo(() => new THREE.Scene(), []);

  return (
    <>
      {createPortal(children, overlayScene)}
      {overlayActive ? <SceneOverlayFrameLoop overlayScene={overlayScene} /> : null}
    </>
  );
}
