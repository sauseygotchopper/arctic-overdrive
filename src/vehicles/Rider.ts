import * as THREE from 'three';
import { aim, box, mergeStatic, orientBetween, tube } from './geometry';

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

export interface RiderLook {
  /** modular = road-style shell with a face shield; mx = motocross shell, peak and goggles */
  helmet: 'modular' | 'mx';
  /** avalanche backpack (mountain riders) */
  pack: boolean;
}

// instance slots: tapered limb segments, and spheres for joints / pads / pelvis
const enum L { thighL, thighR, shinL, shinR, upperL, upperR, foreL, foreR, neck }
const enum J { kneeL, kneeR, elbowL, elbowR, shoulderL, shoulderR, padL, padR, pelvis }
const LIMB_R = [0.096, 0.096, 0.074, 0.074, 0.07, 0.07, 0.056, 0.056, 0.09];
const SCR = new THREE.Object3D();

/** Procedural rider: pose targets blended per frame, limbs solved with two-bone IK. */
export class RiderRig {
  readonly group = new THREE.Group();
  readonly headPos = new THREE.Vector3();
  private torso: THREE.Mesh;
  private torsoFrame = new THREE.Group();
  private helmet = new THREE.Group();
  private limbs: THREE.InstancedMesh;
  private joints: THREE.InstancedMesh;
  private bootL: THREE.Group;
  private bootR: THREE.Group;
  private gloveL: THREE.Group;
  private gloveR: THREE.Group;
  private cur: Pose = clonePose(POSES.seated);

  constructor(suitColor: THREE.ColorRepresentation = 0x1e2a3a, accentColor: THREE.ColorRepresentation = 0x2fb5ff, helmetColor: THREE.ColorRepresentation = 0xf2f4f7, look: RiderLook = { helmet: 'modular', pack: false }) {
    const suitC = new THREE.Color(suitColor), accentC = new THREE.Color(accentColor), helmetC = new THREE.Color(helmetColor);
    const pantsC = suitC.clone().multiplyScalar(0.55);
    const jacket = new THREE.MeshStandardMaterial({ map: jacketTexture(suitC, accentC), roughness: 0.82 });
    const accent = new THREE.MeshStandardMaterial({ color: accentC, roughness: 0.7 });
    const helmetMat = new THREE.MeshPhysicalMaterial({ map: helmetTexture(helmetC, accentC, suitC), roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08 });
    const visorMat = new THREE.MeshPhysicalMaterial({ color: 0x0d1218, roughness: 0.04, metalness: 0.7, clearcoat: 1 });
    const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xff8a2a, roughness: 0.05, metalness: 0.95, iridescence: 1, iridescenceIOR: 1.6 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.75 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.6 });

    // torso: a lathe, flattened front-to-back, spanning hips → chest (unit length, scaled per frame)
    const torsoGeo = new THREE.LatheGeometry([
      [0.0, -0.52], [0.13, -0.5], [0.155, -0.4], [0.16, -0.2], [0.172, 0.0], [0.188, 0.2], [0.198, 0.34], [0.17, 0.44], [0.1, 0.52], [0.075, 0.56], [0.0, 0.57],
    ].map(([r, y]) => new THREE.Vector2(r, y)), 20);
    torsoGeo.scale(1.15, 1, 0.85);
    this.torso = new THREE.Mesh(torsoGeo, jacket);
    this.group.add(this.torso, this.torsoFrame);

    // limbs + neck: one tapered tube instanced per segment; joints, kneepads and pelvis: spheres
    const skin = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    this.limbs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.82, 1, 1, 12, 1, true), skin, 9);
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), skin, 9);
    for (const im of [this.limbs, this.joints]) { im.frustumCulled = false; this.group.add(im); }
    [pantsC, pantsC, pantsC, pantsC, suitC, suitC, suitC, suitC, suitC].forEach((c, i) => this.limbs.setColorAt(i, c));
    [pantsC, pantsC, suitC, suitC, accentC, accentC, accentC, accentC, pantsC].forEach((c, i) => this.joints.setColorAt(i, c));

    // boots: tall shaft, rounded toe, chunky sole, accent cuff (local +Y up the shin, +Z toward the toe)
    const boot = () => {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.066, 0.24, 12), bootMat);
      shaft.position.y = 0.1;
      const toeGeo = new THREE.SphereGeometry(1, 14, 8);
      toeGeo.scale(0.062, 0.052, 0.13);
      const toe = new THREE.Mesh(toeGeo, bootMat);
      toe.position.set(0, 0.0, 0.07);
      const sole = box(0.115, 0.03, 0.29, trimMat);
      sole.position.set(0, -0.04, 0.055);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.035, 12), accent);
      cuff.position.y = 0.22;
      const buckle = box(0.02, 0.03, 0.03, trimMat);
      buckle.position.set(0.07, 0.12, 0.02);
      g.add(shaft, toe, sole, cuff, buckle);
      this.group.add(g);
      return g;
    };
    this.bootL = boot();
    this.bootR = boot();
    // gauntlet gloves (local +Y along the forearm, fist at the origin)
    const glove = () => {
      const g = new THREE.Group();
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.068, 0.11, 12, 1, true), bootMat);
      cuff.position.y = -0.08;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.022, 12), accent);
      band.position.y = -0.13;
      const fistGeo = new THREE.SphereGeometry(1, 12, 8);
      fistGeo.scale(0.05, 0.065, 0.045);
      const fist = new THREE.Mesh(fistGeo, bootMat);
      g.add(cuff, band, fist);
      this.group.add(g);
      return g;
    };
    this.gloveL = glove();
    this.gloveR = glove();

    // backpack rides in the torso frame (origin at the hips, +Y up the spine, +Z forward)
    if (look.pack) {
      const packGeo = new THREE.CapsuleGeometry(0.1, 0.2, 4, 12);
      packGeo.scale(1.3, 1, 0.6);
      const pack = new THREE.Mesh(packGeo, accent);
      pack.position.set(0, 0.3, -0.2);
      const lid = box(0.2, 0.03, 0.1, trimMat);
      lid.position.set(0, 0.45, -0.2);
      this.torsoFrame.add(pack, lid);
      for (const s of [-1, 1]) this.torsoFrame.add(tube([[s * 0.1, 0.2, -0.16], [s * 0.1, 0.5, -0.1], [s * 0.1, 0.52, 0.06], [s * 0.09, 0.36, 0.16]], 0.014, trimMat, 10));
      this.torsoFrame.add(tube([[-0.1, 0.36, 0.165], [0, 0.355, 0.175], [0.1, 0.36, 0.165]], 0.012, trimMat, 6));
    }

    // ---------- helmet (local +Z = face, +Y = up) ----------
    const skull = new THREE.Group();
    skull.scale.set(1, 1.02, 1.12);
    this.helmet.add(skull);
    const R = 0.145;
    // sphere slices: phi π/2 faces forward, theta measured down from the crown
    const slice = (r: number, phiHalf: number, th0: number, th1: number, m: THREE.Material) =>
      new THREE.Mesh(new THREE.SphereGeometry(r, 24, 8, Math.PI / 2 - phiHalf, phiHalf * 2, th0, th1 - th0), m);
    skull.add(new THREE.Mesh(new THREE.SphereGeometry(R, 28, 18), helmetMat));
    if (look.helmet === 'modular') {
      skull.add(slice(R + 0.006, 1.05, 1.02, 1.86, visorMat));
      const chin = slice(R + 0.012, 1.15, 1.86, 2.55, helmetMat);
      chin.scale.set(1, 1, 1.06);
      skull.add(chin);
      // low rear spoiler lip
      skull.add(slice(R + 0.008, 0.5, 1.45, 1.7, trimMat).rotateY(Math.PI));
      for (const s of [-1, 1]) {
        const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.01, 10), trimMat);
        pivot.rotation.z = Math.PI / 2;
        pivot.position.set(s * (R + 0.008), -0.005, 0.03);
        this.helmet.add(pivot);
      }
    } else {
      // goggle frame + mirrored lens + strap, then the long MX chin bar and peak
      skull.add(slice(R + 0.004, 2 * Math.PI / 2, 1.2, 1.42, trimMat));
      skull.add(slice(R + 0.01, 0.95, 1.08, 1.66, trimMat));
      skull.add(slice(R + 0.016, 0.82, 1.14, 1.6, lensMat));
      const chinGeo = new THREE.SphereGeometry(1, 18, 10, Math.PI / 2 - 1.0, 2.0, Math.PI / 2 + 0.25, 1.1);
      chinGeo.scale(0.13, 0.13, 0.2);
      const chin = new THREE.Mesh(chinGeo, helmetMat);
      chin.position.set(0, -0.01, 0.03);
      const mouth = box(0.05, 0.03, 0.02, trimMat);
      mouth.position.set(0, -0.08, 0.2);
      mouth.rotation.x = -0.6;
      // peak: a shallow curved shell slice pulled forward over the goggles
      const peakGeo = new THREE.SphereGeometry(0.22, 18, 4, Math.PI / 2 - 0.75, 1.5, 0.45, 0.55);
      peakGeo.scale(1, 0.45, 1.1);
      const peak = new THREE.Mesh(peakGeo, new THREE.MeshPhysicalMaterial({ color: accentC, roughness: 0.3, clearcoat: 1, side: THREE.DoubleSide }));
      peak.position.set(0, 0.025, -0.02);
      peak.rotation.x = -0.18;
      this.helmet.add(chin, mouth, peak);
    }
    this.group.add(this.helmet);
    for (const g of [this.helmet, this.bootL, this.bootR, this.gloveL, this.gloveR, this.torsoFrame]) mergeStatic(g);
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

    orientBetween(this.torso, p.hips, p.chest);
    this.joint(J.pelvis, p.hips, 0.17, 0.12, 0.145, this.torso.quaternion);
    this.torsoFrame.position.copy(p.hips);
    this.torsoFrame.quaternion.copy(this.torso.quaternion);

    // head
    const neck = p.chest.clone().addScaledVector(spineDir, 0.28).add(v(0, 0, 0.06));
    this.headPos.copy(neck);
    this.helmet.position.copy(neck);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd.clone().addScaledVector(spineDir, -0.2).negate(), spineDir);
    this.helmet.quaternion.setFromRotationMatrix(m);
    this.limb(L.neck, p.chest.clone().addScaledVector(spineDir, 0.08), neck.clone().addScaledVector(spineDir, -0.08));

    // legs (knees bend forward/outward)
    for (const s of [1, -1]) {
      const left = s > 0;
      const hip = p.hips.clone().addScaledVector(side, 0.1 * s);
      const foot = left ? p.footL : p.footR;
      const knee = solveIK(hip, foot, THIGH, SHIN, v(0.25 * s, 0.4, 1));
      this.limb(left ? L.thighL : L.thighR, hip, knee);
      this.limb(left ? L.shinL : L.shinR, knee, foot);
      this.joint(left ? J.kneeL : J.kneeR, knee, 0.078);
      // kneepad faces along the bend
      const out = knee.clone().sub(hip.clone().add(foot).multiplyScalar(0.5)).normalize();
      this.joint(left ? J.padL : J.padR, knee.clone().addScaledVector(out, 0.055), 0.07, 0.08, 0.035, new THREE.Quaternion().setFromUnitVectors(v(0, 0, 1), out));
      const bootG = left ? this.bootL : this.bootR;
      bootG.position.copy(foot).add(v(0, 0.03, 0));
      basis(bootG, knee.clone().sub(foot), fwd);
    }
    // arms (elbows out and down)
    for (const s of [1, -1]) {
      const left = s > 0;
      const shoulder = p.chest.clone().addScaledVector(side, 0.2 * s).addScaledVector(spineDir, -0.04);
      const hand = (left ? p.handL : p.handR) ?? (left ? gripL : gripR);
      const elbow = solveIK(shoulder, hand, UPPER_ARM, FOREARM, v(0.6 * s, -0.6, -0.2));
      this.limb(left ? L.upperL : L.upperR, shoulder, elbow);
      this.limb(left ? L.foreL : L.foreR, elbow, hand);
      this.joint(left ? J.shoulderL : J.shoulderR, shoulder, 0.078);
      this.joint(left ? J.elbowL : J.elbowR, elbow, 0.058);
      const gl = left ? this.gloveL : this.gloveR;
      gl.position.copy(hand);
      aim(gl, hand.clone().sub(elbow));
    }
    this.limbs.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
  }

  /** Tapered segment from a (thick end) to b. */
  private limb(i: L, a: THREE.Vector3, b: THREE.Vector3) {
    orientBetween(SCR, a, b);
    SCR.scale.x = SCR.scale.z = LIMB_R[i];
    SCR.updateMatrix();
    this.limbs.setMatrixAt(i, SCR.matrix);
  }

  private joint(i: J, at: THREE.Vector3, rx: number, ry = rx, rz = rx, q?: THREE.Quaternion) {
    SCR.position.copy(at);
    if (q) SCR.quaternion.copy(q); else SCR.quaternion.identity();
    SCR.scale.set(rx, ry, rz);
    SCR.updateMatrix();
    this.joints.setMatrixAt(i, SCR.matrix);
  }
}

/** Orient a +Y-up / +Z-forward object: Y along `up`, Z as close to `fwd` as it allows. */
function basis(obj: THREE.Object3D, up: THREE.Vector3, fwd: THREE.Vector3) {
  const y = up.clone().normalize();
  const z = fwd.clone().addScaledVector(y, -fwd.dot(y));
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Jacket on the torso lathe: u wraps from the chest (0) round the left side, v runs waist → collar. */
function jacketTexture(suit: THREE.Color, accent: THREE.Color) {
  const W = 256, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const Y = (v: number) => (1 - v) * H;
  g.fillStyle = `#${suit.getHexString()}`;
  g.fillRect(0, 0, W, H);
  // bib pants showing at the waist, then a belt line
  g.fillStyle = `#${suit.clone().multiplyScalar(0.55).getHexString()}`;
  g.fillRect(0, Y(0.14), W, H);
  g.fillStyle = '#121316';
  g.fillRect(0, Y(0.17), W, 6);
  // accent yoke across the shoulders and down the side panels
  g.fillStyle = `#${accent.getHexString()}`;
  g.fillRect(0, 0, W, Y(0.74));
  for (const u of [0.25, 0.75]) g.fillRect(u * W - 18, Y(0.74), 36, Y(0.17) - Y(0.74));
  // reflective chest strip and centre zip
  g.fillStyle = '#c9d1da';
  g.fillRect(0, Y(0.62), W, 5);
  g.fillStyle = '#0e0f12';
  g.fillRect(0, 0, 3, H);
  g.fillRect(W - 3, 0, 3, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Helmet shell graphics in sphere UVs (u = 0.25 faces forward, v = 1 at the crown). */
function helmetTexture(base: THREE.Color, accent: THREE.Color, dark: THREE.Color) {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const X = (u: number) => u * W, Y = (v: number) => (1 - v) * H;
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, W, H);
  const a = `#${accent.getHexString()}`;
  // twin crown stripes running front to back
  g.fillStyle = a;
  for (const u of [0.25, 0.75]) {
    g.fillRect(X(u - 0.035), 0, X(0.025), Y(0.42));
    g.fillRect(X(u + 0.01), 0, X(0.025), Y(0.42));
  }
  // side flash sweeping back from the face
  for (const u0 of [0.4, 0.1]) {
    const dir = u0 > 0.25 ? 1 : -1;
    g.beginPath();
    g.moveTo(X(u0), Y(0.3));
    g.lineTo(X(u0 + dir * 0.22), Y(0.52));
    g.lineTo(X(u0 + dir * 0.26), Y(0.46));
    g.lineTo(X(u0 + dir * 0.06), Y(0.28));
    g.closePath();
    g.fill();
  }
  g.fillStyle = `#${dark.clone().multiplyScalar(0.6).getHexString()}`;
  g.fillRect(0, Y(0.32), W, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
