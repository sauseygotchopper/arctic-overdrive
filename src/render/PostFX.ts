import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GraphicsPreset } from '../core/Graphics';

const quadVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Linear-HDR pass before tone mapping: sun shafts (radial march toward the sun) and speed blur. */
const LensShader = {
  uniforms: {
    tDiffuse: { value: null }, uSunPos: { value: new THREE.Vector2(0.5, 0.5) }, uSunColor: { value: new THREE.Color() },
    uShafts: { value: 0 }, uThresh: { value: 1.3 }, uBlur: { value: 0 },
  },
  vertexShader: quadVert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunPos;
    uniform vec3 uSunColor;
    uniform float uShafts, uThresh, uBlur;
    varying vec2 vUv;
    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      if (uBlur > 0.001) {
        vec2 dir = vUv - 0.5;
        float m = smoothstep(0.12, 0.6, length(dir));
        vec3 acc = col;
        for (int i = 1; i < 8; i++) acc += texture2D(tDiffuse, vUv - dir * float(i) * 0.011 * uBlur * m).rgb;
        col = acc / 8.0;
      }
      if (uShafts > 0.001) {
        vec2 delta = (vUv - uSunPos) / 28.0;
        vec2 p = vUv;
        float illum = 0.0, decay = 1.0;
        for (int i = 0; i < 28; i++) {
          p -= delta;
          float l = dot(texture2D(tDiffuse, p).rgb, vec3(0.3, 0.59, 0.11));
          illum += smoothstep(uThresh, uThresh * 1.5, l) * decay;
          decay *= 0.95;
        }
        float fall = 1.0 - smoothstep(0.0, 0.85, length((vUv - uSunPos) * vec2(1.6, 1.0)));
        col += uSunColor * (illum / 28.0) * uShafts * fall;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** Display-space grade after tone mapping: saturation, contrast, lavender split-tone, vignette, dither. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uSat: { value: 1.08 }, uContrast: { value: 1.04 }, uVignette: { value: 0.22 },
    uShadowTint: { value: new THREE.Vector3(-0.01, -0.015, 0.05) }, uHighTint: { value: new THREE.Vector3(0.02, 0.01, -0.01) },
  },
  vertexShader: quadVert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSat, uContrast, uVignette;
    uniform vec3 uShadowTint, uHighTint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = (c - 0.5) * uContrast + 0.5;
      c += uShadowTint * (1.0 - smoothstep(0.05, 0.65, l)) + uHighTint * smoothstep(0.55, 1.0, l);
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.8);
      c *= mix(1.0 - uVignette, 1.0, smoothstep(0.75, 0.2, length(d)));
      c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export interface PostState { speed: number; sunDir: THREE.Vector3; sunVisible: number; sunColor: THREE.Color; night: number }

/**
 * Post chain: scene → (GTAO) → bloom → lens (shafts + speed blur) → tone map → grade.
 * On the low preset there is no composer: the scene renders straight to the screen.
 */
export class PostFX {
  private composer: EffectComposer | null = null;
  private bloom?: UnrealBloomPass;
  private gtao?: GTAOPass;
  private lens?: ShaderPass;
  private grade?: ShaderPass;
  private sunNdc = new THREE.Vector3();

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private preset: GraphicsPreset) {
    if (!preset.post) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: preset.msaa });
    const c = (this.composer = new EffectComposer(renderer, rt));
    c.addPass(new RenderPass(scene, camera));
    if (preset.ssao) {
      this.gtao = new GTAOPass(scene, camera, size.x, size.y);
      this.gtao.blendIntensity = 0.55;
      this.gtao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.5, thickness: 1.5, scale: 1 });
      c.addPass(this.gtao);
    }
    if (preset.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.2, 0.55, 1.4);
      c.addPass(this.bloom);
    }
    if (preset.shafts || preset.motionBlur) {
      this.lens = new ShaderPass(LensShader);
      c.addPass(this.lens);
    }
    c.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    c.addPass(this.grade);
  }

  setSize(w: number, h: number) {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  render(dt: number, s: PostState) {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const night = s.night;
    if (this.bloom) {
      this.bloom.strength = THREE.MathUtils.lerp(0.16, 0.3, night);
      this.bloom.threshold = THREE.MathUtils.lerp(1.45, 1.1, night);
      this.bloom.radius = THREE.MathUtils.lerp(0.5, 0.7, night);
    }
    if (this.lens) {
      const u = this.lens.uniforms;
      const kmh = s.speed * 3.6;
      const blurT = this.preset.motionBlur ? THREE.MathUtils.smoothstep(kmh, 55, 120) : 0;
      u.uBlur.value += (blurT - u.uBlur.value) * Math.min(1, dt * 4);
      let shafts = 0;
      if (this.preset.shafts && s.sunVisible > 0.05) {
        this.sunNdc.copy(s.sunDir).multiplyScalar(1000).add(this.camera.position).project(this.camera);
        const facing = s.sunDir.dot(this.camera.getWorldDirection(new THREE.Vector3()));
        if (facing > 0) {
          u.uSunPos.value.set(this.sunNdc.x * 0.5 + 0.5, this.sunNdc.y * 0.5 + 0.5);
          shafts = 0.35 * s.sunVisible * THREE.MathUtils.smoothstep(facing, 0.1, 0.6);
        }
      }
      u.uShafts.value = shafts;
      u.uSunColor.value.copy(s.sunColor).multiplyScalar(0.35);
    }
    if (this.grade) this.grade.uniforms.uVignette.value = THREE.MathUtils.lerp(0.2, 0.32, night);
    this.composer.render(dt);
  }
}
