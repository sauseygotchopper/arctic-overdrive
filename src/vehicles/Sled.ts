import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainData } from '../world/TerrainData';
import { SledPhysics, DriveInput } from './SledPhysics';
import { SledModel, SledVisual } from './SledModel';
import { SledSetup, deriveParams } from './SledSpec';
import { StuntSystem, TrickControls } from './Tricks';
import type { TreeGrid } from '../world/Scenery';
import handlingData from '../data/handling.json';
import { handling } from '../physics/Handling';
import { Trailer } from './Trailer';
import { CargoItem, CargoType } from './Cargo';
import tricksData from '../data/tricks.json';

/** A sled in the world: physics body + visual + stunts, optional trailer, with render interpolation. */
export class Sled {
  readonly physics: SledPhysics;
  readonly visual: SledVisual;
  readonly stunts: StuntSystem;
  trailer: Trailer | null = null;
  /** Tree trunks to dodge (the ridden sled only): see dodgeTrees. */
  trees: TreeGrid | null = null;
  /** Cargo strapped to the rear rack – part of the sled's own mass. */
  readonly rack: CargoItem[] = [];
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  flippedTime = 0;

  constructor(phys: PhysicsWorld, private terrain: TerrainData, public setup: SledSetup, pos: THREE.Vector3, yaw: number) {
    const params = deriveParams(setup);
    this.physics = new SledPhysics(phys, terrain, params, pos, yaw);
    this.visual = new SledModel(setup.spec, params, setup.livery);
    this.stunts = new StuntSystem(this.physics);
    this.physics.readState();
    this.snapshot();
  }

  /** Total moving mass including anything towed. */
  get totalMass(): number {
    return this.physics.params.mass + (this.trailer?.mass ?? 0);
  }

  /** Call right before each physics step. */
  fixedUpdate(dt: number, input: DriveInput, tricks?: TrickControls) {
    this.snapshot();
    const towing = !!this.trailer?.sled;
    this.stunts.towing = towing;
    this.physics.airControlScale = towing ? tricksData.air.towingScale : 1;
    this.dodgeTrees(dt);
    this.physics.step(dt, input);
    this.stunts.fixedUpdate(dt, tricks ?? { jumpHeld: false, buttons: { trick1: false, trick2: false, trick3: false, trick4: false }, steer: input.steer, leanX: input.leanX, leanZ: input.leanZ });
    this.trailer?.fixedUpdate(dt);
    this.flippedTime = this.physics.isFlipped() ? this.flippedTime + dt : 0;
  }

  attachTrailer(t: Trailer) {
    this.trailer = t;
    t.placeBehind(this.physics);
    t.attach(this.physics);
  }

  detachTrailer() {
    this.trailer?.detach();
    this.trailer = null;
  }

  /**
   * Arcade tree assist (arcade handling only): if a trunk sits in the path the sled will cover in the next moment, nudge the
   * sled sideways (limited acceleration) so a near-miss skims past instead of stopping dead. Dead-centre
   * hits still happen if you aim straight at a tree late; glancing ones mostly become close calls.
   */
  private dodgeTrees(dt: number) {
    const A = handlingData.treeAssist;
    const p = this.physics;
    if (!this.trees || !handling().treeAssist || p.groundedCount === 0) return;
    const v = p.velocity;
    const sp = Math.hypot(v.x, v.z);
    if (sp < A.minSpeed) return;
    const dx = v.x / sp, dz = v.z / sp;
    const sx = -dz, sz = dx; // right of travel (yaw = atan2(x, z) grows to the left)
    const look = Math.min(A.maxLook, sp * A.lookSeconds);
    const px = p.position.x, pz = p.position.z;
    let along = Infinity, lat = 0;
    this.trees.forEachNear(px + dx * look * 0.5, pz + dz * look * 0.5, look * 0.5 + A.clearance, (tx, tz) => {
      const rx = tx - px, rz = tz - pz;
      const a = rx * dx + rz * dz;
      if (a < 0.4 || a > look || a > along) return;
      const l = rx * sx + rz * sz;
      if (Math.abs(l) >= A.clearance) return;
      along = a;
      lat = l;
    });
    if (along === Infinity) return;
    // go the side we're already drifting or steering to when it's dead ahead, else away from the trunk
    const latVel = v.x * sx + v.z * sz;
    const side = Math.abs(lat) > 0.12 ? -Math.sign(lat) : Math.sign(latVel) || 1;
    const need = A.clearance - (side === -Math.sign(lat) ? Math.abs(lat) : -Math.abs(lat));
    const want = need / Math.max(along / sp, 0.12); // sideways speed that clears it in time
    const deficit = want - latVel * side;
    if (deficit <= 0) return;
    const dv = Math.min(deficit, A.maxAccel * dt);
    const m = p.body.mass();
    p.body.applyImpulse({ x: sx * side * dv * m, y: 0, z: sz * side * dv * m }, true);
    // and turn the nose a touch the same way so it reads as a swerve, not a slide
    p.body.applyTorqueImpulse({ x: 0, y: -side * dv * m * A.yawPerDv, z: 0 }, true); // +y yaws left
  }

  /** Re-apply derived params after setup changes (cargo, parts...). */
  refreshSetup() {
    this.physics.setParams(deriveParams(this.setup));
  }

  /** Load the rear rack (adds the cargo's mass to the sled). */
  setRack(types: CargoType[]) {
    for (const c of this.rack) c.dispose();
    this.rack.length = 0;
    for (const t of types) this.rack.push(new CargoItem(t));
    this.syncRack();
  }

  /** Remove one rack item (e.g. it fell off) and return it. */
  dropRackItem(item: CargoItem) {
    const i = this.rack.indexOf(item);
    if (i >= 0) this.rack.splice(i, 1);
    this.syncRack();
  }

  addRackItem(item: CargoItem) {
    this.rack.push(item);
    this.syncRack();
  }

  private syncRack() {
    this.setup.cargoMass = this.rack.reduce((a, c) => a + c.def.massKg, 0);
    this.refreshSetup();
    this.visual.setRack(this.rack.map((c) => c.mesh));
  }

  private snapshot() {
    this.prevPos.copy(this.physics.position);
    this.prevQuat.copy(this.physics.quaternion);
  }

  /** alpha = fraction of the way to the next physics step. */
  render(alpha: number, dt: number) {
    const p = this.physics;
    p.readState();
    const root = this.visual.root;
    root.position.lerpVectors(this.prevPos, p.position, alpha);
    root.quaternion.slerpQuaternions(this.prevQuat, p.quaternion, alpha);
    const c = p.contacts;
    const len = (i: number) => c[i].maxLen - c[i].compression;
    this.visual.setSuspension(len(0), len(1), (len(2) + len(3)) / 2, (len(4) + len(5)) / 2);
    this.visual.setSteer(p.steerAngle);
    this.visual.setTrackSpeed(p.trackSpeed, dt);
    this.visual.setRider(this.stunts.rider, dt);
    this.trailer?.render(alpha);
  }

  /** Remove from the world (sled swap in the garage). */
  dispose(phys: PhysicsWorld, scene: THREE.Scene) {
    phys.world.removeRigidBody(this.physics.body);
    scene.remove(this.visual.root);
    disposeObject(this.visual.root);
  }

  /** Move the sled (and anything hitched to it) – never teleport physics.body directly while towing. */
  teleport(pos: THREE.Vector3, yaw: number) {
    const t = this.trailer;
    t?.detach();
    // on a slope, lift the spawn so no part of the footprint starts buried in the snow
    const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    let ground = -Infinity;
    for (const [a, b] of [[1.4, 0.6], [1.4, -0.6], [-1.6, 0.5], [-1.6, -0.5], [0, 0]]) {
      ground = Math.max(ground, this.terrain.heightAt(pos.x + f.x * a + r.x * b, pos.z + f.z * a + r.z * b));
    }
    pos = pos.clone();
    pos.y = Math.max(pos.y, ground + 0.55);
    this.physics.teleport(pos, yaw);
    this.stunts.reset();
    this.snapshot();
    if (t) {
      t.placeBehind(this.physics);
      t.attach(this.physics);
    }
  }

  recover() {
    const p = this.physics;
    this.teleport(p.position.clone().add(new THREE.Vector3(0, 1.5, 0)), Math.atan2(p.forward.x, p.forward.z));
  }
}
