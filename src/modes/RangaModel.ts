import * as THREE from 'three';
import { box, orientBetween } from '../vehicles/geometry';
import { solveIK } from '../vehicles/Rider';

const THIGH = 0.47, SHIN = 0.47, UPPER = 0.31, FORE = 0.29, SPINE = 0.52, ANKLE = 0.07;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Seg = THREE.Mesh & { userData: { r: number } };

/**
 * The Angry Ranga on foot: ginger crop, red polo with a navy collar, beige shorts, tan loafers and a
 * tattooed forearm. Model space has the soles on y = 0, +Z ahead and +X to his left. A pose is a handful
 * of points (hips, chest, feet, hands); limbs are solved with two-bone IK so planted feet stay planted.
 */
export class RangaModel {
  readonly root = new THREE.Group();
  private hips = v(0, 0.86, 0);
  private chest = v(0, 1.36, 0.06);
  private foot = [v(0.3, 0, 0), v(-0.3, 0, 0)];
  private hand = [v(0.25, 0.8, 0.2), v(-0.25, 0.8, 0.2)];
  private kneeHint = v(0.3, 0.2, 1);
  private elbowHint = v(1, -0.2, -0.4);

  private torso: THREE.Mesh;
  private belt: THREE.Mesh;
  private pelvis: THREE.Mesh;
  private neck: Seg;
  private head = new THREE.Group();
  private thigh: Seg[] = [];
  private shorts: Seg[] = [];
  private shin: Seg[] = [];
  private upper: Seg[] = [];
  private sleeve: Seg[] = [];
  private cuff: Seg[] = [];
  private fore: Seg[] = [];
  private knee: THREE.Mesh[] = [];
  private elbow: THREE.Mesh[] = [];
  private shoulder: THREE.Mesh[] = [];
  private fist: THREE.Mesh[] = [];
  private shoe: THREE.Group[] = [];

  constructor(scale = 1) {
    const std = (color: number, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
    const skin = std(0xf0c3a2, 0.75);
    const ink = new THREE.MeshStandardMaterial({ map: tattooTexture(), roughness: 0.75 });
    const shirt = std(0xd3202a, 0.85);
    const navy = std(0x1a2752, 0.85);
    const cloth = std(0xe4d6bd, 0.9);
    const leather = std(0x3b2a1f, 0.6);
    const tan = std(0xb07a45, 0.7);
    const ginger = std(0xe0632a, 0.9);

    const taper = new THREE.CylinderGeometry(0.84, 1, 1, 12);
    const tube = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    const ball = new THREE.SphereGeometry(1, 14, 10);
    const seg = (m: THREE.Material, r: number, geo: THREE.BufferGeometry = taper) => {
      const s = new THREE.Mesh(geo, m) as Seg;
      s.userData.r = r;
      this.root.add(s);
      return s;
    };
    const blob = (m: THREE.Material, r: number) => {
      const s = new THREE.Mesh(ball, m);
      s.scale.setScalar(r);
      this.root.add(s);
      return s;
    };

    // polo: a lathe from the hem to the collar, wider at the chest than the waist
    const torsoGeo = new THREE.LatheGeometry([
      [0.0, -0.56], [0.15, -0.55], [0.168, -0.4], [0.17, -0.2], [0.19, 0.0], [0.215, 0.2], [0.228, 0.34], [0.2, 0.45], [0.11, 0.53], [0.085, 0.58], [0.0, 0.59],
    ].map(([r, y]) => new THREE.Vector2(r, y)), 20);
    torsoGeo.scale(1.2, 1, 0.8);
    this.torso = new THREE.Mesh(torsoGeo, new THREE.MeshStandardMaterial({ map: poloTexture(), roughness: 0.85 }));
    this.belt = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 16), leather);
    this.belt.scale.set(1.1, 1, 0.78);
    this.pelvis = new THREE.Mesh(ball, cloth);
    this.pelvis.scale.set(0.215, 0.16, 0.165);
    this.root.add(this.torso, this.belt, this.pelvis);
    this.neck = seg(skin, 0.072);

    for (const i of [0, 1]) {
      this.thigh.push(seg(skin, 0.098));
      this.shorts.push(seg(cloth, 0.122));
      this.shin.push(seg(skin, 0.078));
      this.knee.push(blob(skin, 0.082));
      this.upper.push(seg(skin, 0.082));
      this.sleeve.push(seg(shirt, 0.096));
      this.cuff.push(seg(navy, 0.099, tube));
      this.fore.push(seg(i === 0 ? ink : skin, 0.067));
      this.elbow.push(blob(i === 0 ? ink : skin, 0.068));
      this.shoulder.push(blob(shirt, 0.104));
      this.fist.push(blob(skin, 0.066));
      // loafer: toe box, heel and a darker sole (toes toward +Z)
      const shoe = new THREE.Group();
      const upper = new THREE.Mesh(ball, tan);
      upper.scale.set(0.058, 0.045, 0.135);
      upper.position.set(0, 0.05, 0.045);
      const sole = box(0.105, 0.022, 0.27, leather);
      sole.position.set(0, 0.011, 0.045);
      shoe.add(upper, sole);
      this.root.add(shoe);
      this.shoe.push(shoe);
    }

    // head (+Z = face): flushed skin, ginger crop, angry brows over a gritted grin
    const part = (m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const s = new THREE.Mesh(ball, m);
      s.scale.set(sx, sy, sz);
      s.position.set(x, y, z);
      this.head.add(s);
      return s;
    };
    part(skin, 0.122, 0.14, 0.13, 0, 0, 0);
    part(skin, 0.108, 0.085, 0.105, 0, -0.07, 0.012);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, 1.3), ginger);
    hair.scale.set(0.129, 0.15, 0.137);
    hair.position.set(0, 0.006, -0.008);
    hair.rotation.x = -0.32;
    this.head.add(hair);
    const white = std(0xf7f4ee, 0.35), dark = std(0x1c1210, 0.6);
    for (const s of [1, -1]) {
      part(skin, 0.022, 0.036, 0.026, s * 0.123, -0.012, -0.005);
      part(white, 0.023, 0.019, 0.012, s * 0.046, 0.012, 0.112);
      part(dark, 0.0105, 0.0105, 0.006, s * 0.044, 0.01, 0.122);
      const brow = box(0.062, 0.016, 0.022, ginger);
      brow.position.set(s * 0.046, 0.045, 0.116);
      brow.rotation.z = s * 0.42;
      this.head.add(brow);
    }
    part(skin, 0.021, 0.026, 0.024, 0, -0.022, 0.126);
    const mouth = box(0.092, 0.04, 0.012, dark);
    mouth.position.set(0, -0.078, 0.104);
    const teeth = box(0.08, 0.024, 0.012, white);
    teeth.position.set(0, -0.078, 0.108);
    this.head.add(mouth, teeth);
    this.root.add(this.head);

    this.root.scale.setScalar(scale);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this.flex(0);
  }

  /** Wide-legged most-muscular flex, straining a little. */
  flex(t: number) {
    const breathe = Math.sin(t * 2.4) * 0.012, strain = Math.sin(t * 33) * 0.005;
    this.hips.set(0, 0.83 + breathe, 0);
    this.chest.set(0, 1.33 + breathe * 2, 0.1);
    for (const [i, s] of [[0, 1], [1, -1]]) {
      this.foot[i].set(s * 0.34, 0, 0.02);
      this.hand[i].set(s * (0.2 + strain), 0.8 + strain, 0.24);
    }
    this.kneeHint.set(0.5, 0.1, 1);
    this.elbowHint.set(1, 0.1, -0.2);
    this.solve();
  }

  /** Sprint cycle: `phase` in radians, one full turn per two steps. */
  run(phase: number) {
    this.hips.set(0, 0.85 + Math.cos(phase * 2) * 0.035, 0);
    this.chest.set(0, 1.31 + Math.cos(phase * 2) * 0.03, 0.27);
    for (const [i, s] of [[0, 1], [1, -1]]) {
      const a = phase + (i ? Math.PI : 0);
      this.foot[i].set(s * 0.13, Math.max(0, Math.cos(a)) * 0.32, Math.sin(a) * 0.46 - 0.04);
      const pump = -Math.sin(a);
      this.hand[i].set(s * 0.27, 1.08 + pump * 0.12, 0.26 + pump * 0.26);
    }
    this.kneeHint.set(0.1, 0.2, 1);
    this.elbowHint.set(0.3, -0.5, -1);
    this.solve();
  }

  /** Mid-air: knees tucked, fists overhead. */
  leap() {
    this.hips.set(0, 0.72, 0);
    this.chest.set(0, 1.2, 0.16);
    for (const [i, s] of [[0, 1], [1, -1]]) {
      this.foot[i].set(s * 0.24, 0.2, 0.16);
      this.hand[i].set(s * 0.3, 1.66, 0.14);
    }
    this.kneeHint.set(0.5, 0.3, 1);
    this.elbowHint.set(1, 0.2, -0.3);
    this.solve();
  }

  /** Squat with the feet `stance` either side of centre: depth 0 = standing, 1 = hips below the knees. */
  squat(depth: number, stance: number) {
    const d = Math.min(1, Math.max(0, depth));
    const lean = 0.12 + d * 0.62;
    this.hips.set(0, lerp(0.88, 0.2, d), lerp(0, -0.22, d));
    this.chest.copy(this.hips).add(v(0, Math.cos(lean) * SPINE, Math.sin(lean) * SPINE));
    for (const [i, s] of [[0, 1], [1, -1]]) {
      this.foot[i].set(s * stance, 0, 0);
      this.hand[i].set(s * lerp(0.3, 0.17, d), lerp(this.hips.y + 0.04, this.chest.y - 0.03, d), lerp(0.1, this.chest.z + 0.52, d));
    }
    this.kneeHint.set(1, 0.1, 0.9);
    this.elbowHint.set(1, -0.6, -0.3);
    this.solve();
  }

  private put(s: Seg, a: THREE.Vector3, b: THREE.Vector3) {
    orientBetween(s, a, b);
    s.scale.x = s.scale.z = s.userData.r;
  }

  private solve() {
    const spine = this.chest.clone().sub(this.hips).normalize();
    orientBetween(this.torso, this.hips, this.chest);
    this.pelvis.position.copy(this.hips).addScaledVector(spine, -0.03);
    this.pelvis.quaternion.copy(this.torso.quaternion);
    this.belt.position.copy(this.hips).addScaledVector(spine, 0.085);
    this.belt.quaternion.copy(this.torso.quaternion);

    // the head stays more upright than the spine so he keeps glaring ahead at the bottom of a squat
    const headAt = this.chest.clone().addScaledVector(spine, 0.3).add(v(0, 0.02, 0.035));
    this.head.position.copy(headAt);
    this.head.quaternion.identity().slerp(this.torso.quaternion, 0.35);
    this.put(this.neck, this.chest.clone().addScaledVector(spine, 0.08), headAt.clone().addScaledVector(spine, -0.07));

    for (const [i, s] of [[0, 1], [1, -1]]) {
      const hip = this.hips.clone().add(v(s * 0.11, 0, 0));
      const ankle = this.foot[i].clone().add(v(0, ANKLE, 0));
      const knee = solveIK(hip, ankle, THIGH, SHIN, v(this.kneeHint.x * s, this.kneeHint.y, this.kneeHint.z));
      this.put(this.thigh[i], hip, knee);
      this.put(this.shorts[i], hip.clone().addScaledVector(spine, 0.05), hip.clone().lerp(knee, 0.64));
      this.put(this.shin[i], knee, ankle);
      this.knee[i].position.copy(knee);
      this.shoe[i].position.copy(this.foot[i]);
      this.shoe[i].rotation.y = s * 0.22;

      const shoulder = this.chest.clone().add(v(s * 0.235, 0, 0)).addScaledVector(spine, -0.03);
      const elbow = solveIK(shoulder, this.hand[i], UPPER, FORE, v(this.elbowHint.x * s, this.elbowHint.y, this.elbowHint.z));
      this.put(this.upper[i], shoulder, elbow);
      this.put(this.sleeve[i], shoulder, shoulder.clone().lerp(elbow, 0.5));
      this.put(this.cuff[i], shoulder.clone().lerp(elbow, 0.44), shoulder.clone().lerp(elbow, 0.53));
      this.put(this.fore[i], elbow, this.hand[i]);
      this.elbow[i].position.copy(elbow);
      this.shoulder[i].position.copy(shoulder);
      this.fist[i].position.copy(this.hand[i]);
    }
  }
}

/** Polo in lathe UVs: u = 0 is the chest centre and grows round his left side, v runs hem → collar. */
function poloTexture() {
  const W = 256, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const Y = (t: number) => (1 - t) * H;
  g.fillStyle = '#d3202a';
  g.fillRect(0, 0, W, H);
  // navy collar and the open placket below it (the lathe seam runs down the chest)
  g.fillStyle = '#1a2752';
  g.fillRect(0, 0, W, Y(0.86));
  g.fillRect(0, Y(0.86), 5, Y(0.72) - Y(0.86));
  g.fillRect(W - 5, Y(0.86), 5, Y(0.72) - Y(0.86));
  // a plain shield crest on the left of the chest
  const cx = 0.085 * W, cy = Y(0.72);
  g.fillStyle = '#f4f1ea';
  g.beginPath();
  g.moveTo(cx - 9, cy - 9); g.lineTo(cx + 9, cy - 9); g.lineTo(cx + 9, cy + 3); g.lineTo(cx, cy + 12); g.lineTo(cx - 9, cy + 3);
  g.closePath();
  g.fill();
  g.fillStyle = '#2c4fa3';
  g.fillRect(cx - 5, cy - 5, 10, 2.5);
  g.fillRect(cx - 5, cy - 1, 10, 2.5);
  g.fillRect(cx - 4, cy + 3, 8, 2.5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Sleeve tattoo: dark swirls over skin, wrapped round the forearm. */
function tattooTexture() {
  const W = 64, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f0c3a2';
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    g.strokeStyle = `rgba(${40 + rnd() * 30},${52 + rnd() * 30},${62 + rnd() * 30},${0.55 + rnd() * 0.35})`;
    g.lineWidth = 2 + rnd() * 4;
    g.beginPath();
    g.arc(rnd() * W, rnd() * H, 4 + rnd() * 10, rnd() * 6.3, rnd() * 6.3);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
