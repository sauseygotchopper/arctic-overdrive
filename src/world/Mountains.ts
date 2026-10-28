import * as THREE from 'three';
import { Noise2D, smoothstep } from './Noise';
import { SkyUniforms } from './Sky';

const vert = /* glsl */ `
  varying vec3 vNormal;
  varying float vH;
  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vH = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const frag = /* glsl */ `
  uniform vec3 uSunDir, uSunColor, uHaze, uAmbient;
  uniform float uLayerHaze;
  varying vec3 vNormal;
  varying float vH;
  void main() {
    vec3 n = normalize(vNormal);
    float snow = smoothstep(0.42, 0.62, n.y + vH * 0.35);
    vec3 albedo = mix(vec3(0.30, 0.34, 0.47), vec3(0.93, 0.94, 1.0), snow);
    float ndl = max(dot(n, uSunDir), 0.0);
    vec3 lit = albedo * (uAmbient * 0.85 + uSunColor * ndl * 0.32);
    float haze = clamp(uLayerHaze + (1.0 - vH) * 0.35, 0.0, 1.0);
    gl_FragColor = vec4(mix(lit, uHaze, haze), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

interface Ring { r0: number; depth: number; peak: number; haze: number; seed: number }
const RINGS: Ring[] = [
  { r0: 1150, depth: 500, peak: 520, haze: 0.28, seed: 11 },
  { r0: 1900, depth: 700, peak: 800, haze: 0.5, seed: 23 },
  { r0: 2900, depth: 900, peak: 1150, haze: 0.68, seed: 37 },
];

/** Three rings of stylised peaks around the valley, hazing toward the sky colour with distance. */
export class Mountains {
  readonly group = new THREE.Group();

  constructor(shared: SkyUniforms) {
    for (const ring of RINGS) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uHaze: shared.uHaze, uAmbient: shared.uAmbient,
          uLayerHaze: { value: ring.haze },
        },
        vertexShader: vert, fragmentShader: frag, fog: false,
      });
      const mesh = new THREE.Mesh(buildRing(ring), mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }
}

function buildRing(ring: Ring): THREE.BufferGeometry {
  const nz = new Noise2D(ring.seed);
  const S = 360, R = 14;
  const pos = new Float32Array((S + 1) * (R + 1) * 3);
  const uv = new Float32Array((S + 1) * (R + 1) * 2);
  for (let i = 0; i <= S; i++) {
    const a = (i / S) * Math.PI * 2;
    // wrap noise around the circle so the seam matches
    const cx = Math.cos(a) * 1.5, cz = Math.sin(a) * 1.5;
    const ridge = 0.35 + 0.65 * Math.pow(nz.ridged(cx + 5, cz + 5, 3), 1.1);
    const offset = nz.noise(cx * 0.7, cz * 0.7) * 0.25;
    for (let j = 0; j <= R; j++) {
      const t = j / R;
      const crest = 0.4 + offset * 0.4;
      const across = t < crest ? smoothstep(0, crest, t) : 1 - smoothstep(crest, 1, t) * 0.8;
      const crag = 0.9 + 0.2 * nz.noise(cx * 3 + t * 3, cz * 3 - t * 2);
      const h = ring.peak * ridge * Math.pow(across, 1.3) * crag;
      const r = ring.r0 + t * ring.depth;
      const k = i * (R + 1) + j;
      pos[k * 3] = Math.cos(a) * r;
      pos[k * 3 + 1] = h - 40;
      pos[k * 3 + 2] = Math.sin(a) * r;
      uv[k * 2] = i / S;
      uv[k * 2 + 1] = Math.min(1, h / (ring.peak * 0.75));
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < R; j++) {
      const a = i * (R + 1) + j, b = a + 1, c = a + R + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
