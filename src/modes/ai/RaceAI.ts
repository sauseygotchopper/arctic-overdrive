import * as THREE from 'three';
import { Route } from '../Route';
import { RouteFollower, SpeedZone } from './RouteFollower';
import { Sled } from '../../vehicles/Sled';
import { DriveInput } from '../../vehicles/SledPhysics';
import { TerrainData } from '../../world/TerrainData';
import { clamp } from '../../world/Noise';

/**
 * An AI rider: the RouteFollower's line and speed planning, scaled by skill (corner bravery,
 * jump speeds, consistency), with a personal racing lane and a fair stuck/flip recovery.
 * It produces the same DriveInput a player does – no physics shortcuts.
 */
export class RaceAI {
  readonly follower: RouteFollower;
  private stuck = 0;
  private wobble = Math.random() * 100;
  private laneDrift = 0;
  /** How many times a marshal had to put this rider back on track (tuning metric). */
  recoveries = 0;
  /** Set each step by the race: lateral shift to get round a rider ahead, and how close they are (m). */
  avoid = 0;
  gapAhead = Infinity;

  constructor(readonly sled: Sled, private route: Route, private terrain: TerrainData, readonly skill: number, zones: SpeedZone[], private lane: number) {
    // braver riders corner harder and hit jumps a little faster
    const z = zones.map((zz) => ({ ...zz, maxKmh: zz.maxKmh * (0.9 + skill * 0.12) }));
    this.follower = new RouteFollower(route, terrain, { cornerAccel: 6 + skill * 1.3, laneOffset: lane, steerGain: 0.9 + skill * 0.2 }, z);
  }

  control(dt: number, enabled: boolean): DriveInput {
    const p = this.sled.physics;
    if (!enabled) return { throttle: 0, brake: 0.45, steer: 0, leanX: 0, leanZ: 0 };
    this.wobble += dt;
    // drift between lanes a little so the pack doesn't ride single file
    this.laneDrift = Math.sin(this.wobble * 0.23) * 1.2;
    this.follower.opts.laneOffset = THREE.MathUtils.clamp(this.lane + this.laneDrift + this.avoid, -4, 4);
    const d = this.follower.control(p);
    // right on someone's tail and couldn't get round yet: ease off rather than ram them
    if (this.gapAhead < 4) d.throttle = Math.min(d.throttle, 0.35);
    // less skilled riders are a bit ragged: steering noise and the odd lift off the throttle
    const sloppy = 1 - this.skill;
    d.steer = clamp(d.steer + Math.sin(this.wobble * 3.1) * sloppy * 0.25, -1, 1);
    if (sloppy > 0.15 && Math.sin(this.wobble * 0.71) > 0.97) d.throttle *= 0.4;
    this.checkStuck(dt);
    return d;
  }

  /** Stalled or upside down for a while: put back on the line a few metres on (like a marshal would). */
  private checkStuck(dt: number) {
    const p = this.sled.physics;
    const bad = p.isFlipped() || Math.abs(p.speed) < 1.5;
    this.stuck = bad ? this.stuck + dt : 0;
    if (this.stuck > 2.2) {
      this.stuck = 0;
      this.recoveries++;
      const r = this.route;
      const i = r.indexAt(this.follower.progress + 3);
      const q = r.pts[i], dq = r.dirs[i];
      const x = q.x - dq.z * this.lane, z = q.z + dq.x * this.lane;
      this.sled.teleport(new THREE.Vector3(x, Math.max(q.y, this.terrain.heightAt(x, z)) + 0.8, z), Math.atan2(dq.x, dq.z));
    }
  }
}
