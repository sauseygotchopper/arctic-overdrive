import * as THREE from 'three';
import { TerrainData } from './TerrainData';
import { SURFACE_ID } from '../physics/Surfaces';
import { clamp, smoothstep } from './Noise';

const CHUNKS = 8;

/**
 * Renders the terrain as CHUNKS x CHUNKS meshes (so the camera and shadow frustums can cull them)
 * sharing one material whose colour/roughness maps are painted from the surface zones.
 */
export class TerrainMesh {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;

  constructor(private data: TerrainData, quality: 'low' | 'medium' | 'high' = 'high') {
    const texSize = quality === 'low' ? 1024 : 2048;
    const { color, rough } = this.paintTextures(texSize);
    this.material = new THREE.MeshStandardMaterial({
      map: color,
      roughnessMap: rough,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.6,
    });
    this.addDetailTexture(this.material);
    this.buildChunks();
  }

  private buildChunks() {
    const d = this.data;
    const n = d.hCells + 1;
    const per = d.hCells / CHUNKS;
    const normals = this.computeNormals();
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const vn = per + 1;
        const pos = new Float32Array(vn * vn * 3);
        const nor = new Float32Array(vn * vn * 3);
        const uv = new Float32Array(vn * vn * 2);
        for (let j = 0; j < vn; j++) {
          for (let i = 0; i < vn; i++) {
            const gx = cx * per + i;
            const gz = cz * per + j;
            const gi = gz * n + gx;
            const vi = j * vn + i;
            const x = gx * d.hStep - d.half;
            const z = gz * d.hStep - d.half;
            pos[vi * 3] = x;
            pos[vi * 3 + 1] = d.heights[gi];
            pos[vi * 3 + 2] = z;
            nor[vi * 3] = normals[gi * 3];
            nor[vi * 3 + 1] = normals[gi * 3 + 1];
            nor[vi * 3 + 2] = normals[gi * 3 + 2];
            uv[vi * 2] = (x + d.half) / d.size;
            uv[vi * 2 + 1] = (z + d.half) / d.size; // data row 0 = v 0 = min z
          }
        }
        const idx = new Uint32Array(per * per * 6);
        let k = 0;
        for (let j = 0; j < per; j++) {
          for (let i = 0; i < per; i++) {
            const a = j * vn + i;
            const b = a + 1;
            const c = a + vn;
            const e = c + 1;
            idx[k++] = a; idx[k++] = c; idx[k++] = b;
            idx[k++] = b; idx[k++] = c; idx[k++] = e;
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.computeBoundingSphere();
        g.computeBoundingBox();
        const m = new THREE.Mesh(g, this.material);
        m.receiveShadow = true;
        m.castShadow = true;
        this.group.add(m);
      }
    }
  }

  private computeNormals(): Float32Array {
    const d = this.data;
    const n = d.hCells + 1;
    const out = new Float32Array(n * n * 3);
    const h = d.heights;
    const v = new THREE.Vector3();
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const hl = h[z * n + Math.max(0, x - 1)];
        const hr = h[z * n + Math.min(n - 1, x + 1)];
        const hd = h[Math.max(0, z - 1) * n + x];
        const hu = h[Math.min(n - 1, z + 1) * n + x];
        v.set(hl - hr, 2 * d.hStep, hd - hu).normalize();
        const i = (z * n + x) * 3;
        out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
      }
    }
    return out;
  }

  /** Albedo + roughness painted per surface so zones read clearly from the saddle. */
  private paintTextures(size: number) {
    const d = this.data;
    const nz = d.noise;
    const col = new Uint8ClampedArray(size * size * 4);
    const rgh = new Uint8ClampedArray(size * size * 4);
    const px = d.size / size;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const x = (i + 0.5) * px - d.half;
        const z = (j + 0.5) * px - d.half;
        // ragged zone edges: jitter the lookup
        const jx = nz.noise(x / 6, z / 6) * 1.6;
        const jz = nz.noise(x / 6 + 31, z / 6 - 17) * 1.6;
        const s = d.surfaceAt(x + jx, z + jz);
        const v = nz.noise(x / 18, z / 18);
        let r = 0.96, g = 0.975, b = 1.0, ro = 0.92;
        switch (s) {
          case SURFACE_ID.powder: {
            const sh = 0.985 + v * 0.015;
            r = 0.95 * sh; g = 0.97 * sh; b = 1.0 * sh; ro = 0.95;
            break;
          }
          case SURFACE_ID.groomed: {
            const td = d.trailDistanceAt(x, z);
            const edge = smoothstep(-2.5, 0, td); // bright windrow at the trail edge
            const cord = 0.5 + 0.5 * Math.sin(td * 9); // corduroy ridges parallel to the trail
            const ruts = Math.exp(-Math.pow((td + 2.2) * 1.4, 2)) + Math.exp(-Math.pow((td + 3.6) * 1.4, 2)) * 0.6; // packed sled lines
            const base = 0.88 - cord * 0.035 - ruts * 0.05 + v * 0.01;
            r = base * 0.93 + edge * 0.1; g = base * 0.95 + edge * 0.09; b = base * 0.99 + edge * 0.05;
            ro = 0.72;
            break;
          }
          case SURFACE_ID.crust: {
            const rip = 0.5 + 0.5 * Math.sin(x * 0.9 + z * 0.35 + nz.noise(x / 9, z / 9) * 4);
            const sh = 0.93 + rip * 0.03 + v * 0.02;
            r = 0.88 * sh; g = 0.91 * sh; b = 0.96 * sh; ro = 0.6;
            break;
          }
          case SURFACE_ID.ice: {
            const crack = smoothstep(0.93, 0.985, nz.ridged(x / 14, z / 14, 2));
            const depth = 0.5 + 0.5 * nz.fbm(x / 30, z / 30, 2);
            r = 0.36 + depth * 0.12 + crack * 0.45;
            g = 0.55 + depth * 0.12 + crack * 0.35;
            b = 0.66 + depth * 0.1 + crack * 0.25;
            ro = 0.08 + crack * 0.4;
            break;
          }
          case SURFACE_ID.slush: {
            const wet = 0.5 + 0.5 * nz.noise(x / 4, z / 4);
            r = 0.62 + wet * 0.08; g = 0.67 + wet * 0.08; b = 0.7 + wet * 0.08; ro = 0.3;
            break;
          }
          case SURFACE_ID.moguls: {
            r = 0.86; g = 0.9; b = 0.95; ro = 0.75;
            break;
          }
        }
        // exposed rock on steep faces
        const slope = d.slopeAt(x, z);
        const rock = smoothstep(1.05, 1.35, slope + nz.noise(x / 5, z / 5) * 0.15);
        if (rock > 0) {
          const rv = 0.32 + 0.08 * nz.noise(x / 2, z / 2);
          r += (rv - r) * rock; g += (rv * 1.02 - g) * rock; b += (rv * 1.08 - b) * rock;
          ro += (0.9 - ro) * rock;
        }
        const o = (j * size + i) * 4;
        col[o] = clamp(r, 0, 1) * 255; col[o + 1] = clamp(g, 0, 1) * 255; col[o + 2] = clamp(b, 0, 1) * 255; col[o + 3] = 255;
        rgh[o] = rgh[o + 1] = rgh[o + 2] = clamp(ro, 0, 1) * 255; rgh[o + 3] = 255;
      }
    }
    const color = new THREE.DataTexture(col, size, size, THREE.RGBAFormat);
    color.colorSpace = THREE.SRGBColorSpace;
    const rough = new THREE.DataTexture(rgh, size, size, THREE.RGBAFormat);
    for (const t of [color, rough]) {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
    return { color, rough };
  }

  /** Tiled fine-scale sparkle/grain so the snow doesn't look blurry up close. */
  private addDetailTexture(mat: THREE.MeshStandardMaterial) {
    const s = 256;
    const data = new Uint8Array(s * s * 4);
    const nz = this.data.noise;
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        // tileable via sampling noise on a torus-ish wrap
        const a = (i / s) * Math.PI * 2;
        const b = (j / s) * Math.PI * 2;
        const v =
          0.5 +
          0.35 * nz.noise(Math.cos(a) * 3 + 100, Math.sin(a) * 3 + Math.cos(b) * 3) +
          0.25 * nz.noise(Math.cos(a) * 9, Math.sin(b) * 9 + Math.sin(a) * 9);
        const o = (j * s + i) * 4;
        data[o] = data[o + 1] = data[o + 2] = clamp(v, 0, 1) * 255;
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, s, s, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    const repeat = this.data.size / 6;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.detailMap = { value: tex };
      shader.uniforms.detailRepeat = { value: repeat };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nuniform float detailRepeat;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float dA = texture2D(detailMap, vMapUv * detailRepeat).r;
          float dB = texture2D(detailMap, vMapUv * detailRepeat * 0.23).r;
          diffuseColor.rgb *= mix(0.93, 1.05, dA * 0.6 + dB * 0.4);`,
        );
    };
  }
}
