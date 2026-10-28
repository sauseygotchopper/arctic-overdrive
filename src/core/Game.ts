import * as THREE from 'three';
import worldDef from '../data/world.json';
import { initRapier, PhysicsWorld, PHYSICS_DT } from '../physics/PhysicsWorld';
import { TerrainData, WorldDef } from '../world/TerrainData';
import { TerrainMesh } from '../world/TerrainMesh';
import { Scenery } from '../world/Scenery';
import { Jumps, JumpDef } from '../world/Jumps';
import { SkySystem, TimeOfDay, Weather, WEATHER_FX } from '../world/Sky';
import { Effects } from '../world/Effects';
import { SnowDeformation, DEFORM_DEPTH } from '../world/SnowDeformation';
import { Sled } from '../vehicles/Sled';
import { getSled, RIDER_MASS } from '../vehicles/SledSpec';
import { DriveInput } from '../vehicles/SledPhysics';
import { Trailer, TrailerUpgrades } from '../vehicles/Trailer';
import { LooseCargo, TEST_LOADS } from '../vehicles/Cargo';
import { Input } from './Input';
import { CameraRig } from './CameraRig';
import { SaveSystem } from './SaveSystem';
import { HUD } from '../ui/HUD';
import { MiniMap } from '../ui/MiniMap';
import { Menu } from '../ui/Menu';
import { DevTools } from './DevTools';
import { GameMode } from '../modes/GameMode';
import { Route, RouteStep, corridorsOf } from '../modes/Route';
import { COURSES, TimeTrial } from '../modes/TimeTrial';
import { Freeride } from '../modes/Freeride';
import { Replay } from '../modes/Replay';
import { PhotoMode } from '../modes/PhotoMode';

const MAX_STEPS = 5;
// brake just under the reverse threshold (0.5) so a held sled never starts backing up
const IDLE_INPUT: DriveInput = { throttle: 0, brake: 0.45, steer: 0, leanX: 0, leanZ: 0 };

/** Owns the renderer, world, player and fixed-timestep loop; game modes plug in via GameMode. */
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
  jumps!: Jumps;
  loose!: LooseCargo;
  snow!: SnowDeformation;
  minimap!: MiniMap;
  menu!: Menu;
  replay!: Replay;
  photo!: PhotoMode;
  readonly routes = new Map<string, Route>();
  readonly dev = new DevTools(this);
  mode: GameMode | null = null;
  /** Audio hook – the audio engine (Phase 7) fills this in. */
  audioCue?: (name: string) => void;
  private state: 'menu' | 'playing' = 'menu';
  private paused = false;
  private scenery!: Scenery;
  private loadIndex = 1;
  private acc = 0;
  private last = 0;
  private menuT = 0;

  constructor(readonly container: HTMLElement, private onProgress: (msg: string, frac: number) => void) {}

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
    this.terrain = new TerrainData(worldDef as unknown as WorldDef, COURSES.flatMap((c) => corridorsOf(c.route as RouteStep[])));
    for (const c of COURSES) this.routes.set(c.id, new Route(this.terrain, c.route as RouteStep[]));
    await step('Laying down snow…', 0.45);
    const terrainMesh = new TerrainMesh(this.terrain, q);
    this.scene.add(terrainMesh.group);
    const defRes = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    this.snow = new SnowDeformation(this.renderer, this.terrain, defRes);
    terrainMesh.deformUniforms.deformMap.value = this.snow.target.texture;
    terrainMesh.deformUniforms.deformTexel.value = 1 / defRes;
    terrainMesh.deformUniforms.deformSlope.value = DEFORM_DEPTH / (2 * (this.terrain.size / defRes));
    this.physics.addTerrain(this.terrain);
    const err = this.physics.verifyTerrain(this.terrain);
    if (err > 0.5) console.warn(`[terrain] physics/visual height mismatch ${err.toFixed(2)} m`);

    await step('Planting the pine forest…', 0.7);
    // off-trail course connectors are kept clear of trees
    const clearings = [...this.routes.values()].flatMap((r) => r.connectors);
    this.scenery = new Scenery(this.terrain, clearings);
    this.scene.add(this.scenery.group);
    this.physics.addStatic(this.scenery.colliders);
    this.jumps = new Jumps(this.terrain, (worldDef as unknown as { jumps: JumpDef[] }).jumps);
    this.scene.add(this.jumps.group);
    for (const c of this.jumps.colliders) this.physics.addTrimesh(c.vertices, c.indices);

    await step('Fuelling up…', 0.9);
    this.sky = new SkySystem(this.scene, this.renderer, q === 'high' ? 2048 : q === 'medium' ? 1024 : 0);
    this.sky.weather = (this.save.data.settings.weather as Weather) || 'clear';
    this.sky.apply((this.save.data.settings.timeOfDay as TimeOfDay) || 'morning');
    this.effects = new Effects(this.scene);
    this.rig = new CameraRig(this.camera, this.terrain);
    this.hud = new HUD(this.container);
    this.hud.setWallet(this.save.data.currency, this.save.data.xp);
    this.minimap = new MiniMap(this.hud.el, this.terrain, this.scenery.treePositions, this.terrain.def.cabins);
    this.loose = new LooseCargo(this.physics, this.scene);

    const sp = this.terrain.def.spawn;
    const yaw = Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z);
    this.player = new Sled(this.physics, this.terrain, { spec: getSled(this.save.data.currentSled), riderMass: RIDER_MASS, cargoMass: 0 }, new THREE.Vector3(sp.x, this.terrain.heightAt(sp.x, sp.z) + 0.9, sp.z), yaw);
    this.scene.add(this.player.visual.root);
    this.replay = new Replay(this);
    this.photo = new PhotoMode(this);
    this.menu = new Menu(this);
    this.applyLighting();
    this.simulate(1.5, IDLE_INPUT); // settle on the snow before the menu shows it

    window.addEventListener('resize', () => this.resize());
    this.resize();
    Object.assign(window, { __game: this, __dev: this.dev });
    this.toMenu();
    await step('Ready', 1);
  }

  applyLighting() {
    const night = this.sky.headlights;
    this.player.visual.setHeadlights(night || this.sky.current === 'overcast' || this.sky.weather === 'blizzard');
    this.scenery.windowMaterial.emissiveIntensity = night ? 2.5 : this.sky.current === 'golden' ? 0.6 : 0;
    const fx = WEATHER_FX[this.sky.weather];
    this.effects.snowIntensity = Math.max(fx.snow, this.sky.current === 'overcast' ? 0.6 : 0);
    this.effects.wind = fx.wind;
  }

  addRewards(currency: number, xp: number) {
    this.save.data.currency += currency;
    this.save.data.xp += xp;
    this.save.save();
    this.hud.setWallet(this.save.data.currency, this.save.data.xp);
  }

  // ---------- modes / menu ----------

  startMode(id: string, arg?: string) {
    this.mode?.exit();
    this.mode = null;
    this.replay.stop();
    if (this.photo.active) this.photo.exit();
    this.menu.hide();
    this.menu.hidePause();
    this.hud.hideResults();
    this.paused = false;
    this.mode = id === 'timeTrial' ? new TimeTrial(this, arg ?? COURSES[0].id) : new Freeride(this);
    this.mode.enter();
    this.hud.setFreerideHelp(id === 'freeride');
    this.hud.el.classList.remove('in-menu');
    this.state = 'playing';
    this.acc = 0;
  }

  toMenu() {
    this.mode?.exit();
    this.mode = null;
    this.replay.stop();
    if (this.photo.active) this.photo.exit();
    this.menu.hidePause();
    this.hud.hideResults();
    this.paused = false;
    if (this.player.trailer) this.toggleTrailer(true);
    const sp = this.terrain.def.spawn;
    this.player.teleport(new THREE.Vector3(sp.x, this.terrain.heightAt(sp.x, sp.z) + 0.8, sp.z), Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z));
    this.simulate(1, IDLE_INPUT);
    this.player.stunts.reset();
    this.save.save();
    this.state = 'menu';
    this.hud.el.classList.add('in-menu');
    this.menu.show();
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) this.menu.showPause(this.mode?.title ?? '', !!this.mode?.restart);
    else this.menu.hidePause();
  }

  // ---------- trailer ----------

  toggleTrailer(silent = false) {
    const p = this.player;
    if (p.trailer) {
      const t = p.trailer;
      p.detachTrailer();
      t.dispose(this.scene);
      if (!silent) this.hud.toast('Trailer unhitched');
      return;
    }
    const t = new Trailer(this.physics, this.terrain, this.loose, { ...this.save.data.trailer.upgrades }, p.physics.position.clone(), 0);
    this.scene.add(t.root);
    t.setCargo(TEST_LOADS[this.loadIndex]);
    p.attachTrailer(t);
    if (!silent) this.hud.toast('Trailer hitched — tricks disabled');
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

  private cycleTime() {
    const t = this.sky.next();
    this.save.data.settings.timeOfDay = t;
    this.applyLighting();
    this.hud.toast(`Time of day: ${t}`);
  }

  private cycleWeather() {
    const w = this.sky.nextWeather();
    this.save.data.settings.weather = w;
    this.applyLighting();
    this.hud.toast(`Weather: ${w}`);
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
      this.mode?.fixedUpdate(PHYSICS_DT);
      if (i % 2 === 0) {
        this.snow.stampSled(this.player);
        if (this.player.trailer) this.snow.stampTrailer(this.player.trailer);
        this.snow.flush();
      }
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
          this.addRewards(e.currency, e.xp);
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

  private render(dt: number) {
    this.effects.update(dt, this.camera.position);
    this.sky.follow(this.player.visual.root.position);
    this.input.endFrame();
    this.snow.flush();
    this.renderer.render(this.scene, this.camera);
  }

  private tick(dt: number) {
    const input = this.input;
    input.update();
    const freeride = this.mode?.id === 'freeride';

    // ---- photo mode: paused world, free camera ----
    if (this.photo.active) {
      if (input.consumePressed('photo') || input.consumePressed('pause')) this.photo.exit();
      if (input.consumePressed('timeOfDay')) this.cycleTime();
      if (input.consumePressed('weather')) this.cycleWeather();
      this.photo.update(dt);
      this.render(0);
      return;
    }
    // ---- replay: paused world, cinematic playback ----
    if (this.replay.active) {
      if (input.consumePressed('replay') || input.consumePressed('pause')) this.replay.stop();
      else this.replay.update(dt);
      this.render(dt);
      return;
    }
    // ---- menu: idle sled, slow orbit camera ----
    if (this.state === 'menu') {
      this.menuT += dt * 0.12;
      const r = this.player.visual.root;
      this.player.render(1, dt);
      this.camera.position.set(r.position.x + Math.sin(this.menuT) * 7.5, r.position.y + 2.2, r.position.z + Math.cos(this.menuT) * 7.5);
      this.camera.lookAt(r.position.x, r.position.y + 0.6, r.position.z);
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
      this.render(dt);
      return;
    }

    if (input.consumePressed('pause') && !this.hud.resultsOpen) this.setPaused(!this.paused);
    if (this.paused) {
      this.render(0);
      return;
    }

    if (input.consumePressed('camera')) this.rig.cycle();
    if (input.consumePressed('reset') && !this.hud.resultsOpen && !this.mode?.recover?.()) this.player.recover();
    if (freeride) {
      if (input.consumePressed('timeOfDay')) this.cycleTime();
      if (input.consumePressed('weather')) this.cycleWeather();
      if (input.consumePressed('hitch')) this.toggleTrailer();
      if (input.consumePressed('cargo')) this.cycleLoad();
      if (input.consumePressed('photo')) this.photo.enter();
      if (input.consumePressed('replay')) this.replay.play();
    }

    this.acc += dt;
    let steps = 0;
    const live = this.mode?.controlsEnabled ?? false;
    const drive = live ? input.drive() : IDLE_INPUT;
    const tricks = input.tricks(drive.steer, drive.leanX, drive.leanZ);
    if (!live) tricks.jumpHeld = false;
    while (this.acc >= PHYSICS_DT && steps < MAX_STEPS) {
      this.player.fixedUpdate(PHYSICS_DT, drive, tricks);
      this.physics.step();
      this.mode?.fixedUpdate(PHYSICS_DT);
      this.acc -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.processEvents();
    if (this.player.flippedTime > 4 && !this.mode?.recover?.()) this.player.recover();
    this.effects.emitFromSled(this.player, dt);
    this.snow.stampSled(this.player);
    if (this.player.trailer) {
      this.effects.emitFromTrailer(this.player.trailer, dt);
      this.snow.stampTrailer(this.player.trailer);
    }

    this.player.render(this.acc / PHYSICS_DT, dt);
    this.loose.sync();
    this.replay.record(dt);
    this.mode?.update(dt);
    this.rig.update(this.player, dt);
    this.hud.update(this.player, dt);
    const p = this.player.physics;
    this.minimap.update(dt, p.position.x, p.position.z, p.forward.x, p.forward.z, this.mode?.drawMap?.bind(this.mode));
    this.render(dt);
  }
}
