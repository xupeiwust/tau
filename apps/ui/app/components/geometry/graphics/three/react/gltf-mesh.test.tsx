import type { MockInstance } from 'vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Group, Mesh, BufferGeometry, MeshBasicMaterial } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { warnIfEmptyGltfScene } from '#components/geometry/graphics/three/react/gltf-mesh.js';

const createGltfWithChildren = (childCount: number): GLTF => {
  const scene = new Group();
  for (let i = 0; i < childCount; i++) {
    scene.add(new Mesh(new BufferGeometry(), new MeshBasicMaterial()));
  }
  // GLTF has many other fields the loader populates, but warnIfEmptyGltfScene
  // only inspects `scene` so a partial cast is the minimum surface.
  const gltf: Pick<GLTF, 'scene'> = { scene };
  return gltf as GLTF;
};

const noop = (): void => {
  /* No-op console.warn replacement */
};

describe('warnIfEmptyGltfScene (R6 OCJS smoke trail)', () => {
  let warnSpy: MockInstance<typeof console.warn> | undefined;

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  it('should warn with byteLength + childrenCount + bbox when GLTFLoader produces a scene with zero children', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    const gltf = createGltfWithChildren(0);

    warnIfEmptyGltfScene(gltf, 1234);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0]!;
    const message = call[0] as string;
    const payload = call[1] as Record<string, unknown>;
    expect(message).toBe('GLTFLoader produced a scene with zero children');
    expect(payload).toMatchObject({
      byteLength: 1234,
      childrenCount: 0,
      bbox: expect.objectContaining({
        min: expect.any(Object) as unknown,
        max: expect.any(Object) as unknown,
        finite: false,
      }) as unknown,
    });
  });

  it('should remain silent on the happy path when the scene has at least one child', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    const gltf = createGltfWithChildren(1);

    warnIfEmptyGltfScene(gltf, 8888);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should remain silent on multi-child scenes regardless of byteLength', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    const gltf = createGltfWithChildren(5);

    warnIfEmptyGltfScene(gltf, 0);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
