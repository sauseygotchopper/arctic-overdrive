import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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

// ---------- lofted hulls ----------

/**
 * One cross-section of a mirrored body, a superellipse in X/Y at a given Z. The widest point (half
 * width `w`) sits at height `ym`; `n`/`nb` shape the upper/lower halves (2 = ellipse, higher =
 * boxier); `ridge` lifts the centreline into a creased, arrowhead crown.
 */
export interface Section { z: number; yt: number; yb: number; w: number; ym?: number; n?: number; nb?: number; ridge?: number }
type FullSection = Required<Section>;
const SECTION_KEYS = ['yt', 'yb', 'w', 'ym', 'n', 'nb', 'ridge'] as const;

export interface SkinOptions {
  /** Part of the contour to skin: 0 = bottom centre, 1 = top centre. May vary along Z. */
  from?: number | ((z: number) => number);
  to?: number | ((z: number) => number);
  z0?: number;
  z1?: number;
  /** Push the skin out from the hull (decals, lenses, trim on top of the body). */
  inflate?: number;
  /** Only one side (+1 = +X); default both. */
  side?: 1 | -1;
  ring?: number;
  dz?: number;
  /** UVs: raw (z, y), or normalised to a [z0, z1, y0, y1] box and flipped on +X so decals read. */
  uvBox?: [number, number, number, number];
}

/** A smooth body lofted through sections (sorted by z) with monotone Hermite interpolation. */
export class Hull {
  private s: FullSection[];
  private slope: Record<(typeof SECTION_KEYS)[number], number[]>;

  constructor(sections: Section[]) {
    this.s = sections.map((s) => ({ z: s.z, yt: s.yt, yb: s.yb, w: s.w, ym: s.ym ?? (s.yt + s.yb) / 2, n: s.n ?? 2.5, nb: s.nb ?? s.n ?? 2.5, ridge: s.ridge ?? 0 }));
    const n = this.s.length;
    this.slope = {} as typeof this.slope;
    for (const k of SECTION_KEYS) {
      const d: number[] = [];
      for (let i = 0; i < n - 1; i++) d.push((this.s[i + 1][k] - this.s[i][k]) / (this.s[i + 1].z - this.s[i].z));
      this.slope[k] = this.s.map((_, i) => {
        if (i === 0) return d[0];
        if (i === n - 1) return d[n - 2];
        return d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
      });
    }
  }

  get zMin() { return this.s[0].z; }
  get zMax() { return this.s[this.s.length - 1].z; }

  at(z: number): FullSection {
    const s = this.s;
    z = THREE.MathUtils.clamp(z, s[0].z, s[s.length - 1].z);
    let i = 0;
    while (i < s.length - 2 && z > s[i + 1].z) i++;
    const a = s[i], b = s[i + 1], h = b.z - a.z, t = (z - a.z) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    const out = { z } as FullSection;
    for (const k of SECTION_KEYS) out[k] = h00 * a[k] + h10 * h * this.slope[k][i] + h01 * b[k] + h11 * h * this.slope[k][i + 1];
    return out;
  }

  /** Surface point of a section at contour position t (0 bottom .. 1 top) on one side. */
  point(sec: FullSection, t: number, side: number, inflate = 0, out = new THREE.Vector3()) {
    const th = -Math.PI / 2 + t * Math.PI;
    const c = Math.max(0, Math.cos(th)), sn = Math.sin(th);
    const up = sn >= 0;
    const e = 2 / (up ? sec.n : sec.nb);
    const xn = Math.pow(c, e);
    const yn = Math.sign(sn) * Math.pow(Math.abs(sn), e);
    const y = up
      ? sec.ym + (sec.yt - sec.ym + inflate) * yn + sec.ridge * Math.pow(1 - xn, 1.5) * yn
      : sec.ym + (sec.ym - sec.yb + inflate) * yn;
    return out.set(side * (Math.max(0.001, sec.w) + inflate) * xn, y, sec.z);
  }

  /** Outward surface normal (approximate) at z / t on a side. */
  normal(z: number, t: number, side: number) {
    const e = 0.004;
    const p = (zz: number, tt: number) => this.point(this.at(zz), tt, side);
    const dz = p(z + e, t).sub(p(z - e, t));
    const dt = p(z, Math.min(1, t + e)).sub(p(z, Math.max(0, t - e)));
    const n = new THREE.Vector3().crossVectors(dt, dz).normalize();
    return side < 0 ? n.negate() : n;
  }

  skin(mat: THREE.Material, o: SkinOptions = {}): THREE.Mesh {
    const z0 = o.z0 ?? this.zMin, z1 = o.z1 ?? this.zMax;
    const fromF = typeof o.from === 'function' ? o.from : () => (o.from as number | undefined) ?? 0;
    const toF = typeof o.to === 'function' ? o.to : () => (o.to as number | undefined) ?? 1;
    const ring = o.ring ?? 12;
    const rows = Math.max(2, Math.ceil((z1 - z0) / (o.dz ?? 0.04)) + 1);
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const p = new THREE.Vector3();
    for (const side of o.side ? [o.side] : [1, -1]) {
      const base = pos.length / 3;
      for (let i = 0; i < rows; i++) {
        const z = z0 + ((z1 - z0) * i) / (rows - 1);
        const sec = this.at(z);
        const fa = fromF(z), fb = toF(z);
        for (let j = 0; j <= ring; j++) {
          this.point(sec, fa + ((fb - fa) * j) / ring, side, o.inflate ?? 0, p);
          pos.push(p.x, p.y, p.z);
          if (o.uvBox) {
            const [bz0, bz1, by0, by1] = o.uvBox;
            const u = (p.z - bz0) / (bz1 - bz0);
            uv.push(side > 0 ? 1 - u : u, (p.y - by0) / (by1 - by0));
          } else uv.push(p.z, p.y);
        }
      }
      for (let i = 0; i < rows - 1; i++) for (let j = 0; j < ring; j++) {
        const a = base + i * (ring + 1) + j, b = a + 1, c = a + ring + 1, d = c + 1;
        if (side > 0) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    // weld the centreline so the two halves shade as one surface
    if (!o.uvBox && !o.side) g = mergeVertices(g, 1e-4);
    g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }

  /** Flat cap closing the full contour at z, facing +Z (facing = 1) or -Z. */
  cap(z: number, mat: THREE.Material, facing: 1 | -1, ring = 14): THREE.Mesh {
    const sec = this.at(z);
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j <= ring; j++) pts.push(this.point(sec, j / ring, 1));
    for (let j = ring - 1; j >= 1; j--) pts.push(this.point(sec, j / ring, -1));
    const pos = [0, sec.ym, z];
    for (const q of pts) pos.push(q.x, q.y, q.z);
    const idx: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = 1 + k, b = 1 + ((k + 1) % pts.length);
      if (facing > 0) idx.push(0, a, b); else idx.push(0, b, a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }
}

/** Curved, raked windshield. `top(u)` scales the height across the width (u = -1..1). */
export function windshield(o: { z: number; y: number; halfW: number; height: number; rake: number; wrap: number; taper?: number; drop?: number; top?: (u: number) => number }, mat: THREE.Material) {
  const cols = 16, rowsN = 6;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const up = new THREE.Vector3(0, Math.cos(o.rake), -Math.sin(o.rake));
  for (let j = 0; j <= rowsN; j++) for (let i = 0; i <= cols; i++) {
    const u = (i / cols) * 2 - 1, v = j / rowsN;
    const h = o.height * (o.top ? o.top(u) : 1) * v;
    const x = u * o.halfW * (1 - (o.taper ?? 0.15) * v);
    const y = o.y - (o.drop ?? 0.06) * u * u + up.y * h;
    // bulges forward a little mid-height, wraps back at the sides
    const z = o.z - o.wrap * u * u + up.z * h + Math.sin(v * Math.PI) * 0.025;
    pos.push(x, y, z);
    uv.push(i / cols, v);
  }
  for (let j = 0; j < rowsN; j++) for (let i = 0; i < cols; i++) {
    const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const top: THREE.Vector3[] = [];
  for (let i = 0; i <= cols; i++) {
    const k = (cols + 1) * rowsN + i;
    top.push(new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]));
  }
  return { mesh: new THREE.Mesh(g, mat), topEdge: top };
}

/** Round tube through points (bumpers, bars, loops). */
export function tube(pts: THREE.Vector3[] | number[][], r: number, mat: THREE.Material, segs = 24, closed = false) {
  const v = pts.map((p) => (p instanceof THREE.Vector3 ? p : new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(v, closed, 'centripetal'), segs, r, 8, closed), mat);
}

/** Coil spring along +Y, unit length centred on 0 – scale Y to compress it (see orientBetween). */
export function coilGeometry(r: number, wire: number, turns: number) {
  const pts: THREE.Vector3[] = [];
  const n = turns * 12;
  for (let i = 0; i <= n; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, i / n - 0.5, Math.sin(a) * r));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, wire, 4, false);
}

/** Point a +Y-up object along a direction without scaling it. */
export function aim(obj: THREE.Object3D, dir: THREE.Vector3) {
  obj.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
}

/** Untextured, opaque standard materials can share a draw call by baking their colour into vertices. */
function plainKey(m: THREE.Material): string | null {
  const s = m as THREE.MeshStandardMaterial;
  if (s.type !== 'MeshStandardMaterial' || s.map || s.alphaMap || s.emissiveMap || s.transparent || s.alphaTest > 0) return null;
  if (s.emissive.getHex() !== 0 && s.emissiveIntensity > 0) return null;
  const rough = s.roughness < 0.25 ? 0 : s.roughness < 0.55 ? 1 : 2;
  return `${rough}:${s.metalness > 0.5 ? 1 : 0}:${s.side}`;
}

/**
 * Bake every mesh under `group` (except `keep` subtrees and instanced meshes) into one mesh per
 * material – plain-coloured materials collapse further into vertex-coloured batches – so a detailed
 * static assembly costs a handful of draw calls. Run before the first render.
 */
export function mergeStatic(group: THREE.Object3D, keep: THREE.Object3D[] = []): THREE.Mesh[] {
  const skip = new Set(keep);
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const batches = new Map<THREE.Material | string, { geos: THREE.BufferGeometry[]; mats: THREE.MeshStandardMaterial[] }>();
  const done: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    for (const c of o.children) {
      if (skip.has(c)) continue;
      const m = c as THREE.Mesh;
      if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(m.material)) {
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        g.morphAttributes = {};
        g.clearGroups();
        if (!g.attributes.normal) g.computeVertexNormals();
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        const plain = plainKey(m.material);
        if (plain) {
          const col = (m.material as THREE.MeshStandardMaterial).color;
          const n = g.attributes.position.count, arr = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
          g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
        }
        const key = plain ?? m.material;
        const b = batches.get(key) ?? { geos: [], mats: [] };
        b.geos.push(g);
        b.mats.push(m.material as THREE.MeshStandardMaterial);
        batches.set(key, b);
        done.push(m);
      }
      visit(c);
    }
  };
  visit(group);
  for (const m of done) m.removeFromParent();
  const out: THREE.Mesh[] = [];
  for (const [key, { geos, mats }] of batches) {
    let mat: THREE.Material;
    if (typeof key === 'string') {
      const avg = (f: (m: THREE.MeshStandardMaterial) => number) => mats.reduce((a, m) => a + f(m), 0) / mats.length;
      mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: avg((m) => m.roughness), metalness: avg((m) => m.metalness), side: mats[0].side });
    } else mat = key;
    const merged = new THREE.Mesh(mergeGeometries(geos), mat);
    for (const g of geos) g.dispose();
    group.add(merged);
    out.push(merged);
  }
  return out;
}
