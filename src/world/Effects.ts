import * as THREE from 'three';
import { Sled } from '../vehicles/Sled';
import { SURFACE_ID } from '../physics/Surfaces';
import { Trailer } from '../vehicles/Trailer';

const SPRAY_MAX = 2500;
const FLAKES = 6000;

const flakeVert = /* glsl */ `
  attribute float aSize;
  uniform float uScale;
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / -mv.z;
    vFade = smoothstep(0.4, 2.0, -mv.z) * (1.0 - smoothstep(25.0, 40.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }`;
const flakeFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(uColor, smoothstep(0.5, 0.15, d) * uOpacity * vFade);
  }`;

const sprayVert = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mv.z) * (0.6 + 0.8 * (1.0 - aLife));
    gl_Position = projectionMatrix * mv;
  }`;
const sprayFrag = /* glsl */ `
  uniform vec3 uColor;
  varying float vLife;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5 || vLife <= 0.0) discard;
    float a = smoothstep(0.5, 0.1, d) * vLife * 0.75;
    gl_FragColor = vec4(uColor, a);
  }`;

/** Snow spray from the track/skis and ambient falling snow around the camera. */
export class Effects {
  private spray: THREE.Points;
  private sp = new Float32Array(SPRAY_MAX * 3);
  private sv = new Float32Array(SPRAY_MAX * 3);
  private life = new Float32Array(SPRAY_MAX);
  private maxLife = new Float32Array(SPRAY_MAX);
  private size = new Float32Array(SPRAY_MAX);
  private next = 0;
  private flakes: THREE.Points;
  private flakeVel = new Float32Array(FLAKES);
  private flakeMat: THREE.ShaderMaterial;
  sprayColor: THREE.Color;
  snowIntensity = 0.6;

  constructor(scene: THREE.Scene, private maxFlakes = FLAKES) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sp, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.sprayColor = new THREE.Color(0xf4f8ff);
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.sprayColor } },
      vertexShader: sprayVert, fragmentShader: sprayFrag,
      transparent: true, depthWrite: false,
    });
    this.spray = new THREE.Points(g, m);
    this.spray.frustumCulled = false;
    scene.add(this.spray);

    const fp = new Float32Array(FLAKES * 3);
    const fs = new Float32Array(FLAKES);
    for (let i = 0; i < FLAKES; i++) {
      fs[i] = 0.6 + Math.random() * Math.random() * 2.2;
      fp[i * 3] = (Math.random() - 0.5) * 80;
      fp[i * 3 + 1] = Math.random() * 40;
      fp[i * 3 + 2] = (Math.random() - 0.5) * 80;
      this.flakeVel[i] = 0.8 + Math.random() * 1.2;
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3).setUsage(THREE.DynamicDrawUsage));
    fg.setAttribute('aSize', new THREE.BufferAttribute(fs, 1));
    this.flakeMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xf6f7ff) }, uOpacity: { value: 0.85 }, uScale: { value: 60 } },
      vertexShader: flakeVert, fragmentShader: flakeFrag, transparent: true, depthWrite: false,
    });
    this.flakes = new THREE.Points(fg, this.flakeMat);
    this.flakes.frustumCulled = false;
    scene.add(this.flakes);
  }

  private emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number) {
    const i = this.next;
    this.next = (this.next + 1) % SPRAY_MAX;
    this.sp.set([p.x, p.y, p.z], i * 3);
    this.sv.set([v.x, v.y, v.z], i * 3);
    this.life[i] = 1;
    this.maxLife[i] = life;
    this.size[i] = size;
  }

  emitFromSled(sled: Sled, dt: number) {
    const ph = sled.physics;
    const speed = Math.abs(ph.speed);
    const tmp = new THREE.Vector3();
    const vel = new THREE.Vector3();
    for (const c of ph.contacts) {
      if (!c.grounded || c.surface.id === SURFACE_ID.ice) continue;
      const k = c.surface.spray;
      const rate = c.isSki ? speed * 0.6 * k : (speed * 1.2 + c.slip * 40 + ph.throttleSpray() * 12) * k;
      let n = rate * dt;
      while (n > 0) {
        if (Math.random() > n) break;
        n -= 1;
        tmp.copy(c.hitPoint);
        tmp.x += (Math.random() - 0.5) * 0.4;
        tmp.z += (Math.random() - 0.5) * 0.4;
        tmp.y += 0.05;
        if (c.isSki) {
          vel.copy(ph.velocity).multiplyScalar(0.3).addScaledVector(ph.right, (c.side) * (1 + Math.random() * 2));
          vel.y += 1 + Math.random() * 1.5;
        } else {
          // rooster tail out the back of the track
          vel.copy(ph.velocity).multiplyScalar(0.25).addScaledVector(ph.forward, -(3 + Math.random() * 5) * (0.4 + c.slip));
          vel.y += 2 + Math.random() * 3.5 * (0.3 + c.surface.sinkDepth * 2);
          vel.x += (Math.random() - 0.5) * 2;
          vel.z += (Math.random() - 0.5) * 2;
        }
        this.emit(tmp, vel, 0.6 + Math.random() * 0.9, 0.35 + Math.random() * 0.5 + c.surface.sinkDepth);
      }
    }
  }

  emitFromTrailer(t: Trailer, dt: number) {
    const speed = Math.abs(t.velocity.dot(t.forward));
    const tmp = new THREE.Vector3();
    const vel = new THREE.Vector3();
    for (const c of t.contacts) {
      if (!c.grounded || c.surface.id === SURFACE_ID.ice) continue;
      let n = speed * 0.35 * c.surface.spray * dt * (1 + c.sink * 4);
      while (n > 0 && Math.random() < n) {
        n -= 1;
        tmp.copy(c.hitPoint);
        tmp.y += 0.05;
        vel.copy(t.velocity).multiplyScalar(0.3).addScaledVector(t.right, c.side * (0.5 + Math.random()));
        vel.y += 0.8 + Math.random();
        this.emit(tmp, vel, 0.5 + Math.random() * 0.6, 0.3 + Math.random() * 0.3 + c.sink);
      }
    }
  }

  /** Kick up a big puff, e.g. on landing. */
  burst(at: THREE.Vector3, strength: number) {
    const v = new THREE.Vector3();
    const n = Math.min(200, strength * 25);
    for (let i = 0; i < n; i++) {
      v.set((Math.random() - 0.5) * 6, Math.random() * 3, (Math.random() - 0.5) * 6);
      this.emit(at, v, 0.8 + Math.random(), 0.6 + Math.random() * 0.6);
    }
  }

  /** Sideways drift; heavier when the weather closes in. */
  wind = 0.4;

  /** Flake brightness tracks the light so they don't glow at night. */
  setFlakeLight(brightness: number, spray = brightness) {
    this.flakeMat.uniforms.uColor.value.setRGB(0.96, 0.97, 1).multiplyScalar(brightness);
    this.sprayColor.setRGB(0.92, 0.94, 1).multiplyScalar(spray);
  }

  update(dt: number, camPos: THREE.Vector3) {
    for (let i = 0; i < SPRAY_MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt / this.maxLife[i];
      const o = i * 3;
      this.sv[o + 1] -= 6 * dt;
      const drag = Math.exp(-dt * 2.2);
      this.sv[o] *= drag; this.sv[o + 1] *= drag; this.sv[o + 2] *= drag;
      this.sp[o] += this.sv[o] * dt;
      this.sp[o + 1] += this.sv[o + 1] * dt;
      this.sp[o + 2] += this.sv[o + 2] * dt;
    }
    const g = this.spray.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aLife.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;

    // falling snow wraps around the camera
    this.flakes.visible = this.snowIntensity > 0;
    const fp = this.flakes.geometry.attributes.position as THREE.BufferAttribute;
    const arr = fp.array as Float32Array;
    const count = Math.floor(this.maxFlakes * Math.min(1, this.snowIntensity));
    this.flakes.geometry.setDrawRange(0, count);
    const t = performance.now() * 0.001;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      arr[o + 1] -= this.flakeVel[i] * dt;
      arr[o] += (Math.sin(t * 0.7 + i) * 0.35 + this.wind) * dt;
      arr[o + 2] += Math.cos(t * 0.5 + i * 1.3) * 0.25 * dt;
      const dx = arr[o] - camPos.x, dy = arr[o + 1] - camPos.y, dz = arr[o + 2] - camPos.z;
      if (dx > 40) arr[o] -= 80; else if (dx < -40) arr[o] += 80;
      if (dz > 40) arr[o + 2] -= 80; else if (dz < -40) arr[o + 2] += 80;
      if (dy < -10) arr[o + 1] += 40; else if (dy > 30) arr[o + 1] -= 40;
    }
    fp.needsUpdate = true;
  }
}
