import * as THREE from 'three';
import { smoothstep } from './Noise';

export type TimeOfDay = 'morning' | 'golden' | 'overcast' | 'night';
export const TIMES_OF_DAY: TimeOfDay[] = ['morning', 'golden', 'overcast', 'night'];
const PRESET_TIME: Record<TimeOfDay, { hour: number; weather: number }> = {
  morning: { hour: 9.5, weather: 0 },
  golden: { hour: 17.0, weather: 0 },
  overcast: { hour: 12.5, weather: 1 },
  night: { hour: 22.5, weather: 0 },
};

/** One point on the 24 h colour script. Colours are sRGB hex; light intensities are three.js physical units. */
interface Key {
  h: number;
  top: number; horizon: number; ground: number;
  sun: number; sunI: number;
  hemiSky: number; hemiGround: number; hemiI: number;
  fog: number; fogDensity: number;
  env: number; exposure: number; night: number;
}

// Stylised alpine palette: periwinkle zenith, lilac horizon haze, lavender-tinted shade, navy nights.
const KEYS: Key[] = [
  { h: 0, top: 0x081230, horizon: 0x1f2d5a, ground: 0x18234a, sun: 0xa8bcff, sunI: 0, hemiSky: 0x3a4f8f, hemiGround: 0x141b33, hemiI: 0.55, fog: 0x1c2852, fogDensity: 0.0022, env: 0.55, exposure: 1.0, night: 1 },
  { h: 5.2, top: 0x0c1838, horizon: 0x2a3566, ground: 0x1c2650, sun: 0xa8bcff, sunI: 0, hemiSky: 0x3a4f8f, hemiGround: 0x141b33, hemiI: 0.55, fog: 0x232f5c, fogDensity: 0.0022, env: 0.55, exposure: 1.0, night: 1 },
  { h: 6.6, top: 0x3e4f9c, horizon: 0xeaa9a6, ground: 0xb492ae, sun: 0xffa47a, sunI: 1.4, hemiSky: 0x8c94d4, hemiGround: 0x9c8fae, hemiI: 0.35, fog: 0xc1a4c2, fogDensity: 0.0019, env: 0.85, exposure: 1.0, night: 0.25 },
  { h: 8.5, top: 0x5675d6, horizon: 0xc9c8f2, ground: 0xb7b6e0, sun: 0xfff0dc, sunI: 3.6, hemiSky: 0xa6b2ff, hemiGround: 0xc4c4e4, hemiI: 0.3, fog: 0xc6c7f0, fogDensity: 0.0015, env: 0.8, exposure: 1.0, night: 0 },
  { h: 12.5, top: 0x4c78de, horizon: 0xcdd6f6, ground: 0xbac2e6, sun: 0xfffaf2, sunI: 3.8, hemiSky: 0xa9bcff, hemiGround: 0xc8cce6, hemiI: 0.3, fog: 0xcad3f2, fogDensity: 0.0014, env: 0.8, exposure: 0.95, night: 0 },
  { h: 15.8, top: 0x5675d6, horizon: 0xcfc6ee, ground: 0xbab2dc, sun: 0xffe6cc, sunI: 3.6, hemiSky: 0xaab0f6, hemiGround: 0xc8c0dc, hemiI: 0.3, fog: 0xccc4ec, fogDensity: 0.0015, env: 0.8, exposure: 1.0, night: 0 },
  { h: 17.0, top: 0x5f68c0, horizon: 0xffc1a2, ground: 0xd4a8b8, sun: 0xffad6e, sunI: 3.2, hemiSky: 0xb3a6ea, hemiGround: 0xcdb0b8, hemiI: 0.3, fog: 0xe9bfbc, fogDensity: 0.0017, env: 0.95, exposure: 1.0, night: 0 },
  { h: 19.0, top: 0x252e6c, horizon: 0xb784a6, ground: 0x6f5c86, sun: 0xff8a6a, sunI: 0.5, hemiSky: 0x5d62a6, hemiGround: 0x3c3756, hemiI: 0.45, fog: 0x6a6694, fogDensity: 0.002, env: 0.75, exposure: 1.1, night: 0.65 },
  { h: 20.6, top: 0x081230, horizon: 0x1f2d5a, ground: 0x18234a, sun: 0xa8bcff, sunI: 0, hemiSky: 0x3a4f8f, hemiGround: 0x141b33, hemiI: 0.55, fog: 0x1c2852, fogDensity: 0.0022, env: 0.55, exposure: 1.0, night: 1 },
  { h: 24, top: 0x081230, horizon: 0x1f2d5a, ground: 0x18234a, sun: 0xa8bcff, sunI: 0, hemiSky: 0x3a4f8f, hemiGround: 0x141b33, hemiI: 0.55, fog: 0x1c2852, fogDensity: 0.0022, env: 0.55, exposure: 1.0, night: 1 },
];
const OVERCAST = { top: 0xa3a8cc, horizon: 0xcdcfe4, ground: 0xb9bbd6, hemiSky: 0xcfd2ec, hemiGround: 0xb4b6cc, fog: 0xc8cadf };
const MOON = 0xa8bcff;

const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // pin to the far plane
  }`;

const skyFrag = /* glsl */ `
  uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor, uMoonDir;
  uniform float uNight, uTime, uCloud, uSunVis, uDisc;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 1.0, pow(clamp(h, 0.0, 1.0), 0.5)));
    col = mix(col, uGround, smoothstep(0.0, -0.12, h));
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * (pow(sd, 5.0) * 0.18 + pow(sd, 48.0) * 0.5) * uSunVis;
    col += uSunColor * smoothstep(0.99935, 0.9997, sd) * 14.0 * uSunVis * uDisc;
    float md = max(dot(d, uMoonDir), 0.0);
    col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.9993, 0.9995, md) * 2.5 * uDisc + pow(md, 32.0) * 0.12) * uNight;
    if (h > 0.0) {
      vec2 uv = d.xz / (h + 0.15) * 1.1 + vec2(uTime * 0.006, uTime * 0.002);
      float n = fbm(uv);
      float c = smoothstep(0.58 - uCloud * 0.4, 0.92 - uCloud * 0.3, n) * smoothstep(0.0, 0.2, h) * (0.55 + 0.45 * uCloud);
      vec3 lit = mix(uHorizon, vec3(1.0), 0.45) * (1.0 - uNight * 0.75) + uSunColor * 0.06 * uSunVis;
      vec3 shade = mix(uHorizon, uTop, 0.35) * 0.95;
      vec3 cc = mix(shade, lit, smoothstep(0.55, 0.85, n + sd * 0.2));
      col = mix(col, cc, c);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** Uniforms shared with other stylised shaders (distant mountains, lamp pools) so they track the sky. */
export interface SkyUniforms {
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uHaze: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
  uNight: { value: number };
}

/**
 * Gradient sky dome with sun/moon and drifting clouds, a continuous 24 h lighting script
 * (sun/moon light, hemisphere fill, fog, exposure) and a sky-derived PMREM environment that does
 * most of the ambient lighting, which is what gives shaded snow its lavender tint.
 */
export class SkySystem {
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
  readonly dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly shared: SkyUniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uHaze: { value: new THREE.Color() },
    uAmbient: { value: new THREE.Color() },
    uNight: { value: 0 },
  };
  current: TimeOfDay = 'morning';
  hour = 9.5;
  weather = 0;
  private weatherTarget = 0;
  /** Advance time automatically; one full day takes `dayLength` seconds. */
  cycle = false;
  dayLength = 720;
  night = 0;
  lamps = 0;
  headlights = false;
  sunVisible = 0;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  private lightDir = new THREE.Vector3();
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envKey = '';
  private shadowExtent = 60;
  private tmp = new THREE.Color();
  private tmp2 = new THREE.Color();
  private time = 0;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, shadowSize: number, softShadows: boolean) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
        uSunDir: this.shared.uSunDir, uSunColor: { value: new THREE.Color() }, uMoonDir: { value: new THREE.Vector3() },
        uNight: this.shared.uNight, uTime: { value: 0 }, uCloud: { value: 0 }, uSunVis: { value: 1 }, uDisc: { value: 1 },
      },
      vertexShader: skyVert, fragmentShader: skyFrag,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.dome.scale.setScalar(5000);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);
    // same material, drawn into the PMREM cube for image-based ambient + reflections
    const envDome = new THREE.Mesh(this.dome.geometry, mat);
    envDome.scale.setScalar(50);
    this.envScene.add(envDome);

    this.sun.castShadow = shadowSize > 0;
    this.sun.shadow.mapSize.set(shadowSize || 512, shadowSize || 512);
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowExtent; cam.right = this.shadowExtent;
    cam.top = this.shadowExtent; cam.bottom = -this.shadowExtent;
    cam.near = 1; cam.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.radius = softShadows ? 4 : 2;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.FogExp2(0xffffff, 0.0015);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.stars = makeStars();
    scene.add(this.stars);
  }

  apply(tod: TimeOfDay) {
    this.current = tod;
    this.hour = PRESET_TIME[tod].hour;
    this.weather = this.weatherTarget = PRESET_TIME[tod].weather;
    this.update(0);
  }

  next(): TimeOfDay {
    const i = TIMES_OF_DAY.indexOf(this.current);
    const t = TIMES_OF_DAY[(i + 1) % TIMES_OF_DAY.length];
    this.apply(t);
    return t;
  }

  get clock(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  update(dt: number) {
    this.time += dt;
    if (this.cycle) this.hour = (this.hour + (dt * 24) / this.dayLength) % 24;
    this.weather += (this.weatherTarget - this.weather) * Math.min(1, dt * 0.5);
    const k = this.sample(this.hour);
    const w = this.weather;

    // sun path: rises ~06:00 in the east, peaks ~38° at noon, sets ~18:00
    const elev = 38 * Math.sin((Math.PI * (this.hour - 6)) / 12);
    const az = THREE.MathUtils.degToRad(100 + ((this.hour - 6) / 12) * 160);
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), az);
    const moonDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(48), az + Math.PI);
    const dayFade = smoothstep(-1, 5, elev);
    this.sunVisible = dayFade * (1 - w * 0.9);

    const u = this.dome.material.uniforms;
    const mixW = (hex: number, over: number, amt: number) => this.tmp.set(hex).lerp(this.tmp2.set(over).multiplyScalar(1 - k.night * 0.85), amt);
    (u.uTop.value as THREE.Color).copy(mixW(k.top, OVERCAST.top, w));
    (u.uHorizon.value as THREE.Color).copy(mixW(k.horizon, OVERCAST.horizon, w));
    (u.uGround.value as THREE.Color).copy(mixW(k.ground, OVERCAST.ground, w));
    (u.uSunColor.value as THREE.Color).set(k.sun);
    u.uMoonDir.value.copy(moonDir);
    u.uSunVis.value = this.sunVisible;
    u.uCloud.value = 0.25 + w * 0.75;
    u.uTime.value = this.time;
    this.night = k.night;
    this.shared.uNight.value = k.night * (1 - w * 0.5);
    this.shared.uSunDir.value.copy(this.sunDir);

    // one directional light: the sun by day, the moon by night, crossing over at zero intensity
    if (elev > -1) {
      this.lightDir.copy(this.sunDir);
      if (elev < 4) this.lightDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(86), az);
      this.sun.color.set(k.sun);
      this.sun.intensity = k.sunI * dayFade * (1 - w * 0.8);
    } else {
      this.lightDir.copy(moonDir);
      this.sun.color.set(MOON);
      this.sun.intensity = 0.55 * smoothstep(-1, -8, elev) * (1 - w * 0.6);
    }
    this.shared.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);

    this.hemi.color.copy(mixW(k.hemiSky, OVERCAST.hemiSky, w));
    this.hemi.groundColor.copy(mixW(k.hemiGround, OVERCAST.hemiGround, w));
    this.hemi.intensity = k.hemiI * (1 + w * 0.6);
    this.shared.uAmbient.value.copy(u.uTop.value).lerp(u.uHorizon.value, 0.5);

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(mixW(k.fog, OVERCAST.fog, w));
    fog.density = k.fogDensity * (1 + w * 1.6);
    this.shared.uHaze.value.copy(fog.color);
    this.renderer.toneMappingExposure = k.exposure * (1 + w * 0.08);
    this.scene.environmentIntensity = k.env * (1 + w * 0.15);

    this.stars.material.opacity = 0.9 * smoothstep(0.5, 1, k.night) * (1 - w);
    this.stars.visible = this.stars.material.opacity > 0.01;
    this.lamps = smoothstep(0.3, 0.75, k.night) + w * 0.3 * (1 - k.night);
    this.headlights = k.night > 0.45 || w > 0.6;

    // re-bake the environment only when the sky has visibly changed
    const key = `${Math.round(this.hour * 4)}|${Math.round(w * 10)}`;
    if (key !== this.envKey) {
      this.envKey = key;
      u.uDisc.value = 0; // no sun disc in the IBL: avoids sparkly fireflies on ice
      this.envRT?.dispose();
      this.envRT = this.pmrem.fromScene(this.envScene, 0.04);
      this.scene.environment = this.envRT.texture;
      u.uDisc.value = 1;
    }
  }

  private sample(h: number): Key {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = THREE.MathUtils.clamp((h - a.h) / (b.h - a.h), 0, 1);
    const s = t * t * (3 - 2 * t);
    const c = (x: number, y: number) => this.tmp.set(x).lerp(this.tmp2.set(y), s).getHex();
    const n = (x: number, y: number) => x + (y - x) * s;
    return {
      h, top: c(a.top, b.top), horizon: c(a.horizon, b.horizon), ground: c(a.ground, b.ground),
      sun: c(a.sun, b.sun), sunI: n(a.sunI, b.sunI), hemiSky: c(a.hemiSky, b.hemiSky), hemiGround: c(a.hemiGround, b.hemiGround),
      hemiI: n(a.hemiI, b.hemiI), fog: c(a.fog, b.fog), fogDensity: n(a.fogDensity, b.fogDensity), env: n(a.env, b.env),
      exposure: n(a.exposure, b.exposure), night: n(a.night, b.night),
    };
  }

  /** Keep the shadow frustum centred on the player, snapped to texels to avoid shimmering. */
  follow(target: THREE.Vector3, camPos: THREE.Vector3) {
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    const tx = Math.round(target.x / texel) * texel;
    const tz = Math.round(target.z / texel) * texel;
    this.sun.target.position.set(tx, target.y, tz);
    this.sun.position.set(tx, target.y, tz).addScaledVector(this.lightDir, 250);
    this.stars.position.copy(camPos);
    this.dome.position.copy(camPos);
  }
}

function makeStars(): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
  const n = 1800;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection();
    v.y = Math.abs(v.y) * 0.9 + 0.05;
    v.normalize().multiplyScalar(1500);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 2.0, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85, depthWrite: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}
