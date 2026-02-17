import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  computeEnvironmentRotation,
  computeHeadlampTransform,
  applyLightingForCamera,
  findTaggedLights,
  defaultHeadlampConfig,
  ambientBaseIntensity,
  headlampBaseIntensity,
  environmentBaseIntensity,
  lightingUserDataKeys,
} from '#components/geometry/graphics/three/utils/lights.utils.js';
import type { HeadlampConfig, LightingConfig } from '#components/geometry/graphics/three/utils/lights.utils.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a PerspectiveCamera positioned along +Z looking at origin. */
function createTestCamera(fov = 54, distance = 10): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Creates a minimal Scene with environment rotation support. */
function createTestScene(): THREE.Scene {
  const scene = new THREE.Scene();
  return scene;
}

/** Creates the default lighting config used in most tests. */
function createDefaultLightingConfig(overrides?: Partial<LightingConfig>): LightingConfig {
  return {
    sceneRadius: 5,
    upDirection: 'z',
    headlampIntensity: headlampBaseIntensity,
    ambientIntensity: ambientBaseIntensity,
    environmentIntensity: environmentBaseIntensity,
    headlampConfig: defaultHeadlampConfig,
    ...overrides,
  };
}

// ── computeEnvironmentRotation ──────────────────────────────────────────────

/**
 * Builds an orbit-camera quaternion: Q_yaw(azimuth) * Q_pitch(polar).
 *
 * For Z-up the orbit is: rotate around Z by `azimuth`, then tilt around
 * the resulting local X by `polar`.
 */
function orbitQuaternion(azimuth: number, polar: number, up: 'x' | 'y' | 'z' = 'z'): THREE.Quaternion {
  const upAxis =
    up === 'z' ? new THREE.Vector3(0, 0, 1) : up === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);

  const pitchAxis =
    up === 'z' ? new THREE.Vector3(1, 0, 0) : up === 'y' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);

  const qYaw = new THREE.Quaternion().setFromAxisAngle(upAxis, azimuth);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(pitchAxis, polar);
  return qYaw.multiply(qPitch);
}

describe('computeEnvironmentRotation', () => {
  describe('identity camera', () => {
    it('should produce a near-zero Euler for an identity quaternion', () => {
      const identityQuat = new THREE.Quaternion(); // (0, 0, 0, 1)
      const euler = computeEnvironmentRotation(identityQuat, 'z');

      expect(euler.x).toBeCloseTo(0, 6);
      expect(euler.y).toBeCloseTo(0, 6);
      expect(euler.z).toBeCloseTo(0, 6);
    });
  });

  describe('euler order selection', () => {
    it('should use ZXY order for z-up', () => {
      const quat = new THREE.Quaternion();
      const euler = computeEnvironmentRotation(quat, 'z');
      expect(euler.order).toBe('ZXY');
    });

    it('should use YXZ order for y-up', () => {
      const quat = new THREE.Quaternion();
      const euler = computeEnvironmentRotation(quat, 'y');
      expect(euler.order).toBe('YXZ');
    });

    it('should use XZY order for x-up', () => {
      const quat = new THREE.Quaternion();
      const euler = computeEnvironmentRotation(quat, 'x');
      expect(euler.order).toBe('XZY');
    });
  });

  describe('azimuth-only extraction', () => {
    it('should produce a non-trivial Euler for a 90° rotation around Z', () => {
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const euler = computeEnvironmentRotation(quat, 'z');

      // Should extract the yaw = π/2 into the z component
      expect(euler.z).toBeCloseTo(Math.PI / 2, 4);
      // Other components should be zero (azimuth-only)
      expect(euler.x).toBeCloseTo(0, 6);
      expect(euler.y).toBeCloseTo(0, 6);
    });

    it('should extract correct yaw for each up direction', () => {
      const angle = Math.PI / 3;

      // Z-up: yaw around Z
      const qZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
      const eulerZ = computeEnvironmentRotation(qZ, 'z');
      expect(eulerZ.z).toBeCloseTo(angle, 4);
      expect(eulerZ.x).toBeCloseTo(0, 6);
      expect(eulerZ.y).toBeCloseTo(0, 6);

      // Y-up: yaw around Y
      const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      const eulerY = computeEnvironmentRotation(qY, 'y');
      expect(eulerY.y).toBeCloseTo(angle, 4);
      expect(eulerY.x).toBeCloseTo(0, 6);
      expect(eulerY.z).toBeCloseTo(0, 6);

      // X-up: yaw around X
      const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
      const eulerX = computeEnvironmentRotation(qX, 'x');
      expect(eulerX.x).toBeCloseTo(angle, 4);
      expect(eulerX.y).toBeCloseTo(0, 6);
      expect(eulerX.z).toBeCloseTo(0, 6);
    });

    it('should only populate the up-axis Euler component (pitch/roll zeroed)', () => {
      // Combined yaw + pitch rotation — only yaw should survive
      const quat = orbitQuaternion(Math.PI / 4, Math.PI / 6, 'z');
      const euler = computeEnvironmentRotation(quat, 'z');

      // Z should reflect the azimuth
      expect(euler.z).toBeCloseTo(Math.PI / 4, 4);
      // X and y must be zero (pitch not tracked)
      expect(euler.x).toBeCloseTo(0, 6);
      expect(euler.y).toBeCloseTo(0, 6);
    });
  });

  describe('polar-angle independence', () => {
    it('should return the same rotation regardless of polar angle (z-up)', () => {
      const azimuth = Math.PI / 4;
      const polarAngles = [
        0,
        Math.PI / 6,
        Math.PI / 4,
        Math.PI / 3,
        Math.PI / 2 - 0.01,
        Math.PI / 2,
        Math.PI / 2 + 0.01,
        (2 * Math.PI) / 3,
        (5 * Math.PI) / 6,
      ];

      const results = polarAngles.map((polar) => {
        const quat = orbitQuaternion(azimuth, polar, 'z');
        return computeEnvironmentRotation(quat, 'z');
      });

      for (const euler of results) {
        expect(euler.z).toBeCloseTo(azimuth, 4);
        expect(euler.x).toBeCloseTo(0, 6);
        expect(euler.y).toBeCloseTo(0, 6);
      }
    });

    it('should return the same rotation regardless of polar angle (y-up)', () => {
      const azimuth = -Math.PI / 3;
      const polarAngles = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4];

      const results = polarAngles.map((polar) => {
        const quat = orbitQuaternion(azimuth, polar, 'y');
        return computeEnvironmentRotation(quat, 'y');
      });

      for (const euler of results) {
        expect(euler.y).toBeCloseTo(azimuth, 4);
        expect(euler.x).toBeCloseTo(0, 6);
        expect(euler.z).toBeCloseTo(0, 6);
      }
    });
  });

  describe('continuity across equatorial plane (no lighting hop)', () => {
    it('should be continuous when sweeping polar angle through 90° (z-up)', () => {
      const azimuth = Math.PI / 3;
      // Dense sweep through the equatorial singularity at polar = π/2
      const steps = 100;
      const polarStart = Math.PI / 4;
      const polarEnd = (3 * Math.PI) / 4;

      let previousZ: number | undefined;
      for (let index = 0; index <= steps; index++) {
        const polar = polarStart + (index / steps) * (polarEnd - polarStart);
        const quat = orbitQuaternion(azimuth, polar, 'z');
        const euler = computeEnvironmentRotation(quat, 'z');

        if (previousZ !== undefined) {
          // Step-to-step change must be small — a hop would produce a ~π jump
          const delta = Math.abs(euler.z - previousZ);
          expect(delta).toBeLessThan(0.1);
        }

        previousZ = euler.z;
      }
    });

    it('should be continuous when sweeping polar angle through 90° (y-up)', () => {
      const azimuth = -Math.PI / 6;
      const steps = 100;
      const polarStart = Math.PI / 4;
      const polarEnd = (3 * Math.PI) / 4;

      let previousY: number | undefined;
      for (let index = 0; index <= steps; index++) {
        const polar = polarStart + (index / steps) * (polarEnd - polarStart);
        const quat = orbitQuaternion(azimuth, polar, 'y');
        const euler = computeEnvironmentRotation(quat, 'y');

        if (previousY !== undefined) {
          const delta = Math.abs(euler.y - previousY);
          expect(delta).toBeLessThan(0.1);
        }

        previousY = euler.y;
      }
    });
  });

  describe('full azimuth sweep is continuous', () => {
    it('should have no jumps across the full 0→2π azimuth range', () => {
      const polar = Math.PI / 3;
      const steps = 360;

      let previousZ: number | undefined;
      for (let index = 0; index <= steps; index++) {
        const azimuth = (index / steps) * 2 * Math.PI - Math.PI; // −π → +π
        const quat = orbitQuaternion(azimuth, polar, 'z');
        const euler = computeEnvironmentRotation(quat, 'z');

        if (previousZ !== undefined) {
          // Allow wrapping at ±π (which is visually seamless since
          // sin/cos are 2π-periodic). The raw angular step is ~0.017 rad;
          // a true discontinuity would be ≫ 0.1 rad even after unwrap.
          let delta = Math.abs(euler.z - previousZ);
          if (delta > Math.PI) {
            delta = 2 * Math.PI - delta;
          }

          expect(delta).toBeLessThan(0.1);
        }

        previousZ = euler.z;
      }
    });
  });

  describe('degenerate case', () => {
    it('should return identity when camera points exactly along up axis (z-up)', () => {
      // 180° around Y: q = (0, 1, 0, 0). Both q.z and q.w are 0 so the
      // twist around Z is degenerate (azimuth undefined). Should fall back
      // to identity.
      const degenerate = new THREE.Quaternion(0, 1, 0, 0);
      const euler = computeEnvironmentRotation(degenerate, 'z');

      expect(euler.x).toBeCloseTo(0, 6);
      expect(euler.y).toBeCloseTo(0, 6);
      expect(euler.z).toBeCloseTo(0, 6);
    });
  });

  describe('does not mutate input', () => {
    it('should not modify the input quaternion', () => {
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
      const originalW = quat.w;
      const originalX = quat.x;
      const originalY = quat.y;
      const originalZ = quat.z;

      computeEnvironmentRotation(quat, 'z');

      expect(quat.x).toBe(originalX);
      expect(quat.y).toBe(originalY);
      expect(quat.z).toBe(originalZ);
      expect(quat.w).toBe(originalW);
    });
  });
});

// ── computeHeadlampTransform ────────────────────────────────────────────────

describe('computeHeadlampTransform', () => {
  describe('identity camera matrix', () => {
    it('should offset position in camera-up (+Y) and camera-right (+X) directions', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 10);
      const cameraMatrix = new THREE.Matrix4().identity();
      const radius = 5;

      const { position } = computeHeadlampTransform(cameraPosition, cameraMatrix, radius, defaultHeadlampConfig);

      // With identity matrix:
      // camera-right = column 0 = (1,0,0)
      // camera-up = column 1 = (0,1,0)
      // Expected position: (0,0,10) + (0,1,0) * 5 * 2.1 + (1,0,0) * 5 * -0.1
      const expectedX = 0 + radius * defaultHeadlampConfig.rightOffset;
      const expectedY = 0 + radius * defaultHeadlampConfig.upOffset;
      const expectedZ = 10;

      expect(position.x).toBeCloseTo(expectedX, 6);
      expect(position.y).toBeCloseTo(expectedY, 6);
      expect(position.z).toBeCloseTo(expectedZ, 6);
    });

    it('should place the target forward of camera with skew offsets', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 10);
      const cameraMatrix = new THREE.Matrix4().identity();
      const radius = 5;

      const { targetPosition } = computeHeadlampTransform(cameraPosition, cameraMatrix, radius, defaultHeadlampConfig);

      // With identity matrix:
      // camera-forward = -column2 = (0,0,-1) negated = (0,0,1)... actually
      // column 2 of identity = (0,0,1), negated = (0,0,-1)
      // forward direction = -column2 = (0,0,-1)
      // target = camera_pos + forward * radius * 2 + right * (-radius * skew) + up * (-radius * skew)
      const expectedZ = 10 + -1 * radius * 2;
      const expectedX = 0 + -radius * defaultHeadlampConfig.targetRightSkew;
      const expectedY = 0 + -radius * defaultHeadlampConfig.targetUpSkew;

      expect(targetPosition.x).toBeCloseTo(expectedX, 6);
      expect(targetPosition.y).toBeCloseTo(expectedY, 6);
      expect(targetPosition.z).toBeCloseTo(expectedZ, 6);
    });
  });

  describe('scaling with sceneRadius', () => {
    it('should produce proportionally larger offsets with larger radius', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 10);
      const cameraMatrix = new THREE.Matrix4().identity();

      const small = computeHeadlampTransform(cameraPosition, cameraMatrix, 1, defaultHeadlampConfig);
      const large = computeHeadlampTransform(cameraPosition, cameraMatrix, 10, defaultHeadlampConfig);

      // The offset from camera position should be 10x larger
      const smallOffset = small.position.clone().sub(cameraPosition);
      const largeOffset = large.position.clone().sub(cameraPosition);

      expect(largeOffset.length()).toBeCloseTo(smallOffset.length() * 10, 4);
    });
  });

  describe('custom config', () => {
    it('should respect custom offset values', () => {
      const cameraPosition = new THREE.Vector3(0, 0, 0);
      const cameraMatrix = new THREE.Matrix4().identity();
      const radius = 1;
      const config: HeadlampConfig = {
        rightOffset: 1,
        upOffset: 1,
        targetRightSkew: 0,
        targetUpSkew: 0,
      };

      const { position } = computeHeadlampTransform(cameraPosition, cameraMatrix, radius, config);

      // Camera-right = (1,0,0), camera-up = (0,1,0)
      // position = (0,0,0) + (0,1,0)*1*1 + (1,0,0)*1*1 = (1, 1, 0)
      expect(position.x).toBeCloseTo(1, 6);
      expect(position.y).toBeCloseTo(1, 6);
      expect(position.z).toBeCloseTo(0, 6);
    });
  });

  describe('does not mutate input', () => {
    it('should not modify the input camera position', () => {
      const cameraPosition = new THREE.Vector3(1, 2, 3);
      const originalX = cameraPosition.x;
      const originalY = cameraPosition.y;
      const originalZ = cameraPosition.z;
      const cameraMatrix = new THREE.Matrix4().identity();

      computeHeadlampTransform(cameraPosition, cameraMatrix, 5, defaultHeadlampConfig);

      expect(cameraPosition.x).toBe(originalX);
      expect(cameraPosition.y).toBe(originalY);
      expect(cameraPosition.z).toBe(originalZ);
    });
  });
});

// ── applyLightingForCamera ──────────────────────────────────────────────────

describe('applyLightingForCamera', () => {
  describe('environment rotation', () => {
    it('should set scene.environmentRotation based on camera orientation', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });

      // EnvironmentRotation should have been set (not identity if camera is looking at origin from +Z)
      const euler = scene.environmentRotation;
      expect(euler).toBeDefined();
      // The Euler order should match z-up
      expect(euler.order).toBe('ZXY');
    });
  });

  describe('environment intensity', () => {
    it('should set scene.environmentIntensity using FOV compensation', () => {
      const scene = createTestScene();
      const camera = createTestCamera(54); // Reference FOV
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });

      // At reference FOV (54), envFactor ≈ 1.0, so intensity ≈ base
      expect(scene.environmentIntensity).toBeCloseTo(environmentBaseIntensity, 2);
    });

    it('should reduce environment intensity at low FOV', () => {
      const scene = createTestScene();
      const camera = createTestCamera(10); // Low FOV
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });

      expect(scene.environmentIntensity).toBeLessThan(environmentBaseIntensity);
    });
  });

  describe('headlamp positioning', () => {
    it('should update headlamp position and intensity when provided', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const headlamp = new THREE.DirectionalLight('white', 1);
      scene.add(headlamp);
      scene.add(headlamp.target);
      const config = createDefaultLightingConfig();

      const originalPosition = headlamp.position.clone();

      applyLightingForCamera({ scene, camera, headlamp, ambient: undefined, config });

      // Position should have changed
      expect(headlamp.position.equals(originalPosition)).toBe(false);
      // Intensity should be set (at reference FOV, headlampFactor ≈ 1.0)
      expect(headlamp.intensity).toBeCloseTo(headlampBaseIntensity, 2);
    });

    it('should not throw when headlamp is undefined', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const config = createDefaultLightingConfig();

      expect(() => {
        applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });
      }).not.toThrow();
    });
  });

  describe('ambient light', () => {
    it('should update ambient intensity with FOV compensation when provided', () => {
      const scene = createTestScene();
      const camera = createTestCamera(54); // Reference FOV
      const ambient = new THREE.AmbientLight('white', 1);
      scene.add(ambient);
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient, config });

      // At reference FOV, ambientFactor ≈ 1.0
      expect(ambient.intensity).toBeCloseTo(ambientBaseIntensity, 2);
    });

    it('should boost ambient intensity at low FOV', () => {
      const scene = createTestScene();
      const camera = createTestCamera(10); // Low FOV
      const ambient = new THREE.AmbientLight('white', 1);
      scene.add(ambient);
      const config = createDefaultLightingConfig();

      applyLightingForCamera({ scene, camera, headlamp: undefined, ambient, config });

      // At low FOV, ambientFactor > 1.0
      expect(ambient.intensity).toBeGreaterThan(ambientBaseIntensity);
    });

    it('should not throw when ambient is undefined', () => {
      const scene = createTestScene();
      const camera = createTestCamera();
      const config = createDefaultLightingConfig();

      expect(() => {
        applyLightingForCamera({ scene, camera, headlamp: undefined, ambient: undefined, config });
      }).not.toThrow();
    });
  });

  describe('consistency across camera angles', () => {
    it('should produce different environment rotations for different azimuthal positions', () => {
      const scene1 = createTestScene();
      const scene2 = createTestScene();
      const config = createDefaultLightingConfig();

      // Camera 1: azimuth 0°, polar 45°
      const camera1 = createTestCamera();
      camera1.quaternion.copy(orbitQuaternion(0, Math.PI / 4, 'z'));
      camera1.updateMatrixWorld(true);

      // Camera 2: azimuth 90°, polar 45°
      const camera2 = createTestCamera();
      camera2.quaternion.copy(orbitQuaternion(Math.PI / 2, Math.PI / 4, 'z'));
      camera2.updateMatrixWorld(true);

      applyLightingForCamera({ scene: scene1, camera: camera1, headlamp: undefined, ambient: undefined, config });
      applyLightingForCamera({ scene: scene2, camera: camera2, headlamp: undefined, ambient: undefined, config });

      // Different azimuths should produce different environment rotations
      const rot1 = scene1.environmentRotation;
      const rot2 = scene2.environmentRotation;
      const isIdentical =
        Math.abs(rot1.x - rot2.x) < 1e-6 && Math.abs(rot1.y - rot2.y) < 1e-6 && Math.abs(rot1.z - rot2.z) < 1e-6;
      expect(isIdentical).toBe(false);
    });
  });
});

// ── findTaggedLights ────────────────────────────────────────────────────────

describe('findTaggedLights', () => {
  it('should find tagged headlamp and ambient light in a scene', () => {
    const scene = createTestScene();
    const headlamp = new THREE.DirectionalLight('white', 1);
    headlamp.userData[lightingUserDataKeys.headlamp] = true;
    const ambient = new THREE.AmbientLight('white', 1);
    ambient.userData[lightingUserDataKeys.ambient] = true;
    scene.add(headlamp);
    scene.add(ambient);

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBe(headlamp);
    expect(result.ambient).toBe(ambient);
  });

  it('should return undefined for missing lights', () => {
    const scene = createTestScene();

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBeUndefined();
    expect(result.ambient).toBeUndefined();
  });

  it('should find lights nested in groups', () => {
    const scene = createTestScene();
    const group = new THREE.Group();
    const headlamp = new THREE.DirectionalLight('white', 1);
    headlamp.userData[lightingUserDataKeys.headlamp] = true;
    group.add(headlamp);
    scene.add(group);

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBe(headlamp);
  });

  it('should not return untagged lights', () => {
    const scene = createTestScene();
    const untaggedLight = new THREE.DirectionalLight('white', 1);
    scene.add(untaggedLight);

    const result = findTaggedLights(scene);

    expect(result.headlamp).toBeUndefined();
    expect(result.ambient).toBeUndefined();
  });
});
