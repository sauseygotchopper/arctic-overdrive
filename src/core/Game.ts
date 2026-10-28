import * as THREE from 'three';
import worldDef from '../data/world.json';
import { initRapier, PhysicsWorld, PHYSICS_DT } from '../physics/PhysicsWorld';
import { TerrainData, WorldDef } from '../world/TerrainData';
import { TerrainMesh } from '../world/TerrainMesh';
import { Scenery } from '../world/Scenery';
import { Jumps, JumpDef } from '../world/Jumps';
import { SkySystem, TimeOfDay } from '../world/Sky';
import { Effects } from '../world/Effects';
import { Sled } from '../vehicles/Sled';
import { getSled, RIDER_MASS } from '../vehicles/SledSpec';
import { DriveInput } from '../vehicles/SledPhysics';
import { Trailer, TrailerUpgrades } from '../vehicles/Trailer';
import { LooseCargo, TEST_LOADS } from '../vehicles/Cargo';
import { Input } from './Input';
import { CameraRig } from './CameraRig';
import { SaveSystem } from './SaveSystem';
import { HUD } from '../ui/HUD';
import { Menu } from '../ui/Menu';
import { CameraMode } from './CameraRig';
import { DevTools } from './DevTools';
import { GRAPHICS, GraphicsPreset } from './Graphics';
import { Mountains } from '../world/Mountains';
import { PostFX } from '../render/PostFX';
import { TrackMarks } from '../world/TrackMarks';
import { Resort, gondolaLine } from '../world/Resort';

const MAX_STEPS = 5;

/** Owns the renderer, world and fixed-timestep loop. Modes (Phase 3+) plug into this. */
export class Game {
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(64, 1, 0.2, 8000);
  input = new Input();
  save = new SaveSystem();
  physics!: PhysicsWorld;
  terrain!: TerrainData;
  sky!: SkySystem;
  effects!: Effects;
  rig!: CameraRig;
  hud!: HUD;
  menu!: Menu;
  player!: Sled;
  jumps!: Jumps;
  loose!: LooseCargo;
  readonly dev = new DevTools(this);
  gfx!: GraphicsPreset;
  post!: PostFX;
  private scenery!: Scenery;
  private terrainMesh!: TerrainMesh;
  private marks!: TrackMarks;
  private resort!: Resort;
  private loadIndex = 1;
  private acc = 0;
  private last = 0;
  private paused = false;
  // adaptive resolution: trims the pixel ratio when frames run long, restores it when there is headroom
  private frameAcc = 0;
  private frameCount = 0;
  private resScale = 1;

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

    const g = (this.gfx = GRAPHICS[q]);
    this.renderer = new THREE.WebGLRenderer({ antialias: g.antialias && !g.post, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, g.pixelRatio));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = g.shadowSize > 0;
    this.renderer.shadowMap.type = g.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.container.appendChild(this.renderer.domElement);

    await step('Shaping the valley…', 0.15);
    this.terrain = new TerrainData(worldDef as unknown as WorldDef);
    await step('Laying down snow…', 0.45);
    this.terrainMesh = new TerrainMesh(this.terrain, g.terrainTex, g.sparkle);
    this.scene.add(this.terrainMesh.group);
    this.marks = new TrackMarks(this.terrain, g.trackPoints);
    this.scene.add(this.marks.group);
    this.physics.addTerrain(this.terrain);
    const err = this.physics.verifyTerrain(this.terrain);
    if (err > 0.5) console.warn(`[terrain] physics/visual height mismatch ${err.toFixed(2)} m`);

    await step('Planting the pine forest…', 0.7);
    this.resort = new Resort(this.terrain, g.lampLights);
    this.scene.add(this.resort.group);
    this.physics.addStatic(this.resort.colliders);
    const [ga, gb] = gondolaLine(this.terrain);
    const gdir = gb.clone().sub(ga);
    const glen2 = gdir.lengthSq();
    const reserved = this.resort.colliders.map((c) => [c.x, c.z]);
    this.scenery = new Scenery(this.terrain, (x, z) => {
      const t = THREE.MathUtils.clamp(((x - ga.x) * gdir.x + (z - ga.y) * gdir.y) / glen2, 0, 1);
      if (Math.hypot(x - (ga.x + gdir.x * t), z - (ga.y + gdir.y * t)) < 9) return true;
      return reserved.some(([rx, rz]) => Math.abs(x - rx) < 4 && Math.abs(z - rz) < 4);
    });
    this.scene.add(this.scenery.group);
    this.physics.addStatic(this.scenery.colliders);
    this.jumps = new Jumps(this.terrain, (worldDef as unknown as { jumps: JumpDef[] }).jumps);
    this.scene.add(this.jumps.group);
    for (const c of this.jumps.colliders) this.physics.addTrimesh(c.vertices, c.indices);

    await step('Fuelling up…', 0.9);
    this.sky = new SkySystem(this.scene, this.renderer, g.shadowSize, g.softShadows);
    this.sky.cycle = this.save.data.settings.dayCycle;
    this.sky.apply((this.save.data.settings.timeOfDay as TimeOfDay) || 'morning');
    this.scene.add(new Mountains(this.sky.shared).group);
    this.post = new PostFX(this.renderer, this.scene, this.camera, g);
    this.effects = new Effects(this.scene, g.snowflakes);
    this.rig = new CameraRig(this.camera, this.terrain);
    this.hud = new HUD(this.container, this.terrain);
    this.hud.onMenu = () => this.setPaused(!this.paused);
    this.rig.setMode((this.save.data.settings.camera as CameraMode) || 'chase');
    this.menu = new Menu(this.container, {
      resume: () => this.setPaused(false),
      quality: () => this.save.data.settings.quality,
      setQuality: (v) => {
        if (v === this.save.data.settings.quality) return;
        this.save.data.settings.quality = v;
        this.save.save();
        location.reload();
      },
      timeOfDay: () => this.sky.current,
      setTimeOfDay: (t) => {
        this.sky.apply(t);
        this.setDayCycle(false);
        this.save.data.settings.timeOfDay = t;
        this.save.save();
      },
      dayCycle: () => this.sky.cycle,
      setDayCycle: (on) => this.setDayCycle(on),
      camera: () => this.rig.mode,
      setCamera: (m) => {
        this.rig.setMode(m);
        this.save.data.settings.camera = m;
        this.save.save();
      },
      clock: () => this.sky.clock,
    });
    this.hud.setWallet(this.save.data.currency, this.save.data.xp);
    this.loose = new LooseCargo(this.physics, this.scene);

    const sp = this.terrain.def.spawn;
    const yaw = Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z);
    this.player = new Sled(this.physics, this.terrain, { spec: getSled(this.save.data.currentSled), riderMass: RIDER_MASS, cargoMass: 0 }, new THREE.Vector3(sp.x, this.terrain.heightAt(sp.x, sp.z) + 0.9, sp.z), yaw);
    this.scene.add(this.player.visual.root);
    this.applyLighting();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    Object.assign(window, { __game: this, __dev: this.dev });
    await step('Ready', 1);
  }

  /** Per-frame: lamps, headlights, windows and snowfall follow the continuous time of day. */
  private applyLighting() {
    const sky = this.sky;
    this.player.visual.setHeadlights(sky.headlights);
    this.scenery.windowMaterial.emissiveIntensity = Math.max(sky.night * 2.5, sky.current === 'golden' ? 0.6 : 0);
    this.effects.snowIntensity = 0.2 + sky.weather * 0.8 + sky.night * 0.15;
    this.terrainMesh.sparkle.value = sky.sunVisible * 2.5;
    this.effects.wind = 0.4 + sky.weather * 2.2;
    this.effects.setFlakeLight(THREE.MathUtils.lerp(1.1, 0.3, sky.night), THREE.MathUtils.lerp(1.0, 0.12, sky.night));
    this.effects.sprayColor.lerp(sky.hemi.color, sky.night * 0.6); // night spray takes on the blue ambient instead of reading as grey smoke
  }

  setPaused(on: boolean) {
    this.paused = on;
    this.menu.show(on);
  }

  setDayCycle(on: boolean) {
    this.sky.cycle = on;
    this.save.data.settings.dayCycle = on;
    this.save.save();
  }

  // ---------- trailer ----------

  toggleTrailer() {
    const p = this.player;
    if (p.trailer) {
      const t = p.trailer;
      p.detachTrailer();
      t.dispose(this.scene);
      this.hud.toast('Trailer unhitched');
      return;
    }
    const t = new Trailer(this.physics, this.terrain, this.loose, { ...this.save.data.trailer.upgrades }, p.physics.position.clone(), 0);
    this.scene.add(t.root);
    t.setCargo(TEST_LOADS[this.loadIndex]);
    p.attachTrailer(t);
    this.hud.toast('Trailer hitched — tricks disabled');
  }

  cycleLoad() {
    const t = this.player.trailer;
    if (!t) { this.hud.toast('Hitch the trailer first (H)'); return; }
    this.loadIndex = (this.loadIndex + 1) % TEST_LOADS.length;
    t.setCargo(TEST_LOADS[this.loadIndex]);
    this.hud.toast(`Load: ${t.cargo.length} items · ${Math.round(t.payloadMass)} kg`);
  }

  /** Dev/console hook until the garage exists (Phase 4). */
  setTrailerUpgrade(slot: keyof TrailerUpgrades, id: string) {
    this.save.data.trailer.upgrades[slot] = id;
    this.save.save();
    const t = this.player.trailer;
    if (t) { t.upgrades[slot] = id; t.applyUpgrades(); }
  }

  // ---------- loop ----------

  /** Deterministic fixed-step simulation for testing/tuning from the console. */
  simulate(seconds: number, drive: Partial<DriveInput>, buttons: Partial<Record<'jump' | 'trick1' | 'trick2' | 'trick3' | 'trick4', boolean>> = {}) {
    const d = { throttle: 0, brake: 0, steer: 0, leanX: 0, leanZ: 0, ...drive };
    const tc = {
      jumpHeld: !!buttons.jump,
      buttons: { trick1: !!buttons.trick1, trick2: !!buttons.trick2, trick3: !!buttons.trick3, trick4: !!buttons.trick4 },
      steer: d.steer, leanX: d.leanX, leanZ: d.leanZ,
    };
    const n = Math.round(seconds / PHYSICS_DT);
    for (let i = 0; i < n; i++) {
      this.player.fixedUpdate(PHYSICS_DT, d, tc);
      this.physics.step();
    }
    this.player.physics.readState();
    this.processEvents();
    return this.player.physics;
  }

  private processEvents() {
    const st = this.player.stunts;
    const t = this.player.trailer;
    for (const e of st.events) if (e.type !== 'trick' && !(e.type === 'landed' && e.quality === 'clean')) this.dev.log.push(`${e.type}${'quality' in e ? ':' + e.quality : ''}${'points' in e ? ':' + e.points : ''}`);
    if (t) for (const e of t.events) if (e.type !== 'bottomOut') this.dev.log.push(`trailer:${e.type}${'spilled' in e ? ':' + e.spilled : ''}@${Math.round(this.player.physics.speed * 3.6)}kmh`);
    for (const e of st.events.splice(0)) {
      switch (e.type) {
        case 'landed':
          if (e.quality === 'crash') this.hud.banner('Crash!', 'bad');
          else if (e.quality === 'sketchy') this.hud.banner('Sketchy landing', 'warn', 1.2);
          if (e.impact > 3) this.effects.burst(this.player.physics.position, e.impact);
          break;
        case 'lost':
          this.hud.toast(`Combo lost −${e.points.toLocaleString('en-US')}`);
          break;
        case 'banked':
          this.save.data.currency += e.currency;
          this.save.data.xp += e.xp;
          this.save.save();
          this.hud.setWallet(this.save.data.currency, this.save.data.xp);
          this.hud.banner(`+${e.points.toLocaleString('en-US')}${e.multiplier > 1 ? `  (×${e.multiplier})` : ''}`, 'good', 2.2);
          this.hud.toast(`+$${e.currency} · +${e.xp} XP`, 2.2);
          break;
        case 'blocked':
          this.hud.toast(e.reason);
          break;
      }
    }
    if (!t) return;
    for (const e of t.events.splice(0)) {
      switch (e.type) {
        case 'jackknife': this.hud.banner('Jackknife!', 'bad'); break;
        case 'flipped': this.hud.banner(e.spilled ? `Trailer flipped — ${e.spilled} spilled` : 'Trailer flipped', 'bad', 2.2); break;
        case 'hardLanding': if (e.spilled || e.damaged) this.hud.banner(e.spilled ? `Hard landing — ${e.spilled} spilled` : 'Hard landing — cargo damaged', 'warn'); break;
        case 'bottomOut': break;
      }
    }
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.post?.setSize(w, h);
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

  private adaptResolution(dt: number) {
    if (dt > 0.1) return; // ignore stalls (tab switches, screenshots)
    this.frameAcc += dt;
    this.frameCount++;
    if (this.frameAcc < 2) return;
    const avg = this.frameAcc / this.frameCount;
    this.frameAcc = this.frameCount = 0;
    const prev = this.resScale;
    if (avg > 1 / 52) this.resScale = Math.max(0.6, this.resScale - 0.1);
    else if (avg < 1 / 58 && this.resScale < 1) this.resScale = Math.min(1, this.resScale + 0.05);
    if (prev !== this.resScale) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.gfx.pixelRatio) * this.resScale);
      this.resize();
    }
  }

  private tick(dt: number) {
    this.adaptResolution(dt);
    const input = this.input;
    input.update();
    if (input.consumePressed('pause')) this.setPaused(!this.paused);
    if (input.consumePressed('camera')) {
      this.rig.cycle();
      this.save.data.settings.camera = this.rig.mode;
      this.save.save();
    }
    if (input.consumePressed('dayCycle')) {
      this.setDayCycle(!this.sky.cycle);
      this.hud.toast(`Day/night cycle ${this.sky.cycle ? 'on' : 'off'}`);
    }
    if (input.consumePressed('timeOfDay')) {
      const t = this.sky.next();
      this.save.data.settings.timeOfDay = t;
      this.save.save();
      this.hud.toast(`Time of day: ${t}`);
    }
    if (input.consumePressed('reset')) this.player.recover();
    if (input.consumePressed('hitch')) this.toggleTrailer();
    if (input.consumePressed('cargo')) this.cycleLoad();

    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      const drive = input.drive();
      const tricks = input.tricks(drive.steer, drive.leanX, drive.leanZ);
      while (this.acc >= PHYSICS_DT && steps < MAX_STEPS) {
        this.player.fixedUpdate(PHYSICS_DT, drive, tricks);
        this.physics.step();
        this.acc -= PHYSICS_DT;
        steps++;
      }
      if (steps === MAX_STEPS) this.acc = 0;
      this.processEvents();
      // auto-recover when left upside down
      if (this.player.flippedTime > 4) this.player.recover();
      this.effects.emitFromSled(this.player, dt);
      this.marks.update(this.player);
      if (this.player.trailer) this.effects.emitFromTrailer(this.player.trailer, dt);
    }
    this.player.render(this.paused ? 1 : this.acc / PHYSICS_DT, this.paused ? 0 : dt);
    this.loose.sync();
    this.rig.update(this.player, dt);
    this.effects.update(this.paused ? 0 : dt, this.camera.position);
    this.sky.update(this.paused ? 0 : dt);
    this.resort.update(this.paused ? 0 : dt, this.sky.lamps, this.player.visual.root.position);
    this.applyLighting();
    this.sky.follow(this.player.visual.root.position, this.camera.position);
    this.hud.update(this.player, dt);
    this.hud.setClock(this.sky.clock);
    input.endFrame();
    this.post.render(dt, { speed: this.player.physics.velocity.length(), sunDir: this.sky.sunDir, sunVisible: this.sky.sunVisible, sunColor: this.sky.sun.color, night: this.sky.night });
  }
}
