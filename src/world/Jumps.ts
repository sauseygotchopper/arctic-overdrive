import * as THREE from 'three';
import { TerrainData, TrailPath } from './TerrainData';

export interface JumpDef {
  trail: string;
  at: number; // 0..1 along the trail
  type: 'kicker' | 'tabletop' | 'rollers';
  height: number;
  width: number;
}

export interface JumpInfo {
  def: JumpDef;
  start: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
}

/** Packed-snow jumps built along trails. Geometry drapes over the terrain; physics uses the same mesh. */
export class Jumps {
  readonly group = new THREE.Group();
  readonly colliders: { vertices: Float32Array; indices: Uint32Array }[] = [];
  readonly list: JumpInfo[] = [];

  constructor(terrain: TerrainData, defs: JumpDef[]) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xe4eaf2, roughness: 0.75, envMapIntensity: 0.5 });
    const lipMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.6 });
    for (const d of defs) {
      const path = terrain.trailPaths.find((t) => t.id === d.trail);
      if (!path) continue;
      const prof = profileFor(d);
      const len = prof[prof.length - 1][0];
      const { pos, dir } = flattestNear(terrain, path, d.at, len, this.list.map((j) => j.start.clone().addScaledVector(j.dir, j.length / 2)));
      const { geo, vertices, indices } = buildRamp(terrain, pos, dir, prof, d.width);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.group.add(mesh);
      this.colliders.push({ vertices, indices });
      // orange marker flags at each kicker lip so jumps read from a distance
      const lipZ = lipOf(d);
      for (const s of [-1, 1]) {
        const right = new THREE.Vector3(dir.z, 0, -dir.x);
        const p = pos.clone().addScaledVector(dir, lipZ).addScaledVector(right, s * (d.width / 2 + 0.4));
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.6, 6), lipMat);
        pole.position.set(p.x, terrain.heightAt(p.x, p.z) + profileY(prof, lipZ) + 0.8, p.z);
        this.group.add(pole);
      }
      this.list.push({ def: d, start: pos, dir, length: prof[prof.length - 1][0] });
    }
  }
}

function pointAlong(path: TrailPath, frac: number) {
  const pts = path.pts;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  let target = total * frac;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (target <= seg || i === pts.length - 1) {
      const t = Math.min(1, target / seg);
      const pos = new THREE.Vector3(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, 0, pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t);
      const a = pts[Math.max(0, i - 3)], b = pts[Math.min(pts.length - 1, i + 3)];
      const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
      return { pos, dir };
    }
    target -= seg;
  }
  return { pos: new THREE.Vector3(pts[0].x, 0, pts[0].z), dir: new THREE.Vector3(0, 0, 1) };
}

/**
 * Jumps want a flat approach and run-out: search a stretch of trail after `at` for the spot where
 * the ground is most level over approach + jump + landing.
 */
function flattestNear(terrain: TerrainData, path: TrailPath, at: number, length: number, taken: THREE.Vector3[]) {
  let best = pointAlong(path, at);
  let bestScore = Infinity;
  for (let k = 0; k <= 24; k++) {
    const cand = pointAlong(path, at + k * 0.004);
    const mid = cand.pos.clone().addScaledVector(cand.dir, length / 2);
    if (taken.some((t) => t.distanceTo(mid) < 80)) continue; // keep jumps well apart
    const h = (d: number) => terrain.heightAt(cand.pos.x + cand.dir.x * d, cand.pos.z + cand.dir.z * d);
    const grade = (Math.abs(h(0) - h(-35)) + Math.abs(h(length + 20) - h(0))) / (length + 55);
    const bump = Math.abs(h(length / 2) - (h(0) + h(length)) / 2) / length;
    const score = grade + bump;
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

/** [distance along, height above ground] samples. */
function profileFor(d: JumpDef): number[][] {
  const H = d.height;
  const out: number[][] = [];
  const ramp = (z0: number, len: number, h0: number, h1: number, exp: number, n = 10) => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push([z0 + t * len, h0 + (h1 - h0) * Math.pow(t, exp)]);
    }
  };
  if (d.type === 'kicker') {
    const L = H * 3.5;
    ramp(0, L, 0, H, 1.6); // ~25° lip
    out.push([L + 0.6, H * 0.85], [L + 0.6 + H * 0.9, 0]);
  } else if (d.type === 'tabletop') {
    const up = H * 4.2, top = 4 + H * 3.5, down = H * 4.5;
    ramp(0, up, 0, H, 1.5); // ~20° lip, long gentle landing
    out.push([up + top, H]);
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      out.push([up + top + t * down, H * (1 - (t * t * (3 - 2 * t)))]);
    }
  } else {
    const wl = 8;
    for (let i = 0; i <= 4 * 16; i++) {
      const z = (i / 16) * wl;
      out.push([z, H * 0.5 * (1 - Math.cos((z / wl) * Math.PI * 2))]);
    }
  }
  return out;
}

function lipOf(d: JumpDef): number {
  if (d.type === 'kicker') return d.height * 3.5;
  if (d.type === 'tabletop') return d.height * 4.2;
  return 4;
}

function profileY(prof: number[][], z: number): number {
  for (let i = 1; i < prof.length; i++) {
    if (prof[i][0] >= z) {
      const t = (z - prof[i - 1][0]) / Math.max(1e-6, prof[i][0] - prof[i - 1][0]);
      return prof[i - 1][1] + (prof[i][1] - prof[i - 1][1]) * t;
    }
  }
  return prof[prof.length - 1][1];
}

function buildRamp(terrain: TerrainData, origin: THREE.Vector3, dir: THREE.Vector3, prof: number[][], width: number) {
  const right = new THREE.Vector3(dir.z, 0, -dir.x);
  const verts: number[] = [];
  const idx: number[] = [];
  const at = (z: number, x: number, y: number) => {
    const wx = origin.x + dir.x * z + right.x * x;
    const wz = origin.z + dir.z * z + right.z * x;
    verts.push(wx, terrain.heightAt(wx, wz) + y, wz);
    return verts.length / 3 - 1;
  };
  const n = prof.length;
  const hw = width / 2;
  // top surface: left edge, right edge per sample; sides slope out to the ground (berm-like)
  const top: number[][] = [];
  for (const [z, y] of prof) top.push([at(z, -hw - 0.6, -0.15), at(z, -hw, y), at(z, hw, y), at(z, hw + 0.6, -0.15)]);
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < 3; k++) {
      const a = top[i][k], b = top[i][k + 1], c = top[i + 1][k], d = top[i + 1][k + 1];
      idx.push(a, c, b, b, c, d);
    }
  }
  const vertices = new Float32Array(verts);
  const indices = new Uint32Array(idx);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return { geo, vertices, indices };
}
