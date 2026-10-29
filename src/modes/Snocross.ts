import * as THREE from 'three';
import type { Game } from '../core/Game';
import { GameMode } from './GameMode';
import { RaceAI } from './ai/RaceAI';
import { Sled } from '../vehicles/Sled';
import { getSled, RIDER_MASS, DEFAULT_LIVERY } from '../vehicles/SledSpec';
import snocrossData from '../data/snocross.json';
import { fmtTime } from './TimeTrial';

export type SnocrossEvent = (typeof snocrossData.events)[number];
export const SNOCROSS_EVENTS = snocrossData.events as SnocrossEvent[];

interface Racer {
  name: string;
  number: number;
  sled: Sled;
  ai: RaceAI | null;
  basePower: number;
  idx: number;
  rel: number; // metres past the start line this lap
  crossings: number;
  halfway: boolean;
  lapStart: number;
  bestLap: number;
  finishTime: number | null;
}

const PLACE = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

/** Six-rider snocross race at Frostpine Arena: grid start, laps, positions, results. */
export class Snocross implements GameMode {
  readonly id = 'snocross';
  readonly title: string;
  private ev: SnocrossEvent;
  private racers: Racer[] = [];
  private state: 'countdown' | 'racing' | 'done' = 'countdown';
  private countdown = 0;
  private time = 0;
  private doneTimer = 0;
  private finishOrder: Racer[] = [];

  constructor(private game: Game, eventId: string) {
    this.ev = SNOCROSS_EVENTS.find((e) => e.id === eventId) ?? SNOCROSS_EVENTS[0];
    this.title = this.ev.name;
  }

  get controlsEnabled() { return this.state === 'racing' && !this.player.finishTime; }
  private get player() { return this.racers.find((r) => !r.ai)!; }
  private get track() { return this.game.track; }

  enter() {
    const g = this.game;
    if (g.player.trailer) g.toggleTrailer(true);
    const spec = getSled(this.ev.aiSled);
    const slots = this.track.grid;
    const playerSlot = 4; // second row, middle: you have to earn the holeshot
    const riders = snocrossData.riders;
    let ai = 0;
    for (let i = 0; i < slots.length; i++) {
      if (i === playerSlot) continue;
      const r = riders[ai];
      const skill = Math.min(1, this.ev.aiSkill + (ai - 2) * 0.025); // a little spread across the field
      const sled = new Sled(g.physics, g.terrain, { spec, riderMass: RIDER_MASS, cargoMass: 0, parts: this.ev.aiParts ?? [], livery: { ...DEFAULT_LIVERY, paint: r.paint, gear: r.gear, number: r.number } }, slots[i].pos, slots[i].yaw);
      g.scene.add(sled.visual.root);
      const lane = ((i % 3) - 1) * 2.4;
      this.racers.push(this.newRacer(r.name, r.number, sled, new RaceAI(sled, this.track.route, g.terrain, skill, this.track.zones, lane)));
      ai++;
    }
    this.racers.push(this.newRacer('You', g.progression.garage(g.save.data.currentSled).livery.number, g.player, null));
    this.reset();
  }

  private newRacer(name: string, number: number, sled: Sled, ai: RaceAI | null): Racer {
    return { name, number, sled, ai, basePower: sled.physics.params.powerW, idx: 0, rel: 0, crossings: 0, halfway: false, lapStart: 0, bestLap: Infinity, finishTime: null };
  }

  private reset() {
    const slots = this.track.grid;
    let ai = 0;
    for (const r of this.racers) {
      const slot = r.ai ? (ai >= 4 ? ai + 1 : ai) : 4;
      if (r.ai) ai++;
      r.sled.teleport(slots[slot].pos.clone(), slots[slot].yaw);
      r.ai?.follower.reset(this.track.route.cum[this.track.route.nearest(slots[slot].pos)]);
      Object.assign(r, { idx: this.track.route.nearest(slots[slot].pos), crossings: 0, halfway: false, lapStart: 0, bestLap: Infinity, finishTime: null });
      r.rel = this.relOf(r);
    }
    this.game.snow.clear();
    this.state = 'countdown';
    this.countdown = 3.6;
    this.time = 0;
    this.finishOrder = [];
    this.game.hud.hideResults();
  }

  restart() { this.reset(); }

  exit() {
    const g = this.game;
    for (const r of this.racers) if (r.ai) r.sled.dispose(g.physics, g.scene);
    this.racers = [];
    g.hud.setObjective(null);
    g.hud.setCountdown('');
    g.hud.setStandings(null);
  }

  recover(): boolean {
    const r = this.player;
    const route = this.track.route;
    const i = route.indexAt(route.cum[r.idx] + 2);
    const q = route.pts[i], d = route.dirs[i];
    r.sled.teleport(new THREE.Vector3(q.x, q.y + 0.8, q.z), Math.atan2(d.x, d.z));
    return true;
  }

  private relOf(r: Racer): number {
    return this.track.route.wrap(this.track.route.cum[r.idx] - this.track.startS);
  }

  /** Racecraft: an AI closing on a rider in its lane moves to whichever side has more room. */
  private avoidTraffic() {
    const route = this.track.route;
    const pos = this.racers.map((r) => {
      const q = route.pts[r.idx], d = route.dirs[r.idx];
      const p = r.sled.physics.position;
      return { s: route.cum[r.idx], lat: (p.x - q.x) * -d.z + (p.z - q.z) * d.x }; // + = left of the line
    });
    this.racers.forEach((r, i) => {
      if (!r.ai) return;
      let best = Infinity, side = 0;
      this.racers.forEach((_o, j) => {
        if (i === j) return;
        const ahead = route.delta(pos[i].s, pos[j].s);
        const dl = pos[j].lat - pos[i].lat;
        if (ahead > 0 && ahead < 12 && Math.abs(dl) < 2.4 && ahead < best) {
          best = ahead;
          // go round on the side away from them, unless that runs out of track
          side = pos[i].lat > 3 ? -1 : pos[i].lat < -3 ? 1 : dl >= 0 ? -1 : 1;
        }
      });
      r.ai.gapAhead = best;
      const target = best < 12 ? side * 2.6 : 0;
      r.ai.avoid += (target - r.ai.avoid) * 0.08;
    });
  }

  prePhysics(dt: number) {
    const racing = this.state === 'racing';
    if (racing) this.avoidTraffic();
    const L = this.track.route.length;
    const mine = this.player.crossings * L + this.player.rel;
    for (const r of this.racers) {
      if (!r.ai) continue;
      // a little extra power when well behind you, so the pack doesn't fade away
      const behind = mine - (r.crossings * L + r.rel);
      const boost = racing ? THREE.MathUtils.clamp(behind / snocrossData.catchUpGap, 0, 1) * snocrossData.catchUp : 0;
      r.sled.physics.params.powerW = r.basePower * (1 + boost);
      // finished AI riders cruise on
      const input = r.ai.control(dt, racing || this.state === 'done');
      r.sled.fixedUpdate(dt, r.finishTime ? { ...input, throttle: Math.min(input.throttle, 0.4) } : input);
      r.sled.stunts.events.length = 0;
    }
  }

  fixedUpdate(dt: number) {
    if (this.state === 'countdown') return;
    this.time += dt;
    const route = this.track.route;
    const L = route.length;
    for (const r of this.racers) {
      r.idx = route.nearest(r.sled.physics.position, r.idx, 30);
      const prev = r.rel;
      r.rel = this.relOf(r);
      if (r.rel > L * 0.4 && r.rel < L * 0.6) r.halfway = true;
      // crossed the line going forwards
      if (prev > L * 0.75 && r.rel < L * 0.25 && (r.halfway || r.crossings === 0)) {
        if (r.crossings > 0) r.bestLap = Math.min(r.bestLap, this.time - r.lapStart);
        r.crossings++;
        r.halfway = false;
        r.lapStart = this.time;
        if (r.crossings > this.ev.laps && r.finishTime === null) {
          r.finishTime = this.time;
          this.finishOrder.push(r);
          if (!r.ai) this.game.audioCue?.('finish');
        }
      }
    }
    if (this.state === 'racing' && this.player.finishTime !== null) {
      this.state = 'done';
      this.doneTimer = 2.5;
    }
  }

  /** Current race order: finishers by time, then by distance covered. */
  private order(): Racer[] {
    const L = this.track.route.length;
    const score = (r: Racer) => r.crossings * L + r.rel;
    const finished = [...this.finishOrder];
    const rest = this.racers.filter((r) => r.finishTime === null).sort((a, b) => score(b) - score(a));
    return [...finished, ...rest];
  }

  update(dt: number) {
    const g = this.game;
    const alpha = g.renderAlpha;
    for (const r of this.racers) {
      if (!r.ai) continue;
      r.sled.render(alpha, dt);
      g.effects.emitFromSled(r.sled, dt);
      g.snow.stampSled(r.sled);
    }
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      g.hud.setCountdown(n > 0 ? String(n) : 'GO!');
      if (this.countdown <= 0.6) { this.state = 'racing'; }
    } else if (this.countdown > -0.6) {
      this.countdown -= dt;
      if (this.countdown <= -0.6) g.hud.setCountdown('');
    }
    const order = this.order();
    const me = this.player;
    const pos = order.indexOf(me) + 1;
    const lap = Math.min(this.ev.laps, Math.max(1, me.crossings));
    g.hud.setObjective({
      title: `${this.ev.name} · Lap ${lap}/${this.ev.laps}`,
      main: `P${pos} / ${order.length}`,
      sub: `Lap ${me.crossings > 0 ? fmtTime(this.time - me.lapStart) : '0:00.00'}${me.bestLap < Infinity ? ` · Best ${fmtTime(me.bestLap)}` : ''}`,
    });
    const leader = order[0];
    g.hud.setStandings(order.map((r, i) => {
      const gap = i === 0 ? '' : r.finishTime !== null && leader.finishTime !== null ? `+${(r.finishTime - leader.finishTime).toFixed(1)}` : r.crossings >= 1 && r.crossings < leader.crossings ? `+${leader.crossings - r.crossings} lap` : '';
      return { text: `${i + 1}. #${r.number} ${r.name}`, gap, me: !r.ai };
    }));
    if (this.state === 'done') {
      this.doneTimer -= dt;
      if (this.doneTimer <= 0 && !g.hud.resultsOpen) this.showResults();
    }
  }

  private showResults() {
    const g = this.game;
    const order = this.order();
    const place = order.indexOf(this.player);
    const currency = this.ev.rewards[place] ?? 0;
    const xp = this.ev.xp[place] ?? 0;
    const rec = (g.save.data.snocross[this.ev.id] ??= { best: 99, wins: 0, podiums: 0, races: 0 });
    rec.races++;
    rec.best = Math.min(rec.best, place + 1);
    if (place === 0) rec.wins++;
    if (place < 3) rec.podiums++;
    const lines = [{ label: `${PLACE[place]} place`, currency, xp }];
    if (this.player.bestLap < Infinity) lines.push({ label: `Best lap ${fmtTime(this.player.bestLap)}`, currency: 0, xp: 0 });
    g.addRewards(currency, xp);
    const medal = place === 0 ? 'gold' : place === 1 ? 'silver' : place === 2 ? 'bronze' : null;
    const nextEv = SNOCROSS_EVENTS[SNOCROSS_EVENTS.indexOf(this.ev) + 1];
    g.hud.showResults({
      title: this.ev.name,
      time: PLACE[place],
      medal,
      subtitle: `${fmtTime(this.player.finishTime ?? this.time)} · ${this.ev.laps} laps${place === 0 ? ' · Victory!' : ''}`,
      medalTimes: [],
      leaderboardTitle: 'Finishing order',
      leaderboard: order.map((r) => {
        const left = this.ev.laps - Math.max(0, r.crossings - 1);
        return { text: `#${r.number} ${r.name} · ${r.finishTime !== null ? fmtTime(r.finishTime) : `still racing (${left} lap${left === 1 ? '' : 's'} to go)`}`, highlight: !r.ai };
      }),
      rewards: lines,
      total: { currency, xp },
      actions: [
        { label: 'Race again', key: 'R', primary: true, run: () => this.reset() },
        ...(nextEv && getSled(g.save.data.currentSled).tier >= nextEv.tier ? [{ label: 'Next event', key: 'N', run: () => g.startMode('snocross', nextEv.id) }] : []),
        { label: 'Menu', key: 'Esc', run: () => g.toMenu() },
      ],
    });
  }

  drawMap(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]) {
    const r = this.track.route;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= r.pts.length; i += 3) {
      const q = r.pts[i % r.pts.length];
      const [x, y] = toMap(q.x, q.z);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    for (const rc of this.racers) {
      if (!rc.ai) continue;
      const p = rc.sled.physics.position;
      const [x, y] = toMap(p.x, p.z);
      ctx.fillStyle = '#9fd3ff';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
