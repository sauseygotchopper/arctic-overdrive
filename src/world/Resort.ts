import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TerrainData } from './TerrainData';
import { StaticCollider } from './Scenery';

const CABLE_GAP = 3.2; // up and down cables either side of the tower centre
const CABINS_PER_SIDE = 7;
const LAMP_SPACING = 46;
const POOL_RADIUS = 10;

/** Valley station → summit. Exposed so Scenery can keep trees out from under the cable. */
export function gondolaLine(t: TerrainData): [THREE.Vector2, THREE.Vector2] {
  let best = new THREE.Vector2(), bh = -Infinity;
  for (let x = -480; x <= 480; x += 12) for (let z = -480; z <= 480; z += 12) {
    const h = t.heightAt(x, z);
    if (h > bh) { bh = h; best = new THREE.Vector2(x, z); }
  }
  const top = clearGround(t, best.clone().multiplyScalar(0.93)); // pull in from the map edge
  const base = clearGround(t, new THREE.Vector2(40, -392));
  return [base, top];
}

/** Nearest spot to `p` (spiralling out) that is well off the trails and lakes and not too steep. */
function clearGround(t: TerrainData, p: THREE.Vector2): THREE.Vector2 {
  for (let r = 0; r <= 120; r += 6) {
    const steps = Math.max(1, Math.round(r / 3));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r, z = p.y + Math.sin(a) * r;
      if (Math.abs(x) > 480 || Math.abs(z) > 480) continue;
      if (t.trailDistanceAt(x, z) > 16 && t.lakeDistance(x, z).d > 1.3 && t.slopeAt(x, z) < 0.4) return new THREE.Vector2(x, z);
    }
  }
  return p;
}

const lampVert = /* glsl */ `
  attribute float aR;
  varying float vR;
  varying float vDist;
  void main() {
    vR = aR;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const lampFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vR;
  varying float vDist;
  void main() {
    float f = pow(1.0 - clamp(vR, 0.0, 1.0), 2.2);
    gl_FragColor = vec4(uColor * f * uIntensity * (1.0 - smoothstep(180.0, 320.0, vDist)), 1.0);
  }`;

/**
 * Resort dressing: gondola line with moving cabins, lamp posts along the trails (glowing heads,
 * additive light pools on the snow and a few real lights that follow the player), and a small
 * terrain park of rails and boxes near the start.
 */
export class Resort {
  readonly group = new THREE.Group();
  readonly colliders: StaticCollider[] = [];
  private lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, emissive: 0xfff1d6, emissiveIntensity: 0, roughness: 0.4 });
  private poolUniforms = { uColor: { value: new THREE.Color(0xfff0d8) }, uIntensity: { value: 0 } };
  private lamps: THREE.Vector3[] = [];
  private lampBases: { x: number; z: number; yaw: number }[] = [];
  private lights: THREE.PointLight[] = [];
  private cabins: THREE.InstancedMesh;
  private cableUp: THREE.Vector3[] = [];
  private cableDown: THREE.Vector3[] = [];
  private cableLen = 0;
  private cabinT = 0;
  private relightTimer = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(private terrain: TerrainData, lampLights: number) {
    this.buildGondola();
    this.cabins = this.makeCabins();
    this.buildLamps(lampLights);
    this.buildPark();
  }

  // ---------- gondola ----------

  private buildGondola() {
    const t = this.terrain;
    const [a, b] = gondolaLine(t);
    const dir = b.clone().sub(a);
    const len = dir.length();
    dir.normalize();
    const side = new THREE.Vector2(dir.y, -dir.x);
    const n = Math.max(3, Math.round(len / 60));
    const towers: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const p = a.clone().addScaledVector(dir, (i / n) * len);
      // towers stand clear of the trails
      for (let k = 0; k < 8 && t.trailDistanceAt(p.x, p.y) < 6; k++) p.addScaledVector(dir, i === n ? -5 : 5);
      const ground = t.heightAt(p.x, p.y);
      const height = i === 0 || i === n ? 9 : 16;
      towers.push(new THREE.Vector3(p.x, ground + height, p.y));
    }
    // raise towers until each span clears the snow (and the trees under it) by a margin
    for (let i = 0; i < n; i++) {
      for (let s = 1; s < 10; s++) {
        const p = towers[i].clone().lerp(towers[i + 1], s / 10);
        const need = t.heightAt(p.x, p.z) + 12 - p.y;
        if (need > 0) { towers[i].y += need; towers[i + 1].y += need; }
      }
    }

    const steel = new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.6, metalness: 0.4 });
    const towerParts: THREE.BufferGeometry[] = [];
    towers.forEach((top, i) => {
      if (i === 0 || i === n) return;
      const ground = t.heightAt(top.x, top.z);
      const h = top.y - ground;
      const yaw = Math.atan2(dir.x, dir.y);
      const mast = new THREE.CylinderGeometry(0.35, 0.6, h, 6);
      mast.translate(0, h / 2, 0);
      const arm = new THREE.BoxGeometry(CABLE_GAP * 2 + 1.2, 0.5, 0.6);
      arm.translate(0, h, 0);
      const g = mergeGeometries([mast.toNonIndexed(), arm.toNonIndexed()])!;
      g.rotateY(yaw + Math.PI / 2);
      g.translate(top.x, ground, top.z);
      towerParts.push(g);
      this.colliders.push({ kind: 'cylinder', x: top.x, y: ground + h / 2, z: top.z, r: 0.7, halfH: h / 2 });
    });
    const towerMesh = new THREE.Mesh(mergeGeometries(towerParts)!, steel);
    towerMesh.castShadow = towerMesh.receiveShadow = true;
    this.group.add(towerMesh);

    for (const [i, end] of [towers[0], towers[n]].entries()) this.station(end, dir, i === 0);

    // cables: offset either side, sagging slightly between towers
    for (const sgn of [1, -1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < n; i++) {
        for (let s = 0; s < 8; s++) {
          const f = s / 8;
          const p = towers[i].clone().lerp(towers[i + 1], f);
          p.y -= Math.sin(f * Math.PI) * 1.4;
          p.x += side.x * CABLE_GAP * sgn;
          p.z += side.y * CABLE_GAP * sgn;
          pts.push(p);
        }
      }
      const last = towers[n].clone();
      last.x += side.x * CABLE_GAP * sgn; last.z += side.y * CABLE_GAP * sgn;
      pts.push(last);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x2a2e38 }));
      this.group.add(line);
      if (sgn > 0) this.cableUp = pts; else this.cableDown = pts.slice().reverse();
    }
    this.cableLen = 0;
    for (let i = 1; i < this.cableUp.length; i++) this.cableLen += this.cableUp[i].distanceTo(this.cableUp[i - 1]);
  }

  private station(top: THREE.Vector3, dir: THREE.Vector2, isBase: boolean) {
    const t = this.terrain;
    const g = new THREE.Group();
    const ground = t.heightAt(top.x, top.z);
    const wall = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 0.9 });
    const roof = new THREE.MeshStandardMaterial({ color: 0xf1f3fa, roughness: 0.85 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.6, metalness: 0.4 });
    const W = 10, L = 14, H = top.y - ground - 1.5;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, Math.max(4, H), L), wall);
    body.position.y = Math.max(4, H) / 2;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.8, L + 1.6), roof);
    cap.position.y = Math.max(4, H) + 0.4;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(CABLE_GAP, 0.25, 6, 24), steel);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(0, top.y - ground, isBase ? -L / 2 + 1 : L / 2 - 1);
    g.add(body, cap, wheel);
    g.position.set(top.x, ground - 0.3, top.z);
    g.rotation.y = Math.atan2(dir.x, dir.y);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(g);
    this.colliders.push({ kind: 'box', x: top.x, y: ground + 2, z: top.z, hx: W / 2, hy: 3, hz: L / 2, rotY: g.rotation.y });
  }

  private makeCabins(): THREE.InstancedMesh {
    const body = new THREE.BoxGeometry(1.7, 1.9, 2.0);
    body.translate(0, -2.6, 0);
    const glass = new THREE.BoxGeometry(1.74, 0.7, 2.04);
    glass.translate(0, -2.2, 0);
    const hanger = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 4);
    hanger.translate(0, -0.8, 0);
    const color = (g: THREE.BufferGeometry, c: number) => {
      const col = new THREE.Color(c);
      const n = g.attributes.position.count;
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) a.set([col.r, col.g, col.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g.toNonIndexed();
    };
    const geo = mergeGeometries([color(body, 0xff5a1f), color(glass, 0x1b2236), color(hanger, 0x2a2e38)])!;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
    const im = new THREE.InstancedMesh(geo, mat, CABINS_PER_SIDE * 2);
    im.castShadow = true;
    im.frustumCulled = false;
    this.group.add(im);
    return im;
  }

  private pointOn(path: THREE.Vector3[], d: number, out: THREE.Vector3): THREE.Vector3 {
    for (let i = 1; i < path.length; i++) {
      const seg = path[i].distanceTo(path[i - 1]);
      if (d <= seg) return out.copy(path[i - 1]).lerp(path[i], d / seg);
      d -= seg;
    }
    return out.copy(path[path.length - 1]);
  }

  // ---------- lamps ----------

  private buildLamps(lightCount: number) {
    const t = this.terrain;
    for (const path of t.trailPaths) {
      if (path.id !== 'loop' && path.id !== 'cross') continue;
      let acc = LAMP_SPACING * 0.5, flip = 1;
      for (let i = 1; i < path.pts.length - 1; i++) {
        acc += Math.hypot(path.pts[i].x - path.pts[i - 1].x, path.pts[i].z - path.pts[i - 1].z);
        if (acc < LAMP_SPACING) continue;
        acc = 0;
        flip = -flip;
        const a = path.pts[i - 1], b = path.pts[i + 1], p = path.pts[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len;
        const x = p.x + nx * flip * (path.width / 2 + 1.6);
        const z = p.z + nz * flip * (path.width / 2 + 1.6);
        if (t.lakeDistance(x, z).d < 1.1) continue;
        // head leans out over the trail
        this.lamps.push(new THREE.Vector3(x - nx * flip * 1.2, t.heightAt(x, z) + 6.2, z - nz * flip * 1.2));
        this.lampBases.push({ x, z, yaw: Math.atan2(-nx * flip, -nz * flip) });
        this.colliders.push({ kind: 'cylinder', x, y: t.heightAt(x, z) + 3, z, r: 0.18, halfH: 3 });
      }
    }
    const poleG = new THREE.CylinderGeometry(0.07, 0.11, 6.4, 6);
    poleG.translate(0, 3.2, 0);
    const armG = new THREE.BoxGeometry(0.08, 0.08, 1.4);
    armG.translate(0, 6.35, 0.6);
    const pole = mergeGeometries([poleG.toNonIndexed(), armG.toNonIndexed()])!;
    const headG = new THREE.BoxGeometry(0.34, 0.16, 0.6);
    headG.translate(0, 6.25, 1.2);
    const poles = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.6, metalness: 0.3 }), this.lamps.length);
    const heads = new THREE.InstancedMesh(headG, this.lampHeadMat, this.lamps.length);
    this.lampBases.forEach(({ x: bx, z: bz, yaw }, i) => {
      this.m.compose(this.v.set(bx, this.terrain.heightAt(bx, bz) - 0.1, bz), this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(i, this.m);
      heads.setMatrixAt(i, this.m);
    });
    poles.castShadow = true;
    poles.computeBoundingSphere();
    heads.computeBoundingSphere();
    this.group.add(poles, heads);

    // light pools: discs draped over the terrain under each head, one merged additive mesh
    const R = 10, S = 16;
    const pos: number[] = [], rr: number[] = [], idx: number[] = [];
    for (const l of this.lamps) {
      const base = pos.length / 3;
      for (let j = 0; j <= R; j++) {
        for (let k = 0; k < S; k++) {
          const r = (j / R) * POOL_RADIUS, a = (k / S) * Math.PI * 2;
          const x = l.x + Math.cos(a) * r, z = l.z + Math.sin(a) * r;
          pos.push(x, this.terrain.heightAt(x, z) + 0.06, z);
          rr.push(j / R);
        }
      }
      for (let j = 0; j < R; j++) for (let k = 0; k < S; k++) {
        const a = base + j * S + k, b = base + j * S + ((k + 1) % S), c = a + S, d = b + S;
        idx.push(a, c, b, b, c, d);
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute('aR', new THREE.Float32BufferAttribute(rr, 1));
    pg.setIndex(idx);
    pg.computeBoundingSphere();
    const pools = new THREE.Mesh(pg, new THREE.ShaderMaterial({
      uniforms: this.poolUniforms, vertexShader: lampVert, fragmentShader: lampFrag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    pools.renderOrder = 2;
    this.group.add(pools);

    for (let i = 0; i < lightCount; i++) {
      const pl = new THREE.PointLight(0xffeccc, 0, 24, 1.6);
      this.lights.push(pl);
      this.group.add(pl);
    }
  }

  // ---------- terrain park ----------

  private buildPark() {
    const t = this.terrain;
    const path = t.trailPaths.find((p) => p.id === 'loop');
    if (!path) return;
    const blue = new THREE.MeshStandardMaterial({ color: 0x2f6bff, roughness: 0.35, metalness: 0.3 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.5 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xc8cedb, roughness: 0.25, metalness: 0.8 });
    const features: { at: number; side: number; kind: 'rail' | 'box' | 'kink' }[] = [
      { at: 12, side: 1, kind: 'box' }, { at: 22, side: -1, kind: 'rail' }, { at: 34, side: 1, kind: 'kink' }, { at: 46, side: -1, kind: 'rail' },
    ];
    for (const f of features) {
      const i = Math.min(path.pts.length - 2, f.at);
      const a = path.pts[i - 1], b = path.pts[i + 1], p = path.pts[i];
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len;
      const off = path.width / 2 + 6;
      const x = p.x + nx * f.side * off, z = p.z + nz * f.side * off;
      const y = t.heightAt(x, z);
      const g = new THREE.Group();
      const L = f.kind === 'box' ? 6 : 8;
      if (f.kind === 'box') {
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, L), orange);
        top.position.y = 0.7;
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, L - 0.1), blue);
        body.position.y = 0.33;
        g.add(top, body);
      } else {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, L, 8), steel);
        pipe.rotation.x = Math.PI / 2;
        pipe.position.y = 0.85;
        g.add(pipe);
        for (const s of [-1, 0, 1]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.85, 0.12), blue);
          leg.position.set(0, 0.42, s * (L / 2 - 0.4));
          g.add(leg);
        }
        if (f.kind === 'kink') {
          pipe.scale.y = 0.5;
          pipe.position.z = -L / 4;
          const down = pipe.clone();
          down.position.set(0, 0.6, L / 4);
          down.rotation.x = Math.PI / 2 - 0.1;
          g.add(down);
        }
      }
      g.position.set(x, y - 0.05, z);
      g.rotation.y = yaw;
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(g);
      this.colliders.push({ kind: 'box', x, y: y + 0.45, z, hx: 0.5, hy: 0.45, hz: L / 2, rotY: yaw });
    }
  }

  // ---------- per frame ----------

  update(dt: number, lampLevel: number, player: THREE.Vector3) {
    // cabins loop up one cable and down the other
    this.cabinT = (this.cabinT + dt * 5) % (this.cableLen * 2);
    const spacing = (this.cableLen * 2) / (CABINS_PER_SIDE * 2);
    for (let i = 0; i < CABINS_PER_SIDE * 2; i++) {
      const d = (this.cabinT + i * spacing) % (this.cableLen * 2);
      const up = d < this.cableLen;
      this.pointOn(up ? this.cableUp : this.cableDown, up ? d : d - this.cableLen, this.v);
      const ahead = this.pointOn(up ? this.cableUp : this.cableDown, Math.min(this.cableLen, (up ? d : d - this.cableLen) + 1), new THREE.Vector3());
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(ahead.x - this.v.x, ahead.z - this.v.z));
      this.m.compose(this.v, this.q, new THREE.Vector3(1, 1, 1));
      this.cabins.setMatrixAt(i, this.m);
    }
    this.cabins.instanceMatrix.needsUpdate = true;

    this.lampHeadMat.emissiveIntensity = lampLevel * 4;
    this.poolUniforms.uIntensity.value = lampLevel * 0.26;
    if ((this.relightTimer -= dt) <= 0 && this.lights.length) {
      this.relightTimer = 0.4;
      const near = this.lamps
        .map((l) => ({ l, d: l.distanceToSquared(player) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.lights.length);
      near.forEach((n, i) => this.lights[i].position.copy(n.l).setY(n.l.y - 0.4));
    }
    for (const l of this.lights) l.intensity = lampLevel * 45;
  }
}
