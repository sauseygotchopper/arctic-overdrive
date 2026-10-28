import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export function box(w: number, h: number, d: number, m: THREE.Material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
}

export function cyl(r: number, h: number, m: THREE.Material) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), m);
}

/** Position + orient a Y-aligned mesh of length `baseLen` to span a → b. */
export function orientBetween(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, baseLen = 1, radius = 0) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-5) return;
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.multiplyScalar(1 / len));
  const core = radius > 0 ? Math.max(0.01, len - radius) : len;
  mesh.scale.set(1, core / baseLen, 1);
}

/**
 * Extrude a side profile given as [z, y] points across the vehicle's width (X). `widthAt(z)` tapers
 * the width along the length (e.g. a narrowing hood).
 */
export function profileExtrude(pts: number[][], width: number, mat: THREE.Material, bevel: number, widthAt?: (z: number) => number) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 3,
    curveSegments: 6,
  });
  // shape X -> Z, extrude Z -> -X (a rotation, not a mirror, so face winding survives)
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const sz = pos.getX(i);
    const sy = pos.getY(i);
    let sx = (width - bevel * 2) / 2 - pos.getZ(i);
    if (widthAt) sx *= widthAt(sz);
    pos.setXYZ(i, sx, sy, sz);
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/** Ski with an upturned tip, length along +Z centred on 0. */
export function skiMesh(length: number, width: number, mat: THREE.Material) {
  const h = length / 2;
  return profileExtrude(
    [[-h, 0], [h - 0.33, 0], [h - 0.13, 0.05], [h, 0.2], [h - 0.05, 0.22], [h - 0.17, 0.08], [h - 0.35, 0.04], [-h, 0.04]],
    width, mat, 0.01,
  );
}
