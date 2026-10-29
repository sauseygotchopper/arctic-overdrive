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
import { SnocrossTrack } from '../world/SnocrossTrack';
import snocrossData from '../data/snocross.json';
import { Sled } from '../vehicles/Sled';
import { Progression } from './Progression';
import { Showroom } from '../ui/Showroom';
import { Garage } from '../ui/Garage';
import { DriveInput } from '../vehicles/SledPhysics';
import { Trailer, TrailerUpgrades } from '../vehicles/Trailer';
import { LooseCargo, TEST_LOADS } from '../vehicles/Cargo';
import { Input, DEFAULT_KEYS } from './Input';
import { CameraRig } from './CameraRig';
import { SaveSystem } from './SaveSystem';
import { HUD } from '../ui/HUD';
import { MiniMap } from '../ui/MiniMap';
import { Menu } from '../ui/Menu';
import { SettingsMenu } from '../ui/Settings';
import { AudioSystem } from '../audio/AudioSystem';
import { Title } from '../ui/Title';
import { CameraMode } from './CameraRig';
import { HandlingMode, HANDLING, setHandlingMode, handlingMode } from '../physics/Handling';
import { DevTools } from './DevTools';
import { GRAPHICS, GraphicsPreset } from './Graphics';
import { Mountains } from '../world/Mountains';
import { PostFX } from '../render/PostFX';
import { TrackMarks } from '../world/TrackMarks';
import { Resort, gondolaLine } from '../world/Resort';
import { GameMode } from '../modes/GameMode';
import { Route, RouteStep, corridorsOf } from '../modes/Route';
import { COURSES, TimeTrial } from '../modes/TimeTrial';
import { Freeride } from '../modes/Freeride';
import { Snocross, SNOCROSS_EVENTS } from '../modes/Snocross';
import { Tutorial } from '../modes/Tutorial';
import { SpecialDelivery, SPECIAL_CONTRACTS } from '../modes/SpecialDelivery';
import { Delivery, DELIVERY_JOBS } from '../modes/Delivery';
import { Replay } from '../modes/Replay';
import { PhotoMode } from '../modes/PhotoMode';

const MAX_STEPS = 5;
// brake just under the reverse threshold (0.5) so a held sled never starts backing up
const IDLE_INPUT: DriveInput = { throttle: 0, brake: 0.45, steer: 0, leanX: 0, leanZ: 0 };

/** Owns the renderer, world, player and fixed-timestep loop; game modes plug in via GameMode. */
export class Game {
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(64, 1, 0.2, 8000);
  input = new Input();
  save = new SaveSystem();
  readonly audio = new AudioSystem(this.save.data.settings.volume);
  physics!: PhysicsWorld;
  terrain!: TerrainData;
  sky!: SkySystem;
  effects!: Effects;
  rig!: CameraRig;
  hud!: HUD;
  menu!: Menu;
  player!: Sled;
  jumps!: Jumps;
  track!: SnocrossTrack;
  loose!: LooseCargo;
  snow!: SnowDeformation;
  minimap!: MiniMap;
  replay!: Replay;
  photo!: PhotoMode;
  progression!: Progression;
  showroom!: Showroom;
  garage!: Garage;
  readonly routes = new Map<string, Route>();
  readonly dev = new DevTools(this);
  mode: GameMode | null = null;
  /** Audio hook – the audio engine (Phase 7) fills this in. */
  audioCue = (name: string) => this.audio.cue(name);
  private state: 'menu' | 'playing' | 'garage' = 'menu';
  private paused = false;
  gfx!: GraphicsPreset;
  post!: PostFX;
  settings!: SettingsMenu;
  title!: Title;
  scenery!: Scenery;
  private terrainMesh!: TerrainMesh;
  private marks!: TrackMarks;
  private resort!: Resort;
  private loadIndex = 1;
  private acc = 0;
  /** Fraction of the way to the next physics step (modes render their own sleds with it). */
  get renderAlpha() { return this.acc / PHYSICS_DT; }
  private last = 0;
  private menuT = 0;
  // adaptive resolution: trims the pixel ratio when frames run long, restores it when there is headroom
  private frameAcc = 0;
  private frameCount = 0;
  private resScale = 1;
  /** Full ticks still owed while the opaque title is up, so shaders compile before the first ride. */
  private warmFrames = 3;
  private settingsClose: (() => void) | null = null;
  private crustSeen = 0;

  constructor(readonly container: HTMLElement, private onProgress: (msg: string, frac: number) => void, private titleRoot: HTMLElement) {}

  async init() {
    const q = this.save.data.settings.quality;
    const step = async (msg: string, frac: number) => {
      this.onProgress(msg, frac);
      await new Promise((r) => setTimeout(r, 16)); // let the loader repaint (rAF stalls in hidden tabs)
    };

    await step('Waking up the physics engine…', 0.05);
    await initRapier();
    this.physics = new PhysicsWorld();
    setHandlingMode(this.save.data.settings.handling);
    this.physics.setGravityScale(HANDLING[handlingMode()].gravityScale);

    const g = (this.gfx = GRAPHICS[q]);
    this.renderer = new THREE.WebGLRenderer({ antialias: g.antialias && !g.post, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, g.pixelRatio));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = g.shadowSize > 0;
    this.renderer.shadowMap.type = g.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.container.appendChild(this.renderer.domElement);

    await step('Shaping the valley…', 0.15);
    this.terrain = new TerrainData(worldDef as unknown as WorldDef, COURSES.flatMap((c) => corridorsOf(c.route as RouteStep[])));
    for (const c of COURSES) this.routes.set(c.id, new Route(this.terrain, c.route as RouteStep[]));
    await step('Laying down snow…', 0.45);
    this.terrainMesh = new TerrainMesh(this.terrain, g.terrainTex, g.sparkle);
    this.scene.add(this.terrainMesh.group);
    this.marks = new TrackMarks(this.terrain, g.trackPoints);
    this.scene.add(this.marks.group);
    const defRes = q === 'high' || q === 'ultra' ? 4096 : q === 'medium' ? 2048 : 1024;
    this.snow = new SnowDeformation(this.renderer, this.terrain, defRes);
    this.terrainMesh.deformUniforms.deformMap.value = this.snow.target.texture;
    this.terrainMesh.deformUniforms.deformTexel.value = 1 / defRes;
    this.terrainMesh.deformUniforms.deformSlope.value = DEFORM_DEPTH / (2 * (this.terrain.size / defRes));
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
    // off-trail course connectors are kept clear of trees
    const clearings = [...this.routes.values()].flatMap((r) => r.connectors);
    this.scenery = new Scenery(this.terrain, clearings, (x, z) => {
      const t = THREE.MathUtils.clamp(((x - ga.x) * gdir.x + (z - ga.y) * gdir.y) / glen2, 0, 1);
      if (Math.hypot(x - (ga.x + gdir.x * t), z - (ga.y + gdir.y * t)) < 9) return true;
      return reserved.some(([rx, rz]) => Math.abs(x - rx) < 4 && Math.abs(z - rz) < 4);
    });
    this.scene.add(this.scenery.group);
    this.physics.addStatic(this.scenery.colliders);
    this.jumps = new Jumps(this.terrain, (worldDef as unknown as { jumps: JumpDef[] }).jumps);
    this.scene.add(this.jumps.group);
    for (const c of this.jumps.colliders) this.physics.addTrimesh(c.vertices, c.indices);
    const venue = this.terrain.def.venues!.find((v) => v.id === snocrossData.venue)!;
    this.track = new SnocrossTrack(this.terrain, venue, snocrossData.trackWidth);
    this.scene.add(this.track.group);
    this.physics.addTrimesh(this.track.vertices, this.track.indices);

    await step('Fuelling up…', 0.9);
    this.sky = new SkySystem(this.scene, this.renderer, g.shadowSize, g.softShadows);
    this.sky.cycle = this.save.data.settings.dayCycle;
    this.sky.weather = (this.save.data.settings.weather as Weather) || 'clear';
    this.sky.apply((this.save.data.settings.timeOfDay as TimeOfDay) || 'morning');
    this.scene.add(new Mountains(this.sky.shared).group);
    this.post = new PostFX(this.renderer, this.scene, this.camera, g);
    this.effects = new Effects(this.scene, g.snowflakes);
    this.rig = new CameraRig(this.camera, this.terrain);
    this.hud = new HUD(this.container);
    this.hud.onMenu = () => this.setPaused(!this.paused);
    this.hud.onCountdown = (text) => this.audio.cue(text === 'GO!' ? 'go' : 'beep');
    // every button clicks; cards and buttons tick on hover
    document.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button:not(:disabled)')) this.audio.cue('click'); });
    let hovered: Element | null = null;
    document.addEventListener('pointerover', (e) => {
      const b = (e.target as HTMLElement).closest('button:not(:disabled)');
      if (b && b !== hovered) this.audio.cue('hover');
      hovered = b;
    });
    this.rig.setMode((this.save.data.settings.camera as CameraMode) || 'chase');
    // on <body>, not the game container: #app is position:fixed (its own stacking context), which left
    // the panel underneath the title overlay when opened from the title screen
    this.settings = new SettingsMenu(document.body, {
      back: () => this.closeSettings(),
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
      handling: () => handlingMode(),
      setHandling: (m) => this.setHandling(m),
      volumes: () => this.save.data.settings.volume,
      setVolumes: (v) => {
        this.save.data.settings.volume = v;
        this.audio.setVolumes(v);
        this.save.save();
      },
      keys: () => this.input.keys,
      setKeys: (k) => {
        this.input.keys = k;
        this.save.data.settings.keys = k;
        this.save.save();
      },
    });
    this.input.keys = { ...structuredClone(DEFAULT_KEYS), ...this.save.data.settings.keys } as typeof this.input.keys;
    this.hud.setWallet(this.save.data.currency, this.save.data.xp);
    this.minimap = new MiniMap(this.hud.el, this.terrain, this.scenery.treePositions, this.terrain.def.cabins);
    this.loose = new LooseCargo(this.physics, this.scene);

    this.progression = new Progression(this.save.data, () => {
      this.save.save();
      this.hud.setWallet(this.save.data.currency, this.save.data.xp);
    });
    this.createPlayer();
    this.replay = new Replay(this);
    this.photo = new PhotoMode(this);
    this.menu = new Menu(this);
    this.title = new Title(this.titleRoot, this);
    this.showroom = new Showroom(this.renderer);
    this.garage = new Garage(this);
    this.applyLighting();
    this.simulate(1.5, IDLE_INPUT); // settle on the snow before the menu shows it

    window.addEventListener('resize', () => this.resize());
    this.resize();
    Object.assign(window, { __game: this, __dev: this.dev });
    this.toMenu();
    await step('Ready', 1);
  }

  private playerSetupKey = '';

  /** (Re)build the player's sled from the save: current sled, fitted parts and livery. */
  createPlayer() {
    const sp = this.terrain.def.spawn;
    const yaw = Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z);
    if (this.player) {
      if (this.player.trailer) this.toggleTrailer(true);
      this.player.dispose(this.physics, this.scene);
    }
    const setup = this.progression.setupFor(this.save.data.currentSled);
    this.playerSetupKey = JSON.stringify(setup);
    this.player = new Sled(this.physics, this.terrain, setup, new THREE.Vector3(sp.x, this.terrain.heightAt(sp.x, sp.z) + 0.9, sp.z), yaw);
    this.scene.add(this.player.visual.root);
  }

  openGarage(tab: 'dealer' | 'upgrades' = 'upgrades') {
    this.menu.hide();
    this.state = 'garage';
    this.showroom.active = true;
    this.garage.open(tab);
  }

  closeGarage() {
    this.garage.close();
    this.showroom.active = false;
    this.refreshPlayer();
    this.toMenu();
  }

  /** Rebuild the ridden sled only if its setup (parts, tuning, skills...) actually changed. */
  refreshPlayer() {
    if (JSON.stringify(this.progression.setupFor(this.save.data.currentSled)) === this.playerSetupKey) return;
    this.createPlayer();
    this.applyLighting();
    this.simulate(1, IDLE_INPUT);
  }

  /** Per-frame: lamps, headlights, windows and snowfall follow the continuous time of day and the weather. */
  applyLighting() {
    const sky = this.sky;
    const fx = WEATHER_FX[sky.weather];
    this.player.visual.setHeadlights(sky.headlights || sky.weather === 'blizzard');
    this.scenery.windowMaterial.emissiveIntensity = Math.max(sky.night * 2.5, sky.current === 'golden' ? 0.6 : 0);
    this.effects.snowIntensity = Math.min(1, Math.max(fx.snow, 0.2 + sky.cloud * 0.8) + sky.night * 0.15);
    this.terrainMesh.sparkle.value = sky.sunVisible * 2.5;
    this.effects.wind = Math.max(fx.wind, 0.4 + sky.cloud * 2.2);
    this.effects.breath = 0.35 + sky.night * 0.5 + (sky.weather === 'clear' ? 0 : 0.15);
    this.effects.setFlakeLight(THREE.MathUtils.lerp(1.1, 0.3, sky.night), THREE.MathUtils.lerp(1.0, 0.12, sky.night));
    this.effects.sprayColor.lerp(sky.hemi.color, sky.night * 0.6); // night spray takes on the blue ambient instead of reading as grey smoke
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
    this.mode = id === 'timeTrial' ? new TimeTrial(this, arg ?? COURSES[0].id)
      : id === 'snocross' ? new Snocross(this, arg ?? SNOCROSS_EVENTS[0].id)
      : id === 'delivery' ? new Delivery(this, arg ?? DELIVERY_JOBS[0].id)
      : id === 'special' ? new SpecialDelivery(this, arg ?? SPECIAL_CONTRACTS[0].id)
      : id === 'tutorial' ? new Tutorial(this)
      : new Freeride(this);
    this.mode.enter();
    this.hud.setFreerideHelp(id === 'freeride');
    this.hud.el.classList.toggle('in-tutorial', id === 'tutorial');
    this.hud.el.classList.remove('in-menu');
    this.state = 'playing';
    this.acc = 0;
  }

  toMenu(view?: 'delivery' | 'snocross' | 'courses' | 'special' | 'skills') {
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
    this.menu.show(view);
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) this.menu.showPause(this.mode?.title ?? '', !!this.mode?.restart);
    else this.menu.hidePause();
  }

  /** Settings panel over whatever opened it; `onClose` brings that screen back. */
  openSettings(onClose: () => void) {
    this.settingsClose = onClose;
    this.settings.show(true);
  }

  closeSettings() {
    this.settings.show(false);
    const cb = this.settingsClose;
    this.settingsClose = null;
    cb?.();
  }

  private toggleDayCycle() {
    this.setDayCycle(!this.sky.cycle);
    this.hud.toast(`Day/night cycle ${this.sky.cycle ? 'on' : 'off'}`);
  }

  /** Switch handling model live: gravity and suspension rates are re-derived for the new gravity. */
  setHandling(m: HandlingMode) {
    setHandlingMode(m);
    this.physics.setGravityScale(HANDLING[handlingMode()].gravityScale);
    this.player.refreshSetup();
    this.player.trailer?.applyUpgrades();
    this.save.data.settings.handling = handlingMode();
    this.save.save();
  }

  setDayCycle(on: boolean) {
    this.sky.cycle = on;
    this.save.data.settings.dayCycle = on;
    this.save.save();
  }

  // ---------- trailer ----------

  /** `fromPlayer`: the hitch key, which needs the sled upright on the snow (modes and tools place it themselves). */
  toggleTrailer(silent = false, fromPlayer = false) {
    const p = this.player;
    if (p.trailer) {
      const t = p.trailer;
      p.detachTrailer();
      t.dispose(this.scene);
      if (!silent) this.hud.toast('Trailer unhitched');
      return;
    }
    if (!p.physics.params.canTow) {
      this.hud.toast('No tow hitch – fit one in Garage › Upgrades › Towing', 3);
      return;
    }
    p.physics.readState();
    if (fromPlayer && (p.physics.up.y < 0.6 || p.physics.groundedCount === 0)) { this.hud.toast('Get the sled upright on the snow first'); return; }
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
      this.mode?.prePhysics?.(PHYSICS_DT);
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
      this.mode?.onStunt?.(e);
      switch (e.type) {
        case 'landed':
          this.audio.land(e.impact, e.quality === 'crash');
          if (e.impact > 4 || e.quality === 'crash') this.rig.shake(Math.min(0.35, e.impact * 0.025 + (e.quality === 'crash' ? 0.12 : 0)));
          if (e.quality === 'crash') this.hud.banner('Crash!', 'bad');
          else if (e.quality === 'sketchy') this.hud.banner('Sketchy landing', 'warn', 1.2);
          if (e.impact > 3) this.effects.burst(this.player.physics.position, e.impact);
          break;
        case 'lost':
          this.hud.toast(`Combo lost −${e.points.toLocaleString('en-US')}`);
          break;
        case 'trick':
          this.audio.cue('trick');
          break;
        case 'banked':
          this.audio.cue('banked');
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
    this.post?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    this.last = performance.now();
    this.title.ready();
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
    this.sky.update(dt);
    this.resort.update(dt, this.sky.lamps, this.player.visual.root.position);
    this.applyLighting();
    this.sky.follow(this.player.visual.root.position, this.camera.position);
    this.hud.setClock(this.sky.clock);
    this.input.endFrame();
    this.snow.flush();
    this.post.render(dt, { speed: this.player.physics.velocity.length(), sunDir: this.sky.sunDir, sunVisible: this.sky.sunVisible, sunColor: this.sky.sun.color, night: this.sky.night });
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
    this.frame(dt);
    // sound follows what's on screen: the ridden sled while playing, a quiet idle behind the menu
    const p = this.player.physics;
    const playing = this.state === 'playing' && !this.paused && !this.photo.active && !this.replay.active && !this.title.visible;
    const menuIdle = this.state === 'menu' && !this.title.visible;
    this.audio.update(dt, playing || menuIdle ? {
      rpm: p.rpm, idleRpm: p.params.idleRpm, maxRpm: p.params.maxRpm, throttle: playing ? this.lastThrottle : 0,
      speed: Math.abs(p.speed), surface: p.surface.key, grounded: p.groundedCount > 0, presence: playing ? 1 : 0.3,
    } : null);
    if (!playing) this.audio.setChase(null, null);
  }

  private lastThrottle = 0;

  private frame(dt: number) {
    this.adaptResolution(dt);
    const input = this.input;
    input.update();
    if (this.title.visible) {
      if (input.consumePressed('jump') && !this.settings.visible) this.title.hide(); // Space / gamepad A
      // the title is opaque: nothing to show, so don't burn a GPU on it (after a few warm-up frames)
      if (this.warmFrames <= 0) { input.endFrame(); return; }
      this.warmFrames--;
    }
    if (this.settings.visible && input.consumePressed('pause') && !this.settings.capturing) this.closeSettings();
    const freeride = this.mode?.id === 'freeride';

    // ---- photo mode: paused world, free camera ----
    if (this.photo.active) {
      if (input.consumePressed('photo') || input.consumePressed('pause')) this.photo.exit();
      if (input.consumePressed('timeOfDay')) this.cycleTime();
      if (input.consumePressed('weather')) this.cycleWeather();
      if (input.consumePressed('dayCycle')) this.toggleDayCycle();
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
    // ---- garage: showroom scene instead of the world ----
    if (this.state === 'garage') {
      this.showroom.update(dt);
      this.garage.update(dt);
      input.endFrame();
      this.showroom.render();
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

    if (input.consumePressed('camera')) {
      this.rig.cycle();
      this.save.data.settings.camera = this.rig.mode;
      this.save.save();
    }
    if (input.consumePressed('reset') && !this.hud.resultsOpen && !this.mode?.recover?.()) this.player.recover();
    if (freeride) {
      if (input.consumePressed('timeOfDay')) this.cycleTime();
      if (input.consumePressed('weather')) this.cycleWeather();
      if (input.consumePressed('dayCycle')) this.toggleDayCycle();
      if (input.consumePressed('hitch')) this.toggleTrailer(false, true);
      if (input.consumePressed('cargo')) this.cycleLoad();
      if (input.consumePressed('photo')) this.photo.enter();
      if (input.consumePressed('replay')) this.replay.play();
    }

    this.acc += dt;
    let steps = 0;
    const live = this.mode?.controlsEnabled ?? false;
    const drive = live ? input.drive() : IDLE_INPUT;
    this.lastThrottle = drive.throttle;
    const tricks = input.tricks(drive.steer, drive.leanX, drive.leanZ);
    if (!live) tricks.jumpHeld = false;
    while (this.acc >= PHYSICS_DT && steps < MAX_STEPS) {
      this.player.fixedUpdate(PHYSICS_DT, drive, tricks);
      this.mode?.prePhysics?.(PHYSICS_DT);
      this.physics.step();
      this.mode?.fixedUpdate(PHYSICS_DT);
      this.acc -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.processEvents();
    if (this.player.physics.crustBreaks !== this.crustSeen) {
      this.crustSeen = this.player.physics.crustBreaks;
      this.effects.burst(this.player.physics.lastBreak, 2.5);
    }
    if (this.player.flippedTime > 4 && !this.mode?.recover?.()) this.player.recover();
    this.effects.emitFromSled(this.player, dt);
    this.effects.emitExhaust(this.player, dt, drive.throttle);
    this.marks.update(this.player);
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
