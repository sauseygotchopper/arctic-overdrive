import * as THREE from 'three';
import { Sled } from '../vehicles/Sled';
import { TerrainData } from '../world/TerrainData';

export type CameraMode = 'chase' | 'far' | 'hood';
const MODES: CameraMode[] = ['chase', 'far', 'hood'];

/** Smooth chase camera (two distances) + hood/first-person camera. */
export class CameraRig {
  mode: CameraMode = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private heading = new THREE.Vector3(0, 0, 1);
  private initialised = false;
  private baseFov = 62;
  private prevYaw = 0;
  private roll = 0;
  private t = 0;

  constructor(readonly camera: THREE.PerspectiveCamera, private terrain: TerrainData) {}

  cycle() {
    this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
  }

  setMode(m: CameraMode) {
    this.mode = MODES.includes(m) ? m : 'chase';
    this.initialised = false;
  }

  update(sled: Sled, dt: number) {
    const root = sled.visual.root;
    const p = sled.physics;
    const speed = p.velocity.length();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion);

    if (this.mode === 'hood') {
      const head = sled.visual.headLocal.clone().applyMatrix4(root.matrixWorld);
      this.camera.position.copy(head);
      const target = head.clone().addScaledVector(fwd, 10);
      target.y -= 1.2;
      const m = new THREE.Matrix4().lookAt(head, target, new THREE.Vector3(0, 1, 0).applyQuaternion(root.quaternion).lerp(new THREE.Vector3(0, 1, 0), 0.6));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      this.camera.quaternion.slerp(q, this.initialised ? 1 - Math.exp(-dt * 14) : 1);
      this.initialised = true;
      this.setFov(speed, 8, dt);
      return;
    }

    // chase: follow a flattened heading that blends sled facing and travel direction
    const flatFwd = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flatFwd.lengthSq() < 0.01) flatFwd.copy(this.heading);
    flatFwd.normalize();
    const vel = new THREE.Vector3(p.velocity.x, 0, p.velocity.z);
    if (vel.length() > 4 && vel.dot(flatFwd) > 0) flatFwd.lerp(vel.normalize(), 0.35).normalize();
    // in the air, hold heading so flips/spins read clearly
    const headingRate = p.groundedCount === 0 ? 0.6 : 4.5;
    this.heading.lerp(flatFwd, this.initialised ? 1 - Math.exp(-dt * headingRate) : 1).normalize();

    const far = this.mode === 'far';
    const towing = sled.trailer ? 1 : 0;
    // low and close like a follow-cam on a rider; pulls back a little with speed
    const dist = (far ? 9.0 : 5.2) + Math.min(speed, 40) * 0.03 + towing * 3.5;
    const height = (far ? 3.2 : 1.75) + towing * 1.0;
    const center = root.position.clone().add(new THREE.Vector3(0, 1.0, 0));
    const desired = center.clone().addScaledVector(this.heading, -dist);
    desired.y += height;
    const ground = this.terrain.heightAt(desired.x, desired.z) + 1.0;
    if (desired.y < ground) desired.y = ground;

    if (!this.initialised) {
      this.pos.copy(desired);
      this.look.copy(center);
      this.initialised = true;
    }
    this.pos.lerp(desired, 1 - Math.exp(-dt * 6));
    this.look.lerp(center.addScaledVector(this.heading, 3.5), 1 - Math.exp(-dt * 10));
    this.camera.position.copy(this.pos);
    // faint high-speed buzz
    this.t += dt;
    const buzz = THREE.MathUtils.smoothstep(speed, 22, 40) * 0.025;
    this.camera.position.x += Math.sin(this.t * 37) * buzz;
    this.camera.position.y += Math.sin(this.t * 29 + 1.3) * buzz;
    this.camera.lookAt(this.look);
    // bank gently into turns
    const yaw = Math.atan2(this.heading.x, this.heading.z);
    let dy = yaw - this.prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.prevYaw = yaw;
    const targetRoll = dt > 0 ? THREE.MathUtils.clamp((dy / dt) * 0.035, -0.06, 0.06) : 0;
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 4);
    this.camera.rotateZ(this.roll);
    this.setFov(speed, 12, dt);
  }

  private setFov(speed: number, extra: number, dt: number) {
    const target = this.baseFov + THREE.MathUtils.smoothstep(speed, 15, 42) * extra;
    this.camera.fov += (target - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();
  }
}
