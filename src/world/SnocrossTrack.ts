import * as THREE from 'three';
import { TerrainData, VenueDef, catmullRom } from './TerrainData';
import { smoothstep } from './Noise';
import { Route } from '../modes/Route';
import { SpeedZone } from '../modes/ai/RouteFollower';
import { Checkpoints } from '../modes/Checkpoints';

interface Feature { kind: 'tabletop' | 'double' | 'whoops' | 'rhythm'; s0: number; length: number; maxKmh: number }

/** Centreline in venue-local metres (u along the venue, v across). A closed loop with an S-bend. */
const LAYOUT: [number, number][] = [
  [-62, -36], [-5, -38], [50, -36], [76, -24], [80, 0], [64, 16], [30, 17], [0, 16],
  [-16, 24], [-30, 38], [-50, 40], [-70, 38], [-84, 22], [-86, -2], [-80, -24],
];

/** Which layout stretch (control point indices) each feature sits on, its length and the AI's speed for it. */
const FEATURES: { kind: Feature['kind']; from: number; to: number; length: number; maxKmh: number }[] = [
  { kind: 'tabletop', from: 0, to: 2, length: 23, maxKmh: 52 },
  { kind: 'double', from: 5, to: 7, length: 27, maxKmh: 55 },
  { kind: 'rhythm', from: 9, to: 11, length: 30, maxKmh: 44 },
  { kind: 'whoops', from: 12, to: 14, length: 33, maxKmh: 55 },
];

/** Height profile (m) of a feature at distance x into it. */
function featureHeight(f: Feature, x: number): number {
  if (x < 0 || x > f.length) return 0;
  switch (f.kind) {
    case 'tabletop': { // 7 m up, 8 m table, 8 m down
      if (x < 7) return 1.7 * Math.pow(x / 7, 1.5);
      if (x < 15) return 1.7;
      return 1.7 * (1 - smoothstep(15, 23, x));
    }
    case 'double': { // kicker, 8 m gap, landing ramp
      if (x < 7) return 1.4 * Math.pow(x / 7, 1.6);
      if (x < 7.8) return 1.4 * (1 - (x - 7) / 0.8);
      if (x < 15.8) return 0;
      if (x < 19) return 1.3 * smoothstep(15.8, 19, x);
      return 1.3 * (1 - smoothstep(19, 27, x));
    }
    case 'whoops': // short bumps you skim across at speed
      return 0.38 * 0.5 * (1 - Math.cos((x / 5.5) * Math.PI * 2)) * smoothstep(0, 2, x) * smoothstep(f.length, f.length - 2, x);
    case 'rhythm': // three rollers
      return 0.8 * 0.5 * (1 - Math.cos((x / 10) * Math.PI * 2));
  }
}

/**
 * Frostpine Arena: a closed snocross track built into a venue pad. Banked berms come from the
 * centreline's curvature; jumps, whoops and a rhythm section are placed on the straights.
 * One trimesh covers the racing surface and the snow-bank walls that keep riders in.
 */
export class SnocrossTrack {
  readonly group = new THREE.Group();
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly route: Route;
  readonly zones: SpeedZone[] = [];
  readonly grid: { pos: THREE.Vector3; yaw: number }[] = [];
  /** Distance along the route of the start/finish line. */
  readonly startS: number;
  readonly gates: Checkpoints;
  private features: Feature[] = [];

  constructor(terrain: TerrainData, venue: VenueDef, readonly width: number) {
    const base = terrain.venueHeights[(terrain.def.venues ?? []).indexOf(venue)] + 0.05;
    // centreline, world space, ~1 m spacing
    const c = Math.cos(venue.rot), s = Math.sin(venue.rot);
    const toWorld = (u: number, v: number) => ({ x: venue.x + u * c - v * s, z: venue.z + u * s + v * c });
    const local = catmullRom([...LAYOUT, LAYOUT[0]], 1);
    local.pop(); // closed: last point repeats the first
    const pts = local.map((p) => toWorld(p.x, p.z));
    const n = pts.length;
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const L = cum[n - 1] + Math.hypot(pts[0].x - pts[n - 1].x, pts[0].z - pts[n - 1].z);
    const dirs = pts.map((_, i) => {
      const a = pts[(i - 2 + n) % n], b = pts[(i + 2) % n];
      return new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
    });
    // signed curvature (+ = turning left)
    const curv = dirs.map((_, i) => {
      const a = dirs[(i - 3 + n) % n], b = dirs[(i + 3) % n];
      return Math.atan2(a.x * b.y - a.y * b.x, a.dot(b)) / 6;
    });
    const smoothK = curv.map((_, i) => {
      let sum = 0;
      for (let k = -4; k <= 4; k++) sum += curv[(i + k + n) % n];
      return sum / 9;
    });

    // features are placed on stretches between layout control points (designed straights)
    const sAtPoint = LAYOUT.map(([u, v]) => {
      const w = toWorld(u, v);
      let bi = 0, bd = Infinity;
      pts.forEach((p, i) => { const d = (p.x - w.x) ** 2 + (p.z - w.z) ** 2; if (d < bd) { bd = d; bi = i; } });
      return cum[bi];
    });
    const span = (a: number, b: number) => { const s0 = sAtPoint[a]; let s1 = sAtPoint[b]; if (s1 < s0) s1 += L; return { s0, s1 }; };
    this.startS = sAtPoint[0] + 26;
    for (const f of FEATURES) {
      const { s0, s1 } = span(f.from, f.to);
      const start = Math.max(s0 + (f.kind === 'tabletop' ? 62 : 4), (s0 + s1) / 2 - f.length / 2);
      this.features.push({ kind: f.kind, s0: start % L, length: f.length, maxKmh: f.maxKmh });
    }
    for (const f of this.features) this.zones.push({ from: f.s0 - 6, to: f.s0 + f.length, maxKmh: f.maxKmh });

    const heightAtS = (sd: number) => {
      let h = 0;
      for (const f of this.features) {
        let x = sd - f.s0;
        if (x < -L / 2) x += L;
        if (x > L / 2) x -= L;
        h += featureHeight(f, x);
      }
      return h;
    };

    // ---- mesh: cross-sections across the track (w: -1 right edge .. +1 left edge) ----
    const hw = width / 2;
    const offsets = [-hw - 5.5, -hw - 2.4, -hw - 0.6, -hw, -hw / 2, 0, hw / 2, hw, hw + 0.6, hw + 2.4, hw + 5.5];
    const verts: number[] = [];
    const cols: number[] = [];
    const routePts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const d = dirs[i];
      const left = { x: -d.y, z: d.x };
      const h = heightAtS(cum[i]);
      const bank = Math.min(1, Math.abs(smoothK[i]) * 38); // berm strength in turns
      const outside = smoothK[i] > 0 ? -1 : 1; // turning left → outside is the right
      for (const o of offsets) {
        const w = THREE.MathUtils.clamp(o / hw, -1, 1);
        const out = Math.max(0, w * outside);
        const berm = bank * 2.3 * Math.pow(out, 1.4);
        let y = base + h + berm;
        const ao = Math.abs(o);
        if (ao > hw) {
          // snow bank: up to a crest ~1.5 m above the track edge, then down to the pad
          const edgeY = y;
          if (ao <= hw + 0.6) y = edgeY + 0.6;
          else if (ao <= hw + 2.4) y = edgeY + 1.5 + (o * outside > 0 ? bank * 0.8 : 0);
          else y = base - 0.3;
        }
        const wx = p.x + left.x * o, wz = p.z + left.z * o;
        verts.push(wx, y, wz);
        // packed racing surface reads slightly grey-blue against the fresh-snow banks
        const onTrack = ao <= hw;
        const tone = onTrack ? 0.84 + 0.04 * Math.sin(cum[i] * 0.7 + o) : 1;
        cols.push(tone * 0.97, tone * 0.98, tone);
      }
      routePts.push(new THREE.Vector3(p.x, base + h, p.z));
    }
    const m = offsets.length;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      for (let k = 0; k < m - 1; k++) {
        const a = i * m + k, b = i * m + k + 1, cc = j * m + k, dd = j * m + k + 1;
        idx.push(a, b, cc, b, dd, cc);
      }
    }
    this.vertices = new Float32Array(verts);
    this.indices = new Uint32Array(idx);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.vertices, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3));
    geo.setIndex(new THREE.BufferAttribute(this.indices, 1));
    geo.computeVertexNormals();
    // fix winding so normals face up (left-hand cross ordering)
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    if (nrm.getY(Math.floor(m / 2)) < 0) {
      for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
      this.indices.set(idx);
      geo.setIndex(new THREE.BufferAttribute(this.indices, 1));
      geo.computeVertexNormals();
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.82, vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.group.add(mesh);

    this.route = Route.loop(terrain, routePts, width);

    // ---- start grid: two rows of three behind the line ----
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const sd = this.startS - 7 - row * 7;
        const i = this.route.indexAt(sd);
        const p = this.route.pts[i], d = this.route.dirs[i];
        const lat = (col - 1) * 3.4 + (row % 2) * 1.2;
        const pos = new THREE.Vector3(p.x - d.z * lat, p.y + 0.7, p.z + d.x * lat);
        this.grid.push({ pos, yaw: Math.atan2(d.x, d.z) });
      }
    }
    this.gates = new Checkpoints(terrain);
    const si = this.route.indexAt(this.startS);
    this.gates.add(this.route.pts[si], this.route.dirs[si], width + 2, 'finish');
    this.gates.setNext(-1);
    this.gates.gates[0].group.visible = true;
    this.group.add(this.gates.group);
    this.addProps(pts, dirs, smoothK, base);
  }

  /** Bales on berms, marker flags, light towers, a grandstand – dressing only, no colliders. */
  private addProps(pts: { x: number; z: number }[], dirs: THREE.Vector2[], k: number[], base: number) {
    const n = pts.length;
    const bale = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.8 });
    const pole = new THREE.MeshStandardMaterial({ color: 0x1d3350, roughness: 0.6 });
    const flag = new THREE.MeshStandardMaterial({ color: 0x2fb5ff, roughness: 0.6, side: THREE.DoubleSide });
    const baleGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.1, 10);
    baleGeo.rotateZ(Math.PI / 2);
    const bales: THREE.Matrix4[] = [];
    for (let i = 0; i < n; i += 6) {
      if (Math.abs(k[i]) < 0.02) continue;
      const d = dirs[i];
      const outside = k[i] > 0 ? -1 : 1;
      const o = (this.width / 2 + 3.4) * outside;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(pts[i].x - d.y * o, base + 2.7, pts[i].z + d.x * o),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(d.x, d.y)),
        new THREE.Vector3(1, 1, 1),
      );
      bales.push(m);
    }
    const im = new THREE.InstancedMesh(baleGeo, bale, bales.length);
    bales.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true;
    this.group.add(im);
    for (let i = 0; i < n; i += 22) {
      const d = dirs[i];
      for (const side of [-1, 1]) {
        const o = (this.width / 2 + 2.4) * side;
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 6), pole);
        p.position.set(pts[i].x - d.y * o, base + 2.6, pts[i].z + d.x * o);
        const f = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), flag);
        f.position.set(p.position.x, p.position.y + 1, p.position.z);
        this.group.add(p, f);
      }
    }
    // grandstand along the main straight
    const si = this.route.indexAt(this.startS + 20);
    const sp = this.route.pts[si], sd = this.route.dirs[si];
    const stand = new THREE.Group();
    const crowdMat = new THREE.MeshStandardMaterial({ map: crowdTexture(), roughness: 0.9 });
    for (let r = 0; r < 4; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(36, 0.8, 2), new THREE.MeshStandardMaterial({ color: 0x3a4658, roughness: 0.8 }));
      step.position.set(0, 0.4 + r * 0.8, r * 2);
      const crowd = new THREE.Mesh(new THREE.PlaneGeometry(36, 0.9), crowdMat);
      crowd.position.set(0, 1.25 + r * 0.8, r * 2 - 0.4);
      crowd.rotation.y = Math.PI;
      stand.add(step, crowd);
    }
    const back = this.width / 2 + 9;
    stand.position.set(sp.x + sd.z * back, base, sp.z - sd.x * back);
    stand.rotation.y = Math.atan2(sd.x, sd.z) + Math.PI / 2;
    stand.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(stand);
  }

  /** Distance along the track for a world position near the racing line. */
  progressAt(pos: THREE.Vector3, hint = -1): { s: number; idx: number } {
    const idx = this.route.nearest(pos, hint, 40);
    return { s: this.route.cum[idx], idx };
  }
}

function crowdTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 16;
  const g = c.getContext('2d')!;
  const cols = ['#ff5a1f', '#2fb5ff', '#f6c400', '#e9eef3', '#7ac943', '#16181d', '#c62a1e'];
  for (let x = 0; x < 512; x += 6) {
    g.fillStyle = cols[(x * 7) % cols.length];
    g.fillRect(x, 4 + ((x * 13) % 5), 5, 12);
    g.fillStyle = '#f2c7a5';
    g.fillRect(x + 1, 1 + ((x * 13) % 5), 3, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  return t;
}
