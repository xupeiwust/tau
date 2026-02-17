/**
 * Pure lighting utilities extracted from the Lights component.
 *
 * These functions encapsulate the per-frame camera-relative lighting logic so
 * that both the live renderer (via `useFrame`) and the offline screenshot
 * renderer can apply identical lighting for any camera orientation.
 */

import * as THREE from 'three';
import { calculateFovLightingCompensation } from '#components/geometry/graphics/three/utils/math.utils.js';

// ── Lighting constants ─────────────────────────────────────────────────────
// Exported so that both the Lights component and the screenshot capture
// system reference the same tuning values.

/** Ambient fill -- provides base illumination floor so no surface is fully dark. */
export const ambientBaseIntensity = 0.05;

/**
 * Camera-relative headlamp base intensity.
 *
 * Reduced from 0.5 since the camera-relative environment now provides
 * directional variation. The headlamp is retained primarily as part of
 * the FOV diffuse compensation system (its intensity is boosted at low FOV).
 */
export const headlampBaseIntensity = 0.8;

/**
 * Scene-level environment intensity (base value) -- the primary illumination
 * source. This base value is scaled per-frame by the FOV compensation factor.
 */
export const environmentBaseIntensity = 0.9;

// ── Headlamp configuration ─────────────────────────────────────────────────

export type HeadlampConfig = {
  /** Camera-right offset (multiplier of sceneRadius). */
  rightOffset: number;
  /** Camera-up offset (multiplier of sceneRadius). */
  upOffset: number;
  /** Target camera-right skew (multiplier of sceneRadius). */
  targetRightSkew: number;
  /** Target camera-up skew (multiplier of sceneRadius). */
  targetUpSkew: number;
};

/** Default headlamp offset configuration matching the studio lighting rig. */
export const defaultHeadlampConfig: HeadlampConfig = {
  rightOffset: -0.1,
  upOffset: 2.1,
  targetRightSkew: 0.2,
  targetUpSkew: 0.1,
};

// ── userData tag constants ─────────────────────────────────────────────────
// Used to identify lights in a cloned scene for screenshot rendering.

export const lightingUserDataKeys = {
  headlamp: 'isScreenshotHeadlamp',
  ambient: 'isScreenshotAmbient',
  config: 'lightingConfig',
} as const;

// ── Lighting config stored on scene.userData ───────────────────────────────

export type SceneLightingConfig = {
  sceneRadius: number;
  upDirection: 'x' | 'y' | 'z';
};

// ── Combined config for applyLightingForCamera ─────────────────────────────

export type LightingConfig = {
  sceneRadius: number;
  upDirection: 'x' | 'y' | 'z';
  headlampIntensity: number;
  ambientIntensity: number;
  environmentIntensity: number;
  headlampConfig: HeadlampConfig;
};

// ── Pure functions ─────────────────────────────────────────────────────────

/**
 * Computes the environment rotation Euler that cancels only the azimuthal
 * (yaw) component of the camera's world orientation around the up axis.
 *
 * By not compensating for polar (pitch) or roll changes, the Lightformers
 * remain stable during horizontal orbit but shift relative to the camera
 * when tilting up/down — producing natural lighting variation at different
 * viewing elevations instead of a uniformly locked rig.
 *
 * Uses swing-twist quaternion decomposition to extract yaw. This avoids
 * the gimbal-lock discontinuity inherent in Euler decomposition, which
 * causes a 180° lighting hop when the camera crosses the equatorial plane
 * (polar angle ≈ 90°). The twist component around the up axis is simply
 * `normalize(0, …, axisComponent, …, w)` — continuous for all orientations.
 *
 * Three.js internally negates all Euler components of `environmentRotation`
 * (WebGLMaterials.js "accommodate left-handed frame"), so the returned yaw
 * angle is provided with the sign that compensates for this negation.
 *
 * @param cameraWorldQuaternion - The camera's world quaternion.
 * @param upDirection - The configured up axis ('x', 'y', or 'z').
 * @returns An Euler suitable for assigning to `scene.environmentRotation`.
 */
export function computeEnvironmentRotation(
  cameraWorldQuaternion: THREE.Quaternion,
  upDirection: 'x' | 'y' | 'z',
): THREE.Euler {
  const order: THREE.EulerOrder = upDirection === 'y' ? 'YXZ' : upDirection === 'z' ? 'ZXY' : 'XZY';

  // Swing-twist decomposition: extract the twist (yaw) around the up axis.
  // For quaternion Q = (x, y, z, w), the twist keeps only w and the
  // component aligned with the up axis, then normalises. The yaw angle
  // is 2·atan2(axisComponent, w), which is continuous everywhere (the only
  // degeneracy — both zero — occurs when the camera points exactly along
  // the up axis, where azimuth is genuinely undefined).
  const { x, y, z, w } = cameraWorldQuaternion;
  const axisComponent = upDirection === 'z' ? z : upDirection === 'y' ? y : x;

  // Degenerate: camera aligned exactly with the up axis (azimuth undefined)
  if (axisComponent * axisComponent + w * w < 1e-10) {
    return new THREE.Euler(0, 0, 0, order);
  }

  // Yaw angle from the twist quaternion.
  // Providing +yaw to environmentRotation means Three.js applies −yaw
  // (its internal negation), which undoes the camera's azimuthal turn.
  const yaw = 2 * Math.atan2(axisComponent, w);

  if (upDirection === 'z') {
    return new THREE.Euler(0, 0, yaw, order);
  }

  if (upDirection === 'y') {
    return new THREE.Euler(0, yaw, 0, order);
  }

  // UpDirection === 'x'
  return new THREE.Euler(yaw, 0, 0, order);
}

/**
 * Computes the world-space position and target for a camera-relative
 * directional headlamp.
 *
 * The headlamp is offset in camera-up and camera-right directions so the
 * highlight remains biased toward screen upper-right. The target is placed
 * forward of the camera with slight lower-left skew.
 *
 * @param cameraPosition - The camera's world position.
 * @param cameraMatrixWorld - The camera's world matrix (used for basis vectors).
 * @param sceneRadius - The bounding sphere radius of the scene.
 * @param config - Offset multipliers for headlamp placement.
 * @returns The world-space position and target position for the headlamp.
 */
export function computeHeadlampTransform(
  cameraPosition: THREE.Vector3,
  cameraMatrixWorld: THREE.Matrix4,
  sceneRadius: number,
  config: HeadlampConfig,
): { position: THREE.Vector3; targetPosition: THREE.Vector3 } {
  // Camera basis vectors in world space:
  // - column 0: camera-right (+X local)
  // - column 1: camera-up (+Y local)
  const cameraRight = new THREE.Vector3().setFromMatrixColumn(cameraMatrixWorld, 0).normalize();
  const cameraUp = new THREE.Vector3().setFromMatrixColumn(cameraMatrixWorld, 1).normalize();

  // Position: camera + up offset + right offset
  const position = cameraPosition.clone();
  position.addScaledVector(cameraUp, sceneRadius * config.upOffset);
  position.addScaledVector(cameraRight, sceneRadius * config.rightOffset);

  // Camera forward direction
  const cameraForward = new THREE.Vector3();
  // Extract forward from the matrix column instead of calling getWorldDirection
  // so this function remains standalone (no camera method dependency).
  cameraForward.setFromMatrixColumn(cameraMatrixWorld, 2).normalize().negate();

  // Target: forward of camera with skew offsets
  const targetPosition = cameraPosition.clone();
  targetPosition.addScaledVector(cameraForward, sceneRadius * 2);
  targetPosition.addScaledVector(cameraRight, -sceneRadius * config.targetRightSkew);
  targetPosition.addScaledVector(cameraUp, -sceneRadius * config.targetUpSkew);

  return { position, targetPosition };
}

// ── applyLightingForCamera options ──────────────────────────────────────────

export type ApplyLightingOptions = {
  /** The THREE.Scene to update. */
  scene: THREE.Scene;
  /** The camera whose orientation drives lighting. */
  camera: THREE.Camera;
  /** Optional directional light to position as headlamp. */
  headlamp: THREE.DirectionalLight | undefined;
  /** Optional ambient light whose intensity to compensate. */
  ambient: THREE.AmbientLight | undefined;
  /** Lighting configuration with base intensities and offsets. */
  config: LightingConfig;
};

/**
 * Applies camera-relative lighting to a scene for the given camera.
 *
 * This function is the single source of truth for per-camera lighting setup.
 * It is called by:
 * - The `Lights` component's `useFrame` callback (live rendering)
 * - The `captureScreenshots` function (offline screenshot rendering)
 *
 * It performs:
 * 1. FOV-dependent intensity compensation
 * 2. Camera-locked environment rotation
 * 3. Headlamp positioning (if headlamp provided)
 * 4. Ambient intensity update (if ambient light provided)
 */
export function applyLightingForCamera({ scene, camera, headlamp, ambient, config }: ApplyLightingOptions): void {
  // FOV compensation
  const currentFov = (camera as THREE.PerspectiveCamera).fov;
  const compensation = calculateFovLightingCompensation(currentFov);

  // Environment intensity
  scene.environmentIntensity = config.environmentIntensity * compensation.envFactor;

  // Camera-locked environment rotation
  const quaternion = new THREE.Quaternion();
  camera.getWorldQuaternion(quaternion);
  const rotation = computeEnvironmentRotation(quaternion, config.upDirection);
  scene.environmentRotation.copy(rotation);

  // Ambient intensity with FOV compensation
  if (ambient) {
    ambient.intensity = config.ambientIntensity * compensation.ambientFactor;
  }

  // Headlamp positioning with FOV compensation
  if (headlamp) {
    headlamp.intensity = config.headlampIntensity * compensation.headlampFactor;

    const transform = computeHeadlampTransform(
      camera.position,
      camera.matrixWorld,
      config.sceneRadius,
      config.headlampConfig,
    );

    headlamp.position.copy(transform.position);
    headlamp.target.position.copy(transform.targetPosition);
    headlamp.target.updateMatrixWorld();
  }
}

/**
 * Discovers tagged lights in a scene graph by traversing and checking
 * `userData` markers. Used by the screenshot capture system to find the
 * headlamp and ambient light in a cloned scene.
 *
 * @param scene - The scene to search.
 * @returns The tagged headlamp and ambient light, or undefined if not found.
 */
export function findTaggedLights(scene: THREE.Scene): {
  headlamp: THREE.DirectionalLight | undefined;
  ambient: THREE.AmbientLight | undefined;
} {
  let headlamp: THREE.DirectionalLight | undefined;
  let ambient: THREE.AmbientLight | undefined;

  scene.traverse((object) => {
    if (object.userData[lightingUserDataKeys.headlamp]) {
      headlamp = object as THREE.DirectionalLight;
    }

    if (object.userData[lightingUserDataKeys.ambient]) {
      ambient = object as THREE.AmbientLight;
    }
  });

  return { headlamp, ambient };
}
