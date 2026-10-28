import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { PoseName } from '../vehicles/Rider';

const POSES: (PoseName | null)[] = [null, 'seated', 'crouch', 'superman', 'canCan', 'heelClicker', 'nacNac', 'seatGrab', 'cliffhanger'];
const STRIDE = 29;
const RATE = 30;
const SECONDS = 25;

type Shot = 'trackside' | 'chaseLow' | 'orbit' | 'heli';
const SHOTS: Shot[] = ['chaseLow', 'trackside', 'orbit', 'trackside', 'heli'];

/**
 * Always-on ring buffer of the last 25 s of the player's visual state, played back with
 * cinematic camera cuts (and slow motion while airborne).
 */
export class Replay {
  private buf = new Float32Array(RATE * SECONDS * STRIDE);
  private count = 0;
  private head = 0;
  private acc = 0;
  private clock = 0;
  active = false;
  private playT = 0;
  private startT = 0;
  private endT = 0;
  private shot = 0;
  private shotTime = 0;
  private shotAnchor = new THREE.Vector3();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private qb = new THREE.Quaternion();

  constructor(private game: Game) {}

  record(dt: number) {
    this.clock += dt;
    this.acc += dt;
    if (this.acc < 1 / RATE) return;
    this.acc = 0;
    const g = this.game;
    const s = g.player;
    const r = s.visual.root;
    const p = s.physics;
    const c = p.contacts;
    const len = (i: number) => c[i].maxLen - c[i].compression;
    const st = s.stunts.rider;
    const t = s.trailer;
    const b = this.buf;
    // a teleport (respawn, recover, mode start) breaks continuity: start a fresh recording
    if (this.count > 0) {
      const l = this.frame(this.count - 1);
      if (Math.hypot(b[l + 1] - r.position.x, b[l + 3] - r.position.z) > 15) this.count = 0;
    }
    const o = this.head * STRIDE;
    b.set([
      this.clock, r.position.x, r.position.y, r.position.z, r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w,
      p.steerAngle, len(0), len(1), (len(2) + len(3)) / 2, (len(4) + len(5)) / 2, p.trackSpeed,
      st.leanX, st.leanZ, st.crouch, POSES.indexOf(st.pose), st.poseSide, st.poseAmount, p.groundedCount > 0 ? 1 : 0,
      t ? 1 : 0, t?.root.position.x ?? 0, t?.root.position.y ?? 0, t?.root.position.z ?? 0,
      t?.root.quaternion.x ?? 0, t?.root.quaternion.y ?? 0, t?.root.quaternion.z ?? 0, t?.root.quaternion.w ?? 1,
    ], o);
    this.head = (this.head + 1) % (RATE * SECONDS);
    this.count = Math.min(this.count + 1, RATE * SECONDS);
  }

  private frame(i: number): number {
    const n = RATE * SECONDS;
    return ((this.head - this.count + i + n) % n) * STRIDE;
  }

  private findFrame(t: number): number {
    let lo = 0, hi = this.count - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.buf[this.frame(mid)] <= t) lo = mid; else hi = mid;
    }
    return lo;
  }

  play() {
    if (this.count < RATE * 2) { this.game.hud.toast('Ride a bit first – nothing to replay yet'); return; }
    this.active = true;
    this.startT = this.buf[this.frame(0)];
    this.endT = this.buf[this.frame(this.count - 1)];
    this.playT = this.startT;
    this.shot = 0;
    this.shotTime = 0;
    this.pickAnchor();
    this.game.hud.el.classList.add('replaying');
  }

  stop() {
    this.active = false;
    this.game.hud.el.classList.remove('replaying');
  }

  private pickAnchor() {
    // trackside camera: a spot ~2 s ahead along the recorded path, off to one side
    const i = Math.min(this.count - 1, this.findFrame(this.playT) + RATE * 2);
    const o = this.frame(i);
    const b = this.buf;
    this.q.set(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.q).setY(0).normalize().multiplyScalar(this.shot % 2 ? 7 : -7);
    this.shotAnchor.set(b[o + 1], b[o + 2], b[o + 3]).add(side);
    this.shotAnchor.y = Math.max(this.shotAnchor.y, this.game.terrain.heightAt(this.shotAnchor.x, this.shotAnchor.z)) + 1.6;
  }

  /** Advance playback and pose the sled + camera. Returns false when finished. */
  update(dt: number): boolean {
    if (!this.active) return false;
    const g = this.game;
    const b = this.buf;
    const i = this.findFrame(this.playT);
    const o = this.frame(i), o2 = this.frame(Math.min(this.count - 1, i + 1));
    const k = THREE.MathUtils.clamp((this.playT - b[o]) / Math.max(1e-4, b[o2] - b[o]), 0, 1);
    const airborne = b[o + 20] < 0.5;
    this.playT += dt * (airborne ? 0.4 : 1);
    this.shotTime += dt;
    if (this.shotTime > 3.2) {
      this.shotTime = 0;
      this.shot = (this.shot + 1) % SHOTS.length;
      this.pickAnchor();
    }
    const vis = g.player.visual;
    const r = vis.root;
    r.position.set(b[o + 1] + (b[o2 + 1] - b[o + 1]) * k, b[o + 2] + (b[o2 + 2] - b[o + 2]) * k, b[o + 3] + (b[o2 + 3] - b[o + 3]) * k);
    this.q.set(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    this.qb.set(b[o2 + 4], b[o2 + 5], b[o2 + 6], b[o2 + 7]);
    r.quaternion.slerpQuaternions(this.q, this.qb, k);
    vis.setSteer(b[o + 8]);
    vis.setSuspension(b[o + 9], b[o + 10], b[o + 11], b[o + 12]);
    vis.setTrackSpeed(b[o + 13], dt);
    vis.setRider({ leanX: b[o + 14], leanZ: b[o + 15], crouch: b[o + 16], pose: POSES[b[o + 17]] ?? null, poseSide: b[o + 18], poseAmount: b[o + 19] }, dt);
    const t = g.player.trailer;
    if (t && b[o + 21] > 0.5) {
      t.root.position.set(b[o + 22], b[o + 23], b[o + 24]);
      t.root.quaternion.set(b[o + 25], b[o + 26], b[o + 27], b[o + 28]);
    }
    this.camera(r.position, r.quaternion);
    if (this.playT >= this.endT) { this.stop(); return false; }
    return true;
  }

  private camera(pos: THREE.Vector3, quat: THREE.Quaternion) {
    const cam = this.game.camera;
    const fwd = this.v.set(0, 0, 1).applyQuaternion(quat).setY(0).normalize();
    const target = pos.clone().add(new THREE.Vector3(0, 0.8, 0));
    switch (SHOTS[this.shot]) {
      case 'chaseLow':
        cam.position.copy(pos).addScaledVector(fwd, -4.2).add(new THREE.Vector3(0, 0.9, 0));
        cam.fov = 62;
        break;
      case 'trackside':
        cam.position.copy(this.shotAnchor);
        cam.fov = 40;
        break;
      case 'orbit': {
        const a = this.shotTime * 0.45;
        cam.position.copy(pos).add(new THREE.Vector3(Math.sin(a) * 7, 2.4, Math.cos(a) * 7));
        cam.fov = 50;
        break;
      }
      case 'heli':
        cam.position.copy(pos).addScaledVector(fwd, -18).add(new THREE.Vector3(6, 16, 0));
        cam.fov = 45;
        break;
    }
    const ground = this.game.terrain.heightAt(cam.position.x, cam.position.z) + 0.5;
    cam.position.y = Math.max(cam.position.y, ground);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
  }
}
