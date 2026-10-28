import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TerrainData } from './TerrainData';
import { mulberry32, smoothstep } from './Noise';

export type StaticCollider =
  | { kind: 'cylinder'; x: number; y: number; z: number; r: number; halfH: number }
  | { kind: 'ball'; x: number; y: number; z: number; r: number }
  | { kind: 'box'; x: number; y: number; z: number; hx: number; hy: number; hz: number; rotY: number };

const CHUNKS = 8;

/** Pines, rocks, cabins, fences and trail markers, instanced per terrain chunk for culling. */
export class Scenery {
  readonly group = new THREE.Group();
  readonly colliders: StaticCollider[] = [];
  /** Warm cabin windows – Sky toggles their glow at night. */
  readonly windowMaterial = new THREE.MeshStandardMaterial({ color: 0x334455, emissive: 0xffa040, emissiveIntensity: 0 });
  treeCount = 0;
  /** x,z pairs of every pine (minimap). */
  readonly treePositions: number[] = [];

  constructor(private data: TerrainData, private clearings: { ax: number; az: number; bx: number; bz: number; width: number }[] = []) {
    const rand = mulberry32(data.def.seed * 7 + 3);
    this.placeTrees(rand);
    this.placeRocks(rand);
    this.placeCabins();
    this.placeFencesAndMarkers(rand);
  }

  /** Off-trail course corridors are kept free of trees and rocks. */
  private inClearing(x: number, z: number, pad: number): boolean {
    for (const c of this.clearings) {
      const vx = c.bx - c.ax, vz = c.bz - c.az;
      const len2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((x - c.ax) * vx + (z - c.az) * vz) / len2));
      if (Math.hypot(x - (c.ax + vx * t), z - (c.az + vz * t)) < c.width / 2 + pad) return true;
    }
    return false;
  }

  private chunkOf(x: number, z: number) {
    const d = this.data;
    const cx = Math.min(CHUNKS - 1, Math.max(0, Math.floor(((x + d.half) / d.size) * CHUNKS)));
    const cz = Math.min(CHUNKS - 1, Math.max(0, Math.floor(((z + d.half) / d.size) * CHUNKS)));
    return cz * CHUNKS + cx;
  }

  private instancedByChunk(
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    items: { m: THREE.Matrix4; c?: THREE.Color; x: number; z: number }[],
    shadows = true,
  ) {
    const buckets: (typeof items)[] = Array.from({ length: CHUNKS * CHUNKS }, () => []);
    for (const it of items) buckets[this.chunkOf(it.x, it.z)].push(it);
    for (const b of buckets) {
      if (!b.length) continue;
      const im = new THREE.InstancedMesh(geom, mat, b.length);
      b.forEach((it, i) => {
        im.setMatrixAt(i, it.m);
        if (it.c) im.setColorAt(i, it.c);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = shadows;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  // ---------- trees ----------

  private pineGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.18, 0.28, 2.2, 6);
    trunk.translate(0, 1.1, 0);
    paint(trunk, () => [0.27, 0.18, 0.12]);
    parts.push(trunk);
    const tiers = 4;
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1);
      const r = 2.3 - f * 1.5;
      const h = 3.4 - f * 0.9;
      const y = 1.6 + t * 1.9;
      const cone = new THREE.ConeGeometry(r, h, 8, 2, true);
      cone.translate(0, y + h / 2, 0);
      const top = y + h;
      paint(cone, (_x, vy) => {
        const k = smoothstep(y + h * 0.35, top, vy); // snow builds up toward each tier's tip
        const green = [0.09, 0.2, 0.15];
        const snow = [0.92, 0.95, 1.0];
        return green.map((g, i) => g + (snow[i] - g) * Math.min(1, k * 1.15)) as [number, number, number];
      });
      parts.push(cone);
      // snow-laden underside ring gives a heavier winter silhouette
      const skirt = new THREE.ConeGeometry(r * 1.02, h * 0.18, 8, 1, true);
      skirt.translate(0, y + h * 0.09, 0);
      paint(skirt, () => [0.82, 0.86, 0.92]);
      parts.push(skirt);
    }
    const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
    g.computeVertexNormals();
    return g;
  }

  private placeTrees(rand: () => number) {
    const d = this.data;
    const nz = d.noise;
    const step = 7;
    const items: { m: THREE.Matrix4; c: THREE.Color; x: number; z: number }[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const spawn = d.def.spawn;
    for (let z = -d.half + 20; z < d.half - 20; z += step) {
      for (let x = -d.half + 20; x < d.half - 20; x += step) {
        const px = x + (rand() - 0.5) * step;
        const pz = z + (rand() - 0.5) * step;
        const forest = nz.fbm(px / 160 + 40, pz / 160, 3) + 0.15;
        const density = smoothstep(0.0, 0.35, forest);
        if (rand() > density * 0.9 + 0.015) continue;
        if (d.trailDistanceAt(px, pz) < 3.5) continue;
        if (this.inClearing(px, pz, 3)) continue;
        if (d.lakeDistance(px, pz).d < 1.12) continue;
        if (d.def.cabins.some((c) => Math.hypot(px - c.x, pz - c.z) < 20)) continue;
        if (Math.hypot(px - spawn.x, pz - spawn.z) < 25) continue;
        const h = d.heightAt(px, pz);
        if (d.slopeAt(px, pz) > 0.9 || h > 125) continue;
        const sc = 0.75 + rand() * 0.65;
        const sy = sc * (0.85 + rand() * 0.4);
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        p.set(px, h - 0.2, pz);
        s.set(sc, sy, sc);
        m.compose(p, q, s);
        const tint = 0.85 + rand() * 0.25;
        items.push({ m: m.clone(), c: new THREE.Color(tint, tint, tint), x: px, z: pz });
        this.treePositions.push(px, pz);
        this.colliders.push({ kind: 'cylinder', x: px, y: h + 2, z: pz, r: 0.35 * sc + 0.1, halfH: 2.5 });
      }
    }
    this.treeCount = items.length;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    this.instancedByChunk(this.pineGeometry(), mat, items);
  }

  // ---------- rocks ----------

  private rockGeometry(): THREE.BufferGeometry {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nz = this.data.noise;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      const k = 1 + 0.28 * nz.noise(v.x * 1.7 + 9, v.z * 1.7 + v.y * 1.3);
      v.multiplyScalar(k);
      v.y *= 0.7;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    const ng = g.index ? g.toNonIndexed() : g;
    ng.computeVertexNormals();
    const nrm = ng.attributes.normal as THREE.BufferAttribute;
    paint(ng, (_x, _y, _z, i) => {
      const ny = nrm.getY(i);
      return ny > 0.55 ? [0.9, 0.93, 0.97] : [0.33, 0.34, 0.37];
    });
    return ng;
  }

  private placeRocks(rand: () => number) {
    const d = this.data;
    const items: { m: THREE.Matrix4; x: number; z: number }[] = [];
    const m = new THREE.Matrix4();
    const e = new THREE.Euler();
    const q = new THREE.Quaternion();
    let tries = 0;
    while (items.length < 320 && tries++ < 20000) {
      const x = (rand() - 0.5) * (d.size - 60);
      const z = (rand() - 0.5) * (d.size - 60);
      const slope = d.slopeAt(x, z);
      if (rand() > 0.15 + slope * 0.8) continue;
      if (d.trailDistanceAt(x, z) < 4 || d.lakeDistance(x, z).d < 1.05) continue;
      if (this.inClearing(x, z, 4)) continue;
      if (d.def.cabins.some((c) => Math.hypot(x - c.x, z - c.z) < 18)) continue;
      const sc = 0.5 + Math.pow(rand(), 2) * 2.8;
      const y = d.heightAt(x, z) - sc * 0.25;
      e.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sc * (0.8 + rand() * 0.5), sc, sc * (0.8 + rand() * 0.5)));
      items.push({ m: m.clone(), x, z });
      this.colliders.push({ kind: 'ball', x, y: y + sc * 0.1, z, r: sc * 0.8 });
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    this.instancedByChunk(this.rockGeometry(), mat, items);
  }

  // ---------- cabins ----------

  private placeCabins() {
    const logTex = makeLogTexture();
    const wallMat = new THREE.MeshStandardMaterial({ map: logTex, roughness: 0.85 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness: 0.9 });
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.9 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6b6d72, roughness: 0.95, flatShading: true });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x5a3320, roughness: 0.8 });
    for (const c of this.data.def.cabins) {
      const g = new THREE.Group();
      const W = 7, L = 9, H = 3.2;
      const walls = new THREE.Mesh(new THREE.BoxGeometry(W, H, L), wallMat);
      walls.position.y = H / 2;
      g.add(walls);
      const roofW = W / 2 / Math.cos(0.6) + 0.6;
      for (const side of [-1, 1]) {
        const roof = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.25, L + 1.4), roofMat);
        roof.position.set(side * (W / 4), H + Math.tan(0.6) * (W / 4) + 0.1, 0);
        roof.rotation.z = -side * 0.6;
        g.add(roof);
        const snow = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.3, L + 1.5), snowMat);
        snow.position.copy(roof.position).add(new THREE.Vector3(0, 0.25, 0));
        snow.rotation.z = roof.rotation.z;
        g.add(snow);
      }
      // gables
      const gable = new THREE.Shape();
      gable.moveTo(-W / 2, 0); gable.lineTo(W / 2, 0); gable.lineTo(0, Math.tan(0.6) * (W / 2)); gable.closePath();
      for (const side of [-1, 1]) {
        const gm = new THREE.Mesh(new THREE.ShapeGeometry(gable), wallMat);
        gm.position.set(0, H, side * (L / 2 + 0.001));
        if (side < 0) gm.rotation.y = Math.PI;
        g.add(gm);
      }
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.6, 0.9), stoneMat);
      chimney.position.set(W / 4, H + 1.6, -L / 4);
      g.add(chimney);
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.1, 0.08), doorMat);
      door.position.set(0, 1.05, L / 2 + 0.04);
      g.add(door);
      for (const wx of [-2.2, 2.2]) {
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.08), this.windowMaterial);
        win.position.set(wx, 1.7, L / 2 + 0.04);
        g.add(win);
      }
      // porch woodpile
      const pile = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 0.8), new THREE.MeshStandardMaterial({ color: 0x6e4a30, roughness: 0.9 }));
      pile.position.set(W / 2 + 0.6, 0.5, 1.5);
      pile.rotation.y = Math.PI / 2;
      g.add(pile);

      const y = this.data.heightAt(c.x, c.z);
      g.position.set(c.x, y - 0.1, c.z);
      g.rotation.y = c.rot;
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(g);
      this.colliders.push({ kind: 'box', x: c.x, y: y + H / 2, z: c.z, hx: W / 2, hy: H / 2 + 0.6, hz: L / 2, rotY: c.rot });
    }
  }

  // ---------- fences + trail markers ----------

  private placeFencesAndMarkers(rand: () => number) {
    const d = this.data;
    const nz = d.noise;
    const posts: { m: THREE.Matrix4; x: number; z: number }[] = [];
    const rails: { m: THREE.Matrix4; x: number; z: number }[] = [];
    const markers: { m: THREE.Matrix4; x: number; z: number }[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    d.trailPaths.forEach((t, ti) => {
      let prev: THREE.Vector3 | null = null;
      for (let i = 1; i < t.pts.length - 1; i++) {
        const a = t.pts[i - 1], b = t.pts[i + 1], p = t.pts[i];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = dz / len, nzv = -dx / len; // right-hand normal
        // trail marker poles alternate sides every ~30 m
        if (i % 15 === 0) {
          const side = (i / 15) % 2 === 0 ? 1 : -1;
          const mx = p.x + nx * side * (t.width / 2 + 1.2);
          const mz = p.z + nzv * side * (t.width / 2 + 1.2);
          if (d.lakeDistance(mx, mz).d > 1 && d.trailDistanceAt(mx, mz) > 0.5) {
            m.compose(new THREE.Vector3(mx, d.heightAt(mx, mz), mz), q.identity(), one);
            markers.push({ m: m.clone(), x: mx, z: mz });
          }
        }
        const fenceOn = nz.noise(i * 0.025 + ti * 13.1, ti * 3.7) > 0.35;
        if (!fenceOn || i % 2 !== 0) { prev = null; continue; }
        const off = t.width / 2 + 3;
        const fx = p.x + nx * off;
        const fz = p.z + nzv * off;
        // never fence across another trail (junctions) or a course corridor
        if (d.lakeDistance(fx, fz).d < 1.1 || d.trailDistanceAt(fx, fz) < 2 || this.inClearing(fx, fz, 2)) { prev = null; continue; }
        const fy = d.heightAt(fx, fz);
        const cur = new THREE.Vector3(fx, fy, fz);
        m.compose(cur, q.setFromAxisAngle(up, rand() * 3), one);
        posts.push({ m: m.clone(), x: fx, z: fz });
        if (prev && prev.distanceTo(cur) < 7) {
          const mid = prev.clone().add(cur).multiplyScalar(0.5);
          const dir = cur.clone().sub(prev);
          const span = dir.length();
          const yaw = Math.atan2(dir.x, dir.z);
          const pitch = Math.asin(dir.y / span);
          const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, 0, 'YXZ'));
          for (const ry of [0.55, 1.0]) {
            m.compose(mid.clone().add(new THREE.Vector3(0, ry, 0)), rq, new THREE.Vector3(1, 1, span));
            rails.push({ m: m.clone(), x: mid.x, z: mid.z });
          }
          this.colliders.push({ kind: 'box', x: mid.x, y: mid.y + 0.6, z: mid.z, hx: 0.08, hy: 0.6, hz: span / 2, rotY: yaw });
        }
        prev = cur;
      }
    });
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.9 });
    const postG = new THREE.CylinderGeometry(0.07, 0.09, 1.3, 5);
    postG.translate(0, 0.62, 0);
    this.instancedByChunk(postG, wood, posts);
    const railG = new THREE.BoxGeometry(0.07, 0.1, 1);
    this.instancedByChunk(railG, wood, rails);

    const markerG = new THREE.CylinderGeometry(0.04, 0.04, 1.8, 5);
    markerG.translate(0, 0.9, 0);
    paint(markerG, (_x, y) => (y > 1.45 ? [1.0, 0.35, 0.05] : [0.12, 0.12, 0.14]));
    this.instancedByChunk(markerG, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), markers, false);
  }
}

/** Assign per-vertex colours from a function of local position. */
function paint(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, i: number) => [number, number, number] | number[]) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = fn(pos.getX(i), pos.getY(i), pos.getZ(i), i);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function makeLogTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    const y = i * 16;
    const grd = ctx.createLinearGradient(0, y, 0, y + 16);
    grd.addColorStop(0, '#4a2f1f');
    grd.addColorStop(0.5, '#7a5236');
    grd.addColorStop(1, '#3b2518');
    ctx.fillStyle = grd;
    ctx.fillRect(0, y, 64, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}
