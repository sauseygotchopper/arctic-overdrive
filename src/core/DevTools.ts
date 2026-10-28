import * as THREE from 'three';
import type { Game } from './Game';
import type { CargoType } from '../vehicles/Cargo';

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
}
