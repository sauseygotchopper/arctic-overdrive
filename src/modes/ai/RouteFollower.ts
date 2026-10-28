import * as THREE from 'three';
import { Route } from '../Route';
import { SledPhysics, DriveInput } from '../../vehicles/SledPhysics';
import { clamp } from '../../world/Noise';
import { TerrainData } from '../../world/TerrainData';
import { SURFACES } from '../../physics/Surfaces';

export interface FollowOptions {
  /** Hard speed ceiling (km/h). */
  maxKmh?: number;
  /** Lateral acceleration the driver dares to use (m/s²) on full-grip snow. Higher = braver. */
  cornerAccel?: number;
  /** Extra steering gain. */
  steerGain?: number;
  /** Ride this far left (+) / right (-) of the centre line (racers spread across the track). */
  laneOffset?: number;
}

/** Stretch of route with a speed ceiling (e.g. jumps, rhythm sections). Distances in metres along the route. */
export interface SpeedZone { from: number; to: number; maxKmh: number }

/**
 * Drives a sled along a Route with the same DriveInput a player produces: pure-pursuit steering,
 * speed planned from upcoming curvature and the current surface's grip. Used by the dev autopilot,
 * medal calibration and (Phase 5) AI riders.
 */
export class RouteFollower {
  idx = 0;
  progress = 0; // metres along the route

  constructor(public route: Route, private terrain: TerrainData, public opts: FollowOptions = {}, public zones: SpeedZone[] = []) {}

  reset(dist = 0) {
    this.idx = this.route.indexAt(dist);
    this.progress = dist;
  }

  control(p: SledPhysics): DriveInput {
    const r = this.route;
    this.idx = r.nearest(p.position, this.idx);
    this.progress = r.cum[this.idx];
    const speed = Math.max(0, p.speed);
    const li = r.indexAt(this.progress + 5 + speed * 0.55);
    const lane = this.opts.laneOffset ?? 0;
    const look = r.pts[li], ld = r.dirs[li];
    const tx = look.x - ld.z * lane, tz = look.z + ld.x * lane; // left of travel = (-dz, dx)
    const to = new THREE.Vector3(tx - p.position.x, 0, tz - p.position.z).normalize();
    const f = new THREE.Vector3(p.forward.x, 0, p.forward.z).normalize();
    const cross = f.x * to.z - f.z * to.x;
    const dot = f.dot(to);
    // pure pursuit + cross-track correction (sideways offset from the line; + = drifted to our left)
    const q = r.pts[this.idx], rd = r.dirs[this.idx];
    const lateral = (p.position.x - q.x) * rd.z - (p.position.z - q.z) * rd.x - lane;
    let steer = clamp((cross * 2.4 + clamp(lateral, -6, 6) * 0.1) * (this.opts.steerGain ?? 1), -1, 1);
    if (dot < 0) steer = cross >= 0 ? 1 : -1; // facing away: full lock toward the line

    // speed plan: every point ahead has a corner speed (curvature × that spot's grip); we may only
    // go as fast as lets us brake down to each of them in time on the snow in between
    const brave = this.opts.cornerAccel ?? 7;
    let target = (this.opts.maxKmh ?? 200) / 3.6;
    let gripSoFar = Math.max(0.15, p.surface.grip);
    for (let s = 4; s < 30 + speed * 3; s += 6) {
      const d = this.progress + s;
      if (!r.closed && d > r.length) break;
      const q = r.pts[r.indexAt(d)];
      const surf = SURFACES[this.terrain.surfaceAt(q.x, q.z)];
      gripSoFar = Math.min(gripSoFar, Math.max(0.15, surf.grip));
      const k = Math.max(1e-4, r.curvatureAhead(d - 4, d + 4));
      const vCorner = Math.sqrt((brave * Math.max(0.12, surf.lateralGrip)) / k);
      const aBrake = 9.81 * gripSoFar * 0.75;
      target = Math.min(target, Math.sqrt(vCorner * vCorner + 2 * aBrake * Math.max(0, s - 4)));
    }
    for (const z of this.zones) {
      // distance until the zone starts (0 while inside it); wraps on closed tracks
      const toStart = r.closed ? r.wrap(z.from - this.progress) : z.from - this.progress;
      const inside = r.closed ? r.wrap(this.progress - z.from) < z.to - z.from : this.progress >= z.from && this.progress <= z.to;
      if (!inside && !r.closed && z.to < this.progress) continue;
      const vz = z.maxKmh / 3.6;
      const ahead = inside ? 0 : Math.max(0, toStart);
      if (ahead > 150) continue;
      target = Math.min(target, Math.sqrt(vz * vz + 2 * 9.81 * gripSoFar * 0.7 * ahead));
    }
    const throttle = speed < target ? 1 : speed < target + 2 ? 0.3 : 0;
    const brake = speed > target + 4 ? clamp((speed - target - 4) / 6, 0.2, 1) : 0;
    // in the air, steering/leaning would spin and roll the sled (trick controls): hold still
    if (p.groundedCount === 0) return { throttle, brake: 0, steer: 0, leanX: 0, leanZ: 0 };
    // lean into turns like a rider would
    const leanX = clamp(steer * 0.8, -1, 1);
    return { throttle, brake, steer, leanX, leanZ: 0 };
  }

  get finished(): boolean {
    return !this.route.closed && this.progress >= this.route.length - 4;
  }
}
