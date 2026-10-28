import * as THREE from 'three';
import { TerrainData } from './TerrainData';
import { Sled } from '../vehicles/Sled';
import { SURFACE_ID } from '../physics/Surfaces';

const SPACING = 0.4; // metres between cross-sections
const LIFT = 0.025; // keeps the rut skin just above the terrain mesh

/**
 * Cross-section of a rut: [offset across (m), height as a fraction of rut depth, ambient shade].
 * Outer points sit on the snow so the edge blends in; berms rise either side of a flatter floor.
 */
type Profile = [number, number, number][];
const SKI: Profile = [[-0.24, 0, 1], [-0.15, 0.6, 1], [-0.09, 0.12, 0.86], [0, 0, 0.8], [0.09, 0.12, 0.86], [0.15, 0.6, 1], [0.24, 0, 1]];
const TRACK: Profile = [[-0.56, 0, 1], [-0.42, 0.75, 1], [-0.32, 0.2, 0.86], [-0.18, 0.05, 0.8], [0, 0.05, 0.78], [0.18, 0.05, 0.8], [0.32, 0.2, 0.86], [0.42, 0.75, 1], [0.56, 0, 1]];
const FLOOR = (i: number, n: number) => i >= 3 && i <= n - 4; // tread-imprinted floor points of TRACK

/** Height on the rendered terrain triangles (same diagonal split as TerrainMesh), not the bilinear one. */
function meshHeight(t: TerrainData, x: number, z: number): number {
  const n = t.hCells + 1;
  const fx = THREE.MathUtils.clamp((x + t.half) / t.hStep, 0, t.hCells - 1e-4);
  const fz = THREE.MathUtils.clamp((z + t.half) / t.hStep, 0, t.hCells - 1e-4);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const h = t.heights;
  const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
  return tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
}

/** One rut (a ski or the track) in a ring buffer of cross-sections; only the changed slice is re-uploaded. */
class Rut {
  readonly mesh: THREE.Mesh;
  private P: number;
  private pos: Float32Array;
  private nor: Float32Array;
  private col: Float32Array;
  private idx: Uint32Array;
  private head = -1;
  private last = new THREE.Vector3();
  private connected = false;
  private count = 0;
  private tn = new THREE.Vector3();
  private v = new THREE.Vector3();

  constructor(private n: number, private profile: Profile, private tread: boolean, mat: THREE.Material) {
    const P = (this.P = profile.length);
    this.pos = new Float32Array(n * P * 3);
    this.nor = new Float32Array(n * P * 3);
    this.col = new Float32Array(n * P * 3);
    this.idx = new Uint32Array(n * (P - 1) * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  add(p: THREE.Vector3, right: THREE.Vector3, depth: number, terrain: TerrainData, down: boolean) {
    if (!down || depth <= 0) { this.connected = false; return; }
    if (this.connected && this.last.distanceToSquared(p) < SPACING * SPACING) return;
    const P = this.P;
    const prev = this.head;
    const k = (this.head = (this.head + 1) % this.n);
    this.count++;
    // terrain normal at the centre, for tilting the profile normals
    const e = 0.5;
    this.tn.set(meshHeight(terrain, p.x - e, p.z) - meshHeight(terrain, p.x + e, p.z), 2 * e, meshHeight(terrain, p.x, p.z - e) - meshHeight(terrain, p.x, p.z + e)).normalize();
    const lug = this.tread && this.count % 2 === 0 ? 0.35 : 0; // alternating cleat imprint
    const heights: number[] = [];
    for (let j = 0; j < P; j++) {
      const [off, hf] = this.profile[j];
      heights.push(depth * (hf + (this.tread && FLOOR(j, P) ? lug * 0.4 : 0)));
      const x = p.x + right.x * off, z = p.z + right.z * off;
      const o = (k * P + j) * 3;
      this.pos[o] = x;
      this.pos[o + 1] = meshHeight(terrain, x, z) + LIFT + heights[j];
      this.pos[o + 2] = z;
    }
    for (let j = 0; j < P; j++) {
      const a = Math.max(0, j - 1), b = Math.min(P - 1, j + 1);
      const slope = (heights[b] - heights[a]) / (this.profile[b][0] - this.profile[a][0]);
      this.v.copy(this.tn).addScaledVector(right, -slope).normalize();
      const o = (k * P + j) * 3;
      this.nor[o] = this.v.x; this.nor[o + 1] = this.v.y; this.nor[o + 2] = this.v.z;
      const shade = this.profile[j][2] - (this.tread && FLOOR(j, P) ? lug * 0.1 : 0);
      this.col[o] = this.col[o + 1] = this.col[o + 2] = shade;
    }
    // quads between consecutive cross-sections; the segment after the newest one is stale, so collapse it
    const seg = (s: number, on: boolean) => {
      const a = s * P, b = ((s + 1) % this.n) * P;
      for (let j = 0; j < P - 1; j++) {
        const o = (s * (P - 1) + j) * 6;
        if (on) this.idx.set([a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j], o);
        else this.idx.fill(0, o, o + 6);
      }
    };
    if (prev >= 0) seg(prev, this.connected);
    seg(k, false);
    this.connected = true;
    this.last.copy(p);

    const g = this.mesh.geometry;
    for (const name of ['position', 'normal', 'color'] as const) {
      const attr = g.attributes[name] as THREE.BufferAttribute;
      attr.addUpdateRange(k * P * 3, P * 3);
      attr.needsUpdate = true;
    }
    const index = g.index!;
    const span = (P - 1) * 6;
    if (prev >= 0) index.addUpdateRange(prev * span, span);
    index.addUpdateRange(k * span, span);
    index.needsUpdate = true;
  }
}

/**
 * Ruts the sled leaves in the snow: two ski grooves and a wider track trench with berms and a
 * cleat imprint. They are real geometry in the snow material, so they shade with the scene light
 * (lavender shade by day, dark under the moon, bright in headlights). Depth follows how far the
 * sled sank. They last the whole session (oldest are recycled once the buffer fills) and are not
 * saved, so every new session starts on untouched snow.
 */
export class TrackMarks {
  readonly group = new THREE.Group();
  private skiL: Rut;
  private skiR: Rut;
  private track: Rut;
  private right = new THREE.Vector3();
  private centre = new THREE.Vector3();

  constructor(private terrain: TerrainData, points: number) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf4f6fd, vertexColors: true, roughness: 0.92,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.skiL = new Rut(points, SKI, false, mat);
    this.skiR = new Rut(points, SKI, false, mat);
    this.track = new Rut(points, TRACK, true, mat);
    this.group.add(this.skiL.mesh, this.skiR.mesh, this.track.mesh);
  }

  update(sled: Sled) {
    const ph = sled.physics;
    // forward × up, so the profile always runs left→right and the faces point up
    this.right.set(-ph.forward.z, 0, ph.forward.x).normalize();
    let tracks = 0, sink = 0, base = 0;
    this.centre.set(0, 0, 0);
    for (const c of ph.contacts) {
      const down = c.grounded && c.surface.id !== SURFACE_ID.ice;
      const depth = rutDepth(c.surface.sinkDepth, c.sink) * 0.7;
      if (c.isSki) (c.side < 0 ? this.skiL : this.skiR).add(c.hitPoint, this.right, depth, this.terrain, down);
      else if (down) { this.centre.add(c.hitPoint); tracks++; sink += c.sink; base += c.surface.sinkDepth; }
    }
    if (tracks) this.centre.divideScalar(tracks);
    this.track.add(this.centre, this.right, rutDepth(base / (tracks || 1), sink / (tracks || 1)), this.terrain, tracks >= 2);
  }
}

/** Packed snow still leaves a shallow imprint; soft snow leaves a trench as deep as the sled sank. */
function rutDepth(surfaceSink: number, actualSink: number) {
  return THREE.MathUtils.clamp(0.035 + surfaceSink * 0.25 + actualSink * 0.6, 0.035, 0.28);
}
