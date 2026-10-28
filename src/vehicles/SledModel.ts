import * as THREE from 'three';
import { SledSpec, SledParams, Livery, DEFAULT_LIVERY, COSMETICS } from './SledSpec';
import { box, cyl, orientBetween, profileExtrude, skiMesh } from './geometry';
import { RiderRig, RiderState } from './Rider';

/**
 * What the game needs from a sled visual. SledModel builds one from primitives; a GLTF loader can
 * implement the same interface later by mapping named nodes onto these hooks.
 */
export interface SledVisual {
  root: THREE.Group;
  /** Suspension lengths from attach point to snow (m) for left ski, right ski, track front, track rear. */
  setSuspension(skiL: number, skiR: number, trackFront: number, trackRear: number): void;
  setSteer(angle: number): void;
  setTrackSpeed(metersPerSecond: number, dt: number): void;
  setRider(state: RiderState, dt: number): void;
  setHeadlights(on: boolean): void;
  /** Put cargo meshes on the rear rack (empty array clears it). */
  setRack(items: THREE.Object3D[]): void;
  /** Rider head position in sled space – the hood camera sits here. */
  headLocal: THREE.Vector3;
}

export class SledModel implements SledVisual {
  readonly root = new THREE.Group();
  readonly headLocal = new THREE.Vector3(0, 1.35, -0.25);
  readonly rider: RiderRig;
  private skiL = new THREE.Group();
  private skiR = new THREE.Group();
  private skiPivotL = new THREE.Group();
  private skiPivotR = new THREE.Group();
  private trackGroup = new THREE.Group();
  private bars = new THREE.Group();
  private gripL = new THREE.Object3D();
  private gripR = new THREE.Object3D();
  private trackTex: THREE.CanvasTexture;
  private headlight: THREE.SpotLight;
  private lampMat: THREE.MeshStandardMaterial;
  private aArms: { mesh: THREE.Mesh; from: THREE.Vector3; left: boolean; dy: number }[] = [];
  private trackScroll = 0;
  private trackLen: number;
  private rack = new THREE.Group();
  private rackFrame = new THREE.Group();

  constructor(spec: SledSpec, params: SledParams, livery: Livery = DEFAULT_LIVERY) {
    const paintDef = COSMETICS.paints.find((x) => x.id === livery.paint);
    const bodyColor = paintDef && 'body' in paintDef ? paintDef.body! : spec.colors.body;
    const accentColor = paintDef && 'accent' in paintDef ? paintDef.accent! : spec.colors.accent;
    const gear = COSMETICS.gear.find((x) => x.id === livery.gear) ?? COSMETICS.gear[0];
    this.rider = new RiderRig(gear.suit, gear.accent, gear.helmet);
    const wrap = livery.wrap !== 'none' ? makeWrapTexture(livery.wrap, bodyColor, accentColor) : null;
    const matte = livery.paint === 'stealth';
    const paint = new THREE.MeshPhysicalMaterial({
      color: wrap ? 0xffffff : bodyColor, map: wrap, roughness: matte ? 0.75 : 0.35, metalness: livery.paint === 'aurora' ? 0.6 : 0.05,
      clearcoat: matte ? 0 : 0.8, clearcoatRoughness: 0.2,
    });
    const accent = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.55, metalness: 0.2 });
    const seatMat = new THREE.MeshStandardMaterial({ color: spec.colors.seat, roughness: 0.8 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.35, metalness: 0.85 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.9 });
    const skiMat = new THREE.MeshStandardMaterial({ color: spec.colors.ski, roughness: 0.5 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x223040, roughness: 0.05, transparent: true, opacity: 0.45 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xdfe8ff, emissive: 0xffffff, emissiveIntensity: 0.2, roughness: 0.2 });

    const trackLen = params.trackContactLen + 0.45;
    this.trackLen = trackLen;
    const trackTopZ = 0.2 + 0.25; // front of track (incl. front idler wrap)
    const tunnelRear = 0.2 - params.trackContactLen - 0.35;
    const taper = (z: number) => 1 - 0.42 * THREE.MathUtils.smoothstep(z, 0.6, 1.65);

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
    if (params.canTow) {
      // receiver + drop mount + ball under the rear bumper
      const hitch = box(0.06, 0.06, 0.2, metal);
      hitch.position.set(0, 0.1, tunnelRear - 0.04);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), metal);
      ball.position.set(0, 0.155, tunnelRear - 0.12);
      this.root.add(hitch, ball);
      if (params.hitchYawBonus > 0) {
        const brace = box(0.3, 0.03, 0.04, metal);
        brace.position.set(0, 0.06, tunnelRear + 0.02);
        this.root.add(brace);
      }
    }
    const tail = box(0.12, 0.04, 0.03, new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 1.2 }));
    tail.position.set(0, 0.2, tunnelRear + 0.05);
    this.root.add(tail);
    this.root.add(profileExtrude([[0.32, 0.15], [0.32, 0.38], [0.15, 0.44], [-0.95, 0.42], [-1.02, 0.3], [-1.02, 0.15]], 0.38, seatMat, 0.035));

    // ---------- hood / belly pan ----------
    this.root.add(profileExtrude([[0.3, -0.12], [0.3, 0.42], [0.55, 0.58], [0.95, 0.48], [1.45, 0.22], [1.62, 0.02], [1.6, -0.14], [1.2, -0.2], [0.55, -0.2]], 0.84, paint, 0.06, taper));
    this.root.add(profileExtrude([[0.3, -0.24], [0.3, -0.12], [1.6, -0.12], [1.68, -0.2], [1.5, -0.27]], 0.78, accent, 0.03, (z) => 1 - 0.35 * THREE.MathUtils.smoothstep(z, 0.6, 1.65)));
    this.root.add(profileExtrude([[0.62, 0.5], [0.95, 0.43], [1.4, 0.2], [1.46, 0.23], [0.98, 0.5], [0.66, 0.57]], 0.855, accent, 0.0, taper));
    const ws = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.32), glass);
    ws.position.set(0, 0.72, 0.62);
    ws.rotation.x = -0.75;
    if (spec.style === 'race') { ws.scale.set(0.8, 0.45, 1); ws.position.set(0, 0.64, 0.68); }
    if (spec.style === 'trail') { ws.scale.set(1.05, 1.5, 1); ws.position.set(0, 0.78, 0.6); }
    this.root.add(ws);
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
    // mountain sleds run tall risers for standing up in deep snow
    this.bars.position.set(0, spec.style === 'mountain' ? 0.66 : 0.52, 0.32);
    this.bars.rotation.x = -0.35;
    this.root.add(this.bars);

    // ---------- skis + front suspension ----------
    const hs = params.stance / 2;
    const shockMat = new THREE.MeshStandardMaterial({ color: 0xffb000, roughness: 0.4, metalness: 0.5 });
    for (const [pivot, skiGroup, x] of [[this.skiPivotL, this.skiL, hs], [this.skiPivotR, this.skiR, -hs]] as const) {
      pivot.position.set(x, 0, 1.08);
      skiGroup.add(pivot);
      this.root.add(skiGroup);
      const ski = skiMesh(1.25, spec.skiWidth, skiMat);
      ski.position.z = 0.12;
      pivot.add(ski);
      const keel = box(0.02, 0.025, 0.9, metal);
      keel.position.set(0, -0.005, -0.05);
      pivot.add(keel);
      const spindle = cyl(0.03, 0.34, metal);
      spindle.position.set(0, 0.2, 0);
      pivot.add(spindle);
      const shock = cyl(0.03, 0.34, shockMat);
      shock.position.set(-Math.sign(x) * 0.02, 0.24, -0.06);
      shock.rotation.z = Math.sign(x) * 0.6;
      pivot.add(shock);
      for (const dy of [0.12, 0.3]) {
        const arm = cyl(0.016, 1, metal);
        this.root.add(arm);
        this.aArms.push({ mesh: arm, from: new THREE.Vector3(Math.sign(x) * 0.18, dy - 0.3, 1.0), left: x > 0, dy });
      }
    }

    // ---------- track ----------
    this.trackTex = makeTrackTexture();
    this.trackTex.repeat.set(1, trackLen * 3);
    const trackMat = new THREE.MeshStandardMaterial({ map: this.trackTex, roughness: 0.9 });
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

    // ---------- class details ----------
    if (spec.style === 'race' || spec.style === 'turbo' || livery.number !== DEFAULT_LIVERY.number) {
      const plate = new THREE.MeshStandardMaterial({ map: makeNumberTexture(livery.number, accentColor), roughness: 0.6 });
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.24), plate);
        p.position.set(s * 0.405, 0.24, 1.0);
        p.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.root.add(p);
      }
    }
    if (spec.style === 'turbo') {
      const scoop = profileExtrude([[0.75, 0.5], [0.75, 0.62], [1.15, 0.5], [1.2, 0.42]], 0.32, accent, 0.02);
      this.root.add(scoop);
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10), new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xff5a1f, emissiveIntensity: 1.6 }));
      glow.rotation.x = Math.PI / 2;
      glow.position.set(-0.33, 0.12, 0.55);
      this.root.add(glow);
    }
    if (spec.style === 'mountain') {
      // tall flap and bars-mounted mountain strap
      const strap = cyl(0.012, 0.36, rubber);
      strap.position.set(0, 0.95, 0.32);
      strap.rotation.x = -0.6;
      this.root.add(strap);
    }

    // ---------- rear rack (shown when carrying cargo) ----------
    this.rack.position.set(0, 0.16, tunnelRear + 0.42);
    for (const sx of [-0.23, 0.23]) {
      const rail = box(0.03, 0.03, 0.62, metal);
      rail.position.set(sx, 0.06, 0);
      this.rackFrame.add(rail);
    }
    for (const sz of [-0.3, 0.3]) {
      const cross = box(0.48, 0.03, 0.03, metal);
      cross.position.set(0, 0.06, sz);
      this.rackFrame.add(cross);
    }
    this.rackFrame.visible = false;
    this.rack.add(this.rackFrame);
    this.root.add(this.rack);

    // ---------- rider ----------
    this.root.add(this.rider.group);

    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    ws.castShadow = false;
    this.setSuspension(0.4, 0.4, 0.46, 0.46);
  }

  setSuspension(skiL: number, skiR: number, trackFront: number, trackRear: number) {
    this.skiL.position.y = -skiL;
    this.skiR.position.y = -skiR;
    const tf = -trackFront, tr = -trackRear;
    this.trackGroup.position.y = (tf + tr) / 2;
    this.trackGroup.rotation.x = Math.atan2(tf - tr, this.trackLen) * 0.8;
    for (const a of this.aArms) {
      const pivot = a.left ? this.skiPivotL : this.skiPivotR;
      const skiY = a.left ? this.skiL.position.y : this.skiR.position.y;
      const to = new THREE.Vector3(pivot.position.x, skiY + a.dy, pivot.position.z - 0.02);
      orientBetween(a.mesh, a.from, to);
    }
  }

  setSteer(angle: number) {
    this.skiPivotL.rotation.y = -angle;
    this.skiPivotR.rotation.y = -angle;
    this.bars.rotation.y = -angle * 0.9;
  }

  setTrackSpeed(v: number, dt: number) {
    this.trackScroll += (v * dt) / 0.33;
    this.trackTex.offset.y = -this.trackScroll;
  }

  setRider(state: RiderState, dt: number) {
    this.bars.updateMatrix();
    const gl = this.gripL.position.clone().applyMatrix4(this.bars.matrix);
    const gr = this.gripR.position.clone().applyMatrix4(this.bars.matrix);
    this.rider.update(dt, state, gl, gr);
    this.headLocal.copy(this.rider.headPos).add(new THREE.Vector3(0, 0.05, 0.05));
  }

  setRack(items: THREE.Object3D[]) {
    for (const c of [...this.rack.children]) if (c !== this.rackFrame) this.rack.remove(c);
    this.rackFrame.visible = items.length > 0;
    // pack in two columns along the rack, stacking when it's full
    let y = 0.08, row = 0, col = 0;
    items.forEach((m) => {
      const size = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
      m.position.set((col - 0.5) * 0.26, y + size.y / 2, (row - 0.5) * 0.32);
      m.rotation.set(0, 0, 0);
      this.rack.add(m);
      if (++col > 1) { col = 0; if (++row > 1) { row = 0; y += 0.35; } }
    });
  }

  setHeadlights(on: boolean) {
    this.headlight.intensity = on ? 60 : 0;
    this.lampMat.emissiveIntensity = on ? 4 : 0.2;
  }
}

/** The extruded track's side faces get UVs running along the belt so the lug texture scrolls. */
function remapExtrudeUV(g: THREE.BufferGeometry) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const along = y < 0.16 ? z : -z + 2;
    uv.setXY(i, x * 2 + 0.5, along);
  }
}

/** Hood wrap graphic painted on a canvas in the livery colours. */
function makeWrapTexture(kind: string, body: string, accent: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = body;
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = accent;
  if (kind === 'stripes') {
    for (const y of [92, 128]) g.fillRect(0, y, 512, 22);
  } else if (kind === 'slash') {
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.moveTo(80 + i * 90, 256); g.lineTo(150 + i * 90, 256); g.lineTo(330 + i * 60, 0); g.lineTo(290 + i * 60, 0);
      g.closePath(); g.fill();
    }
  } else if (kind === 'camo') {
    const cols = [accent, '#4a5a3a', '#2b3320'];
    for (let i = 0; i < 70; i++) {
      g.fillStyle = cols[i % 3];
      g.beginPath();
      g.ellipse((i * 97) % 512, (i * 53) % 256, 30 + (i % 5) * 9, 16 + (i % 4) * 7, i, 0, Math.PI * 2);
      g.fill();
    }
  } else if (kind === 'digital') {
    for (let y = 0; y < 256; y += 16) for (let x = 0; x < 512; x += 16) {
      const v = Math.sin(x * 0.07 + y * 0.11) + Math.sin(x * 0.023 - y * 0.05);
      if (v > 0.6) { g.fillStyle = accent; g.fillRect(x, y, 16, 16); }
      else if (v > 0.2) { g.fillStyle = '#ffffff55'; g.fillRect(x, y, 16, 16); }
    }
  } else if (kind === 'flames') {
    for (let i = 0; i < 7; i++) {
      const y0 = 40 + i * 28;
      g.beginPath();
      g.moveTo(512, y0);
      for (let x = 512; x > 120; x -= 40) g.quadraticCurveTo(x - 20, y0 + (x % 80 ? -26 : 26), x - 40, y0);
      g.quadraticCurveTo(60, y0 + 10, 512, y0 + 18);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // hood caps take shape coordinates (z 0.3..1.7, y -0.25..0.6) as UVs
  t.repeat.set(1 / 1.4, 1 / 0.85);
  t.offset.set(-0.3 / 1.4, 0.25 / 0.85);
  return t;
}

function makeNumberTexture(n: number, accent: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 80;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f6f8';
  g.fillRect(0, 0, 128, 80);
  g.strokeStyle = accent;
  g.lineWidth = 8;
  g.strokeRect(4, 4, 120, 72);
  g.fillStyle = '#111';
  g.font = 'italic 800 58px "Barlow Condensed", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 64, 43);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
