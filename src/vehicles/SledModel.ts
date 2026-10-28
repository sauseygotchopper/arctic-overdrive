import * as THREE from 'three';
import { SledSpec, SledParams } from './SledSpec';

/**
 * What the game needs from a sled visual. SledModel builds one from primitives; a GLTF loader can
 * implement the same interface later by mapping named nodes onto these hooks.
 */
export interface SledVisual {
  root: THREE.Group;
  /** Suspension lengths from attach point to snow (m) for left ski, right ski, track. */
  setSuspension(skiL: number, skiR: number, trackFront: number, trackRear: number): void;
  setSteer(angle: number): void;
  setTrackSpeed(metersPerSecond: number, dt: number): void;
  setLean(x: number, z: number): void;
  setHeadlights(on: boolean): void;
  /** Rider head position in sled space – the hood camera sits here. */
  headLocal: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

export class SledModel implements SledVisual {
  readonly root = new THREE.Group();
  readonly headLocal = new THREE.Vector3(0, 1.35, -0.25);
  private skiL = new THREE.Group();
  private skiR = new THREE.Group();
  private skiPivotL = new THREE.Group();
  private skiPivotR = new THREE.Group();
  private trackGroup = new THREE.Group();
  private bars = new THREE.Group();
  private rider = new THREE.Group();
  private trackTex: THREE.CanvasTexture;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private shoulderL = new THREE.Object3D();
  private shoulderR = new THREE.Object3D();
  private gripL = new THREE.Object3D();
  private gripR = new THREE.Object3D();
  private headlight: THREE.SpotLight;
  private lampMat: THREE.MeshStandardMaterial;
  private aArms: { mesh: THREE.Mesh; from: THREE.Vector3; ski: THREE.Group }[] = [];
  private trackScroll = 0;
  private trackLen: number;

  constructor(spec: SledSpec, params: SledParams) {
    const paint = new THREE.MeshPhysicalMaterial({ color: spec.colors.body, roughness: 0.35, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.2 });
    const accent = new THREE.MeshStandardMaterial({ color: spec.colors.accent, roughness: 0.55, metalness: 0.2 });
    const seatMat = new THREE.MeshStandardMaterial({ color: spec.colors.seat, roughness: 0.8 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.35, metalness: 0.85 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.9 });
    const skiMat = new THREE.MeshStandardMaterial({ color: spec.colors.ski, roughness: 0.5 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x223040, roughness: 0.05, metalness: 0, transmission: 0, transparent: true, opacity: 0.45 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xdfe8ff, emissive: 0xffffff, emissiveIntensity: 0.2, roughness: 0.2 });

    const trackLen = params.trackContactLen + 0.45;
    this.trackLen = trackLen;
    const trackTopZ = 0.2 + 0.25; // front of track (incl. front idler wrap)
    const tunnelRear = 0.2 - params.trackContactLen - 0.35;

    // ---------- tunnel, running boards, seat ----------
    const tunnelLen = 0.55 - tunnelRear;
    const tunnel = box(0.5, 0.06, tunnelLen, accent);
    tunnel.position.set(0, 0.12, tunnelRear + tunnelLen / 2);
    this.root.add(tunnel);
    for (const s of [-1, 1]) {
      const side = box(0.02, 0.26, tunnelLen, accent);
      side.position.set(s * 0.25, 0.0, tunnelRear + tunnelLen / 2);
      this.root.add(side);
      const board = box(0.16, 0.025, 1.15, metal);
      board.position.set(s * 0.33, -0.08, -0.25);
      this.root.add(board);
    }
    const flap = box(0.46, 0.32, 0.01, rubber);
    flap.position.set(0, -0.08, tunnelRear - 0.02);
    flap.rotation.x = 0.15;
    this.root.add(flap);
    const bumper = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.018, 6, 16, Math.PI), metal);
    bumper.position.set(0, 0.16, tunnelRear + 0.02);
    bumper.rotation.set(-Math.PI / 2, 0, Math.PI);
    this.root.add(bumper);
    const tail = box(0.12, 0.04, 0.03, new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 1.2 }));
    tail.position.set(0, 0.2, tunnelRear + 0.05);
    this.root.add(tail);

    const seat = profileExtrude([[0.32, 0.15], [0.32, 0.38], [0.15, 0.44], [-0.95, 0.42], [-1.02, 0.3], [-1.02, 0.15]], 0.38, seatMat, 0.035);
    this.root.add(seat);

    // ---------- hood / belly pan ----------
    const hood = profileExtrude(
      [[0.3, -0.12], [0.3, 0.42], [0.55, 0.58], [0.95, 0.48], [1.45, 0.22], [1.62, 0.02], [1.6, -0.14], [1.2, -0.2], [0.55, -0.2]],
      0.84, paint, 0.06,
      (z) => 1 - 0.42 * THREE.MathUtils.smoothstep(z, 0.6, 1.65),
    );
    this.root.add(hood);
    const belly = profileExtrude([[0.3, -0.24], [0.3, -0.12], [1.6, -0.12], [1.68, -0.2], [1.5, -0.27]], 0.78, accent, 0.03, (z) => 1 - 0.35 * THREE.MathUtils.smoothstep(z, 0.6, 1.65));
    this.root.add(belly);
    const stripe = profileExtrude([[0.62, 0.5], [0.95, 0.43], [1.4, 0.2], [1.46, 0.23], [0.98, 0.5], [0.66, 0.57]], 0.855, accent, 0.0, (z) => 1 - 0.42 * THREE.MathUtils.smoothstep(z, 0.6, 1.65));
    this.root.add(stripe);
    // windshield
    const ws = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.32), glass);
    ws.position.set(0, 0.72, 0.62);
    ws.rotation.x = -0.75;
    this.root.add(ws);
    // headlights
    for (const s of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), this.lampMat);
      lamp.position.set(s * 0.13, 0.3, 1.33);
      lamp.rotation.x = Math.PI / 2 - 0.5;
      lamp.scale.set(1.4, 1, 0.8);
      this.root.add(lamp);
    }
    this.headlight = new THREE.SpotLight(0xf2f5ff, 0, 90, 0.55, 0.45, 1.4);
    this.headlight.position.set(0, 0.35, 1.45);
    this.headlight.target.position.set(0, -2.2, 14);
    this.headlight.castShadow = false;
    this.root.add(this.headlight, this.headlight.target);

    // ---------- handlebars ----------
    const riser = cyl(0.022, 0.32, metal);
    riser.position.set(0, 0.16, 0);
    this.bars.add(riser);
    const bar = cyl(0.016, 0.82, metal);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 0.32;
    this.bars.add(bar);
    for (const s of [-1, 1]) {
      const grip = cyl(0.024, 0.13, rubber);
      grip.rotation.z = Math.PI / 2;
      grip.position.set(s * 0.36, 0.32, 0);
      this.bars.add(grip);
      const guard = box(0.12, 0.08, 0.1, accent);
      guard.position.set(s * 0.37, 0.34, 0.07);
      this.bars.add(guard);
    }
    this.gripL.position.set(0.36, 0.32, 0);
    this.gripR.position.set(-0.36, 0.32, 0);
    this.bars.add(this.gripL, this.gripR);
    this.bars.position.set(0, 0.52, 0.32);
    this.bars.rotation.x = -0.35;
    this.root.add(this.bars);

    // ---------- skis + front suspension ----------
    const hs = params.stance / 2;
    for (const [pivot, ski, x] of [[this.skiPivotL, this.skiL, hs], [this.skiPivotR, this.skiR, -hs]] as const) {
      pivot.position.set(x, 0, 1.08);
      ski.add(pivot);
      this.root.add(ski);
      const skiMesh = profileExtrude([[-0.5, 0], [0.42, 0], [0.62, 0.05], [0.75, 0.2], [0.7, 0.22], [0.58, 0.08], [0.4, 0.04], [-0.5, 0.04]], params.stance * 0 + spec.skiWidth, skiMat, 0.01);
      pivot.add(skiMesh);
      const keel = box(0.02, 0.025, 0.9, metal);
      keel.position.set(0, -0.005, -0.05);
      pivot.add(keel);
      const spindle = cyl(0.03, 0.34, metal);
      spindle.position.set(0, 0.2, 0.0);
      pivot.add(spindle);
      const shock = cyl(0.03, 0.34, new THREE.MeshStandardMaterial({ color: 0xffb000, roughness: 0.4, metalness: 0.5 }));
      shock.position.set(-Math.sign(x) * 0.02, 0.24, -0.06);
      shock.rotation.z = Math.sign(x) * 0.6;
      pivot.add(shock);
      for (const dy of [0.05, 0.2]) {
        const arm = cyl(0.016, 1, metal);
        this.root.add(arm);
        this.aArms.push({ mesh: arm, from: new THREE.Vector3(Math.sign(x) * 0.18, dy - 0.08, 1.0), ski });
      }
    }

    // ---------- track ----------
    this.trackTex = makeTrackTexture();
    this.trackTex.repeat.set(1, trackLen * 3);
    const trackMat = new THREE.MeshStandardMaterial({ map: this.trackTex, roughness: 0.9, color: 0xffffff });
    const tShape = new THREE.Shape();
    const r = 0.11;
    const L = trackLen - 2 * r;
    tShape.moveTo(0, 0);
    tShape.lineTo(L, 0);
    tShape.absarc(L, r, r, -Math.PI / 2, Math.PI / 2, false);
    tShape.lineTo(0.15, 0.32);
    tShape.absarc(0, r + 0.02, r + 0.02, Math.PI / 2, (3 * Math.PI) / 2, false);
    const tGeo = new THREE.ExtrudeGeometry(tShape, { depth: params.trackWidth, bevelEnabled: false, curveSegments: 8 });
    tGeo.rotateY(-Math.PI / 2);
    tGeo.translate(params.trackWidth / 2, 0, 0);
    remapExtrudeUV(tGeo);
    const trackMesh = new THREE.Mesh(tGeo, trackMat);
    trackMesh.position.z = trackTopZ - trackLen;
    this.trackGroup.add(trackMesh);
    // rails + idler wheels
    for (const s of [-1, 1]) {
      const rail = box(0.025, 0.04, trackLen - 0.2, metal);
      rail.position.set(s * params.trackWidth * 0.32, 0.06, trackTopZ - trackLen / 2);
      this.trackGroup.add(rail);
      for (const wz of [trackTopZ - trackLen + 0.12, trackTopZ - 0.15]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 12), metal);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(s * (params.trackWidth / 2 + 0.02), 0.11, wz);
        this.trackGroup.add(wheel);
      }
    }
    this.root.add(this.trackGroup);

    // ---------- rider ----------
    this.buildRider();
    this.armL = this.rider.getObjectByName('armL') as THREE.Mesh;
    this.armR = this.rider.getObjectByName('armR') as THREE.Mesh;

    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    ws.castShadow = false;
    this.setSuspension(0.4, 0.4, 0.46, 0.46);
  }

  private buildRider() {
    const suit = new THREE.MeshStandardMaterial({ color: 0x1e2a3a, roughness: 0.85 });
    const suitAccent = new THREE.MeshStandardMaterial({ color: 0x2fb5ff, roughness: 0.7 });
    const helmet = new THREE.MeshPhysicalMaterial({ color: 0xf2f4f7, roughness: 0.3, clearcoat: 1 });
    const visor = new THREE.MeshPhysicalMaterial({ color: 0x111820, roughness: 0.05, metalness: 0.6 });
    const boot = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
    const R = this.rider;
    R.position.set(0, 0.42, -0.42);
    this.root.add(R);

    const hips = new THREE.Vector3(0, 0.12, 0);
    const chest = new THREE.Vector3(0, 0.62, 0.22);
    R.add(limb(hips, chest, 0.19, suit));
    const jacket = limb(hips.clone().add(new THREE.Vector3(0, 0.25, 0.08)), chest, 0.2, suitAccent);
    jacket.scale.set(1.02, 0.5, 1.02);
    R.add(jacket);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), helmet);
    head.position.set(0, 0.9, 0.3);
    head.scale.set(1, 1, 1.12);
    R.add(head);
    const vis = new THREE.Mesh(new THREE.SphereGeometry(0.152, 16, 8, Math.PI / 2 - 0.9, 1.8, 1.1, 0.7), visor);
    vis.position.copy(head.position);
    vis.scale.copy(head.scale);
    R.add(vis);
    const chin = box(0.14, 0.06, 0.1, helmet);
    chin.position.set(0, 0.8, 0.45);
    R.add(chin);
    this.shoulderL.position.set(0.2, 0.58, 0.2);
    this.shoulderR.position.set(-0.2, 0.58, 0.2);
    R.add(this.shoulderL, this.shoulderR);
    for (const [name] of [['armL'], ['armR']]) {
      const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 1, 4, 8), suit);
      a.name = name;
      R.add(a);
    }
    for (const s of [-1, 1]) {
      // thigh, shin, boot (feet planted on running boards)
      const hip = new THREE.Vector3(s * 0.13, 0.08, 0.02);
      const knee = new THREE.Vector3(s * 0.26, 0.2, 0.42);
      const foot = new THREE.Vector3(s * 0.33, -0.42, 0.38);
      R.add(limb(hip, knee, 0.085, suit));
      R.add(limb(knee, foot, 0.075, suit));
      const b = box(0.11, 0.1, 0.26, boot);
      b.position.copy(foot).add(new THREE.Vector3(0, 0.0, 0.06));
      R.add(b);
    }
  }

  setSuspension(skiL: number, skiR: number, trackFront: number, trackRear: number) {
    this.skiL.position.y = -skiL;
    this.skiR.position.y = -skiR;
    const tf = -trackFront, tr = -trackRear;
    this.trackGroup.position.y = (tf + tr) / 2;
    this.trackGroup.rotation.x = Math.atan2(tf - tr, this.trackLen) * 0.8;
    for (const a of this.aArms) {
      const to = new THREE.Vector3().copy((a.ski === this.skiL ? this.skiPivotL : this.skiPivotR).position);
      to.y += a.ski.position.y + (a.from.y + 0.15);
      to.z -= 0.02;
      orientBetween(a.mesh, a.from, to);
    }
  }

  setSteer(angle: number) {
    this.skiPivotL.rotation.y = -angle;
    this.skiPivotR.rotation.y = -angle;
    this.bars.rotation.y = -angle * 0.9;
    this.updateArms();
  }

  setTrackSpeed(v: number, dt: number) {
    this.trackScroll += (v * dt) / 0.33;
    this.trackTex.offset.y = -this.trackScroll;
  }

  setLean(x: number, z: number) {
    // x: +right, z: +forward
    this.rider.position.x = -x * 0.22;
    this.rider.position.z = -0.42 + z * 0.18;
    this.rider.position.y = 0.42 + Math.abs(x) * 0.08 + Math.max(0, z) * 0.06;
    this.rider.rotation.z = x * 0.35;
    this.rider.rotation.x = z * 0.3;
    this.updateArms();
  }

  setHeadlights(on: boolean) {
    this.headlight.intensity = on ? 60 : 0;
    this.lampMat.emissiveIntensity = on ? 4 : 0.2;
  }

  private updateArms() {
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.rider.matrixWorld).invert();
    for (const [arm, sh, gr] of [[this.armL, this.shoulderL, this.gripL], [this.armR, this.shoulderR, this.gripR]] as const) {
      const g = gr.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      orientBetween(arm, sh.position, g, 1);
    }
  }
}

// ---------- geometry helpers ----------

function box(w: number, h: number, d: number, m: THREE.Material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
}
function cyl(r: number, h: number, m: THREE.Material) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), m);
}

/** Capsule from a to b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, 1, 4, 10), m);
  orientBetween(mesh, a, b, 1, r);
  return mesh;
}

/** Position + orient a Y-aligned unit-length mesh to span a → b. */
function orientBetween(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, baseLen = 1, radius = 0) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  const capsuleCore = radius > 0 ? Math.max(0.01, len - radius) : len;
  mesh.scale.set(1, capsuleCore / baseLen, 1);
}

/**
 * Extrude a side profile given as [z, y] points across the sled's width (X). `widthAt(z)` tapers
 * the width along the length, which gives hoods their narrowing nose.
 */
function profileExtrude(pts: number[][], width: number, mat: THREE.Material, bevel: number, widthAt?: (z: number) => number) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 3,
    curveSegments: 6,
  });
  // shape X -> sled Z, extrude Z -> sled -X (a rotation, not a mirror, so face winding survives)
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const sz = pos.getX(i);
    const sy = pos.getY(i);
    let sx = (width - bevel * 2) / 2 - pos.getZ(i);
    if (widthAt) sx *= widthAt(sz);
    pos.setXYZ(i, sx, sy, sz);
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/** The extruded track's side faces get UVs running along the belt so the lug texture scrolls. */
function remapExtrudeUV(g: THREE.BufferGeometry) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // approximate belt arclength from position around the loop
    const along = y < 0.16 ? z : -z + 2;
    uv.setXY(i, x * 2 + 0.5, along);
  }
}

function makeTrackTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1b1c1f';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#2c2e33';
  ctx.fillRect(0, 0, 64, 18);
  ctx.fillStyle = '#0d0e10';
  ctx.fillRect(0, 18, 64, 4);
  ctx.fillStyle = '#8a8f99';
  ctx.fillRect(12, 6, 6, 6);
  ctx.fillRect(46, 6, 6, 6);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
