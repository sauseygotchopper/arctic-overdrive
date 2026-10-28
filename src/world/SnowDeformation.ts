import * as THREE from 'three';
import { TerrainData } from './TerrainData';
import { SURFACE_ID } from '../physics/Surfaces';
import { Sled } from '../vehicles/Sled';
import { Trailer } from '../vehicles/Trailer';

const MAX_STAMPS = 256;
/** Depth (m) that maps to 1.0 in the deformation texture. */
export const DEFORM_DEPTH = 0.6;

/** Base mark depth per surface on top of what the contact actually sank. */
const BASE_MARK = [0.012, 0.05, 0.01, 0, 0.07, 0.02]; // groomed, powder, crust, ice, slush, moguls

const vert = /* glsl */ `
  attribute float aDepth;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vDepth = aDepth;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;
const frag = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    float across = 1.0 - pow(abs(vUv.x * 2.0 - 1.0), 3.0);
    float along = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
    gl_FragColor = vec4(vDepth * across * along, 0.0, 0.0, 1.0);
  }`;

/**
 * Persistent snow deformation. Contacts stamp ruts into a world-sized GPU texture (max-blended so
 * the deepest pass wins); the terrain shader turns it into shading + normals. A matching coarse CPU
 * grid (TerrainData.packed) tells the physics the snow there is already compressed.
 */
export class SnowDeformation {
  readonly target: THREE.WebGLRenderTarget;
  readonly texel: number;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private mesh: THREE.InstancedMesh;
  private depthAttr: THREE.InstancedBufferAttribute;
  private count = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private z = new THREE.Vector3(0, 0, 1);

  constructor(private renderer: THREE.WebGLRenderer, private terrain: TerrainData, resolution: number) {
    this.target = new THREE.WebGLRenderTarget(resolution, resolution, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.texel = 1 / resolution;
    const h = terrain.half;
    // world X → texture U, world Z → texture V (same as the terrain's map UVs)
    this.camera = new THREE.OrthographicCamera(-h, h, h, -h, -1, 1);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.depthAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS), 1);
    geo.setAttribute('aDepth', this.depthAttr);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_STAMPS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.scene.add(this.mesh);
    this.clear();
  }

  clear() {
    const prev = this.renderer.getRenderTarget();
    const prevColor = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(prevColor, prevAlpha);
    this.terrain.packed.fill(0);
  }

  /** Queue an oriented rut: centre (x,z), heading (dx,dz), length/width in m, depth in m. */
  stamp(x: number, z: number, dx: number, dz: number, length: number, width: number, depth: number) {
    if (depth <= 0.003 || this.count >= MAX_STAMPS) return;
    const angle = Math.atan2(-dx, dz);
    this.q.setFromAxisAngle(this.z, angle);
    this.m.compose(new THREE.Vector3(x, z, 0), this.q, new THREE.Vector3(width, length, 1));
    this.mesh.setMatrixAt(this.count, this.m);
    this.depthAttr.setX(this.count, Math.min(1, depth / DEFORM_DEPTH));
    this.count++;
    // coarse physics copy along the centre line
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    for (let s = -length / 2; s <= length / 2; s += 0.5) this.terrain.pack(x + ux * s, z + uz * s, depth);
  }

  stampSled(sled: Sled) {
    const p = sled.physics;
    const c = p.contacts;
    const f = p.forward;
    // skis
    for (const i of [0, 1]) {
      const k = c[i];
      if (!k.grounded) continue;
      const d = k.sink + BASE_MARK[k.surface.id] * 0.6;
      if (k.surface.id !== SURFACE_ID.ice) this.stamp(k.hitPoint.x, k.hitPoint.z, f.x, f.z, 1.0, sled.setup.spec.skiWidth * 1.6, d);
    }
    // track: one stamp spanning the four track contacts; wheelspin digs deeper
    const tr = c.slice(2).filter((k) => k.grounded && k.surface.id !== SURFACE_ID.ice);
    if (tr.length) {
      let x = 0, z = 0, sink = 0, slip = 0, base = 0;
      for (const k of tr) { x += k.hitPoint.x; z += k.hitPoint.z; sink += k.sink; slip += k.slip; base += BASE_MARK[k.surface.id]; }
      const n = tr.length;
      const soft = tr[0].surface.sinkDepth;
      const d = sink / n + base / n + (slip / n) * soft * 0.35;
      this.stamp(x / n, z / n, f.x, f.z, p.params.trackContactLen + 0.3, p.params.trackWidth * 1.05, d);
    }
  }

  stampTrailer(t: Trailer) {
    const f = t.forward;
    for (const [a, b] of [[0, 2], [1, 3]]) {
      const ca = t.contacts[a], cb = t.contacts[b];
      if (!ca.grounded && !cb.grounded) continue;
      const k = ca.grounded ? ca : cb;
      if (k.surface.id === SURFACE_ID.ice) continue;
      const x = ca.grounded && cb.grounded ? (ca.hitPoint.x + cb.hitPoint.x) / 2 : k.hitPoint.x;
      const z = ca.grounded && cb.grounded ? (ca.hitPoint.z + cb.hitPoint.z) / 2 : k.hitPoint.z;
      this.stamp(x, z, f.x, f.z, 1.9, t.skiWidthM * 1.4, Math.max(ca.sink, cb.sink) + BASE_MARK[k.surface.id] * 0.7);
    }
  }

  /** Render queued stamps into the deformation texture. */
  flush() {
    if (!this.count) return;
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.depthAttr.needsUpdate = true;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const auto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    r.autoClear = auto;
    this.count = 0;
    this.mesh.count = 0;
  }
}
