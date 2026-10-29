import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import type { Game } from '../core/Game';
import { GameMode } from './GameMode';
import { Sled } from '../vehicles/Sled';
import { getSled, RIDER_MASS, DEFAULT_LIVERY } from '../vehicles/SledSpec';
import { Helicopter } from '../vehicles/Helicopter';
import { PursuitAI, PursuitTarget } from './ai/PursuitAI';
import { jobPoint, drawTargetPin } from './Delivery';
import { fmtTime } from './TimeTrial';
import type { TimeOfDay } from '../world/Sky';
import type { CargoType } from '../vehicles/Cargo';
import specialData from '../data/special.json';
import { SCAUCE } from '../ui/Scauce';

export type SpecialContract = (typeof specialData.contracts)[number];
export const SPECIAL_CONTRACTS = specialData.contracts as SpecialContract[];
const S = specialData;

interface Agent {
  sled: Sled;
  ai: PursuitAI;
  basePower: number;
  sees: boolean;
  lights: THREE.Object3D[];
  /** Closest it has got to the player lately, and how long since it last improved on that (no-progress respawn). */
  closest: number;
  noProgress: number;
}

/** A random line from Scauce for the results card. */
const scauceQuote = (lines: string[]) => `<div class="r-quote">${SCAUCE.name}: “${lines[Math.floor(Math.random() * lines.length)]}”</div>`;

/** One helicopter per game: its SpotLight stays in the scene so entering the mode again doesn't rebuild shaders. */
const helicopters = new WeakMap<Game, Helicopter>();

/**
 * Special Delivery: get an unmarked package from A to B while agents chase you. Being seen raises the
 * wanted level (more, faster agents; a helicopter with a searchlight from 3 stars). Break line of sight –
 * terrain, forest, distance – long enough to lose them, and only make the drop when nobody is on you.
 * Stopped with an agent alongside fills the bust meter.
 */
export class SpecialDelivery implements GameMode {
  readonly id = 'special';
  readonly title: string;
  private c: SpecialContract;
  private state: 'countdown' | 'running' | 'done' = 'countdown';
  private countdown = 0;
  private time = 0;
  private dest!: { x: number; z: number; name: string };
  private marker = new THREE.Group();
  private agents: Agent[] = [];
  private heli!: Helicopter;
  private heliLeaving = 0;
  private heat = 1;
  private maxStarsReached = 1;
  private status: 'chase' | 'search' | 'clear' = 'chase';
  private unseen = 0;
  private searchT = 0;
  private losTimer = 0;
  private seen = false;
  private seenByHeli = false;
  private bust = 0;
  private lastSeen = new THREE.Vector3();
  private lastSeenVel = new THREE.Vector3();
  private sweep = 0;
  /** Seconds the agents are tipped off about where you are (contract start, reinforcements radioed in). */
  private alert = 0;
  private t = 0;
  private prevTime: TimeOfDay = 'morning';
  private prevCycle = false;

  constructor(private game: Game, contractId: string) {
    this.c = SPECIAL_CONTRACTS.find((x) => x.id === contractId) ?? SPECIAL_CONTRACTS[0];
    this.title = this.c.name;
  }

  get controlsEnabled() { return this.state === 'running'; }
  private get stars() { return THREE.MathUtils.clamp(Math.floor(this.heat), 0, this.c.maxStars); }

  enter() {
    const g = this.game;
    this.dest = jobPoint(g, this.c.to);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 140, 16, 1, true), beamMat);
    beam.position.y = 70;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(10, 0.25, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.4;
    this.marker.add(beam, ring);
    this.marker.position.set(this.dest.x, g.terrain.heightAt(this.dest.x, this.dest.z), this.dest.z);
    g.scene.add(this.marker);
    let heli = helicopters.get(g);
    if (!heli) helicopters.set(g, (heli = new Helicopter(g.scene, g.terrain, S.helicopter)));
    this.heli = heli;
    this.prevTime = g.sky.current;
    this.prevCycle = g.sky.cycle;
    g.sky.cycle = false;
    g.sky.apply(this.c.time as TimeOfDay);
    this.reset();
  }

  private reset() {
    const g = this.game;
    const p = g.player;
    this.clearAgents();
    this.heli.exit();
    this.heliLeaving = 0;
    if (p.trailer) g.toggleTrailer(true);
    const start = this.startPoint();
    p.teleport(new THREE.Vector3(start.x, g.terrain.heightAt(start.x, start.z) + 0.8, start.z), start.yaw);
    p.setRack(['package'] as CargoType[]);
    g.snow.clear();
    this.state = 'countdown';
    this.countdown = 2.6;
    this.time = 0;
    this.heat = this.c.startStars;
    this.maxStarsReached = this.c.startStars;
    this.status = 'chase';
    this.unseen = 0;
    this.searchT = 0;
    this.bust = 0;
    this.alert = S.alertSeconds;
    this.seen = true;
    this.lastSeen.copy(p.physics.position);
    this.lastSeenVel.set(0, 0, 0);
    g.hud.hideResults();
  }

  restart() { this.reset(); }

  /** The groomed trail nearest the pickup cabin (cabins sit in hollows off the trail), facing the way that heads for the drop. */
  private startPoint(): { x: number; z: number; yaw: number } {
    const g = this.game;
    const from = jobPoint(g, this.c.from);
    let best: { x: number; z: number; yaw: number } | null = null;
    let bestD = 150;
    for (const t of g.terrain.trailPaths) {
      for (let i = 1; i < t.pts.length - 1; i++) {
        const q = t.pts[i];
        const d = Math.hypot(q.x - from.x, q.z - from.z);
        if (d >= bestD) continue;
        const a = t.pts[i - 1], b = t.pts[i + 1];
        const toDest = (b.x - a.x) * (this.dest.x - q.x) + (b.z - a.z) * (this.dest.z - q.z);
        bestD = d;
        best = { x: q.x, z: q.z, yaw: toDest >= 0 ? Math.atan2(b.x - a.x, b.z - a.z) : Math.atan2(a.x - b.x, a.z - b.z) };
      }
    }
    if (best) return best;
    const dx = this.dest.x - from.x, dz = this.dest.z - from.z, len = Math.hypot(dx, dz) || 1;
    return { x: from.x + (dx / len) * 12, z: from.z + (dz / len) * 12, yaw: Math.atan2(dx, dz) };
  }

  exit() {
    const g = this.game;
    this.clearAgents();
    this.heli.exit();
    disposeObject(this.marker);
    g.player.setRack([]);
    g.sky.cycle = this.prevCycle;
    g.sky.apply(this.prevTime);
    g.hud.setObjective(null);
    g.hud.setCountdown('');
    g.hud.setWanted(null);
    g.hud.setWarning('');
    g.audio.setChase(null, null);
  }

  private clearAgents() {
    for (const a of this.agents) a.sled.dispose(this.game.physics, this.game.scene);
    this.agents = [];
  }

  // ---------- agents ----------

  /** A clear spot `dist` m from the player, behind or beside them (out of the camera's view). */
  private spawnPoint(dist: [number, number]): THREE.Vector3 {
    const g = this.game;
    const p = g.player.physics;
    const back = Math.atan2(-p.forward.x, -p.forward.z);
    const lim = g.terrain.half - 30;
    let best: THREE.Vector3 | null = null;
    // score open spots: a clear, drivable straight line to the player first, then the least climb
    let bestScore = Infinity;
    const py = p.position.y;
    for (let i = 0; i < 60; i++) {
      const a = back + (Math.random() - 0.5) * (i < 30 ? 1.6 : 3.6);
      const d = dist[0] + Math.random() * (dist[1] - dist[0]);
      const x = p.position.x + Math.sin(a) * d, z = p.position.z + Math.cos(a) * d;
      if (Math.abs(x) > lim || Math.abs(z) > lim) continue;
      if (g.scenery.obstacles.countNear(x, z, 5) > 0 || g.terrain.slopeAt(x, z) > 0.4) continue;
      const score = Math.abs(g.terrain.heightAt(x, z) - py) + (this.drivable(x, z, p.position.x, p.position.z) ? 0 : 100);
      if (score < bestScore) { bestScore = score; best = new THREE.Vector3(x, 0, z); }
      if (score < 6) break;
    }
    best ??= p.position.clone().add(new THREE.Vector3(-p.forward.x * dist[0], 0, -p.forward.z * dist[0]));
    best.y = g.terrain.heightAt(best.x, best.z) + 0.8;
    return best;
  }

  /** Straight line a→b with no obstacles and no stretch steeper than a sled can comfortably climb. */
  private drivable(ax: number, az: number, bx: number, bz: number): boolean {
    const g = this.game;
    if (g.scenery.obstacles.countAlong(ax, az, bx, bz, 1.6) > 0) return false;
    const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 6);
    let prev = g.terrain.heightAt(ax, az);
    for (let i = 1; i <= n; i++) {
      const h = g.terrain.heightAt(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n);
      if (Math.abs(h - prev) / (d / n) > 0.35) return false;
      prev = h;
    }
    return true;
  }

  private spawnAgent() {
    const g = this.game;
    const lvl = S.levels[Math.max(0, this.stars - 1)];
    const pos = this.spawnPoint((this.time < 1 ? S.firstSpawnDistance : S.spawnDistance) as [number, number]);
    const p = g.player.physics.position;
    const sled = new Sled(g.physics, g.terrain, {
      spec: getSled(lvl.sled), riderMass: RIDER_MASS, cargoMass: 0, parts: lvl.parts,
      livery: { ...DEFAULT_LIVERY, paint: S.agentLivery.paint, gear: S.agentLivery.gear, number: 0 },
    }, pos, Math.atan2(p.x - pos.x, p.z - pos.z));
    // light bar on a short mast behind the seat
    const bar = new THREE.Group();
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.13, 0.13), new THREE.MeshBasicMaterial({ color: 0xff2030 }));
    const blue = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.13, 0.13), new THREE.MeshBasicMaterial({ color: 0x2060ff }));
    red.position.x = -0.16;
    blue.position.x = 0.16;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), new THREE.MeshBasicMaterial({ color: 0x222222 }));
    mast.position.y = -0.27;
    bar.add(red, blue, mast);
    bar.position.set(0, 1.3, -1.05);
    sled.visual.root.add(bar);
    g.scene.add(sled.visual.root);
    const ai = new PursuitAI(sled, g.scenery.obstacles, g.terrain, this.agents.length);
    this.agents.push({ sled, ai, basePower: sled.physics.params.powerW, sees: false, lights: [red, blue], closest: Infinity, noProgress: 0 });
  }

  /** Put a wrecked or hopelessly stuck agent back into the chase from out of sight. */
  private respawn(a: Agent) {
    const g = this.game;
    const pos = this.spawnPoint([90, 120]);
    const p = g.player.physics.position;
    a.sled.teleport(pos, Math.atan2(p.x - pos.x, p.z - pos.z));
    a.ai.resetStuck();
    a.closest = Infinity;
    a.noProgress = 0;
  }

  // ---------- sight ----------

  /** Terrain and forest between an agent and the player. */
  private canSee(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const g = this.game;
    const d = Math.hypot(to.x - from.x, to.z - from.z);
    if (d > S.sightRange) return false;
    const ay = from.y + 1.4, by = to.y + 1.2;
    const n = Math.ceil(d / 5);
    for (let i = 1; i < n; i++) {
      const k = i / n;
      const x = from.x + (to.x - from.x) * k, z = from.z + (to.z - from.z) * k;
      if (g.terrain.heightAt(x, z) > ay + (by - ay) * k + 0.2) return false;
    }
    return g.scenery.trees.countAlong(from.x, from.z, to.x, to.z, 1.0) < S.forestBlocksAt;
  }

  private underCanopy(): boolean {
    const p = this.game.player.physics.position;
    return this.game.scenery.trees.countNear(p.x, p.z, 6) >= S.helicopter.canopyHides;
  }

  // ---------- loop ----------

  prePhysics(dt: number) {
    const g = this.game;
    const running = this.state === 'running';
    const pp = g.player.physics;
    // agents chase what they know: the real you while someone has eyes on you, else where you were last seen
    const target: PursuitTarget = this.seen
      ? { position: pp.position, velocity: pp.velocity, forward: pp.forward, speed: Math.max(0, pp.speed) }
      : { position: this.lastSeen.clone().addScaledVector(this.lastSeenVel, Math.min(this.unseen, 3)), velocity: this.lastSeenVel, forward: this.lastSeenVel.clone().normalize(), speed: this.lastSeenVel.length() };
    for (const a of this.agents) {
      const ap = a.sled.physics;
      const dist = Math.hypot(pp.position.x - ap.position.x, pp.position.z - ap.position.z);
      // agents far behind get extra power, so outrunning them alone doesn't end the chase
      const boost = THREE.MathUtils.clamp((dist - S.catchUpFrom) / (S.catchUpFull - S.catchUpFrom), 0, 1) * S.catchUpPower;
      ap.params.powerW = a.basePower * (1 + (a.ai.mode === 'chase' ? boost : 0));
      const input = running ? a.ai.control(dt, target) : { throttle: 0, brake: 0.45, steer: 0, leanX: 0, leanZ: 0 };
      a.sled.fixedUpdate(dt, input);
      a.sled.stunts.events.length = 0;
    }
  }

  fixedUpdate(dt: number) {
    if (this.state !== 'running') return;
    const g = this.game;
    const pp = g.player.physics;
    this.time += dt;

    // who can see the player (checked a few times a second)
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = S.losCheckSeconds;
      for (const a of this.agents) a.sees = a.ai.mode !== 'leave' && this.canSee(a.sled.physics.position, pp.position);
      this.seenByHeli = this.heli.active && this.heliLeaving === 0 && this.heli.inBeam(pp.position.x, pp.position.z) && !this.underCanopy();
      this.seen = this.seenByHeli || this.agents.some((a) => a.sees);
    }
    this.alert = Math.max(0, this.alert - dt);
    if (this.alert > 0 && this.status === 'chase') this.seen = true;
    if (this.seen) {
      this.lastSeen.copy(pp.position);
      this.lastSeenVel.copy(pp.velocity).setY(0);
    }

    const before = this.stars;
    if (this.status === 'chase') {
      if (this.seen) {
        this.unseen = 0;
        this.heat = Math.min(this.c.maxStars + 0.999, this.heat + S.heatRisePerSecond * dt);
      } else {
        this.unseen += dt;
        if (this.unseen >= this.evadeNeeded()) {
          this.status = 'search';
          this.searchT = 0;
          for (const a of this.agents) { a.ai.mode = 'search'; a.ai.searchPoint.copy(this.lastSeen); }
          g.hud.banner('Lost them – stay hidden', 'good', 2.2);
        }
      }
    } else if (this.status === 'search') {
      if (this.seen) {
        this.status = 'chase';
        this.unseen = 0;
        for (const a of this.agents) a.ai.mode = 'chase';
        g.hud.banner('Spotted!', 'bad', 1.6);
      } else {
        this.searchT += dt;
        if (this.searchT >= S.searchSeconds) {
          this.status = 'clear';
          this.heat = 0;
          for (const a of this.agents) { a.ai.mode = 'leave'; a.ai.searchPoint.copy(a.sled.physics.position); }
          if (this.heli.active) this.heliLeaving = 0.001;
          g.hud.banner('They gave up – make the drop', 'good', 2.4);
        }
      }
    }
    const now = this.stars;
    if (now > before) {
      this.maxStarsReached = Math.max(this.maxStarsReached, now);
      g.audioCue('wanted');
      g.hud.banner(`${'★'.repeat(now)}  ${now >= S.helicopterAt && before < S.helicopterAt ? 'Helicopter inbound' : 'Wanted level up'}`, 'warn', 2.2);
    }

    // reinforcements while chased; the helicopter from helicopterAt stars
    if (this.status === 'chase') {
      const want = S.levels[Math.max(0, now - 1)].agents;
      if (this.agents.length < want) {
        this.spawnAgent();
        this.alert = Math.max(this.alert, S.alertSeconds * 0.4);
      }
      if (now >= S.helicopterAt && !this.heli.active) {
        const from = this.spawnPoint([260, 320]);
        this.heli.enter(from);
      }
    }
    // agents that left are removed once well away
    for (const a of [...this.agents]) {
      if (a.ai.mode === 'leave' && Math.hypot(a.sled.physics.position.x - pp.position.x, a.sled.physics.position.z - pp.position.z) > 180) {
        a.sled.dispose(g.physics, g.scene);
        this.agents.splice(this.agents.indexOf(a), 1);
      } else if (a.ai.mode === 'chase') {
        // bogged on a slope, wedged, flipped, or crawling without getting closer: bring it back in from out of sight
        const d = a.sled.physics.position.distanceTo(pp.position);
        if (d < a.closest - 4 || d < 15) { a.closest = Math.min(a.closest, d); a.noProgress = 0; } else if (Math.abs(a.sled.physics.speed) < 6) a.noProgress += dt;
        if (a.sled.flippedTime > 2 || a.ai.stuckTotal > 5 || (a.noProgress > S.noProgressSeconds && !a.sees)) this.respawn(a);
      }
    }

    // boxed in: stopped with an agent alongside
    const near = this.agents.filter((a) => a.ai.mode !== 'leave' && a.sled.physics.position.distanceTo(pp.position) < S.bustRadius).length;
    if (near > 0 && Math.abs(pp.speed) < S.bustSpeed) this.bust += (S.bustFillPerSecond + S.bustFillPerExtraAgent * (near - 1)) * dt;
    else this.bust = Math.max(0, this.bust - S.bustDrainPerSecond * dt);
    if (this.bust >= 1) this.busted();
  }

  private evadeNeeded() { return S.evadeSeconds + S.evadePerStar * this.stars; }

  update(dt: number) {
    const g = this.game;
    this.t += dt;
    const alpha = g.renderAlpha;
    const flash = Math.floor(this.t * 6) % 2 === 0;
    for (const a of this.agents) {
      a.sled.render(alpha, dt);
      a.sled.visual.setHeadlights(g.sky.headlights);
      a.lights[0].visible = a.ai.mode === 'leave' || flash;
      a.lights[1].visible = a.ai.mode === 'leave' || !flash;
    }
    this.updateHeli(dt);
    this.updateChaseAudio();
    (this.marker.children[1] as THREE.Mesh).scale.setScalar(1 + 0.05 * Math.sin(this.t * 3));

    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      g.hud.setCountdown(n > 0 ? String(n) : 'GO!');
      if (this.countdown <= 0.6) {
        this.state = 'running';
        g.hud.banner('They\'re onto you – lose them!', 'warn', 2.2);
      }
    } else if (this.countdown > -0.6) {
      this.countdown -= dt;
      if (this.countdown <= -0.6) g.hud.setCountdown('');
    }
    if (this.state === 'done') return;

    const pp = g.player.physics;
    const dist = Math.hypot(pp.position.x - this.dest.x, pp.position.z - this.dest.z);
    g.hud.setObjective({
      title: `${this.c.name} → ${this.dest.name}`,
      main: fmtTime(this.time),
      sub: `${dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m'} to the drop · ${this.agents.filter((a) => a.ai.mode !== 'leave').length} agents${this.heli.active && !this.heliLeaving ? ' + helicopter' : ''}`,
    });
    const s = this.stars;
    const kind = this.status === 'chase' ? (this.unseen > 0 ? 'evade' : 'chase') : this.status;
    g.hud.setWanted({
      stars: s, max: this.c.maxStars, kind, bust: this.bust,
      status: kind === 'chase' ? (this.seenByHeli && !this.agents.some((a) => a.sees) ? 'IN THE SEARCHLIGHT' : 'AGENTS IN PURSUIT')
        : kind === 'evade' ? 'OUT OF SIGHT – KEEP GOING'
          : kind === 'search' ? 'SEARCHING – STAY HIDDEN' : 'CLEAR – MAKE THE DROP',
      meter: kind === 'evade' ? this.unseen / this.evadeNeeded() : kind === 'search' ? this.searchT / S.searchSeconds : 1,
    });

    const inRing = dist < 12;
    g.hud.setWarning(this.state === 'running' && inRing && this.status === 'chase' ? 'Lose them before the drop!' : this.bust > 0.25 ? 'Boxed in – get moving!' : '');
    if (this.state === 'running' && inRing && this.status !== 'chase' && Math.abs(pp.speed) < 3.5) this.deliver();
  }

  /** Siren from the nearest agent still on the job, rotor from the helicopter, panned around the camera. */
  private updateChaseAudio() {
    const g = this.game;
    const cam = g.camera.position;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(g.camera.quaternion);
    const pos = (p: THREE.Vector3) => {
      const d = p.clone().sub(cam);
      const dist = d.length();
      return { dist, pan: dist > 0.1 ? d.normalize().dot(right) : 0 };
    };
    let nearest: THREE.Vector3 | null = null;
    let best = Infinity;
    for (const a of this.agents) {
      if (a.ai.mode === 'leave') continue;
      const d = a.sled.physics.position.distanceTo(cam);
      if (d < best) { best = d; nearest = a.sled.physics.position; }
    }
    const live = this.state !== 'countdown';
    g.audio.setChase(live && nearest ? pos(nearest) : null, live && this.heli.active && !this.heliLeaving ? pos(this.heli.root.position) : null);
  }

  private updateHeli(dt: number) {
    const h = this.heli;
    if (!h.active) return;
    const g = this.game;
    const pp = g.player.physics;
    this.sweep += dt;
    if (this.heliLeaving > 0) {
      this.heliLeaving += dt;
      const away = pp.position.clone().add(new THREE.Vector3(h.root.position.x - pp.position.x, 0, h.root.position.z - pp.position.z).setLength(600));
      h.update(dt, away, away, g.sky.night, g.camera.position);
      if (this.heliLeaving > 14) { h.exit(); this.heliLeaving = 0; }
      return;
    }
    if (this.seen) {
      // hang back and to the side so the beam rakes forward over you
      const back = new THREE.Vector3(-pp.forward.x, 0, -pp.forward.z).setLength(14);
      h.update(dt, pp.position.clone().add(back), pp.position, g.sky.night, g.camera.position);
    } else {
      // circle the last sighting and sweep the beam around it
      const r = 18 + Math.min(this.unseen + this.searchT, 25) * 1.6;
      const centre = this.lastSeen.clone().addScaledVector(this.lastSeenVel, Math.min(this.unseen, 2));
      const aim = centre.clone().add(new THREE.Vector3(Math.cos(this.sweep * 0.7) * r, 0, Math.sin(this.sweep * 0.9) * r));
      const orbit = centre.clone().add(new THREE.Vector3(Math.cos(this.sweep * 0.25) * 30, 0, Math.sin(this.sweep * 0.25) * 30));
      h.update(dt, orbit, aim, g.sky.night, g.camera.position);
    }
  }

  private deliver() {
    const g = this.game;
    this.state = 'done';
    g.hud.setWarning('');
    const stars = this.maxStarsReached;
    const bonus = Math.round(this.c.pay * S.wantedBonus * stars);
    const currency = this.c.pay + bonus;
    const xp = Math.round(currency * S.xpPerDollar);
    const rec = (g.save.data.special.jobs[this.c.id] ??= { done: 0, busts: 0, bestPay: 0, bestStars: 0 });
    rec.done++;
    rec.bestPay = Math.max(rec.bestPay, currency);
    rec.bestStars = Math.max(rec.bestStars, stars);
    g.save.data.special.completed++;
    g.addRewards(currency, xp);
    g.audioCue?.('finish');
    this.endChase();
    g.hud.showResults({
      title: `${this.c.name} · ${this.dest.name}`,
      time: fmtTime(this.time),
      medal: stars >= this.c.maxStars ? 'gold' : stars >= this.c.maxStars - 1 ? 'silver' : 'bronze',
      subtitle: `Package delivered · ${'★'.repeat(stars)} wanted${scauceQuote(stars >= 4 ? SCAUCE.deliveredHot : SCAUCE.delivered)}`,
      medalTimes: [['Highest wanted level', `${stars} of ${this.c.maxStars}`]],
      leaderboardTitle: 'This contract',
      leaderboard: [{ text: `Done ${rec.done}× · best $${rec.bestPay.toLocaleString('en-US')}`, highlight: rec.bestPay === currency }],
      rewards: [
        { label: 'Contract', currency: this.c.pay, xp },
        { label: `Wanted bonus (${'★'.repeat(stars)})`, currency: bonus, xp: 0 },
      ],
      total: { currency, xp },
      actions: [
        { label: 'Run it again', key: 'R', primary: true, run: () => this.reset() },
        { label: 'Contracts', key: 'J', run: () => g.toMenu('special') },
        { label: 'Menu', key: 'Esc', run: () => g.toMenu() },
      ],
    });
  }

  private busted() {
    const g = this.game;
    this.state = 'done';
    g.hud.setWarning('');
    const rec = (g.save.data.special.jobs[this.c.id] ??= { done: 0, busts: 0, bestPay: 0, bestStars: 0 });
    rec.busts++;
    g.save.data.special.busts++;
    g.save.save();
    this.endChase();
    g.audioCue('busted');
    g.hud.banner('BUSTED', 'bad', 3);
    g.hud.showResults({
      title: `${this.c.name} · Busted`,
      time: fmtTime(this.time),
      medal: null,
      subtitle: `Boxed in and stopped. Package confiscated.${scauceQuote(SCAUCE.busted)}`,
      medalTimes: [['Highest wanted level', `${this.maxStarsReached} of ${this.c.maxStars}`]],
      leaderboardTitle: 'This contract',
      leaderboard: [{ text: `Done ${rec.done}× · busted ${rec.busts}×`, highlight: false }],
      rewards: [{ label: 'No pay', currency: 0, xp: 0 }],
      total: { currency: 0, xp: 0 },
      actions: [
        { label: 'Try again', key: 'R', primary: true, run: () => this.reset() },
        { label: 'Contracts', key: 'J', run: () => g.toMenu('special') },
        { label: 'Menu', key: 'Esc', run: () => g.toMenu() },
      ],
    });
  }

  private endChase() {
    for (const a of this.agents) a.ai.mode = 'leave';
    this.game.hud.setWanted(null);
  }

  drawMap(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]) {
    drawTargetPin(ctx, toMap, this.dest.x, this.dest.z, '#ffb347');
    for (const a of this.agents) {
      if (a.ai.mode === 'leave') continue;
      const p = a.sled.physics.position;
      const [x, y] = toMap(p.x, p.z);
      ctx.fillStyle = a.sees ? '#ff4d4d' : 'rgba(255,120,120,0.55)';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.heli.active) {
      const [x, y] = toMap(this.heli.beamPoint.x, this.heli.beamPoint.z);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
      const [hx, hy] = toMap(this.heli.root.position.x, this.heli.root.position.z);
      ctx.fillStyle = '#ff4d4d';
      ctx.fillRect(hx - 3, hy - 3, 6, 6);
    }
  }
}
