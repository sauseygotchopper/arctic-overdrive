import * as THREE from 'three';
import { SledModel } from '../vehicles/SledModel';
import { SledSpec, deriveParams, RIDER_MASS } from '../vehicles/SledSpec';
import { PhysicsWorldLike } from './types';

const STRIDE = 9; // t, x, y, z, qx, qy, qz, qw, steer
const RATE = 20; // Hz

/** Records a run as compact keyframes. */
export class GhostRecorder {
  private data: number[] = [];
  private acc = 0;

  reset() { this.data = []; this.acc = 0; }

  sample(t: number, dt: number, p: PhysicsWorldLike) {
    this.acc += dt;
    if (this.acc < 1 / RATE && this.data.length) return;
    this.acc = 0;
    const q = p.quaternion;
    this.data.push(t, p.position.x, p.position.y, p.position.z, q.x, q.y, q.z, q.w, p.steerAngle);
  }

  toArray(): Float32Array { return new Float32Array(this.data); }
}

/** Plays a recorded run back as a translucent sled. */
export class GhostPlayer {
  readonly model: SledModel;
  private frames: Float32Array;
  private q0 = new THREE.Quaternion();
  private q1 = new THREE.Quaternion();

  constructor(spec: SledSpec, frames: Float32Array) {
    this.frames = frames;
    this.model = new SledModel(spec, deriveParams({ spec, riderMass: RIDER_MASS, cargoMass: 0 }));
    const ghostMat = new THREE.MeshStandardMaterial({ color: 0x9fd3ff, emissive: 0x2a6fa8, emissiveIntensity: 0.6, transparent: true, opacity: 0.38, depthWrite: false, roughness: 0.4 });
    this.model.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.material = ghostMat; m.castShadow = false; m.receiveShadow = false; }
      if ((o as THREE.Light).isLight) o.visible = false;
    });
    this.model.setRider({ leanX: 0, leanZ: 0, crouch: 0, pose: null, poseSide: 1, poseAmount: 0 }, 1);
  }

  get duration(): number {
    return this.frames.length >= STRIDE ? this.frames[this.frames.length - STRIDE] : 0;
  }

  /** Position the ghost at time t (s). */
  set(t: number) {
    const f = this.frames;
    const n = f.length / STRIDE;
    if (n < 2) { this.model.root.visible = false; return; }
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid * STRIDE] <= t) lo = mid; else hi = mid;
    }
    const a = lo * STRIDE, b = hi * STRIDE;
    const k = THREE.MathUtils.clamp((t - f[a]) / Math.max(1e-4, f[b] - f[a]), 0, 1);
    const r = this.model.root;
    r.visible = t <= this.duration + 1;
    r.position.set(f[a + 1] + (f[b + 1] - f[a + 1]) * k, f[a + 2] + (f[b + 2] - f[a + 2]) * k, f[a + 3] + (f[b + 3] - f[a + 3]) * k);
    this.q0.set(f[a + 4], f[a + 5], f[a + 6], f[a + 7]);
    this.q1.set(f[b + 4], f[b + 5], f[b + 6], f[b + 7]);
    r.quaternion.slerpQuaternions(this.q0, this.q1, k);
    this.model.setSteer(f[a + 8] + (f[b + 8] - f[a + 8]) * k);
  }

  /** Ghost's position at time t, for the minimap. */
  positionAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    this.set(t);
    return out.copy(this.model.root.position);
  }
}

const KEY = (course: string) => `arctic-overdrive-ghost-${course}`;

export function saveGhost(course: string, frames: Float32Array) {
  try {
    const bytes = new Uint8Array(frames.buffer, frames.byteOffset, frames.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    localStorage.setItem(KEY(course), btoa(bin));
  } catch { /* storage full – ghost just won't persist */ }
}

export function loadGhost(course: string): Float32Array | null {
  try {
    const s = localStorage.getItem(KEY(course));
    if (!s) return null;
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}
