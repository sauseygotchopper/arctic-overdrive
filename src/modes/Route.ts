import * as THREE from 'three';
import { TerrainData } from '../world/TerrainData';

export type RouteStep =
  | { trail: string; from: number[]; to: number[]; dir?: number }
  | { point: number[] };

export interface Segment { ax: number; az: number; bx: number; bz: number; width: number }

const STEP = 2;

/**
 * Off-trail connectors of a route, derived from its data alone (trail sections end at their `to`
 * point), so TerrainData can shape corridors before any Route is built.
 */
export function corridorsOf(steps: RouteStep[]): { points: number[][]; width: number }[] {
  const out: { points: number[][]; width: number }[] = [];
  let last: number[] | null = null;
  for (const s of steps) {
    if ('point' in s) {
      if (last) out.push({ points: [last, s.point], width: 8 });
      last = s.point;
    } else {
      if (last && Math.hypot(last[0] - s.from[0], last[1] - s.from[1]) > 6) out.push({ points: [last, s.from], width: 8 });
      last = s.to;
    }
  }
  return out;
}
const CONNECTOR_WIDTH = 12;

/**
 * A drivable line through the world: chained trail sections and straight off-trail connectors,
 * resampled every 2 m. Used for checkpoint placement, minimap lines and the AI/autopilot.
 */
export class Route {
  readonly pts: THREE.Vector3[] = [];
  readonly dirs: THREE.Vector3[] = [];
  readonly widths: number[] = [];
  readonly cum: number[] = [];
  readonly connectors: Segment[] = [];
  length = 0;
  /** Closed loops (race tracks) wrap distance and searches around. */
  closed = false;

  /** A closed loop from pre-sampled points (heights taken from the points, e.g. a raised track surface). */
  static loop(terrain: TerrainData, points: THREE.Vector3[], width: number): Route {
    const r = new Route(terrain, []);
    r.closed = true;
    for (const p of points) { r.pts.push(p.clone()); r.widths.push(width); }
    const n = r.pts.length;
    r.cum.push(0);
    for (let i = 1; i < n; i++) r.cum.push(r.cum[i - 1] + Math.hypot(r.pts[i].x - r.pts[i - 1].x, r.pts[i].z - r.pts[i - 1].z));
    r.length = r.cum[n - 1] + Math.hypot(r.pts[0].x - r.pts[n - 1].x, r.pts[0].z - r.pts[n - 1].z);
    for (let i = 0; i < n; i++) {
      const a = r.pts[(i - 2 + n) % n], b = r.pts[(i + 2) % n];
      r.dirs.push(new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize());
    }
    return r;
  }

  constructor(private terrain: TerrainData, steps: RouteStep[]) {
    if (!steps.length) return;
    const raw: { x: number; z: number; w: number }[] = [];
    const last = () => raw[raw.length - 1];
    const line = (bx: number, bz: number, w: number) => {
      const a = last();
      if (!a) { raw.push({ x: bx, z: bz, w }); return; }
      const d = Math.hypot(bx - a.x, bz - a.z);
      const n = Math.max(1, Math.ceil(d / STEP));
      for (let i = 1; i <= n; i++) raw.push({ x: a.x + ((bx - a.x) * i) / n, z: a.z + ((bz - a.z) * i) / n, w });
    };
    for (const s of steps) {
      if ('point' in s) {
        const a = last();
        if (a) this.connectors.push({ ax: a.x, az: a.z, bx: s.point[0], bz: s.point[1], width: CONNECTOR_WIDTH });
        line(s.point[0], s.point[1], CONNECTOR_WIDTH);
        continue;
      }
      const path = terrain.trailPaths.find((t) => t.id === s.trail);
      if (!path) throw new Error(`Route: unknown trail ${s.trail}`);
      const pts = path.pts;
      const closed = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 1;
      const n = closed ? pts.length - 1 : pts.length;
      const nearest = (p: number[]) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < n; i++) {
          const d = (pts[i].x - p[0]) ** 2 + (pts[i].z - p[1]) ** 2;
          if (d < bd) { bd = d; bi = i; }
        }
        return bi;
      };
      const i0 = nearest(s.from), i1 = nearest(s.to);
      const dir = closed ? (s.dir ?? 1) : Math.sign(i1 - i0) || 1;
      // join from wherever we are to the start of the section
      if (last()) line(pts[i0].x, pts[i0].z, path.width + 4);
      else raw.push({ x: pts[i0].x, z: pts[i0].z, w: path.width + 4 });
      for (let i = i0; i !== i1; ) {
        i = closed ? (i + dir + n) % n : i + dir;
        raw.push({ x: pts[i].x, z: pts[i].z, w: path.width + 4 });
      }
    }
    this.resample(raw);
  }

  private resample(raw: { x: number; z: number; w: number }[]) {
    let acc = 0;
    let carry = 0;
    const push = (x: number, z: number, w: number) => {
      this.pts.push(new THREE.Vector3(x, this.terrain.heightAt(x, z), z));
      this.widths.push(w);
      this.cum.push(acc);
    };
    push(raw[0].x, raw[0].z, raw[0].w);
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 1e-6) continue;
      let t = STEP - carry;
      while (t <= d) {
        acc += t === STEP - carry && carry > 0 ? STEP - carry : STEP;
        push(a.x + ((b.x - a.x) * t) / d, a.z + ((b.z - a.z) * t) / d, b.w);
        t += STEP;
      }
      carry = d - (t - STEP);
      acc = this.cum[this.cum.length - 1];
    }
    // recompute cumulative distances exactly
    this.cum[0] = 0;
    for (let i = 1; i < this.pts.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].z - this.pts[i - 1].z);
    }
    this.length = this.cum[this.cum.length - 1];
    for (let i = 0; i < this.pts.length; i++) {
      const a = this.pts[Math.max(0, i - 2)], b = this.pts[Math.min(this.pts.length - 1, i + 2)];
      this.dirs.push(new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize());
    }
  }

  /** Wrap a distance onto [0, length) for closed loops (clamp for open routes). */
  wrap(dist: number): number {
    return this.closed ? ((dist % this.length) + this.length) % this.length : THREE.MathUtils.clamp(dist, 0, this.length);
  }

  /** Signed shortest distance from a to b along a closed loop (b - a for open routes). */
  delta(a: number, b: number): number {
    if (!this.closed) return b - a;
    let d = this.wrap(b - a);
    if (d > this.length / 2) d -= this.length;
    return d;
  }

  indexAt(dist: number): number {
    const d = this.wrap(dist);
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < d) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Closest route index to a position, searching a window around `hint` (or everywhere). */
  nearest(pos: THREE.Vector3, hint = -1, window = 60): number {
    if (this.closed) {
      const n = this.pts.length;
      let bi = Math.max(0, hint), bd = Infinity;
      const span = hint < 0 ? n : window + 10;
      for (let k = 0; k < span; k++) {
        const i = hint < 0 ? k : (hint - 10 + k + n) % n;
        const q = this.pts[i];
        const d = (q.x - pos.x) ** 2 + (q.z - pos.z) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      return bi;
    }
    const from = hint < 0 ? 0 : Math.max(0, hint - 10);
    const to = hint < 0 ? this.pts.length - 1 : Math.min(this.pts.length - 1, hint + window);
    let bi = from, bd = Infinity;
    for (let i = from; i <= to; i++) {
      const q = this.pts[i];
      const d = (q.x - pos.x) ** 2 + (q.z - pos.z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  /**
   * Speed ceilings over jumps that lie on this route: rollers want ~45 km/h, kickers and tables a
   * take-off speed that grows with their height (so the AI clears tables instead of casing or overshooting).
   */
  jumpZones(jumps: { start: THREE.Vector3; dir: THREE.Vector3; length: number; def: { type: string; height: number } }[]) {
    const zones: { from: number; to: number; maxKmh: number }[] = [];
    for (const j of jumps) {
      const i = this.nearest(j.start);
      if (Math.hypot(this.pts[i].x - j.start.x, this.pts[i].z - j.start.z) > 5) continue;
      if (this.dirs[i].dot(j.dir) < 0.5) continue; // jump faces the other way on this route
      const kmh = j.def.type === 'rollers' ? 45 : j.def.type === 'tabletop' ? 50 + j.def.height * 9 : 42 + j.def.height * 8;
      zones.push({ from: this.cum[i] - 5, to: this.cum[i] + j.length, maxKmh: kmh });
    }
    return zones;
  }

  /** Turn sharpness ahead: max heading change per metre over [d0, d1]. */
  curvatureAhead(d0: number, d1: number): number {
    if (this.closed) {
      let k = 0;
      for (let d = d0; d < d1 - 6; d += 4) {
        const a = this.dirs[this.indexAt(d)], b = this.dirs[this.indexAt(d + 6)];
        k = Math.max(k, Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) / 6);
      }
      return k;
    }
    const i0 = this.indexAt(d0), i1 = this.indexAt(d1);
    let k = 0;
    for (let i = i0; i < i1 - 3; i += 2) {
      const a = this.dirs[i], b = this.dirs[i + 3];
      const ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
      k = Math.max(k, ang / Math.max(1, this.cum[i + 3] - this.cum[i]));
    }
    return k;
  }
}
