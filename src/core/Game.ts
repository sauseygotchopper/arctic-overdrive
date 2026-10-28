import * as THREE from 'three';
import worldDef from '../data/world.json';
import { initRapier, PhysicsWorld, PHYSICS_DT } from '../physics/PhysicsWorld';
import { TerrainData, WorldDef } from '../world/TerrainData';
import { TerrainMesh } from '../world/TerrainMesh';
import { Scenery } from '../world/Scenery';
import { SkySystem, TimeOfDay } from '../world/Sky';
import { Effects } from '../world/Effects';
import { Sled } from '../vehicles/Sled';
import { getSled, RIDER_MASS } from '../vehicles/SledSpec';
import { Input } from './Input';
import { CameraRig } from './CameraRig';
import { SaveSystem } from './SaveSystem';
import { HUD } from '../ui/HUD';

const MAX_STEPS = 5;

/** Owns the renderer, world and fixed-timestep loop. Modes (Phase 3+) plug into this. */
export class Game {
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(68, 1, 0.2, 6000);
  input = new Input();
  save = new SaveSystem();
  physics!: PhysicsWorld;
  terrain!: TerrainData;
  sky!: SkySystem;
  effects!: Effects;
  rig!: CameraRig;
  hud!: HUD;
  player!: Sled;
  private acc = 0;
  private last = 0;
  private paused = false;

  constructor(private container: HTMLElement, private onProgress: (msg: string, frac: number) => void) {}

  async init() {
    const q = this.save.data.settings.quality;
    const step = async (msg: string, frac: number) => {
      this.onProgress(msg, frac);
      await new Promise((r) => setTimeout(r, 16)); // let the loader repaint (rAF stalls in hidden tabs)
    };

    await step('Waking up the physics engine…', 0.05);
    await initRapier();
    this.physics = new PhysicsWorld();

    this.renderer = new THREE.WebGLRenderer({ antialias: q !== 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = q !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.container.appendChild(this.renderer.domElement);

    await step('Shaping the valley…', 0.15);
    this.terrain = new TerrainData(worldDef as unknown as WorldDef);
    await step('Laying down snow…', 0.45);
    const tmesh = new TerrainMesh(this.terrain, q);
    this.scene.add(tmesh.group);
    this.physics.addTerrain(this.terrain);
    const err = this.physics.verifyTerrain(this.terrain);
    if (err > 0.5) console.warn(`[terrain] physics/visual height mismatch ${err.toFixed(2)} m`);

    await step('Planting the pine forest…', 0.7);
    const scenery = new Scenery(this.terrain);
    this.scene.add(scenery.group);
    this.physics.addStatic(scenery.colliders);

    await step('Fuelling up…', 0.9);
    this.sky = new SkySystem(this.scene, this.renderer, q === 'high' ? 2048 : q === 'medium' ? 1024 : 0);
    this.sky.apply((this.save.data.settings.timeOfDay as TimeOfDay) || 'morning');
    this.sceneryRef = scenery;
    this.effects = new Effects(this.scene);
    this.rig = new CameraRig(this.camera, this.terrain);
    this.hud = new HUD(this.container);

    const sp = this.terrain.def.spawn;
    const yaw = Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z);
    this.player = new Sled(this.physics, this.terrain, { spec: getSled(this.save.data.currentSled), riderMass: RIDER_MASS, cargoMass: 0 }, new THREE.Vector3(sp.x, this.terrain.heightAt(sp.x, sp.z) + 0.9, sp.z), yaw);
    this.scene.add(this.player.visual.root);
    this.applyLighting();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    (window as unknown as { __game: Game }).__game = this;
    await step('Ready', 1);
  }

  private sceneryRef!: Scenery;

  private applyLighting() {
    const night = this.sky.headlights;
    this.player.visual.setHeadlights(night || this.sky.current === 'overcast');
    this.sceneryRef.windowMaterial.emissiveIntensity = night ? 2.5 : this.sky.current === 'golden' ? 0.6 : 0;
    this.effects.snowIntensity = this.sky.current === 'overcast' ? 1 : this.sky.current === 'night' ? 0.5 : 0.25;
  }

  /** Deterministic fixed-step simulation for testing/tuning from the console. */
  simulate(seconds: number, drive: Partial<import('../vehicles/SledPhysics').DriveInput>) {
    const d = { throttle: 0, brake: 0, steer: 0, leanX: 0, leanZ: 0, ...drive };
    const n = Math.round(seconds / PHYSICS_DT);
    for (let i = 0; i < n; i++) {
      this.player.fixedUpdate(PHYSICS_DT, d);
      this.physics.step();
    }
    this.player.physics.readState();
    return this.player.physics;
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    this.last = performance.now();
    const frame = (now: number) => {
      requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.tick(dt);
    };
    requestAnimationFrame(frame);
  }

  private tick(dt: number) {
    const input = this.input;
    input.update();
    if (input.consumePressed('pause')) this.paused = !this.paused;
    if (input.consumePressed('camera')) this.rig.cycle();
    if (input.consumePressed('timeOfDay')) {
      const t = this.sky.next();
      this.save.data.settings.timeOfDay = t;
      this.save.save();
      this.applyLighting();
      this.hud.toast(`Time of day: ${t}`);
    }
    if (input.consumePressed('reset')) this.player.recover();

    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      const drive = input.drive();
      while (this.acc >= PHYSICS_DT && steps < MAX_STEPS) {
        this.player.fixedUpdate(PHYSICS_DT, drive);
        this.physics.step();
        this.acc -= PHYSICS_DT;
        steps++;
      }
      if (steps === MAX_STEPS) this.acc = 0;
      const p = this.player.physics;
      if (p.landingImpact > 3) {
        this.effects.burst(p.position, p.landingImpact);
        p.landingImpact = 0;
      }
      this.effects.emitFromSled(this.player, dt);
    }
    this.player.render(this.paused ? 1 : this.acc / PHYSICS_DT, this.paused ? 0 : dt);
    this.rig.update(this.player, dt);
    this.effects.update(this.paused ? 0 : dt, this.camera.position);
    this.sky.follow(this.player.visual.root.position);
    this.hud.update(this.player, dt);
    input.endFrame();
    this.renderer.render(this.scene, this.camera);
  }
}
