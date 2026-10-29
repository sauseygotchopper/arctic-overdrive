import * as THREE from 'three';
import { Sled } from '../vehicles/Sled';
import { SURFACE_ID } from '../physics/Surfaces';
import { Trailer } from '../vehicles/Trailer';

const SPRAY_MAX = 2500;
const FLAKES = 6000;
const PUFF_MAX = 360;

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
  // exhaust and breath: slow, rising, fading puffs in their own small pool
  private puffs: THREE.Points;
  private pp = new Float32Array(PUFF_MAX * 3);
  private pv = new Float32Array(PUFF_MAX * 3);
  private pLife = new Float32Array(PUFF_MAX);
  private pMax = new Float32Array(PUFF_MAX);
  private pSize = new Float32Array(PUFF_MAX);
  private pNext = 0;
  private exhaustAcc = 0;
  private breathT = 0;
  puffColor = new THREE.Color(0xdfe5ee);
  /** 0..1: how visible breath is (cold night air shows it most). */
  breath = 0.4;
  snowIntensity = 0.6;
  wind = 0.5;

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

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pp, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aLife', new THREE.BufferAttribute(this.pLife, 1).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.puffs = new THREE.Points(pg, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.puffColor } },
      vertexShader: sprayVert, fragmentShader: sprayFrag.replace('vLife * 0.75', 'vLife * 0.32'),
      transparent: true, depthWrite: false,
    }));
    this.puffs.frustumCulled = false;
    scene.add(this.puffs);

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

  private puff(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number) {
    const i = this.pNext;
    this.pNext = (this.pNext + 1) % PUFF_MAX;
    this.pp.set([p.x, p.y, p.z], i * 3);
    this.pv.set([v.x, v.y, v.z], i * 3);
    this.pLife[i] = 1;
    this.pMax[i] = life;
    this.pSize[i] = size;
  }

  /** Two-stroke smoke from under the hood (more on the throttle) and the rider's breath in the cold. */
  emitExhaust(sled: Sled, dt: number, throttle: number) {
    const ph = sled.physics;
    const root = sled.visual.root;
    const r = Math.min(1, ph.rpm / ph.params.maxRpm);
    this.exhaustAcc += dt * (4 + throttle * 22 + r * 10);
    const at = new THREE.Vector3();
    const v = new THREE.Vector3();
    while (this.exhaustAcc >= 1) {
      this.exhaustAcc -= 1;
      at.set(0.32, 0.28, 0.7).applyMatrix4(root.matrixWorld);
      v.copy(ph.velocity).multiplyScalar(0.6).addScaledVector(ph.right, 0.6 + Math.random() * 0.6);
      v.y += 0.4 + Math.random() * 0.6;
      this.puff(at, v, 0.8 + Math.random() * 0.8, 0.5 + throttle * 0.5 + Math.random() * 0.4);
    }
    this.breathT -= dt;
    if (this.breathT <= 0 && this.breath > 0.05) {
      this.breathT = 2.2 + Math.random() * 1.4;
      at.copy(sled.visual.headLocal).add(new THREE.Vector3(0, -0.05, 0.25)).applyMatrix4(root.matrixWorld);
      for (let i = 0; i < 5; i++) {
        v.copy(ph.velocity).multiplyScalar(0.85).addScaledVector(ph.forward, 0.5 + Math.random() * 0.4);
        v.y += 0.15 + Math.random() * 0.2;
        this.puff(at, v, 0.9 + Math.random() * 0.5, 0.25 + this.breath * 0.25);
      }
    }
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

  /** Flake brightness tracks the light so they don't glow at night. */
  setFlakeLight(brightness: number, spray = brightness) {
    this.flakeMat.uniforms.uColor.value.setRGB(0.96, 0.97, 1).multiplyScalar(brightness);
    this.sprayColor.setRGB(0.92, 0.94, 1).multiplyScalar(spray);
    this.puffColor.setRGB(0.87, 0.9, 0.95).multiplyScalar(spray);
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
    for (let i = 0; i < PUFF_MAX; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt / this.pMax[i];
      const o = i * 3;
      const drag = Math.exp(-dt * 1.6);
      this.pv[o] = this.pv[o] * drag + this.wind * 0.3 * dt;
      this.pv[o + 1] = this.pv[o + 1] * drag + 0.5 * dt;
      this.pv[o + 2] *= drag;
      this.pp[o] += this.pv[o] * dt;
      this.pp[o + 1] += this.pv[o + 1] * dt;
      this.pp[o + 2] += this.pv[o + 2] * dt;
      this.pSize[i] += dt * 0.6; // puffs spread as they drift
    }
    const pg = this.puffs.geometry;
    pg.attributes.position.needsUpdate = true;
    pg.attributes.aLife.needsUpdate = true;
    pg.attributes.aSize.needsUpdate = true;

    const g = this.spray.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aLife.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;

    // falling snow wraps around the camera
    this.flakes.visible = this.snowIntensity > 0;
    this.flakeMat.uniforms.uScale.value = 60 * (1 + this.wind * 0.04); // bigger, streakier flakes in a blizzard
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
