import * as THREE from 'three';
import { SledSpec, SledParams, Livery, DEFAULT_LIVERY, COSMETICS } from './SledSpec';
import { box, coilGeometry, cyl, Hull, mergeStatic, orientBetween, skiMesh, tube, windshield } from './geometry';
import { RiderRig, RiderState } from './Rider';
import { Design, designFor, patchRange } from './SledDesigns';

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

const LUG_PITCH = 0.0762; // 3in, a common track pitch
const SCRATCH = new THREE.Object3D();

/** One front-suspension link: chassis point → a point on the spindle, drawn as an instance of `kind`. */
interface Strut { kind: number; idx: number; from: THREE.Vector3; left: boolean; dy: number; dx: number; dz: number }

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
  /** A-arm rods and coilovers spanning chassis → spindle, re-aimed when the skis move. */
  private struts: Strut[] = [];
  /** Instanced link meshes: rods, springs, dampers. */
  private links: THREE.InstancedMesh[] = [];
  private trackScroll = 0;
  private trackLen: number;
  private path: TrackPath;
  private lugs: THREE.InstancedMesh;
  private lugRows: { x: number; phase: number }[];
  private lugCount: number;
  private lugPitch: number;
  private rack = new THREE.Group();
  private rackFrame = new THREE.Group();

  constructor(spec: SledSpec, params: SledParams, livery: Livery = DEFAULT_LIVERY) {
    const d = designFor(spec.style);
    const paintDef = COSMETICS.paints.find((x) => x.id === livery.paint);
    const bodyColor = paintDef && 'body' in paintDef ? paintDef.body! : spec.colors.body;
    const accentColor = paintDef && 'accent' in paintDef ? paintDef.accent! : spec.colors.accent;
    const gear = COSMETICS.gear.find((x) => x.id === livery.gear) ?? COSMETICS.gear[0];
    this.rider = new RiderRig(gear.suit, gear.accent, gear.helmet, { helmet: d.helmet, pack: d.pack });
    const wrap = livery.wrap !== 'none' ? makeWrapTexture(livery.wrap, bodyColor, accentColor) : null;
    const matte = livery.paint === 'stealth';
    const paint = new THREE.MeshPhysicalMaterial({
      color: wrap ? 0xffffff : bodyColor, map: wrap, roughness: matte ? 0.75 : 0.32, metalness: livery.paint === 'aurora' ? 0.6 : 0.05,
      clearcoat: matte ? 0 : 0.9, clearcoatRoughness: 0.15,
    });
    const sideMats = ([-1, 1] as const).map((s) => new THREE.MeshPhysicalMaterial({
      map: makeSideTexture(spec, d, bodyColor, accentColor, s > 0), roughness: matte ? 0.7 : 0.38, clearcoat: matte ? 0 : 0.6, clearcoatRoughness: 0.25,
    }));
    const accent = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.55, metalness: 0.2 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.62 });
    const seatMat = new THREE.MeshStandardMaterial({ color: spec.colors.seat, roughness: 0.85 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xa3abb6, roughness: 0.35, metalness: 0.85 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.12, metalness: 1 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.4, metalness: 0.7 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.9 });
    const skiMat = new THREE.MeshStandardMaterial({ color: spec.colors.ski, roughness: 0.45 });
    const glass = new THREE.MeshPhysicalMaterial({ color: d.windshield?.tint ?? 0x223040, roughness: 0.05, transparent: true, opacity: d.windshield?.opacity ?? 0.45, side: THREE.DoubleSide, depthWrite: false });
    const vent = new THREE.MeshStandardMaterial({ map: makeVentTexture(), roughness: 0.8 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xdfe8ff, emissive: 0xffffff, emissiveIntensity: 0.2, roughness: 0.15, metalness: 0.3 });
    const drl = new THREE.MeshStandardMaterial({ color: 0xe6f2ff, emissive: 0xcfe6ff, emissiveIntensity: 1.4 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 1.2 });

    const trackLen = params.trackContactLen + 0.45;
    this.trackLen = trackLen;
    const trackTopZ = 0.2 + 0.25; // front of track (incl. front idler wrap)
    const tunnelRear = 0.2 - params.trackContactLen - 0.35;

    // ---------- front body: belly pan, side panels, painted hood ----------
    const body = new Hull(d.hull);
    const noseZ = d.hull[d.hull.length - 1].z;
    const belt = (z: number) => d.belt + d.chin * THREE.MathUtils.smoothstep(z, 1.2, noseZ);
    const hoodFrom = (z: number) => Math.max(belt(z), d.hoodFrom(z));
    this.root.add(body.skin(trim, { from: 0, to: belt }));
    sideMats.forEach((m, i) => this.root.add(body.skin(m, { from: belt, to: hoodFrom, side: i ? 1 : -1, uvBox: SIDE_BOX })));
    this.root.add(body.skin(paint, { from: hoodFrom, to: 1, ring: 16, dz: 0.03 }));
    this.root.add(body.cap(body.zMin, trim, -1));
    for (const p of d.patches) {
      const r = patchRange(p);
      const mat = p.mat === 'lamp' ? this.lampMat : p.mat === 'drl' ? drl : p.mat === 'chrome' ? chrome : vent;
      if (p.mat === 'lamp') {
        // dark bezel around the lens
        const b = patchRange({ ...p, z0: p.z0 - 0.02, z1: p.z1 + 0.02, t0: p.t0 - 0.025, t1: p.t1 >= 1 ? 1 : p.t1 + 0.025 });
        this.root.add(body.skin(trim, { ...b, z0: p.z0 - 0.02, z1: p.z1 + 0.02, inflate: 0.003, ring: 6, dz: 0.02 }));
      }
      this.root.add(body.skin(mat, { ...r, z0: p.z0, z1: p.z1, inflate: p.mat === 'lamp' ? 0.008 : 0.004, ring: 6, dz: 0.02 }));
    }
    const hoodTop = (z: number) => body.point(body.at(z), 1, 1).y;
    if (d.scoop) {
      const scoop = new Hull([
        { z: 0.66, yt: hoodTop(0.66) + 0.004, yb: hoodTop(0.66) - 0.06, w: 0.1, n: 3 },
        { z: 0.86, yt: hoodTop(0.86) + 0.06, yb: hoodTop(0.86) - 0.06, w: 0.15, n: 3 },
        { z: 1.04, yt: hoodTop(1.04) + 0.085, yb: hoodTop(1.04) - 0.06, w: 0.16, n: 3 },
      ]);
      this.root.add(scoop.skin(accent, { from: 0.45, to: 1 }), scoop.cap(1.04, vent, 1));
    }
    this.root.add(new Hull(d.console).skin(d.consoleMat === 'paint' ? paint : trim, { from: 0.35, to: 1 }));
    // gauge pod on the console
    const gauge = box(0.16, 0.07, 0.1, trim);
    gauge.position.set(0, hoodTop(0.5) + 0.05, 0.5);
    gauge.rotation.x = -0.5;
    const gaugeTex = makeGaugeTexture();
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.05), new THREE.MeshStandardMaterial({ map: gaugeTex, emissive: 0xffffff, emissiveMap: gaugeTex, emissiveIntensity: 0.9 }));
    screen.position.set(0, 0.038, -0.01);
    screen.rotation.x = -Math.PI / 2 + 0.25;
    gauge.add(screen);
    this.root.add(gauge);

    if (d.windshield) {
      const w = d.windshield;
      const shield = windshield({ ...w, y: hoodTop(w.z) - 0.01 }, glass);
      this.root.add(shield.mesh, tube(shield.topEdge, 0.006, trim, 24));
    }

    // ---------- bumpers + lights ----------
    const nose = d.hull[d.hull.length - 1];
    const bumperMat = d.bumper === 'chrome' ? chrome : trim;
    const by = nose.yb + 0.0;
    const bumperPts = [[0.21, by - 0.08, 1.5], [0.2, by - 0.04, 1.66], [0.12, by - 0.01, nose.z + 0.05], [0, by, nose.z + 0.07]];
    const loop = [...bumperPts, ...bumperPts.slice(0, -1).reverse().map(([x, y, z]) => [-x, y, z])];
    this.root.add(tube(loop, d.bumper === 'race' ? 0.022 : 0.016, bumperMat, 32));
    if (d.bumper === 'race') {
      const bar = tube([[0.17, by - 0.1, 1.58], [0, by - 0.08, nose.z + 0.02], [-0.17, by - 0.1, 1.58]], 0.016, bumperMat, 16);
      this.root.add(bar);
    }
    if (d.lightBar) {
      const housing = box(0.34, 0.045, 0.05, trim);
      housing.position.set(0, by + 0.035, nose.z + 0.055);
      const lens = box(0.32, 0.028, 0.01, this.lampMat);
      lens.position.set(0, 0, 0.026);
      housing.add(lens);
      this.root.add(housing);
    }
    this.headlight = new THREE.SpotLight(0xf2f5ff, 0, 90, 0.55, 0.45, 1.4);
    this.headlight.position.set(0, 0.35, 1.45);
    this.headlight.target.position.set(0, -2.2, 14);
    this.root.add(this.headlight, this.headlight.target);

    // ---------- seat ----------
    const seat = new Hull(d.seat);
    this.root.add(seat.skin(seatMat, { from: 0, to: 0.6 }), seat.skin(accent, { from: 0.6, to: 0.64, ring: 2 }), seat.skin(seatMat, { from: 0.64, to: 1 }));
    this.root.add(seat.cap(seat.zMin, seatMat, -1));
    const seatBack = d.seat[0];
    const tail = box(0.16, 0.035, 0.02, tailMat);
    tail.position.set(0, seatBack.yt - 0.09, seatBack.z - 0.01);
    this.root.add(tail);

    // ---------- tunnel, running boards ----------
    const tunnelLen = 0.55 - tunnelRear;
    const tunnel = box(0.5, 0.025, tunnelLen, trim);
    tunnel.position.set(0, 0.135, tunnelRear + tunnelLen / 2);
    this.root.add(tunnel);
    // heat exchanger fins on the exposed tunnel behind the seat
    const coolerLen = seatBack.z - tunnelRear - 0.12;
    if (coolerLen > 0.1) {
      const cooler = new THREE.Mesh(new THREE.PlaneGeometry(0.34, coolerLen), new THREE.MeshStandardMaterial({ map: makeFinTexture(coolerLen), roughness: 0.4, metalness: 0.8 }));
      cooler.rotation.x = -Math.PI / 2;
      cooler.position.set(0, 0.149, tunnelRear + 0.08 + coolerLen / 2);
      this.root.add(cooler);
    }
    const tunnelDecal = new THREE.MeshStandardMaterial({ map: makeTunnelDecal(spec.brand, bodyColor), transparent: true, roughness: 0.5, depthWrite: false });
    const boardMat = new THREE.MeshStandardMaterial({ color: 0x8d949e, roughness: 0.45, metalness: 0.8, alphaMap: makeBoardAlpha(d.boardOpen), alphaTest: 0.5, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const side = box(0.012, 0.27, tunnelLen, trim);
      side.position.set(s * 0.25, 0.0, tunnelRear + tunnelLen / 2);
      this.root.add(side);
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.14), tunnelDecal);
      decal.position.set(s * 0.2575, 0.02, tunnelRear + 0.2 + 0.475);
      decal.rotation.y = s * Math.PI / 2;
      this.root.add(decal);
      // running board: perforated plate with a raised outer rail and a toe hook
      const board = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 1.18), boardMat);
      board.rotation.x = -Math.PI / 2;
      board.position.set(s * 0.34, -0.08, -0.27);
      this.root.add(board);
      const railOut = box(0.018, 0.035, 1.18, metal);
      railOut.position.set(s * 0.425, -0.07, -0.27);
      this.root.add(railOut);
      this.root.add(tube([[s * 0.27, -0.08, 0.27], [s * 0.3, 0.05, 0.3], [s * 0.36, 0.06, 0.24], [s * 0.38, -0.06, 0.22]], 0.012, metal, 12));
    }
    const flapTex = makeFlapTexture(spec.brand);
    const flap = new THREE.Mesh(new THREE.PlaneGeometry(0.46, d.boardOpen >= 1 ? 0.42 : 0.32), new THREE.MeshStandardMaterial({ map: flapTex, roughness: 0.9, side: THREE.DoubleSide }));
    flap.position.set(0, d.boardOpen >= 1 ? -0.13 : -0.08, tunnelRear - 0.03);
    flap.rotation.set(0.15, Math.PI, 0);
    this.root.add(flap);
    const rb = [[0.25, 0.14, tunnelRear + 0.2], [0.25, 0.16, tunnelRear - 0.0], [0.17, 0.17, tunnelRear - 0.07], [0, 0.17, tunnelRear - 0.08]];
    this.root.add(tube([...rb, ...rb.slice(0, -1).reverse().map(([x, y, z]) => [-x, y, z])], 0.017, d.bumper === 'chrome' ? chrome : metal, 28));
    const tailBar = box(0.22, 0.03, 0.02, tailMat);
    tailBar.position.set(0, 0.12, tunnelRear - 0.0);
    this.root.add(tailBar);
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

    // ---------- handlebars ----------
    const riserH = 0.32;
    this.bars.add(tube([[0, 0, -0.02], [0, riserH * 0.5, 0], [0, riserH, 0.02]], 0.02, darkMetal, 8));
    const barPts = [[-0.43, 0.32, -0.015], [-0.3, 0.325, 0.0], [-0.14, 0.335, 0.025], [0, 0.34, 0.03], [0.14, 0.335, 0.025], [0.3, 0.325, 0.0], [0.43, 0.32, -0.015]];
    this.bars.add(tube(barPts, 0.014, darkMetal, 24));
    const guardMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.5, side: THREE.DoubleSide });
    const clamp = box(0.08, 0.05, 0.05, trim);
    clamp.position.set(0, 0.335, 0.02);
    this.bars.add(clamp);
    for (const s of [-1, 1]) {
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.13, 12), rubber);
      grip.rotation.z = Math.PI / 2;
      grip.position.set(s * 0.36, 0.322, -0.005);
      this.bars.add(grip);
      // wrap-around hand guard
      const guard = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 8, 0, Math.PI, 0.35, 1.9), guardMat);
      guard.scale.set(1.2, 0.65, 0.75);
      guard.position.set(s * 0.37, 0.335, 0.015);
      this.bars.add(guard);
      // brake lever on the left, thumb throttle on the right
      const lever = box(0.11, 0.012, 0.02, darkMetal);
      lever.position.set(s * 0.32, 0.33, 0.06);
      lever.rotation.y = s * 0.2;
      if (s > 0) this.bars.add(lever);
      else {
        const thumb = box(0.03, 0.035, 0.012, darkMetal);
        thumb.position.set(-0.3, 0.33, 0.035);
        this.bars.add(thumb);
      }
    }
    if (d.barExtras.includes('pad')) {
      this.bars.add(tube([[-0.18, 0.335, 0.025], [-0.12, 0.4, 0.03], [0.12, 0.4, 0.03], [0.18, 0.335, 0.025]], 0.011, darkMetal, 12));
      const pad = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.2, 4, 10), accent);
      pad.rotation.z = Math.PI / 2;
      pad.position.set(0, 0.4, 0.03);
      this.bars.add(pad);
    }
    if (d.barExtras.includes('strap')) {
      // mountain strap: a loop from the riser block to the bar
      this.bars.add(tube([[0, 0.34, 0.03], [0, 0.42, 0.12], [0, 0.5, 0.1], [0, 0.48, 0.04]], 0.012, rubber, 12));
    }
    this.gripL.position.set(0.36, 0.32, 0);
    this.gripR.position.set(-0.36, 0.32, 0);
    this.bars.add(this.gripL, this.gripR);
    this.bars.position.set(0, d.barY, 0.32);
    this.bars.rotation.x = -0.35;
    this.root.add(this.bars);

    // ---------- skis + front suspension ----------
    const hs = params.stance / 2;
    const shockBody = new THREE.MeshStandardMaterial({ color: d.shocks.body, roughness: 0.3, metalness: 0.7 });
    const springMat = new THREE.MeshStandardMaterial({ color: d.shocks.spring, roughness: 0.35, metalness: 0.4 });
    const armMat = spec.style === 'turbo' ? skiMat : darkMetal;
    const coil = coilGeometry(0.034, 0.006, 7);
    const strut = (kind: number, from: THREE.Vector3, left: boolean, dy: number, dx: number, dz: number) =>
      this.struts.push({ kind, idx: this.struts.filter((x) => x.kind === kind).length, from, left, dy, dx, dz });
    for (const [pivot, skiGroup, x] of [[this.skiPivotL, this.skiL, hs], [this.skiPivotR, this.skiR, -hs]] as const) {
      const s = Math.sign(x);
      pivot.position.set(x, 0, 1.08);
      skiGroup.add(pivot);
      this.root.add(skiGroup);
      const ski = skiMesh(1.25, params.skiWidth, skiMat);
      ski.position.z = 0.12;
      pivot.add(ski);
      // handle loop over the tip, carbide runner + keel under the ski
      pivot.add(tube([[0, 0.05, 0.42], [0, 0.17, 0.56], [0, 0.22, 0.67], [0, 0.2, 0.72]], 0.012, skiMat, 12));
      const keel = box(0.016, 0.03, 0.95, metal);
      keel.position.set(0, -0.012, -0.04);
      pivot.add(keel);
      const saddle = box(0.07, 0.07, 0.16, darkMetal);
      saddle.position.set(0, 0.07, 0);
      pivot.add(saddle);
      const spindle = cyl(0.026, 0.3, darkMetal);
      spindle.position.set(0, 0.24, 0);
      pivot.add(spindle);
      // upper + lower A-arms (two rods each, converging on the spindle)
      for (const [dy, cy] of [[0.12, -0.19], [0.32, -0.02]] as const) {
        for (const dz of [-0.13, 0.11]) strut(0, new THREE.Vector3(s * 0.2, cy, 1.08 + dz), x > 0, dy, -s * 0.015, 0);
      }
      // coilover: spring + damper body from the chassis to the lower arm
      for (const kind of [1, 2]) strut(kind, new THREE.Vector3(s * 0.21, 0.2, 1.02), x > 0, 0.14, -s * 0.08, -0.03);
      if (d.shocks.piggyback) {
        const res = cyl(0.022, 0.12, shockBody);
        res.position.set(s * 0.26, 0.2, 1.0);
        res.rotation.x = 0.4;
        this.root.add(res);
      }
    }

    const linkGeo = [new THREE.CylinderGeometry(0.012, 0.012, 1, 8), coil, new THREE.CylinderGeometry(0.018, 0.018, 1, 10)];
    const linkMat = [armMat, springMat, shockBody];
    this.links = linkGeo.map((g, k) => {
      const im = new THREE.InstancedMesh(g, linkMat[k], this.struts.filter((x) => x.kind === k).length);
      im.frustumCulled = false;
      this.root.add(im);
      return im;
    });

    // ---------- track + rear skid ----------
    const tw = params.trackWidth;
    this.path = new TrackPath(params.trackContactLen, trackTopZ);
    const P = this.path.length;
    this.lugCount = Math.max(8, Math.round(P / LUG_PITCH));
    this.lugPitch = P / this.lugCount;
    this.trackTex = makeTrackTexture();
    const trackMat = new THREE.MeshStandardMaterial({ map: this.trackTex, roughness: 0.92, side: THREE.DoubleSide });
    const trackMesh = new THREE.Mesh(this.path.beltGeometry(tw, this.lugPitch), trackMat);
    this.trackGroup.add(trackMesh);
    const lugH = Math.max(0.02, params.lugHeightIn * 0.0254);
    const paddles = lugH > 0.05;
    this.lugRows = paddles
      ? [{ x: -tw * 0.25, phase: 0 }, { x: tw * 0.25, phase: 0.5 }]
      : [{ x: -tw / 3, phase: 0 }, { x: 0, phase: 0.5 }, { x: tw / 3, phase: 0 }];
    const lugGeo = new THREE.BoxGeometry(paddles ? tw * 0.44 : tw * 0.26, lugH, 0.014);
    lugGeo.translate(0, lugH / 2, 0);
    this.lugs = new THREE.InstancedMesh(lugGeo, new THREE.MeshStandardMaterial({ color: 0x1e1f23, roughness: 0.9 }), this.lugCount * this.lugRows.length);
    this.lugs.frustumCulled = false;
    this.trackGroup.add(this.lugs);
    const zr = this.path.rearZ, zf = this.path.contactEnd;
    const wheel = (r: number, x: number, y: number, z: number, mat: THREE.Material = metal) => {
      const g = new THREE.Group();
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.035, 16), mat);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.04, 10), trim);
      g.add(tyre, hub);
      g.rotation.z = Math.PI / 2;
      g.position.set(x, y, z);
      this.trackGroup.add(g);
    };
    for (const s of [-1, 1]) {
      this.trackGroup.add(tube([[s * tw * 0.3, 0.03, zr + 0.02], [s * tw * 0.3, 0.025, (zr + zf) / 2], [s * tw * 0.3, 0.03, zf], [s * tw * 0.3, 0.12, zf + 0.2]], 0.014, darkMetal, 16));
      wheel(0.09, s * (tw / 2 - 0.035), 0.1, zr);
      wheel(0.075, s * tw * 0.13, 0.085, zr + 0.02);
      wheel(0.05, s * (tw / 2 - 0.035), 0.06, zr + (zf - zr) * 0.45);
      wheel(0.09, s * (tw / 2 - 0.05), this.path.driveY, this.path.driveZ, trim);
    }
    const rs = new THREE.Mesh(coil, springMat);
    orientBetween(rs, new THREE.Vector3(0, 0.07, zr + (zf - zr) * 0.32), new THREE.Vector3(0, 0.28, zr + (zf - zr) * 0.62));
    const rd = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 10), shockBody);
    orientBetween(rd, new THREE.Vector3(0, 0.07, zr + (zf - zr) * 0.32), new THREE.Vector3(0, 0.2, zr + (zf - zr) * 0.5));
    this.trackGroup.add(rs, rd);
    this.root.add(this.trackGroup);

    // ---------- class details ----------
    if (spec.style === 'race' || spec.style === 'turbo' || livery.number !== DEFAULT_LIVERY.number) {
      const plate = new THREE.MeshStandardMaterial({ map: makeNumberTexture(livery.number, accentColor), roughness: 0.6 });
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.22), plate);
        stick(p, body, 0.98, 0.5, s, 0.006);
        this.root.add(p);
      }
      if (spec.style === 'race') {
        const front = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.16), plate);
        stick(front, body, 1.4, 1, 1, 0.006);
        this.root.add(front);
      }
    }
    if (spec.style === 'turbo') {
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xff5a1f, emissiveIntensity: 1.6 }));
      glow.rotation.x = Math.PI / 2;
      glow.position.set(-0.3, 0.1, 0.5);
      this.root.add(glow);
      this.root.add(tube([[-0.3, 0.1, 0.44], [-0.36, 0.02, 0.3], [-0.38, -0.12, 0.26]], 0.03, darkMetal, 10));
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

    // bake the static parts of each moving assembly into one mesh per material
    mergeStatic(this.root, [this.skiL, this.skiR, this.bars, this.trackGroup, this.rider.group, this.rack]);
    mergeStatic(this.bars, [this.gripL, this.gripR]);
    mergeStatic(this.trackGroup, [this.lugs]);
    mergeStatic(this.skiPivotL);
    mergeStatic(this.skiPivotR);

    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // lenses, decals and glass are flush or see-through: not worth a shadow draw
      const mat = m.material as THREE.MeshStandardMaterial;
      m.castShadow = !mat.transparent && !(mat.emissive?.getHex() && mat.emissiveIntensity > 0);
      m.receiveShadow = true;
    });
    this.lugs.castShadow = false;
    this.updateLugs();
    this.setSuspension(0.4, 0.4, 0.46, 0.46);
  }

  setSuspension(skiL: number, skiR: number, trackFront: number, trackRear: number) {
    this.skiL.position.y = -skiL;
    this.skiR.position.y = -skiR;
    const tf = -trackFront, tr = -trackRear;
    this.trackGroup.position.y = (tf + tr) / 2;
    this.trackGroup.rotation.x = Math.atan2(tf - tr, this.trackLen) * 0.8;
    const to = new THREE.Vector3();
    for (const a of this.struts) {
      const pivot = a.left ? this.skiPivotL : this.skiPivotR;
      const skiY = a.left ? this.skiL.position.y : this.skiR.position.y;
      to.set(pivot.position.x + a.dx, skiY + a.dy, pivot.position.z + a.dz);
      orientBetween(SCRATCH, a.from, to);
      SCRATCH.updateMatrix();
      this.links[a.kind].setMatrixAt(a.idx, SCRATCH.matrix);
    }
    for (const l of this.links) l.instanceMatrix.needsUpdate = true;
  }

  setSteer(angle: number) {
    this.skiPivotL.rotation.y = -angle;
    this.skiPivotR.rotation.y = -angle;
    this.bars.rotation.y = -angle * 0.9;
  }

  setTrackSpeed(v: number, dt: number) {
    if (v === 0) return;
    this.trackScroll = (this.trackScroll + v * dt) % this.path.length;
    this.trackTex.offset.y = this.trackScroll / this.lugPitch;
    this.updateLugs();
  }

  private updateLugs() {
    const m = new THREE.Matrix4(), X = new THREE.Vector3(1, 0, 0), N = new THREE.Vector3(), Z = new THREE.Vector3();
    const s = { z: 0, y: 0, nz: 0, ny: 0 };
    let i = 0;
    for (const row of this.lugRows) for (let k = 0; k < this.lugCount; k++) {
      this.path.sample((k + row.phase) * this.lugPitch - this.trackScroll, s);
      N.set(0, s.ny, s.nz);
      Z.crossVectors(X, N);
      m.makeBasis(X, N, Z).setPosition(row.x, s.y, s.z);
      this.lugs.setMatrixAt(i++, m);
    }
    this.lugs.instanceMatrix.needsUpdate = true;
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
    this.headlight.intensity = on ? 22 : 0;
    this.lampMat.emissiveIntensity = on ? 1.6 : 0.2;
  }
}

/** Lay a flat decal on the hull surface at (z, t), facing out. */
function stick(mesh: THREE.Object3D, hull: Hull, z: number, t: number, side: number, off: number) {
  const n = hull.normal(z, t, side);
  const p = hull.point(hull.at(z), t, side).addScaledVector(n, off);
  mesh.position.copy(p);
  mesh.lookAt(p.clone().add(n));
}

/**
 * Closed loop of the track belt in the track group's (z, y) plane: rear idler, flat run on the snow,
 * the long approach ramp up to the drive sprocket, and the return run under the tunnel. Sampled
 * evenly by arc length, counter-clockwise, with outward normals.
 */
class TrackPath {
  readonly length: number;
  readonly rearZ: number;
  readonly contactEnd: number;
  readonly driveZ: number;
  readonly driveY = 0.27;
  private z: Float32Array;
  private y: Float32Array;
  private nz: Float32Array;
  private ny: Float32Array;
  private n: number;

  constructor(contact: number, frontZ: number) {
    const R = 0.1;
    const zr = frontZ - contact - 0.45 + R;
    const za = zr + contact;
    this.rearZ = zr;
    this.contactEnd = za;
    this.driveZ = frontZ - 0.1;
    const top = (f: number) => [0.3 + (zr - 0.3) * f, 0.39 + (2 * R - 0.39) * f];
    const ctrl: number[][] = [];
    for (const a of [90, 135, 180, 225]) ctrl.push([zr + R * Math.cos((a * Math.PI) / 180), R + R * Math.sin((a * Math.PI) / 180)]);
    for (let f = 0; f <= 1.0001; f += 0.25) ctrl.push([zr + (za - zr) * f, 0]);
    ctrl.push([za + 0.16, 0.05], [frontZ - 0.05, 0.17], [frontZ, 0.28], [frontZ - 0.05, 0.36], top(0), top(0.33), top(0.66));
    const curve = new THREE.CatmullRomCurve3(ctrl.map(([z, y]) => new THREE.Vector3(0, y, z)), true, 'centripetal');
    this.length = curve.getLength();
    this.n = Math.ceil(this.length / 0.015);
    const pts = curve.getSpacedPoints(this.n);
    this.z = new Float32Array(this.n + 1);
    this.y = new Float32Array(this.n + 1);
    this.nz = new Float32Array(this.n + 1);
    this.ny = new Float32Array(this.n + 1);
    for (let i = 0; i <= this.n; i++) {
      const a = pts[(i - 1 + this.n) % this.n], b = pts[(i + 1) % this.n];
      const tz = b.z - a.z, ty = b.y - a.y, l = Math.hypot(tz, ty) || 1;
      this.z[i] = pts[i % this.n].z;
      this.y[i] = pts[i % this.n].y;
      this.nz[i] = ty / l;
      this.ny[i] = -tz / l;
    }
  }

  sample(s: number, out: { z: number; y: number; nz: number; ny: number }) {
    const L = this.length;
    const u = ((((s % L) + L) % L) / L) * this.n;
    const i = Math.min(this.n - 1, Math.floor(u)), f = u - i;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * f;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * f;
    out.nz = this.nz[i] + (this.nz[i + 1] - this.nz[i]) * f;
    out.ny = this.ny[i] + (this.ny[i + 1] - this.ny[i]) * f;
  }

  /** Open-sided belt strip; v runs along the belt in lug pitches so the texture scrolls with the lugs. */
  beltGeometry(width: number, pitch: number) {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i <= this.n; i++) {
      const v = (i / this.n) * (this.length / pitch);
      for (const s of [-1, 1]) {
        pos.push((s * width) / 2, this.y[i], this.z[i]);
        uv.push(s > 0 ? 1 : 0, v);
      }
    }
    for (let i = 0; i < this.n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

// ---------- canvas textures ----------

/** Side panels take UVs from this [z0, z1, y0, y1] box (Hull.skin uvBox). */
const SIDE_BOX: [number, number, number, number] = [0.2, 1.8, -0.3, 0.62];

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d')! };
}

function tex(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const FONT = '"Barlow Condensed", "Arial Narrow", system-ui, sans-serif';

/**
 * Side panel graphics in sled coordinates (rear → front reads left → right). The +X side is
 * mirrored so the artwork sweeps the same way on both sides while the lettering still reads.
 */
function makeSideTexture(spec: SledSpec, d: Design, body: string, accent: string, mirror: boolean): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const { c, g } = canvas(W, H);
  const [z0, z1, y0, y1] = SIDE_BOX;
  const X = (z: number) => ((z - z0) / (z1 - z0)) * W;
  const Y = (y: number) => ((y1 - y) / (y1 - y0)) * H;
  const poly = (pts: number[][], fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    pts.forEach(([z, y], i) => (i ? g.lineTo(X(z), Y(y)) : g.moveTo(X(z), Y(y))));
    g.closePath();
    g.fill();
  };
  const light = new THREE.Color(accent).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;
  const ink = light ? '#16181d' : '#f2f4f7';
  g.fillStyle = d.sideArt === 'swoosh' ? body : accent;
  g.fillRect(0, 0, W, H);
  g.save();
  if (mirror) { g.translate(W, 0); g.scale(-1, 1); }
  const gills = (z: number, y: number, n: number, col: string) => {
    for (let i = 0; i < n; i++) poly([[z + i * 0.05, y], [z + i * 0.05 + 0.025, y], [z + i * 0.05 + 0.09, y + 0.2], [z + i * 0.05 + 0.065, y + 0.2]], col);
  };
  if (d.sideArt === 'swoosh') {
    g.fillStyle = accent;
    g.beginPath();
    g.moveTo(X(0.2), Y(-0.02));
    g.bezierCurveTo(X(0.6), Y(-0.1), X(1.0), Y(0.22), X(1.8), Y(0.3));
    g.lineTo(X(1.8), Y(0.12));
    g.bezierCurveTo(X(1.1), Y(0.06), X(0.7), Y(-0.22), X(0.2), Y(-0.24));
    g.fill();
    g.strokeStyle = '#16181d';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(X(0.2), Y(0.04));
    g.bezierCurveTo(X(0.6), Y(-0.04), X(1.0), Y(0.28), X(1.8), Y(0.36));
    g.stroke();
  } else if (d.sideArt === 'shards') {
    poly([[0.2, -0.3], [1.05, -0.3], [1.55, 0.05], [0.95, -0.08], [0.6, 0.02], [0.2, -0.1]], body);
    poly([[0.75, 0.3], [1.45, 0.22], [1.8, 0.4], [1.8, 0.5], [1.2, 0.38]], body);
    poly([[1.05, -0.3], [1.15, -0.3], [1.65, 0.06], [1.55, 0.05]], '#f2f4f7');
    gills(0.32, 0.06, 4, '#3a3f47');
  } else if (d.sideArt === 'topo') {
    g.strokeStyle = body;
    g.lineWidth = 3;
    for (let k = 0; k < 9; k++) {
      g.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = Y(-0.22 + k * 0.035) + Math.sin(x * 0.012 + k * 0.7) * 14 + Math.sin(x * 0.031 - k) * 6;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    poly([[1.1, 0.12], [1.8, 0.2], [1.8, 0.3], [1.0, 0.2]], body);
  } else if (d.sideArt === 'race') {
    poly([[0.2, -0.3], [1.3, -0.3], [1.7, 0.1], [1.3, 0.1], [1.0, -0.12], [0.2, -0.12]], body);
    poly([[0.2, 0.3], [0.7, 0.3], [0.9, 0.5], [0.2, 0.5]], body);
    poly([[1.3, 0.1], [1.7, 0.1], [1.75, 0.15], [1.35, 0.15]], '#f2f4f7');
    poly([[0.2, -0.12], [1.0, -0.12], [1.03, -0.09], [0.2, -0.09]], '#f2f4f7');
  } else {
    // carbon weave with an orange slash
    for (let y = 0; y < H; y += 8) for (let x = 0; x < W; x += 8) {
      const k = ((x >> 3) + (y >> 3)) % 4 < 2;
      g.fillStyle = k ? '#202328' : '#15171a';
      g.fillRect(x, y, 8, 8);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(x, y, k ? 8 : 3, k ? 3 : 8);
    }
    poly([[0.45, -0.3], [0.62, -0.3], [1.25, 0.45], [1.08, 0.45]], accent);
    poly([[0.7, -0.3], [0.76, -0.3], [1.39, 0.45], [1.33, 0.45]], accent);
    gills(1.25, -0.12, 3, '#0c0d0f');
  }
  g.restore();
  // lettering, drawn unmirrored at the mirrored spot
  const text = (s: string, z: number, y: number, px: number, col: string) => {
    g.font = `italic 800 ${px}px ${FONT}`;
    g.fillStyle = col;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s, mirror ? W - X(z) : X(z), Y(y));
  };
  const brand = spec.brand.replace(/ Racing| Customs/, '').toUpperCase();
  const tagCol = d.sideArt === 'carbon' || d.sideArt === 'race' ? '#f2f4f7' : d.sideArt === 'swoosh' ? accent : body;
  if (d.sideArt === 'carbon') {
    text('TURBO', 0.78, 0.15, 92, '#f2f4f7');
    text(brand, 0.78, 0.03, 34, accent);
  } else {
    text(brand, 0.72, 0.16, 70, tagCol);
    text(spec.model.toUpperCase(), 0.72, 0.05, 34, ink === tagCol ? body : ink);
  }
  return tex(c);
}

function makeTunnelDecal(brand: string, color: string) {
  const { c, g } = canvas(512, 76);
  g.font = `italic 800 60px ${FONT}`;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(brand.toUpperCase(), 8, 40);
  const w = g.measureText(brand.toUpperCase()).width;
  g.fillRect(w + 24, 34, 512 - w - 32, 8);
  return tex(c);
}

function makeFlapTexture(brand: string) {
  const { c, g } = canvas(256, 160);
  g.fillStyle = '#18191c';
  g.fillRect(0, 0, 256, 160);
  g.font = `italic 800 44px ${FONT}`;
  g.fillStyle = '#d8dde4';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(brand.split(' ')[0].toUpperCase(), 128, 60);
  g.fillRect(40, 92, 176, 4);
  return tex(c);
}

function makeVentTexture() {
  const { c, g } = canvas(64, 64);
  g.fillStyle = '#121316';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#2a2d33';
  for (let y = 0; y < 64; y += 8) g.fillRect(0, y, 64, 3);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(20, 20);
  return t;
}

function makeFinTexture(len: number) {
  const { c, g } = canvas(64, 64);
  g.fillStyle = '#5a6069';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#9aa2ad';
  for (let x = 0; x < 64; x += 8) g.fillRect(x, 0, 3, 64);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, len * 2);
  return t;
}

function makeGaugeTexture() {
  const { c, g } = canvas(128, 64);
  g.fillStyle = '#05080c';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#39c8ff';
  for (let i = 0; i < 10; i++) g.fillRect(8 + i * 11, 44 - i * 2.5, 8, 8 + i * 2.5);
  g.font = `700 22px ${FONT}`;
  g.fillStyle = '#e6f6ff';
  g.fillText('88', 92, 26);
  return tex(c);
}

/** Running board perforations as an alpha map (white = metal). */
function makeBoardAlpha(open: number) {
  const { c, g } = canvas(64, 256);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 64, 256);
  g.fillStyle = '#000';
  if (open > 0.7) {
    for (let y = 14; y < 240; y += 34) { g.beginPath(); g.roundRect(14, y, 36, 22, 8); g.fill(); }
  } else {
    const r = 3 + open * 4;
    for (let y = 10; y < 250; y += 12) for (let x = 12; x < 56; x += 13) { g.beginPath(); g.arc(x + ((y / 12) % 2) * 6, y, r, 0, Math.PI * 2); g.fill(); }
  }
  return tex(c, false);
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
  // hood skins take sled coordinates (z 0.3..1.7, y -0.25..0.6) as UVs
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
  g.font = `italic 800 58px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 64, 43);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Belt rubber between the lugs: cross ribs and the steel clips on the drive windows. */
function makeTrackTexture() {
  const { c, g } = canvas(64, 64);
  g.fillStyle = '#1b1c1f';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#25272b';
  g.fillRect(0, 20, 64, 24);
  g.fillStyle = '#0d0e10';
  g.fillRect(0, 30, 64, 3);
  g.fillStyle = '#8a8f99';
  for (const x of [18, 44]) g.fillRect(x - 3, 26, 6, 12);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

