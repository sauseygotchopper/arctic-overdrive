import * as THREE from 'three';
import type { Game } from './Game';
import type { CargoType } from '../vehicles/Cargo';
import { RouteFollower, FollowOptions } from '../modes/ai/RouteFollower';

/**
 * Console helpers for tuning: `__dev.startTrail('loop', 'full')`, `__dev.drive(10, 60)`.
 * Drives with a simple trail-following autopilot through the deterministic simulate() path.
 */
export class DevTools {
  log: string[] = [];
  private idx = 0;
  private trail = 'loop';

  constructor(private game: Game) {}

  static readonly LOADS: Record<string, CargoType[] | null> = {
    none: null,
    empty: [],
    light: ['crate', 'crate'],
    full: ['crate', 'crate', 'firewood', 'fuel', 'fuel', 'medical', 'parcel', 'parcel'],
  };

  startTrail(trailId = 'loop', load: keyof typeof DevTools.LOADS = 'none', at = 0) {
    const g = this.game;
    for (const l of [...g.loose.items]) g.loose.remove(l.item);
    const cargo = DevTools.LOADS[load];
    if (cargo === null) { if (g.player.trailer) g.toggleTrailer(); }
    else { if (!g.player.trailer) g.toggleTrailer(); g.player.trailer!.setCargo(cargo); }
    const pts = g.terrain.trailPaths.find((t) => t.id === trailId)!.pts;
    this.trail = trailId;
    this.idx = Math.floor(at * (pts.length - 1));
    const a = pts[this.idx], b = pts[Math.min(pts.length - 1, this.idx + 3)];
    g.player.teleport(new THREE.Vector3(a.x, g.terrain.heightAt(a.x, a.z) + 0.7, a.z), Math.atan2(b.x - a.x, b.z - a.z));
    g.simulate(1, {});
    this.log.length = 0;
  }

  /** Autopilot along the current trail for `seconds`, holding about `kmh`. */
  drive(seconds: number, kmh: number, opts: { brakeAfter?: number; steerBias?: number } = {}) {
    const g = this.game;
    const p = g.player.physics;
    const pts = g.terrain.trailPaths.find((t) => t.id === this.trail)!.pts;
    const n = pts.length;
    const out = { maxHitchYaw: 0, minTrailerUp: 1, dist: 0, kmh: 0, cargo: 0, surf: '', events: [] as string[] };
    const last = p.position.clone();
    for (let i = 0; i < seconds * 20; i++) {
      let best = this.idx, bd = Infinity;
      for (let k = this.idx - 5; k < this.idx + 40; k++) {
        const q = pts[((k % n) + n) % n];
        const d = (q.x - p.position.x) ** 2 + (q.z - p.position.z) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      this.idx = ((best % n) + n) % n;
      const look = pts[(this.idx + Math.round(5 + p.speed * 0.6)) % n];
      const to = new THREE.Vector3(look.x - p.position.x, 0, look.z - p.position.z).normalize();
      const f = new THREE.Vector3(p.forward.x, 0, p.forward.z).normalize();
      const steer = THREE.MathUtils.clamp((f.x * to.z - f.z * to.x) * 3 + (opts.steerBias ?? 0), -1, 1);
      const v = p.speed * 3.6;
      const braking = opts.brakeAfter !== undefined && i / 20 > opts.brakeAfter;
      const throttle = braking ? 0 : v < kmh ? 1 : v < kmh + 8 ? 0.25 : 0;
      const brake = braking ? 1 : v > kmh + 12 ? 0.4 : 0;
      g.simulate(0.05, { throttle, brake, steer });
      const t = g.player.trailer;
      if (t) {
        out.maxHitchYaw = Math.max(out.maxHitchYaw, Math.abs(t.hitchYaw) * 57.3);
        out.minTrailerUp = Math.min(out.minTrailerUp, t.up.y);
      }
      out.dist += p.position.distanceTo(last);
      last.copy(p.position);
    }
    out.kmh = Math.round(p.speed * 3.6);
    out.cargo = g.player.trailer?.cargo.length ?? 0;
    out.surf = p.surface.key;
    out.maxHitchYaw = Math.round(out.maxHitchYaw);
    out.minTrailerUp = +out.minTrailerUp.toFixed(2);
    out.dist = Math.round(out.dist);
    out.events = this.log.splice(0);
    return out;
  }

  /**
   * Drive a course route with the AI follower and time it (medal calibration).
   * Returns elapsed seconds, or -1 if it got stuck.
   */
  runRoute(courseId: string, opts: FollowOptions = {}, maxSeconds = 400) {
    const g = this.game;
    const route = g.routes.get(courseId)!;
    const f = new RouteFollower(route, g.terrain, opts, route.jumpZones(g.jumps.list));
    const p = g.player.physics;
    const p0 = route.pts[1], d0 = route.dirs[1];
    g.player.teleport(new THREE.Vector3(p0.x, g.terrain.heightAt(p0.x, p0.z) + 0.6, p0.z), Math.atan2(d0.x, d0.z));
    g.snow.clear();
    g.simulate(0.5, {}); // settle (holding brake at standstill would engage reverse)
    let t = 0, stuck = 0, lastProg = 0, crashes = 0;
    const log: string[] = [];
    while (t < maxSeconds && !f.finished) {
      const d = f.control(p);
      g.simulate(1 / 30, d);
      t += 1 / 30;
      if (p.crashTimer > 0.85) crashes++;
      if (Math.floor(t) % 5 === 0 && Math.abs(t % 5) < 1 / 30) {
        if (f.progress - lastProg < 5) {
          stuck++;
          log.push(`stuck@${Math.round(f.progress)}m (${Math.round(p.position.x)},${Math.round(p.position.z)}) ${p.surface.key}`);
          // put it back on the line a little further on
          const i = route.indexAt(f.progress + 6);
          const q = route.pts[i], dq = route.dirs[i];
          g.player.teleport(new THREE.Vector3(q.x, g.terrain.heightAt(q.x, q.z) + 0.6, q.z), Math.atan2(dq.x, dq.z));
          f.reset(f.progress + 6);
        }
        lastProg = f.progress;
        if (stuck > 6) return { time: -1, progress: Math.round(f.progress), length: Math.round(route.length), log };
      }
    }
    return { time: +t.toFixed(2), progress: Math.round(f.progress), length: Math.round(route.length), avgKmh: Math.round((route.length / t) * 3.6), crashes, log };
  }
}
