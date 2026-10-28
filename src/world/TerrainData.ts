import { Noise2D, clamp, lerp, smoothstep } from './Noise';
import { SURFACE_ID, SurfaceKey } from '../physics/Surfaces';

export interface TrailDef { id: string; width: number; points: number[][] }
export interface LakeDef { x: number; z: number; r: number }
export interface ZoneDef { surface: SurfaceKey; shape: 'circle'; x: number; z: number; r: number }
export interface CabinDef { id: string; x: number; z: number; rot: number }
export interface VenueDef { id: string; x: number; z: number; rot: number; halfLength: number; halfWidth: number; margin: number }
export interface WorldDef {
  size: number;
  seed: number;
  spawn: { x: number; z: number; headingTo: number[] };
  trails: TrailDef[];
  lakes: LakeDef[];
  zones: ZoneDef[];
  cabins: CabinDef[];
  venues?: VenueDef[];
}

/** A smoothed trail polyline sampled every ~2 m. */
export interface TrailPath { id: string; width: number; pts: { x: number; z: number }[] }

const BIG = 1e6;

/**
 * Pure data for the world: height grid (2 m, matches the physics heightfield) and
 * surface grid (1 m). Everything is generated deterministically from world.json + seed.
 */
export class TerrainData {
  readonly size: number;
  readonly half: number;
  /** Height grid: (hCells+1)^2 samples, row-major by z then x. */
  readonly hCells = 512;
  readonly hStep: number;
  readonly heights: Float32Array;
  /** Surface grid: sCells^2 cells, 1 m each. */
  readonly sCells: number;
  readonly surface: Uint8Array;
  readonly trailDist: Float32Array;
  /** Distance to the nearest trail OR course corridor – drives the level bench in the heightfield. */
  private benchDist: Float32Array;
  /** Height of the nearest trail centreline (trails are cut level across the hillside). */
  private trailH: Float32Array;
  readonly trailPaths: TrailPath[] = [];
  readonly noise: Noise2D;
  readonly lakeLevels: number[] = [];
  /** Flat pad height of each venue (world.json venues). */
  readonly venueHeights: number[] = [];
  /** Snow already compressed by tracks (m of depth, 1 m cells). Written by SnowDeformation. */
  readonly packed: Float32Array;

  /**
   * @param corridors ungroomed off-trail course connectors: shaped like trails (no cliffs to climb)
   * but left as natural snow.
   */
  constructor(readonly def: WorldDef, private corridors: { points: number[][]; width: number }[] = []) {
    this.size = def.size;
    this.half = def.size / 2;
    this.hStep = this.size / this.hCells;
    this.sCells = this.size;
    this.noise = new Noise2D(def.seed);
    const n = this.hCells + 1;
    this.heights = new Float32Array(n * n);
    this.surface = new Uint8Array(this.sCells * this.sCells);
    this.trailDist = new Float32Array(this.sCells * this.sCells).fill(BIG);
    this.trailH = new Float32Array(this.sCells * this.sCells);
    this.benchDist = new Float32Array(this.sCells * this.sCells).fill(BIG);
    this.packed = new Float32Array(this.sCells * this.sCells);

    for (const lake of def.lakes) this.lakeLevels.push(this.lowHeight(lake.x, lake.z) - 6);
    for (const v of def.venues ?? []) this.venueHeights.push(this.lowHeight(v.x, v.z));
    this.buildTrails();
    this.buildHeights();
    this.paintSurfaces();
  }

  // ---------- generation ----------

  private buildTrails() {
    const S = this.sCells;
    // Each trail rasterises into its own scratch field, then all trails are blended by distance so
    // the level benches of two trails merge smoothly at junctions instead of meeting as a step.
    const tDist = new Float32Array(S * S).fill(BIG);
    const tH = new Float32Array(S * S);
    const sumW = new Float32Array(S * S);
    const profiles: { pts: { x: number; z: number }[]; ch: number[] }[] = [];
    const profileHeightNear = (x: number, z: number): number | null => {
      let best: number | null = null, bd = 36; // within 6 m
      for (const pr of profiles) {
        for (let i = 0; i < pr.pts.length; i++) {
          const d = (pr.pts[i].x - x) ** 2 + (pr.pts[i].z - z) ** 2;
          if (d < bd) { bd = d; best = pr.ch[i]; }
        }
      }
      return best;
    };
    const all = [...this.def.trails.map((t) => ({ ...t, groomed: true })), ...this.corridors.map((c, i) => ({ id: `corridor-${i}`, ...c, groomed: false }))];
    for (const t of all) {
      const pts = t.groomed ? catmullRom(t.points, 2) : straight(t.points, 2);
      if (t.groomed) this.trailPaths.push({ id: t.id, width: t.width, pts });
      const closed = t.points.length > 2 && t.points[0][0] === t.points[t.points.length - 1][0] && t.points[0][1] === t.points[t.points.length - 1][1];
      // centreline heights, smoothed along the path (wrapping on loops) so the trail rolls gently
      // follow the lake-shaped landform so trails run down into lake bowls instead of being tilted by them
      const raw = pts.map((p) => this.lakeShape(this.lowHeight(p.x, p.z), p.x, p.z));
      const W = 16;
      const n = raw.length;
      const ch = raw.map((_, i) => {
        let sum = 0, c = 0;
        for (let k = -W; k <= W; k++) {
          let j = i + k;
          if (closed) j = ((j % (n - 1)) + (n - 1)) % (n - 1);
          if (j >= 0 && j < n) { sum += raw[j]; c++; }
        }
        return sum / c;
      });
      // junctions: an end that joins an earlier trail takes that trail's height, so they meet level
      // (a closed loop pins both ends to its own start so it closes without a step)
      // (ends out on a frozen lake pin to the ice level so there's no step at the shore)
      const onIce = (p: { x: number; z: number }) => {
        const l = this.lakeDistance(p.x, p.z);
        return l.i >= 0 && l.d < 1 ? this.lakeLevels[l.i] : null;
      };
      const pin0 = closed ? ch[0] : profileHeightNear(pts[0].x, pts[0].z) ?? onIce(pts[0]);
      const pinN = closed ? ch[0] : profileHeightNear(pts[n - 1].x, pts[n - 1].z) ?? onIce(pts[n - 1]);
      if (pin0 !== null) ch[0] = pin0;
      if (pinN !== null) ch[n - 1] = pinN;
      // grade limit: trails never climb steeper than a sled can manage; the bench cuts/fills to match
      const maxGrade = (t.groomed ? 0.28 : 0.3) * 2; // per 2 m sample
      for (let pass = 0; pass < 8; pass++) {
        for (let i = 1; i < n; i++) if (!(i === n - 1 && pinN !== null)) ch[i] = clamp(ch[i], ch[i - 1] - maxGrade, ch[i - 1] + maxGrade);
        for (let i = n - 2; i >= 0; i--) if (!(i === 0 && pin0 !== null)) ch[i] = clamp(ch[i], ch[i + 1] - maxGrade, ch[i + 1] + maxGrade);
      }
      profiles.push({ pts, ch });
      const reach = t.width / 2 + 14;
      let bx0 = S, bx1 = 0, bz0 = S, bz1 = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach + this.half));
        const x1 = Math.min(S - 1, Math.ceil(Math.max(a.x, b.x) + reach + this.half));
        const z0 = Math.max(0, Math.floor(Math.min(a.z, b.z) - reach + this.half));
        const z1 = Math.min(S - 1, Math.ceil(Math.max(a.z, b.z) + reach + this.half));
        bx0 = Math.min(bx0, x0); bx1 = Math.max(bx1, x1); bz0 = Math.min(bz0, z0); bz1 = Math.max(bz1, z1);
        for (let cz = z0; cz <= z1; cz++) {
          for (let cx = x0; cx <= x1; cx++) {
            const idx = cz * S + cx;
            const px = cx - this.half + 0.5;
            const pz = cz - this.half + 0.5;
            const d = segDist(px, pz, a.x, a.z, b.x, b.z) - t.width / 2;
            if (d < tDist[idx]) {
              tDist[idx] = d;
              tH[idx] = (ch[i] + ch[i + 1]) / 2;
            }
          }
        }
      }
      for (let cz = bz0; cz <= bz1; cz++) {
        for (let cx = bx0; cx <= bx1; cx++) {
          const idx = cz * S + cx;
          const d = tDist[idx];
          if (d < reach) {
            const w = smoothstep(14, -t.width / 2, d) + 1e-4;
            sumW[idx] += w;
            this.trailH[idx] += w * tH[idx];
            if (t.groomed && d < this.trailDist[idx]) this.trailDist[idx] = d;
            if (d < this.benchDist[idx]) this.benchDist[idx] = d;
          }
          tDist[idx] = BIG;
          tH[idx] = 0;
        }
      }
    }
    for (let i = 0; i < S * S; i++) if (sumW[i] > 0) this.trailH[i] /= sumW[i];
  }

  /** Large-scale landform without detail – trails follow this so they stay smooth. */
  private lowHeight(x: number, z: number): number {
    const n = this.noise;
    let h = n.fbm(x / 420, z / 420, 3) * 34 + n.fbm(x / 170 + 10, z / 170 - 4, 2) * 11;
    const ridgeMask = smoothstep(-0.1, 0.5, n.noise(x / 600 + 3, z / 600));
    h += n.ridged(x / 300 + 5, z / 300 - 3, 3) * 26 * ridgeMask;
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h += smoothstep(340, 500, edge) * 120 * (0.75 + 0.25 * n.noise(x / 70, z / 70));
    return h;
  }

  private detailHeight(x: number, z: number): number {
    return this.noise.fbm(x / 45 + 50, z / 45, 3) * 3.2;
  }

  /** Normalised distance (1 = shoreline) to the nearest lake, plus that lake's index. */
  lakeDistance(x: number, z: number): { d: number; i: number } {
    let best = BIG;
    let bi = -1;
    this.def.lakes.forEach((l, i) => {
      const raw = Math.hypot(x - l.x, z - l.z);
      // cheap reject before paying for the shoreline wobble noise
      if (raw / (l.r * 0.86) > Math.min(best, 3)) return;
      const wobble = 1 + 0.14 * this.noise.noise(x / 35 + i * 7, z / 35);
      const d = raw / (l.r * wobble);
      if (d < best) { best = d; bi = i; }
    });
    return { d: best, i: bi };
  }

  private trailHeightAt(x: number, z: number): number {
    const cx = clamp(Math.floor(x + this.half), 0, this.sCells - 1);
    const cz = clamp(Math.floor(z + this.half), 0, this.sCells - 1);
    return this.trailH[cz * this.sCells + cx];
  }

  private trailDistAt(x: number, z: number): number {
    const cx = clamp(Math.floor(x + this.half), 0, this.sCells - 1);
    const cz = clamp(Math.floor(z + this.half), 0, this.sCells - 1);
    return this.trailDist[cz * this.sCells + cx];
  }

  /** Carve lake bowls: flat ice inside the shoreline, a rising rim out to 2.2 radii. */
  private lakeShape(h: number, x: number, z: number): number {
    const { d, i } = this.lakeDistance(x, z);
    if (i < 0 || d >= 2.2) return h;
    const level = this.lakeLevels[i];
    if (d < 1) return level;
    const bowlTarget = level + 0.4 + (d - 1) * 6;
    h = Math.min(h, lerp(bowlTarget, h, smoothstep(1, 2.2, d)));
    // keep the shoreline just above the ice, fading out so there's no step where land dips lower
    return lerp(h, Math.max(h, level + 0.25), smoothstep(1.6, 1.0, d));
  }

  private buildHeights() {
    const n = this.hCells + 1;
    const cabinH = this.def.cabins.map((c) => this.lowHeight(c.x, c.z));
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = ix * this.hStep - this.half;
        const z = iz * this.hStep - this.half;
        const low = this.lowHeight(x, z);
        let h = low + this.detailHeight(x, z);

        // lake bowls first, then trails cut a level bench through whatever is left
        h = this.lakeShape(h, x, z);
        const cx = clamp(Math.floor(x + this.half), 0, this.sCells - 1);
        const cz = clamp(Math.floor(z + this.half), 0, this.sCells - 1);
        const td = this.benchDist[cz * this.sCells + cx];
        if (td < 12) h = lerp(h, this.trailHeightAt(x, z), smoothstep(12, 0.5, td));
        // frozen surface is perfectly flat even where a trail crosses it
        const { d, i } = this.lakeDistance(x, z);
        if (i >= 0 && d < 1) h = this.lakeLevels[i];

        // venues: a dead-flat pad with banks blending out over `margin`
        (this.def.venues ?? []).forEach((v, vi) => {
          const dv = this.venueDistance(v, x, z);
          if (dv < v.margin) h = lerp(h, this.venueHeights[vi], smoothstep(v.margin, 0, dv));
        });

        // flat pads for cabins
        this.def.cabins.forEach((c, ci) => {
          const dc = Math.hypot(x - c.x, z - c.z);
          if (dc < 22) h = lerp(h, cabinH[ci], smoothstep(22, 12, dc));
        });

        // moguls: real bumps in the heightfield
        for (const zn of this.def.zones) {
          if (zn.surface !== 'moguls') continue;
          const dz = Math.hypot(x - zn.x, z - zn.z);
          if (dz < zn.r + 6) {
            const k = (Math.PI * 2) / 9;
            const m = Math.sin(x * k + Math.sin(z * 0.11) * 2) * Math.sin(z * k);
            h += m * 0.85 * smoothstep(zn.r + 6, zn.r - 6, dz);
          }
        }
        this.heights[iz * n + ix] = h;
      }
    }
  }

  private paintSurfaces() {
    const S = this.sCells;
    const n = this.noise;
    const late: ZoneDef[] = this.def.zones.filter((z) => z.surface === 'moguls' || z.surface === 'slush');
    const early: ZoneDef[] = this.def.zones.filter((z) => !late.includes(z));
    for (let cz = 0; cz < S; cz++) {
      for (let cx = 0; cx < S; cx++) {
        const x = cx - this.half + 0.5;
        const z = cz - this.half + 0.5;
        const idx = cz * S + cx;
        const h = this.heightAt(x, z);
        const slope = this.slopeAt(x, z);

        let s: number = SURFACE_ID.powder;
        const windy = n.noise(x / 140 - 9, z / 140 + 2) > 0.42 || (h > 70 && n.noise(x / 90, z / 90) > -0.25);
        if (windy || slope > 0.85) s = SURFACE_ID.crust;

        for (const zn of early) if (Math.hypot(x - zn.x, z - zn.z) < zn.r) s = SURFACE_ID[zn.surface];
        if (this.trailDist[idx] < 0) s = SURFACE_ID.groomed;
        for (const zn of late) {
          const wob = 1 + 0.2 * n.noise(x / 12, z / 12);
          if (Math.hypot(x - zn.x, z - zn.z) < zn.r * wob) s = SURFACE_ID[zn.surface];
        }

        if ((this.def.venues ?? []).some((v) => this.venueDistance(v, x, z) < 4)) s = SURFACE_ID.groomed;
        const { d } = this.lakeDistance(x, z);
        if (d < 1) {
          s = SURFACE_ID.ice;
          // wind-blown snow drifts lying on the ice
          if (n.fbm(x / 22, z / 22, 2) > 0.38) s = SURFACE_ID.crust;
        } else if (d < 1.07) {
          s = SURFACE_ID.slush;
        }
        this.surface[idx] = s;
      }
    }
  }

  // ---------- queries ----------

  heightAt(x: number, z: number): number {
    const n = this.hCells + 1;
    const fx = clamp((x + this.half) / this.hStep, 0, this.hCells - 0.0001);
    const fz = clamp((z + this.half) / this.hStep, 0, this.hCells - 0.0001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.heights;
    const a = h[iz * n + ix];
    const b = h[iz * n + ix + 1];
    const c = h[(iz + 1) * n + ix];
    const d = h[(iz + 1) * n + ix + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Gradient magnitude (rise over run). */
  slopeAt(x: number, z: number): number {
    const e = 1.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  surfaceAt(x: number, z: number): number {
    const cx = clamp(Math.floor(x + this.half), 0, this.sCells - 1);
    const cz = clamp(Math.floor(z + this.half), 0, this.sCells - 1);
    return this.surface[cz * this.sCells + cx];
  }

  /** Venue-local coordinates: u along its length, v across. */
  venueLocal(v: VenueDef, x: number, z: number): { u: number; v: number } {
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    const dx = x - v.x, dz = z - v.z;
    return { u: dx * c + dz * s, v: -dx * s + dz * c };
  }

  /** Distance outside a venue's rectangle (0 inside). */
  venueDistance(v: VenueDef, x: number, z: number): number {
    const l = this.venueLocal(v, x, z);
    return Math.hypot(Math.max(0, Math.abs(l.u) - v.halfLength), Math.max(0, Math.abs(l.v) - v.halfWidth));
  }

  packedAt(x: number, z: number): number {
    const cx = Math.floor(x + this.half), cz = Math.floor(z + this.half);
    if (cx < 0 || cz < 0 || cx >= this.sCells || cz >= this.sCells) return 0;
    return this.packed[cz * this.sCells + cx];
  }

  pack(x: number, z: number, depth: number) {
    const cx = Math.floor(x + this.half), cz = Math.floor(z + this.half);
    if (cx < 0 || cz < 0 || cx >= this.sCells || cz >= this.sCells) return;
    const i = cz * this.sCells + cx;
    if (depth > this.packed[i]) this.packed[i] = depth;
  }

  trailDistanceAt(x: number, z: number): number {
    return this.trailDistAt(x, z);
  }
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz || 1;
  const t = clamp(((px - ax) * vx + (pz - az) * vz) / len2, 0, 1);
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

/** Straight polyline resampled every `step` metres. */
function straight(points: number[][], step: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) out.push({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n });
  }
  const l = points[points.length - 1];
  out.push({ x: l[0], z: l[1] });
  return out;
}

/** Catmull-Rom through control points, resampled roughly every `step` metres. */
export function catmullRom(points: number[][], step: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const closed = points.length > 2 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
  const p = closed ? points.slice(0, -1) : points;
  const count = closed ? p.length : p.length - 1;
  const get = (i: number) => (closed ? p[(i + p.length) % p.length] : p[clamp(i, 0, p.length - 1)]);
  for (let i = 0; i < count; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.ceil(segLen / step));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0[0], p1[0], p2[0], p3[0]), z: f(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  const last = closed ? p[0] : p[p.length - 1];
  out.push({ x: last[0], z: last[1] });
  return out;
}
