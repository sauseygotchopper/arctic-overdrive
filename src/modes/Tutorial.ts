import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Action } from '../core/Input';
import { GameMode } from './GameMode';
import type { StuntEvent } from '../vehicles/Tricks';
import { keyName } from '../ui/Settings';
import modesData from '../data/modes.json';

interface Step {
  id: string;
  title: string;
  text: string;
  keys: Action[][];
  /** Seconds of progress needed (for hold-style steps), else 1 for one-shot steps. */
  need: number;
}

const STEPS: Step[] = [
  { id: 'throttle', title: 'Throttle', text: 'Hold to accelerate. Get up to 30 km/h.', keys: [['throttle']], need: 1 },
  { id: 'steer', title: 'Steer', text: 'Steer left and right while moving. Make a couple of turns.', keys: [['steerLeft', 'steerRight']], need: 1.2 },
  { id: 'brake', title: 'Brake', text: 'Get some speed, then brake to a stop. Hold brake when stopped to reverse.', keys: [['brake']], need: 1 },
  { id: 'lean', title: 'Lean', text: 'Shift your weight while you turn – leaning into a corner carves tighter. Lean back in deep powder, forward up steep climbs.', keys: [['leanLeft', 'leanRight'], ['leanBack', 'leanForward']], need: 1.4 },
  { id: 'pop', title: 'Pop', text: 'Hold to crouch, release to pop off the snow. Works best off a lip or bump.', keys: [['jump']], need: 1 },
  { id: 'trick', title: 'Tricks', text: 'Full throttle at the tabletop ahead. In the air, hold a trick key – or lean/steer to flip and spin.', keys: [['trick1', 'trick2', 'trick3', 'trick4']], need: 1 },
  { id: 'land', title: 'Land it', text: 'Let go of the trick before you land and keep the skis level. A clean landing banks your points. Crash and they\'re lost.', keys: [['leanBack', 'leanForward']], need: 1 },
];

/** First-launch tutorial: throttle, steering, braking, lean, pop, a trick off a tabletop and a clean landing. */
export class Tutorial implements GameMode {
  readonly id = 'tutorial';
  readonly title = 'Tutorial';
  readonly controlsEnabled = true;
  private step = 0;
  private progress = 0;
  private hadSpeed = false;
  private prevYaw = 0;
  private card!: HTMLDivElement;
  private jump!: { pos: THREE.Vector3; yaw: number };
  private done = false;
  private note = '';
  private noteT = 0;
  private lastHtml = '';

  constructor(private game: Game) {}

  enter() {
    const g = this.game;
    const sp = g.terrain.def.spawn;
    g.player.teleport(new THREE.Vector3(sp.x, g.terrain.heightAt(sp.x, sp.z) + 0.8, sp.z), Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z));
    // the trick step starts in front of the big tabletop on the loop
    const j = g.jumps.list.find((x) => x.def.type === 'tabletop' && x.def.height >= 2) ?? g.jumps.list[0];
    const pos = j.start.clone().addScaledVector(j.dir, -60);
    pos.y = g.terrain.heightAt(pos.x, pos.z) + 0.8;
    this.jump = { pos, yaw: Math.atan2(j.dir.x, j.dir.z) };
    this.card = document.createElement('div');
    this.card.className = 'tutorial';
    this.card.innerHTML = '<button class="tut-skip" type="button">Skip tutorial</button><div class="tut-body"></div>';
    g.hud.el.appendChild(this.card);
    this.card.querySelector('.tut-skip')!.addEventListener('click', () => this.finish(true));
    this.lastHtml = '';
    this.prevYaw = this.yaw();
    this.render();
  }

  exit() {
    this.card.remove();
  }

  restart() {
    this.step = 0;
    this.progress = 0;
    this.done = false;
    this.game.hud.hideResults();
    this.exit();
    this.enter();
  }

  /** In the trick steps, R puts you back in front of the jump. */
  recover(): boolean {
    if (this.step < 5) return false;
    this.toJump();
    return true;
  }

  private toJump() {
    this.game.player.teleport(this.jump.pos.clone(), this.jump.yaw);
  }

  private yaw() {
    const f = this.game.player.physics.forward;
    return Math.atan2(f.x, f.z);
  }

  fixedUpdate() {}

  onStunt(e: StuntEvent) {
    const id = STEPS[this.step]?.id;
    if (id === 'trick' && e.type === 'trick') this.advance();
    else if (id === 'land' && e.type === 'banked') this.advance();
    else if ((id === 'trick' || id === 'land') && e.type === 'lost') {
      this.say('Combo lost – land straight next time. Press R to go back to the jump.');
      if (id === 'land') { this.step = 5; this.progress = 0; this.render(); }
    } else if (id === 'trick' && e.type === 'landed' && e.airTime > 0.5) {
      this.say('Nice air! Now hold a trick key while you\'re up there. Press R to go again.');
    }
  }

  update(dt: number) {
    if (this.done) return;
    const g = this.game;
    const p = g.player.physics;
    const kmh = Math.abs(p.speed) * 3.6;
    const inp = g.input.drive();
    const yaw = this.yaw();
    let dy = yaw - this.prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.prevYaw = yaw;
    const s = STEPS[this.step];
    switch (s.id) {
      case 'throttle':
        if (kmh >= 30) this.progress = 1;
        else this.progress = Math.max(this.progress, kmh / 30);
        break;
      case 'steer':
        if (kmh > 8) this.progress += Math.abs(dy);
        break;
      case 'brake':
        if (kmh > 18) this.hadSpeed = true;
        if (this.hadSpeed && kmh < 4 && g.input.held('brake')) this.progress = 1;
        break;
      case 'lean':
        if (kmh > 10 && Math.abs(inp.steer) > 0.3 && Math.abs(inp.leanX) > 0.5) this.progress += dt;
        break;
      case 'pop':
        if (g.player.stunts.inAir && g.player.stunts.airTime > 0.2) this.progress = 1;
        break;
    }
    if (this.progress >= s.need && s.id !== 'trick' && s.id !== 'land') this.advance();
    this.noteT -= dt;
    this.render();
  }

  private advance() {
    const g = this.game;
    g.audioCue('tutorial');
    this.step++;
    this.progress = 0;
    this.hadSpeed = false;
    if (this.step >= STEPS.length) { this.finish(false); return; }
    if (STEPS[this.step].id === 'trick') {
      this.toJump();
      this.say('Here\'s a tabletop. Line up and go full throttle.');
    } else this.say('');
  }

  private say(text: string) {
    this.note = text;
    this.noteT = text ? 5 : 0;
  }

  private finish(skipped: boolean) {
    const g = this.game;
    this.done = true;
    const first = !g.save.data.tutorialDone;
    g.save.data.tutorialDone = true;
    g.save.save();
    this.card.remove();
    if (skipped) { g.toMenu(); return; }
    const r = modesData.tutorial;
    const currency = first ? r.currency : 0, xp = first ? r.xp : 0;
    if (first) g.addRewards(currency, xp);
    g.hud.showResults({
      title: 'Tutorial complete',
      time: 'Ready to ride',
      medal: 'gold',
      subtitle: 'Throttle, steering, lean, pops, tricks and landings – you\'ve got the basics.',
      medalTimes: [['Next', 'Try Freeride or Time Trial']],
      leaderboardTitle: 'Tips',
      leaderboard: [
        { text: 'Heavier setups rotate slower', highlight: false },
        { text: 'Powder needs momentum – lean back', highlight: false },
        { text: 'Skills unlock as your level rises', highlight: false },
      ],
      rewards: first ? [{ label: 'First-time bonus', currency, xp }] : [],
      total: { currency, xp },
      actions: [
        { label: 'Freeride', key: 'F', primary: true, run: () => g.startMode('freeride') },
        { label: 'Menu', key: 'Esc', run: () => g.toMenu() },
      ],
    });
  }

  private render() {
    if (this.done) return;
    const s = STEPS[this.step];
    const keys = this.game.input.keys;
    const caps = s.keys.map((group) => group.map((a) => (keys[a] ?? []).slice(0, 1).map((k) => `<kbd>${keyName(k)}</kbd>`).join('')).join('')).join('<i>+</i>');
    const prog = Math.min(1, this.progress / s.need);
    const dots = STEPS.map((_, i) => `<span class="${i < this.step ? 'done' : i === this.step ? 'now' : ''}"></span>`).join('');
    const html = `
      <div class="tut-top"><span class="tut-step">Step ${this.step + 1}/${STEPS.length}</span><div class="tut-dots">${dots}</div></div>
      <div class="tut-title">${s.title} <span class="tut-keys">${caps}</span></div>
      <div class="tut-text">${s.text}</div>
      <div class="tut-bar"><span style="width:${(prog * 100).toFixed(0)}%"></span></div>
      ${this.noteT > 0 && this.note ? `<div class="tut-note">${this.note}</div>` : ''}`;
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.card.querySelector('.tut-body')!.innerHTML = html;
  }
}
