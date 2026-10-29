import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import type { Game } from '../core/Game';
import { GameMode } from './GameMode';
import { CargoItem, CargoType } from '../vehicles/Cargo';
import deliveryData from '../data/deliveries.json';
import { fmtTime } from './TimeTrial';
import type { StuntEvent } from '../vehicles/Tricks';

export type DeliveryJob = (typeof deliveryData.jobs)[number];
export const DELIVERY_JOBS = deliveryData.jobs as DeliveryJob[];

/** Where a job's `from`/`to` id points: a cabin, or the trailhead depot. */
export function jobPoint(game: Game, id: string): { x: number; z: number; name: string } {
  if (id === 'depot') return { x: game.terrain.def.spawn.x, z: game.terrain.def.spawn.z, name: 'Trailhead Depot' };
  const c = game.terrain.def.cabins.find((x) => x.id === id)!;
  return { x: c.x, z: c.z, name: id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') };
}

/** Minimap marker for a destination, pinned to the map's edge when it's out of view. */
export function drawTargetPin(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number], wx: number, wz: number, color: string) {
  let [x, y] = toMap(wx, wz);
  const r = 90, cx = x - r, cy = y - r;
  const d = Math.hypot(cx, cy);
  const edge = d > r - 8;
  if (edge) { x = r + (cx / d) * (r - 8); y = r + (cy / d) * (r - 8); }
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0b1626';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, edge ? 5 : 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Pick up at a depot, haul to a remote cabin against the clock; fragile cargo pays by condition. */
export class Delivery implements GameMode {
  readonly id = 'delivery';
  readonly title: string;
  private job: DeliveryJob;
  private state: 'countdown' | 'running' | 'done' = 'countdown';
  private countdown = 0;
  private time = 0;
  private dest!: { x: number; z: number; name: string };
  private marker = new THREE.Group();
  private items: CargoItem[] = []; // everything this job started with
  private t = 0;

  constructor(private game: Game, jobId: string) {
    this.job = DELIVERY_JOBS.find((j) => j.id === jobId) ?? DELIVERY_JOBS[0];
    this.title = this.job.name;
  }

  get controlsEnabled() { return this.state === 'running'; }
  private get trailerJob() { return this.job.carry === 'trailer'; }

  /** Cargo still with us (rack or trailer). */
  private carried(): CargoItem[] {
    const p = this.game.player;
    return this.trailerJob ? p.trailer?.cargo ?? [] : p.rack;
  }

  enter() {
    const g = this.game;
    this.dest = jobPoint(g, this.job.to);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0x7cf3b0, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 140, 16, 1, true), beamMat);
    beam.position.y = 70;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(10, 0.25, 8, 48), new THREE.MeshBasicMaterial({ color: 0x7cf3b0 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.4;
    this.marker.add(beam, ring);
    this.marker.position.set(this.dest.x, g.terrain.heightAt(this.dest.x, this.dest.z), this.dest.z);
    g.scene.add(this.marker);
    this.reset();
  }

  private reset() {
    const g = this.game;
    const p = g.player;
    if (p.trailer) g.toggleTrailer(true);
    p.setRack([]);
    for (const l of [...g.loose.items]) { g.loose.remove(l.item); l.item.dispose(); }
    // start beside the pickup, facing the destination
    const from = jobPoint(g, this.job.from);
    const dx = this.dest.x - from.x, dz = this.dest.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const sx = from.x + (dx / len) * 22, sz = from.z + (dz / len) * 22;
    p.teleport(new THREE.Vector3(sx, g.terrain.heightAt(sx, sz) + 0.8, sz), Math.atan2(dx, dz));
    const cargo = this.job.cargo as CargoType[];
    if (this.trailerJob) {
      g.toggleTrailer(true);
      p.trailer?.setCargo(cargo);
      this.items = [...(p.trailer?.cargo ?? [])];
    } else {
      p.setRack(cargo);
      this.items = [...p.rack];
    }
    g.snow.clear();
    this.state = 'countdown';
    this.countdown = 2.6;
    this.time = 0;
    g.hud.hideResults();
  }

  restart() { this.reset(); }

  exit() {
    const g = this.game;
    disposeObject(this.marker);
    for (const l of [...g.loose.items]) { g.loose.remove(l.item); l.item.dispose(); }
    if (g.player.trailer) g.toggleTrailer(true);
    g.player.setRack([]);
    g.hud.setObjective(null);
    g.hud.setCountdown('');
  }

  fixedUpdate() {
    if (this.state === 'running') this.time += 1 / 60;
  }

  update(dt: number) {
    const g = this.game;
    this.t += dt;
    (this.marker.children[1] as THREE.Mesh).scale.setScalar(1 + 0.05 * Math.sin(this.t * 3));
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      g.hud.setCountdown(n > 0 ? String(n) : 'GO!');
      if (this.countdown <= 0.6) this.state = 'running';
    } else if (this.countdown > -0.6) {
      this.countdown -= dt;
      if (this.countdown <= -0.6) g.hud.setCountdown('');
    }
    if (this.state !== 'running') return;

    this.pickUpLoose();
    const p = g.player.physics;
    const dist = Math.hypot(p.position.x - this.dest.x, p.position.z - this.dest.z);
    const left = this.job.timeLimit - this.time;
    const carried = this.carried();
    const fragile = carried.filter((c) => c.def.fragile);
    const health = fragile.length ? fragile.reduce((a, c) => a + c.health, 0) / fragile.length : 1;
    g.hud.setObjective({
      title: `${this.job.name} → ${this.dest.name}`,
      main: left >= 0 ? fmtTime(left) : `LATE ${fmtTime(-left)}`,
      sub: `${dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m'} · ${carried.length}/${this.items.length} items${fragile.length ? ` · condition <span class="${health > 0.7 ? 'ahead' : 'behind'}">${Math.round(health * 100)}%</span>` : ''}`,
    });
    g.hud.setWarning(left < 0 && left > -2 ? 'Late!' : '');
    if (dist < 12 && Math.abs(p.speed) < 3.5) this.deliver();
  }

  /** Rack cargo has no suspension of its own: hard landings and crashes hurt it, crashes can shed it. */
  onStunt(e: StuntEvent) {
    const g = this.game;
    if (this.trailerJob || this.state !== 'running') return;
    {
      if (e.type !== 'landed') return;
      if (e.impact > 5) for (const c of g.player.rack) c.damage((e.impact - 5) * 0.12);
      if (e.quality === 'crash' && g.player.rack.length) {
        const item = g.player.rack[g.player.rack.length - 1];
        const wp = item.mesh.getWorldPosition(new THREE.Vector3());
        const wq = item.mesh.getWorldQuaternion(new THREE.Quaternion());
        g.player.dropRackItem(item);
        g.loose.spill(item, wp, wq, g.player.physics.velocity);
        g.hud.toast(`${item.def.name} fell off – go back for it`, 2.5);
      }
    }
  }

  /** Roll up slowly next to spilled cargo to load it back on. */
  private pickUpLoose() {
    const g = this.game;
    const p = g.player.physics;
    if (Math.abs(p.speed) > 2.5) return;
    const near = (this.trailerJob && g.player.trailer ? g.player.trailer.position : p.position);
    for (const { item, body } of [...g.loose.items]) {
      if (!this.items.includes(item)) continue;
      const t = body.translation();
      if (Math.hypot(t.x - near.x, t.z - near.z) > 4) continue;
      g.loose.remove(item);
      if (this.trailerJob && g.player.trailer) g.player.trailer.addCargo(item);
      else g.player.addRackItem(item);
      g.hud.toast(`${item.def.name} reloaded`, 1.5);
    }
  }

  private deliver() {
    const g = this.game;
    this.state = 'done';
    const D = deliveryData;
    const carried = this.carried();
    const totalValue = this.items.reduce((a, c) => a + c.def.value, 0) || 1;
    const deliveredValue = carried.reduce((a, c) => a + c.def.value * (c.def.fragile ? c.health : 1), 0);
    const late = this.time > this.job.timeLimit;
    const base = this.job.pay * (deliveredValue / totalValue);
    const lines: { label: string; currency: number; xp: number }[] = [];
    lines.push({ label: `Delivered ${carried.length}/${this.items.length} · condition ${Math.round((deliveredValue / totalValue) * 100)}%`, currency: Math.round(base), xp: 0 });
    let total = base;
    if (late) {
      const cut = base * (1 - D.latePay);
      lines.push({ label: 'Late delivery', currency: -Math.round(cut), xp: 0 });
      total -= cut;
    } else {
      const bonus = Math.min((this.job.timeLimit - this.time) * D.timeBonusPerSecond, base * D.timeBonusCap);
      lines.push({ label: `Time bonus (${Math.round(this.job.timeLimit - this.time)} s early)`, currency: Math.round(bonus), xp: 0 });
      total += bonus;
    }
    const currency = Math.max(0, Math.round(total));
    const xp = Math.round(currency * D.xpPerDollar);
    lines[0].xp = xp;
    const rec = (g.save.data.delivery.jobs[this.job.id] ??= { done: 0, bestPay: 0, bestTime: null });
    rec.done++;
    rec.bestPay = Math.max(rec.bestPay, currency);
    if (!late) rec.bestTime = rec.bestTime === null ? this.time : Math.min(rec.bestTime, this.time);
    g.save.data.delivery.completed++;
    g.addRewards(currency, xp);
    g.audioCue?.('finish');
    const condition = deliveredValue / totalValue;
    g.hud.showResults({
      title: `${this.job.name} · ${this.dest.name}`,
      time: fmtTime(this.time),
      medal: !late && condition > 0.95 ? 'gold' : !late && condition > 0.75 ? 'silver' : !late ? 'bronze' : null,
      subtitle: late ? 'Delivered late' : condition > 0.95 ? 'Perfect delivery!' : 'Delivered on time',
      medalTimes: [['Time limit', fmtTime(this.job.timeLimit)]],
      leaderboardTitle: 'This job',
      leaderboard: rec.bestTime !== null ? [{ text: `Best ${fmtTime(rec.bestTime)}`, highlight: rec.bestTime === this.time }] : [],
      rewards: lines,
      total: { currency, xp },
      actions: [
        { label: 'Run it again', key: 'R', primary: true, run: () => this.reset() },
        { label: 'Job board', key: 'J', run: () => g.toMenu('delivery') },
        { label: 'Menu', key: 'Esc', run: () => g.toMenu() },
      ],
    });
  }

  drawMap(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]) {
    drawTargetPin(ctx, toMap, this.dest.x, this.dest.z, '#7cf3b0');
    for (const { item, body } of this.game.loose.items) {
      if (!this.items.includes(item)) continue;
      const t = body.translation();
      const [lx, ly] = toMap(t.x, t.z);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(lx - 2.5, ly - 2.5, 5, 5);
    }
  }
}
