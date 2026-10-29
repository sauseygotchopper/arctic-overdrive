import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import type { Game } from '../core/Game';
import { GameMode } from './GameMode';
import { Checkpoints } from './Checkpoints';
import { GhostPlayer, GhostRecorder, loadGhost, saveGhost } from './Ghost';
import { Route } from './Route';
import modesData from '../data/modes.json';
import tracksData from '../data/tracks.json';
import { TimeOfDay } from '../world/Sky';

export type Medal = 'gold' | 'silver' | 'bronze' | null;
export type CourseDef = (typeof tracksData.courses)[number];
export const COURSES = tracksData.courses as CourseDef[];

export function medalFor(course: CourseDef, time: number): Medal {
  const m = course.medals;
  if (!m.gold) return null;
  if (time <= m.gold) return 'gold';
  if (time <= m.silver) return 'silver';
  if (time <= m.bronze) return 'bronze';
  return null;
}

export const fmtTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

/** Checkpoint race against the clock and your best-run ghost. */
export class TimeTrial implements GameMode {
  readonly id = 'timeTrial';
  readonly title: string;
  private course: CourseDef;
  private route: Route;
  private gates!: Checkpoints;
  private state: 'countdown' | 'racing' | 'finished' = 'countdown';
  private countdown = 0;
  private time = 0;
  private next = 0;
  private splits: number[] = [];
  private lastDelta: number | null = null;
  private deltaTimer = 0;
  private prevPos = new THREE.Vector3();
  private recorder = new GhostRecorder();
  private ghost: GhostPlayer | null = null;
  private wrongWay = 0;
  private prevTod: TimeOfDay;

  constructor(private game: Game, courseId: string) {
    this.course = COURSES.find((c) => c.id === courseId)!;
    this.title = this.course.name;
    this.route = game.routes.get(courseId)!;
    this.prevTod = game.sky.current;
  }

  get controlsEnabled() { return this.state === 'racing'; }

  private get record() {
    const g = this.game.save.data.timeTrials;
    return (g[this.course.id] ??= { best: null, times: [], splits: [], medals: [] });
  }

  enter() {
    const g = this.game;
    g.sky.apply(this.course.timeOfDay as TimeOfDay);
    g.applyLighting();
    if (g.player.trailer) g.toggleTrailer(true);
    this.gates = new Checkpoints(g.terrain);
    const r = this.route;
    const n = this.course.checkpoints;
    for (let i = 1; i <= n; i++) {
      const d = (r.length * i) / n - (i === n ? 2 : 0);
      const idx = r.indexAt(d);
      this.gates.add(r.pts[idx], r.dirs[idx], r.widths[idx], i === n ? 'finish' : 'checkpoint');
    }
    g.scene.add(this.gates.group);
    const frames = loadGhost(this.course.id);
    if (frames) {
      this.ghost = new GhostPlayer(g.player.setup.spec, frames);
      g.scene.add(this.ghost.model.root);
    }
    this.reset();
  }

  private reset() {
    const g = this.game;
    const r = this.route;
    const p0 = r.pts[1], d0 = r.dirs[1];
    g.player.teleport(new THREE.Vector3(p0.x, g.terrain.heightAt(p0.x, p0.z) + 0.6, p0.z), Math.atan2(d0.x, d0.z));
    g.snow.clear();
    this.state = 'countdown';
    this.countdown = 3.6;
    this.time = 0;
    this.next = 0;
    this.splits = [];
    this.lastDelta = null;
    this.recorder.reset();
    this.prevPos.copy(g.player.physics.position);
    this.gates.setNext(0);
    g.hud.hideResults();
  }

  restart() { this.reset(); }

  exit() {
    const g = this.game;
    this.gates.dispose();
    if (this.ghost) disposeObject(this.ghost.model.root);
    g.hud.setObjective(null);
    g.hud.setCountdown('');
    g.hud.setWarning('');
    g.sky.apply(this.prevTod);
    g.applyLighting();
  }

  recover(): boolean {
    const g = this.game;
    const gate = this.next > 0 ? this.gates.gates[this.next - 1] : null;
    const r = this.route;
    const pos = gate ? gate.pos : r.pts[1];
    const dir = gate ? gate.dir : r.dirs[1];
    const back = gate ? 4 : 0;
    const x = pos.x - dir.x * back, z = pos.z - dir.z * back;
    g.player.teleport(new THREE.Vector3(x, g.terrain.heightAt(x, z) + 0.8, z), Math.atan2(dir.x, dir.z));
    this.prevPos.copy(g.player.physics.position);
    return true;
  }

  fixedUpdate(dt: number) {
    if (this.state !== 'racing') return;
    const p = this.game.player.physics;
    this.time += dt;
    this.recorder.sample(this.time, dt, p);
    if (this.gates.crossed(this.next, this.prevPos, p.position)) this.passGate();
    this.prevPos.copy(p.position);
    // wrong way: driving against the route direction for a while
    const idx = this.route.nearest(p.position);
    const along = p.velocity.x * this.route.dirs[idx].x + p.velocity.z * this.route.dirs[idx].z;
    this.wrongWay = along < -3 ? this.wrongWay + dt : 0;
  }

  private passGate() {
    const best = this.record.splits;
    this.splits.push(this.time);
    const i = this.splits.length - 1;
    this.lastDelta = best[i] !== undefined ? this.time - best[i] : null;
    this.deltaTimer = 3;
    this.next++;
    this.game.audioCue?.('checkpoint');
    if (this.next >= this.gates.gates.length) this.finish();
    else this.gates.setNext(this.next);
  }

  private finish() {
    const g = this.game;
    this.state = 'finished';
    const rec = this.record;
    const time = this.time;
    const prevBest = rec.best;
    const isPB = prevBest === null || time < prevBest;
    const medal = medalFor(this.course, time);
    const R = modesData.timeTrial;
    const lines: { label: string; currency: number; xp: number }[] = [{ label: 'Course complete', ...R.finish }];
    if (medal) {
      const full = !rec.medals.includes(medal);
      const m = R.medals[medal];
      const k = full || !R.firstMedalOnly ? 1 : 0.25;
      lines.push({ label: `${medal[0].toUpperCase()}${medal.slice(1)} medal${full ? '' : ' (repeat)'}`, currency: Math.round(m.currency * k), xp: Math.round(m.xp * k) });
      if (full) rec.medals.push(medal);
    }
    if (isPB && prevBest !== null) lines.push({ label: 'New personal best', ...R.personalBest });
    if (isPB) {
      rec.best = time;
      rec.splits = [...this.splits];
      saveGhost(this.course.id, this.recorder.toArray());
    }
    rec.times = [...rec.times, time].sort((a, b) => a - b).slice(0, 5);
    const total = lines.reduce((a, l) => ({ currency: a.currency + l.currency, xp: a.xp + l.xp }), { currency: 0, xp: 0 });
    g.addRewards(total.currency, total.xp);
    g.hud.setCountdown('');
    g.hud.showResults({
      title: this.course.name,
      time: fmtTime(time),
      medal,
      subtitle: isPB ? (prevBest === null ? 'First finish!' : `New personal best · ${fmtTime(prevBest - time)} faster`) : `Best ${fmtTime(prevBest!)} · +${(time - prevBest!).toFixed(2)}s`,
      medalTimes: this.course.medals.gold ? [['Gold', fmtTime(this.course.medals.gold)], ['Silver', fmtTime(this.course.medals.silver)], ['Bronze', fmtTime(this.course.medals.bronze)]] : [],
      leaderboard: rec.times.map((t) => ({ text: fmtTime(t), highlight: t === time })),
      rewards: lines,
      total,
      actions: [
        { label: 'Retry', key: 'R', primary: true, run: () => this.reset() },
        ...(this.nextCourseId() ? [{ label: 'Next course', key: 'N', run: () => g.startMode('timeTrial', this.nextCourseId()!) }] : []),
        { label: 'Menu', key: 'Esc', run: () => g.toMenu() },
      ],
    });
  }

  private nextCourseId(): string | null {
    const i = COURSES.findIndex((c) => c.id === this.course.id);
    return COURSES[i + 1]?.id ?? null;
  }

  update(dt: number) {
    const g = this.game;
    this.gates.update(dt);
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      g.hud.setCountdown(n > 0 ? String(n) : 'GO!');
      if (this.countdown <= 0.6) {
        this.state = 'racing';
      }
    } else if (this.state === 'racing' && this.countdown > -0.6) {
      this.countdown -= dt;
      if (this.countdown <= -0.6) g.hud.setCountdown('');
    }
    if (this.ghost) this.ghost.set(this.state === 'countdown' ? 0 : this.time);
    this.deltaTimer -= dt;
    const delta = this.deltaTimer > 0 && this.lastDelta !== null
      ? `<span class="${this.lastDelta <= 0 ? 'ahead' : 'behind'}">${this.lastDelta <= 0 ? '−' : '+'}${Math.abs(this.lastDelta).toFixed(2)}</span>`
      : '';
    g.hud.setObjective({
      title: this.course.name,
      main: fmtTime(this.time),
      sub: `Checkpoint ${Math.min(this.next + 1, this.gates.gates.length)}/${this.gates.gates.length} ${delta}`,
    });
    g.hud.setWarning(this.state === 'racing' && this.wrongWay > 1.2 ? 'Wrong way' : '');
  }

  drawMap(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]) {
    const r = this.route;
    ctx.strokeStyle = 'rgba(255,90,31,0.85)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < r.pts.length; i += 3) {
      const [x, y] = toMap(r.pts[i].x, r.pts[i].z);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    this.gates.gates.forEach((gate, i) => {
      if (i < this.next) return;
      const [x, y] = toMap(gate.pos.x, gate.pos.z);
      ctx.fillStyle = i === this.next ? '#ffffff' : 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.arc(x, y, i === this.next ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    if (this.ghost && this.state === 'racing') {
      const gp = this.ghost.model.root.position;
      const [x, y] = toMap(gp.x, gp.z);
      ctx.fillStyle = '#9fd3ff';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
