import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainData } from '../world/TerrainData';
import { SledPhysics, DriveInput } from './SledPhysics';
import { SledModel, SledVisual } from './SledModel';
import { SledSetup, deriveParams } from './SledSpec';
import { StuntSystem, TrickControls } from './Tricks';
import { Trailer } from './Trailer';
import tricksData from '../data/tricks.json';

/** A sled in the world: physics body + visual + stunts, optional trailer, with render interpolation. */
export class Sled {
  readonly physics: SledPhysics;
  readonly visual: SledVisual;
  readonly stunts: StuntSystem;
  trailer: Trailer | null = null;
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  flippedTime = 0;

  constructor(phys: PhysicsWorld, private terrain: TerrainData, public setup: SledSetup, pos: THREE.Vector3, yaw: number) {
    const params = deriveParams(setup);
    this.physics = new SledPhysics(phys, terrain, params, pos, yaw);
    this.visual = new SledModel(setup.spec, params);
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

  /** Re-apply derived params after setup changes (cargo, parts...). */
  refreshSetup() {
    this.physics.setParams(deriveParams(this.setup));
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
