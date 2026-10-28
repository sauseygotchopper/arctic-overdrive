import * as THREE from 'three';
import { Sky as SkyShader } from 'three/examples/jsm/objects/Sky.js';

export type TimeOfDay = 'morning' | 'golden' | 'overcast' | 'night';
export const TIMES_OF_DAY: TimeOfDay[] = ['morning', 'golden', 'overcast', 'night'];
export type Weather = 'clear' | 'snowing' | 'blizzard';
export const WEATHERS: Weather[] = ['clear', 'snowing', 'blizzard'];
/** Fog multiplier, falling-snow intensity, wind (m/s) per weather. */
export const WEATHER_FX: Record<Weather, { fog: number; snow: number; wind: number }> = {
  clear: { fog: 1, snow: 0.15, wind: 0.5 },
  snowing: { fog: 1.7, snow: 0.75, wind: 2 },
  blizzard: { fog: 3.4, snow: 1, wind: 9 },
};

interface Preset {
  elevation: number; azimuth: number; turbidity: number; rayleigh: number;
  sunColor: number; sunIntensity: number; hemiSky: number; hemiGround: number; hemiIntensity: number;
  fog: number; fogDensity: number; exposure: number; headlights: boolean; envIntensity: number;
}

const PRESETS: Record<TimeOfDay, Preset> = {
  morning:  { elevation: 14, azimuth: 135, turbidity: 3,  rayleigh: 1.2, sunColor: 0xfff1de, sunIntensity: 3.0, hemiSky: 0xbfd8ff, hemiGround: 0x8a95a8, hemiIntensity: 0.9, fog: 0xc9daeb, fogDensity: 0.0026, exposure: 0.55, headlights: false, envIntensity: 0.6 },
  golden:   { elevation: 6, azimuth: 245, turbidity: 6, rayleigh: 2.4, sunColor: 0xffb070, sunIntensity: 3.2, hemiSky: 0xffd2b4, hemiGround: 0x7a7a98, hemiIntensity: 1.1, fog: 0xf0c4a4, fogDensity: 0.0024, exposure: 0.78, headlights: false, envIntensity: 0.55 },
  overcast: { elevation: 30, azimuth: 160, turbidity: 18, rayleigh: 0.3, sunColor: 0xdfe6ee, sunIntensity: 0.7, hemiSky: 0xd4dde8, hemiGround: 0xa0a8b4, hemiIntensity: 1.7, fog: 0xc3cad3, fogDensity: 0.0055, exposure: 0.62, headlights: false, envIntensity: 0.5 },
  night:    { elevation: -12, azimuth: 200, turbidity: 2, rayleigh: 0.2, sunColor: 0x8fa8ff, sunIntensity: 0.35, hemiSky: 0x23314f, hemiGround: 0x0b0f1a, hemiIntensity: 0.35, fog: 0x0b1220, fogDensity: 0.0042, exposure: 0.75, headlights: true, envIntensity: 0.2 },
};

/**
 * Sky dome, sun/moon, hemisphere fill, fog and the PMREM environment for reflections.
 * The sun's shadow camera follows a target so shadows stay crisp near the player.
 */
export class SkySystem {
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
  readonly sky = new SkyShader();
  readonly stars: THREE.Points;
  current: TimeOfDay = 'morning';
  weather: Weather = 'clear';
  headlights = false;
  private sunDir = new THREE.Vector3();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private shadowExtent = 60;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, shadowSize: number) {
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);
    this.sun.castShadow = shadowSize > 0;
    this.sun.shadow.mapSize.set(shadowSize || 512, shadowSize || 512);
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowExtent; cam.right = this.shadowExtent;
    cam.top = this.shadowExtent; cam.bottom = -this.shadowExtent;
    cam.near = 1; cam.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.radius = 3;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.FogExp2(0xffffff, 0.003);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.stars = makeStars();
    scene.add(this.stars);
  }

  apply(tod: TimeOfDay) {
    this.current = tod;
    const p = PRESETS[tod];
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = tod === 'overcast' ? 0.02 : 0.005;
    u.mieDirectionalG.value = 0.8;
    const phi = THREE.MathUtils.degToRad(90 - Math.max(p.elevation, -2));
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sky.visible = tod !== 'night';
    this.stars.visible = tod === 'night';

    // at night the "sun" light is the moon: put it high so shadows still read
    if (tod === 'night') this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(50), theta);
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.set(p.fog);
    fog.density = p.fogDensity * WEATHER_FX[this.weather].fog;
    this.renderer.toneMappingExposure = p.exposure;
    this.headlights = p.headlights;
    this.scene.background = tod === 'night' ? new THREE.Color(0x060a14) : tod === 'overcast' ? new THREE.Color(p.fog) : null;
    if (tod === 'overcast') this.sky.visible = false;

    // environment map for reflections (ice!) from the sky itself
    this.envRT?.dispose();
    const envScene = new THREE.Scene();
    if (tod === 'night' || tod === 'overcast') {
      envScene.background = new THREE.Color(tod === 'night' ? 0x0a1222 : p.fog);
    } else {
      const s2 = new SkyShader();
      s2.scale.setScalar(1000);
      Object.assign(s2.material.uniforms.sunPosition.value, this.sunDir);
      for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) s2.material.uniforms[k].value = u[k].value;
      envScene.add(s2);
    }
    this.envRT = this.pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = p.envIntensity;
  }

  setWeather(w: Weather) {
    this.weather = w;
    this.apply(this.current);
  }

  nextWeather(): Weather {
    const w = WEATHERS[(WEATHERS.indexOf(this.weather) + 1) % WEATHERS.length];
    this.setWeather(w);
    return w;
  }

  next(): TimeOfDay {
    const i = TIMES_OF_DAY.indexOf(this.current);
    const t = TIMES_OF_DAY[(i + 1) % TIMES_OF_DAY.length];
    this.apply(t);
    return t;
  }

  /** Keep the shadow frustum centred on the player, snapped to texels to avoid shimmering. */
  follow(target: THREE.Vector3) {
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    const tx = Math.round(target.x / texel) * texel;
    const tz = Math.round(target.z / texel) * texel;
    this.sun.target.position.set(tx, target.y, tz);
    this.sun.position.set(tx, target.y, tz).addScaledVector(this.sunDir, 250);
    this.stars.position.copy(target);
  }
}

function makeStars(): THREE.Points {
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
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 });
  return new THREE.Points(g, m);
}
