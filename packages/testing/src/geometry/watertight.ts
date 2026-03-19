import type { Document } from '@gltf-transform/core';

/** Epsilon for merging coincident vertices (in glTF meter-scale units). */
const spatialEpsilon = 0.001;

/**
 * Determines whether a mesh is watertight (manifold).
 *
 * A mesh is watertight when every triangle edge is shared by exactly two
 * triangles. Boundary edges (shared by only one triangle) indicate gaps
 * in the surface.
 *
 * @param document - A glTF-Transform Document
 * @returns `true` if the mesh is watertight, `false` otherwise
 * @public
 */
export const isWatertight = (document: Document): boolean => {
  const root = document.getRoot();
  const meshes = root.listMeshes();

  const allPositions: Array<[number, number, number]> = [];
  const allTriangles: Array<[number, number, number]> = [];
  let vertexOffset = 0;

  for (const mesh of meshes) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) {
        continue; // TRIANGLES only
      }

      const posAccessor = primitive.getAttribute('POSITION');
      const indexAccessor = primitive.getIndices();
      if (!posAccessor || !indexAccessor) {
        continue;
      }

      const vCount = posAccessor.getCount();
      const indexCount = indexAccessor.getCount();

      for (let i = 0; i < vCount; i++) {
        allPositions.push(posAccessor.getElement(i, [0, 0, 0]));
      }

      for (let i = 0; i < indexCount; i += 3) {
        allTriangles.push([
          indexAccessor.getScalar(i) + vertexOffset,
          indexAccessor.getScalar(i + 1) + vertexOffset,
          indexAccessor.getScalar(i + 2) + vertexOffset,
        ]);
      }

      vertexOffset += vCount;
    }
  }

  if (allTriangles.length === 0) {
    return false;
  }

  // Spatial hashing: merge vertices within epsilon
  const gridSize = spatialEpsilon * 2;
  const positionToCanonical = new Map<string, number>();
  const vertexMap = new Int32Array(allPositions.length);

  for (const [i, position] of allPositions.entries()) {
    const [x, y, z] = position;
    const key = `${Math.round(x / gridSize)},${Math.round(y / gridSize)},${Math.round(z / gridSize)}`;

    const existing = positionToCanonical.get(key);
    if (existing === undefined) {
      positionToCanonical.set(key, i);
      vertexMap[i] = i;
    } else {
      vertexMap[i] = existing;
    }
  }

  // Build edge reference count map using canonical vertex indices
  const edgeCounts = new Map<string, number>();

  for (const tri of allTriangles) {
    const v0 = vertexMap[tri[0]]!;
    const v1 = vertexMap[tri[1]]!;
    const v2 = vertexMap[tri[2]]!;

    const edges: Array<[number, number]> = [
      [Math.min(v0, v1), Math.max(v0, v1)],
      [Math.min(v1, v2), Math.max(v1, v2)],
      [Math.min(v0, v2), Math.max(v0, v2)],
    ];

    for (const [a, b] of edges) {
      const key = `${a},${b}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  // Watertight iff every edge is shared by exactly 2 triangles
  for (const count of edgeCounts.values()) {
    if (count !== 2) {
      return false;
    }
  }

  return true;
};
