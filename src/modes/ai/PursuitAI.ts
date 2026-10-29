import * as THREE from 'three';
import type { Sled } from '../../vehicles/Sled';
import type { DriveInput } from '../../vehicles/SledPhysics';
import type { TreeGrid } from '../../world/Scenery';
import type { TerrainData } from '../../world/TerrainData';
import { clamp } from '../../world/Noise';
import { SURFACES } from '../../physics/Surfaces';

/** Where an agent wants to sit relative to the target when close: x = metres to its right, z = metres ahead. */
const SLOTS = [
  { x: 0, z: -4 }, // tail
  { x: -3.2, z: 1.5 }, // left flank
  { x: 3.2, z: 1.5 }, // right flank
  { x: 0, z: 5 }, // cut in front
];

/** Steeper than this (rise over run) up or down is avoided when picking a line; deep snow bogs on far less. */
const MAX_GRADE = 0.5;
const MAX_GRADE_DEEP = 0.25;

export interface PursuitTarget {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  speed: number;
}

/**
 * An agent on a snowmobile: drives with the same inputs a player does. Heads for where the target
 * will be, picks the clearest heading through the trees, and once close takes a slot around the target
 * (tail, flanks, in front) so a slowing rider gets boxed in.
 */
export class PursuitAI {
  /** What the agent is driving to: 'chase' the target, or 'search' around a point. */
  mode: 'chase' | 'search' | 'leave' = 'chase';
  searchPoint = new THREE.Vector3();
  private searchTarget = new THREE.Vector3();
  private searchTimer = 0;
  private stuck = 0;
  private reverse = 0;
  private reverseSteer = 1;
  private t = Math.random() * 10;
  /** Heading that just got us stuck, avoided for a few seconds after backing out. */
  private badHeading = 0;
  private badTimer = 0;
  stuckTotal = 0;

  constructor(readonly sled: Sled, private obstacles: TreeGrid, private terrain: TerrainData, readonly slot: number) {}

  control(dt: number, target: PursuitTarget): DriveInput {
    const p = this.sled.physics;
    this.t += dt;
    const pos = p.position;
    const fwd = new THREE.Vector3(p.forward.x, 0, p.forward.z).normalize();
    const speed = Math.max(0, p.speed);

    // where to go
    let goal: THREE.Vector3;
    let wantSpeed = 60;
    const tf = new THREE.Vector3(target.forward.x, 0, target.forward.z).normalize();
    const tr = new THREE.Vector3(-tf.z, 0, tf.x); // right of the target's travel (left is +x when facing +z)
    const dist = Math.hypot(target.position.x - pos.x, target.position.z - pos.z);
    if (this.mode === 'chase') {
      const lead = clamp(dist / Math.max(8, speed + 4), 0, 1.6);
      goal = target.position.clone().addScaledVector(target.velocity, lead).setY(0);
      if (dist < 30) {
        const s = SLOTS[this.slot % SLOTS.length];
        const k = 1 - clamp((dist - 12) / 18, 0, 1); // ease into the slot as we close in
        goal.addScaledVector(tr, s.x * k).addScaledVector(tf, s.z * k);
        // match the target's speed, plus a little to close the gap to the slot
        const toSlot = goal.clone().sub(pos).setY(0);
        const gap = toSlot.length();
        const ahead = toSlot.dot(fwd); // + = the slot is in front of us
        wantSpeed = Math.max(0, target.speed + clamp(ahead * 0.9, -6, 12));
        if (gap > 3) wantSpeed = Math.max(wantSpeed, Math.min(gap * 0.8, 8)); // keep rolling to get round to it
        // in position (or already pressed up against them): sit on the brakes
        if (target.speed < 3 && (gap < 2.5 || dist < 4.5)) wantSpeed = 0;
      }
    } else {
      // search: weave between random points around where they last saw you; leave: drive away
      this.searchTimer -= dt;
      if (this.searchTimer <= 0 || Math.hypot(this.searchTarget.x - pos.x, this.searchTarget.z - pos.z) < 8) {
        const a = Math.random() * Math.PI * 2, r = this.mode === 'leave' ? 400 : 20 + Math.random() * 45;
        this.searchTarget.set(this.searchPoint.x + Math.cos(a) * r, 0, this.searchPoint.z + Math.sin(a) * r);
        this.searchTimer = 8 + Math.random() * 5;
      }
      goal = this.searchTarget;
      wantSpeed = this.mode === 'leave' ? 50 : 32;
    }

    // stuck: back out with the opposite lock, then try again
    if (this.reverse > 0) {
      this.reverse -= dt;
      return { throttle: 0, brake: 1, steer: this.reverseSteer, leanX: 0, leanZ: 0 };
    }
    const wedged = speed < 1.2 && wantSpeed > 3 && !(this.mode === 'chase' && dist < 8); // pinned against the target is the point
    this.stuck = wedged ? this.stuck + dt : 0;
    this.stuckTotal = wedged ? this.stuckTotal + dt : Math.max(0, this.stuckTotal - dt * 0.5);

    // pick the clearest heading toward the goal: the desired one, else fan out ±15° steps
    const desired = Math.atan2(goal.x - pos.x, goal.z - pos.z);
    const look = clamp(6 + speed * 0.9, 8, 26);
    let heading = desired;
    this.badTimer = Math.max(0, this.badTimer - dt);
    for (const off of [0, 0.26, -0.26, 0.52, -0.52, 0.8, -0.8, 1.1, -1.1, 1.45, -1.45]) {
      const h = desired + off;
      if (this.badTimer > 0 && Math.abs(angleDiff(h, this.badHeading)) < 0.45) continue;
      if (this.clear(pos, h, look)) { heading = h; break; }
    }
    const cur = Math.atan2(fwd.x, fwd.z);
    const err = angleDiff(heading, cur);
    // yaw = atan2(x, z) grows to the left; steer +1 is right
    const steer = clamp(-err * 2.2, -1, 1);
    if (this.stuck > 1.6) {
      this.stuck = 0;
      this.reverse = 1.3;
      this.badHeading = cur;
      this.badTimer = 4;
      this.reverseSteer = -Math.sign(steer || 1);
    }

    // slow for sharp turns, otherwise hold the wanted speed
    const turnCap = Math.abs(err) > 0.9 ? 9 : Math.abs(err) > 0.5 ? 16 : 99;
    const v = Math.min(wantSpeed, turnCap);
    const throttle = v === 0 ? 0 : speed < v ? 1 : speed < v + 1.5 ? 0.3 : 0;
    const brake = speed > v + 3 ? clamp((speed - v - 3) / 5, 0.2, 1) : wantSpeed === 0 && speed < 2 ? 0.44 : 0;
    if (p.groundedCount === 0) return { throttle, brake: 0, steer: 0, leanX: 0, leanZ: 0 };
    // lean over the bars on climbs so the nose stays down in deep snow
    const leanZ = p.forward.y > 0.12 ? clamp((p.forward.y - 0.12) * 5, 0, 1) : 0;
    return { throttle, brake, steer, leanX: clamp(steer * 0.8, -1, 1), leanZ };
  }

  /** Nothing solid within look m along heading h, and not a wall of snow too steep to climb. */
  private clear(pos: THREE.Vector3, h: number, look: number): boolean {
    const x = pos.x + Math.sin(h) * look, z = pos.z + Math.cos(h) * look;
    const deep = SURFACES[this.terrain.surfaceAt(x, z)].sinkDepth > 0.2 || SURFACES[this.terrain.surfaceAt(pos.x, pos.z)].sinkDepth > 0.2;
    const rise = (this.terrain.heightAt(x, z) - this.terrain.heightAt(pos.x, pos.z)) / look;
    if (Math.abs(rise) > MAX_GRADE || (deep && rise > MAX_GRADE_DEEP)) return false;
    return this.obstacles.countAlong(pos.x, pos.z, x, z, 1.4) === 0;
  }

  resetStuck() {
    this.stuck = 0;
    this.stuckTotal = 0;
    this.reverse = 0;
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
