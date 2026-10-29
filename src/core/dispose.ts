import * as THREE from 'three';

/** Free the GPU resources (geometries, materials, their textures) of everything under `root`, and detach it. */
export function disposeObject(root: THREE.Object3D) {
  root.removeFromParent();
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.geometry) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat) mats.add(mat);
  });
  for (const mat of mats) {
    for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
    mat.dispose();
  }
}
