import * as THREE from 'three';
import { box, orientBetween } from './geometry';

export type PoseName = 'seated' | 'crouch' | 'superman' | 'canCan' | 'heelClicker' | 'nacNac' | 'seatGrab' | 'cliffhanger';

/** What the rider is doing this frame (driven by StuntSystem + input). */
export interface RiderState {
  leanX: number; // +right
  leanZ: number; // +forward
  crouch: number; // 0..1 (pop preload)
  pose: PoseName | null;
  poseSide: number; // +1 / -1 for asymmetric poses
  poseAmount: number; // 0..1 blend from seated into pose
}

interface Pose {
  hips: THREE.Vector3;
  chest: THREE.Vector3;
  footL: THREE.Vector3;
  footR: THREE.Vector3;
  handL: THREE.Vector3 | null; // null = on the grip
  handR: THREE.Vector3 | null;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// Sled-local coordinates (+X = rider's left, +Z forward). Mirror with poseSide for one-sided poses.
const POSES: Record<PoseName, Pose> = {
  seated:      { hips: v(0, 0.52, -0.42), chest: v(0, 1.0, -0.2),   footL: v(0.33, -0.02, -0.02), footR: v(-0.33, -0.02, -0.02), handL: null, handR: null },
  crouch:      { hips: v(0, 0.66, -0.5),  chest: v(0, 1.0, -0.08),  footL: v(0.33, -0.02, -0.06), footR: v(-0.33, -0.02, -0.06), handL: null, handR: null },
  superman:    { hips: v(0, 1.12, -0.98), chest: v(0, 1.1, -0.38),  footL: v(0.2, 1.2, -1.85),    footR: v(-0.2, 1.15, -1.85),   handL: null, handR: null },
  heelClicker: { hips: v(0, 0.62, -0.58), chest: v(0, 1.06, -0.48), footL: v(0.05, 1.05, 0.72),   footR: v(-0.05, 1.05, 0.72),   handL: null, handR: null },
  canCan:      { hips: v(0.1, 0.6, -0.42), chest: v(0.06, 1.02, -0.22), footL: v(0.33, -0.02, -0.02), footR: v(0.55, 0.6, 0.05),  handL: null, handR: null },
  nacNac:      { hips: v(0.16, 0.78, -0.44), chest: v(0.12, 1.15, -0.2), footL: v(0.33, -0.02, -0.02), footR: v(0.42, 0.95, -1.3), handL: null, handR: null },
  seatGrab:    { hips: v(0, 0.98, -0.3),  chest: v(0, 1.42, -0.12), footL: v(0.33, -0.02, 0.0),   footR: v(-0.33, -0.02, 0.0),   handL: v(0.2, 0.5, -1.0), handR: null },
  cliffhanger: { hips: v(0, 1.22, -0.18), chest: v(0, 1.72, -0.38), footL: v(0.14, 0.8, 0.3),     footR: v(-0.14, 0.8, 0.3),     handL: v(0.48, 2.1, -0.3), handR: v(-0.48, 2.1, -0.3) },
};

const THIGH = 0.46, SHIN = 0.46, UPPER_ARM = 0.33, FOREARM = 0.33;

/** Procedural rider: pose targets blended per frame, limbs solved with two-bone IK. */
export class RiderRig {
  readonly group = new THREE.Group();
  readonly headPos = new THREE.Vector3();
  private torso: THREE.Mesh;
  private jacket: THREE.Mesh;
  private pelvis: THREE.Mesh;
  private helmet = new THREE.Group();
  private limbs: Record<'thighL' | 'thighR' | 'shinL' | 'shinR' | 'upperL' | 'upperR' | 'foreL' | 'foreR', THREE.Mesh>;
  private bootL: THREE.Mesh;
  private bootR: THREE.Mesh;
  private gloveL: THREE.Mesh;
  private gloveR: THREE.Mesh;
  private cur: Pose = clonePose(POSES.seated);

  constructor(suitColor: THREE.ColorRepresentation = 0x1e2a3a, accentColor: THREE.ColorRepresentation = 0x2fb5ff, helmetColor: THREE.ColorRepresentation = 0xf2f4f7) {
    const suit = new THREE.MeshStandardMaterial({ color: suitColor, roughness: 0.85 });
    const accent = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.7 });
    const helmetMat = new THREE.MeshPhysicalMaterial({ color: helmetColor, roughness: 0.3, clearcoat: 1 });
    const visorMat = new THREE.MeshPhysicalMaterial({ color: 0x111820, roughness: 0.05, metalness: 0.6 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
    const cap = (r: number, m: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, 1, 4, 10), m);
      this.group.add(mesh);
      return mesh;
    };
    this.torso = cap(0.17, suit);
    this.jacket = cap(0.185, accent);
    this.pelvis = box(0.34, 0.16, 0.26, suit);
    this.group.add(this.pelvis);
    this.limbs = {
      thighL: cap(0.085, suit), thighR: cap(0.085, suit), shinL: cap(0.072, suit), shinR: cap(0.072, suit),
      upperL: cap(0.062, accent), upperR: cap(0.062, accent), foreL: cap(0.055, suit), foreR: cap(0.055, suit),
    };
    this.bootL = box(0.11, 0.11, 0.27, bootMat);
    this.bootR = box(0.11, 0.11, 0.27, bootMat);
    this.gloveL = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), bootMat);
    this.gloveR = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), bootMat);
    this.group.add(this.bootL, this.bootR, this.gloveL, this.gloveR);

    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), helmetMat);
    shell.scale.set(1, 1, 1.12);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.152, 16, 8, Math.PI / 2 - 0.9, 1.8, 1.1, 0.7), visorMat);
    visor.scale.copy(shell.scale);
    const chin = box(0.14, 0.06, 0.1, helmetMat);
    chin.position.set(0, -0.1, 0.15);
    this.helmet.add(shell, visor, chin);
    this.group.add(this.helmet);
  }

  update(dt: number, s: RiderState, gripL: THREE.Vector3, gripR: THREE.Vector3) {
    // target pose = seated/crouch blended toward the trick pose
    const base = blendPose(POSES.seated, POSES.crouch, s.crouch);
    const target = s.pose && s.pose !== 'seated'
      ? blendPose(base, mirrorPose(POSES[s.pose], s.poseSide), smooth(s.poseAmount))
      : base;
    // lean shifts hips/chest; standing slightly when leaning hard
    const lx = -s.leanX, lz = s.leanZ;
    const leanW = 1 - smooth(s.poseAmount);
    target.hips.add(v(lx * 0.2, Math.abs(lx) * 0.1 + Math.max(0, lz) * 0.08, lz * 0.14).multiplyScalar(leanW));
    target.chest.add(v(lx * 0.36, Math.abs(lx) * 0.06, lz * 0.26).multiplyScalar(leanW));
    // follow quickly but not instantly, so pose changes look physical
    const k = 1 - Math.exp(-dt * 18);
    for (const key of ['hips', 'chest', 'footL', 'footR'] as const) this.cur[key].lerp(target[key], k);
    this.cur.handL = lerpHand(this.cur.handL, target.handL, gripL, k);
    this.cur.handR = lerpHand(this.cur.handR, target.handR, gripR, k);
    this.solve(gripL, gripR);
  }

  private solve(gripL: THREE.Vector3, gripR: THREE.Vector3) {
    const p = this.cur;
    const spine = new THREE.Vector3().subVectors(p.chest, p.hips);
    const spineDir = spine.clone().normalize();
    const fwd = v(0, 0, 1);
    const side = new THREE.Vector3().crossVectors(spineDir, fwd).normalize(); // rider's left-ish

    orientBetween(this.torso, p.hips, p.chest, 1, 0.17);
    orientBetween(this.jacket, p.hips.clone().addScaledVector(spine, 0.45), p.chest, 1, 0.185);
    this.pelvis.position.copy(p.hips);
    this.pelvis.quaternion.copy(this.torso.quaternion);

    // head
    const neck = p.chest.clone().addScaledVector(spineDir, 0.28).add(v(0, 0, 0.06));
    this.headPos.copy(neck);
    this.helmet.position.copy(neck);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd.clone().addScaledVector(spineDir, -0.2).negate(), spineDir);
    this.helmet.quaternion.setFromRotationMatrix(m);

    // legs (knees bend forward/outward)
    for (const s of [1, -1]) {
      const hip = p.hips.clone().addScaledVector(side, 0.12 * s);
      const foot = s > 0 ? p.footL : p.footR;
      const knee = solveIK(hip, foot, THIGH, SHIN, v(0.25 * s, 0.4, 1));
      orientBetween(s > 0 ? this.limbs.thighL : this.limbs.thighR, hip, knee, 1, 0.085);
      orientBetween(s > 0 ? this.limbs.shinL : this.limbs.shinR, knee, foot, 1, 0.072);
      const boot = s > 0 ? this.bootL : this.bootR;
      boot.position.copy(foot).add(v(0, 0.02, 0.06));
    }
    // arms (elbows out and down)
    for (const s of [1, -1]) {
      const shoulder = p.chest.clone().addScaledVector(side, 0.2 * s).addScaledVector(spineDir, -0.04);
      const hand = (s > 0 ? p.handL : p.handR) ?? (s > 0 ? gripL : gripR);
      const elbow = solveIK(shoulder, hand, UPPER_ARM, FOREARM, v(0.6 * s, -0.6, -0.2));
      orientBetween(s > 0 ? this.limbs.upperL : this.limbs.upperR, shoulder, elbow, 1, 0.062);
      orientBetween(s > 0 ? this.limbs.foreL : this.limbs.foreR, elbow, hand, 1, 0.055);
      (s > 0 ? this.gloveL : this.gloveR).position.copy(hand);
    }
  }
}

function smooth(t: number) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function clonePose(p: Pose): Pose {
  return { hips: p.hips.clone(), chest: p.chest.clone(), footL: p.footL.clone(), footR: p.footR.clone(), handL: p.handL?.clone() ?? null, handR: p.handR?.clone() ?? null };
}

function mirrorPose(p: Pose, side: number): Pose {
  const c = clonePose(p);
  if (side >= 0) return c;
  const m = (x: THREE.Vector3 | null) => (x ? x.set(-x.x, x.y, x.z) : null);
  m(c.hips); m(c.chest); m(c.footL); m(c.footR); m(c.handL); m(c.handR);
  [c.footL, c.footR] = [c.footR, c.footL];
  [c.handL, c.handR] = [c.handR, c.handL];
  return c;
}

/** Blend two poses. Hands blend between "on grip" (null) and free targets via the grip position later. */
function blendPose(a: Pose, b: Pose, t: number): Pose {
  return {
    hips: a.hips.clone().lerp(b.hips, t),
    chest: a.chest.clone().lerp(b.chest, t),
    footL: a.footL.clone().lerp(b.footL, t),
    footR: a.footR.clone().lerp(b.footR, t),
    handL: t > 0.5 ? b.handL?.clone() ?? null : a.handL?.clone() ?? null,
    handR: t > 0.5 ? b.handR?.clone() ?? null : a.handR?.clone() ?? null,
  };
}

function lerpHand(cur: THREE.Vector3 | null, target: THREE.Vector3 | null, grip: THREE.Vector3, k: number): THREE.Vector3 | null {
  const from = cur ?? grip.clone();
  const to = target ?? grip;
  const r = from.clone().lerp(to, k);
  // snap back onto the grip once close so hands stay locked to the bars while steering
  if (!target && r.distanceTo(grip) < 0.02) return null;
  return r;
}

/** Two-bone IK: joint position for a limb from a → c with segment lengths l1, l2, bending toward `hint`. */
function solveIK(a: THREE.Vector3, c: THREE.Vector3, l1: number, l2: number, hint: THREE.Vector3): THREE.Vector3 {
  const ac = new THREE.Vector3().subVectors(c, a);
  let d = ac.length();
  const dir = ac.clone().normalize();
  d = Math.min(d, l1 + l2 - 1e-3);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const bend = hint.clone().addScaledVector(dir, -hint.dot(dir));
  if (bend.lengthSq() < 1e-6) bend.set(0, 1, 0);
  bend.normalize();
  return a.clone().addScaledVector(dir, x).addScaledVector(bend, h);
}
