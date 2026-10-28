import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainData } from '../world/TerrainData';
import { SledPhysics, DriveInput } from './SledPhysics';
import { SledModel, SledVisual } from './SledModel';
import { SledSetup, deriveParams } from './SledSpec';

/** A sled in the world: physics body + visual, with render interpolation between physics steps. */
export class Sled {
  readonly physics: SledPhysics;
  readonly visual: SledVisual;
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private lastInput: DriveInput = { throttle: 0, brake: 0, steer: 0, leanX: 0, leanZ: 0 };
  flippedTime = 0;

  constructor(phys: PhysicsWorld, terrain: TerrainData, public setup: SledSetup, pos: THREE.Vector3, yaw: number) {
    const params = deriveParams(setup);
    this.physics = new SledPhysics(phys, terrain, params, pos, yaw);
    this.visual = new SledModel(setup.spec, params);
    this.physics.readState();
    this.snapshot();
  }

  /** Call right before each physics step. */
  fixedUpdate(dt: number, input: DriveInput) {
    this.snapshot();
    this.lastInput = input;
    this.physics.step(dt, input);
    this.flippedTime = this.physics.isFlipped() ? this.flippedTime + dt : 0;
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
    // visual snow contact sits a bit lower than the ray when sinking, so skis sink into powder
    const len = (i: number) => c[i].maxLen - c[i].compression + 0.0;
    this.visual.setSuspension(len(0), len(1), (len(2) + len(3)) / 2, (len(4) + len(5)) / 2);
    this.visual.setSteer(p.steerAngle);
    this.visual.setTrackSpeed(p.trackSpeed, dt);
    this.visual.setLean(this.lastInput.leanX, this.lastInput.leanZ);
  }

  recover() {
    const p = this.physics;
    const yaw = Math.atan2(p.forward.x, p.forward.z);
    p.teleport(p.position.clone().add(new THREE.Vector3(0, 1.5, 0)), yaw);
    this.snapshot();
  }
}
