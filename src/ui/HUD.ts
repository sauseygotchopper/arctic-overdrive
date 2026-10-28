import { Sled } from '../vehicles/Sled';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export interface ResultsData {
  title: string;
  time: string;
  medal: 'gold' | 'silver' | 'bronze' | null;
  subtitle: string;
  medalTimes: [string, string][];
  leaderboard: { text: string; highlight: boolean }[];
  /** Heading over the leaderboard column (default "Personal bests"). */
  leaderboardTitle?: string;
  rewards: { label: string; currency: number; xp: number }[];
  total: { currency: number; xp: number };
  actions: { label: string; key: string; primary?: boolean; run: () => void }[];
}

/** Driving HUD: speed, RPM, surface, weight, trailer, tricks/combo, wallet. Plain DOM, updated per frame. */
export class HUD {
  readonly el: HTMLDivElement;
  private q: <T extends HTMLElement = HTMLElement>(s: string) => T;
  private toastTimer = 0;
  private bannerTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private lastSurface = '';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-tl">
        <div class="hud-surface"><span class="dot"></span><span class="name">—</span></div>
        <div class="hud-weight"></div>
        <div class="hud-fps">-- fps</div>
      </div>
      <div class="hud-tr"><div class="hud-wallet"></div><div class="hud-standings"></div></div>
      <div class="hud-objective"><div class="o-title"></div><div class="o-main"></div><div class="o-sub"></div></div>
      <div class="hud-countdown"></div>
      <div class="hud-warning"></div>
      <div class="hud-replay-tag">● REPLAY <span>V / Esc to exit</span></div>
      <div class="hud-results"></div>
      <div class="hud-combo"><div class="names"></div><div class="pts"></div><div class="pose"></div></div>
      <div class="hud-banner"></div>
      <div class="hud-toast"></div>
      <div class="hud-air"></div>
      <div class="hud-recover">Stuck or flipped? Press <kbd>R</kbd> to recover</div>
      <div class="hud-trailer">
        <div class="t-title">TRAILER <span class="t-flags"></span></div>
        <div class="t-line"></div>
        <div class="t-bar"><span></span></div>
      </div>
      <div class="hud-br">
        <div class="hud-pop"><span></span></div>
        <div class="hud-speed"><span class="val">0</span><span class="unit">km/h</span></div>
        <div class="hud-rpm"><div class="fill"></div></div>
        <div class="hud-rpm-text">0 rpm</div>
      </div>
      <div class="hud-help">
        <b>W/S</b> throttle/brake · <b>A/D</b> steer (spin in air) · <b>Arrows</b> lean / flip · <b>Space</b> hold+release to pop ·
        <b>J K L I</b> tricks (+A/D Can-Can, Nac-Nac) · <b>C</b> camera · <b>R</b> recover · <b>Esc</b> pause<span class="help-free"> · <b>H</b> trailer · <b>G</b> load · <b>T</b> time · <b>Y</b> weather · <b>F</b> photo · <b>V</b> replay</span>
      </div>`;
    parent.appendChild(this.el);
    this.q = <T extends HTMLElement = HTMLElement>(s: string) => this.el.querySelector(s) as T;
  }

  toast(text: string, seconds = 2) {
    const t = this.q('.hud-toast');
    t.textContent = text;
    t.classList.add('show');
    this.toastTimer = seconds;
  }

  /** Big centred result line (landing quality, banked points, warnings). */
  banner(text: string, kind: 'good' | 'warn' | 'bad' | 'info' = 'info', seconds = 1.8) {
    const b = this.q('.hud-banner');
    b.textContent = text;
    b.className = `hud-banner show ${kind}`;
    this.bannerTimer = seconds;
  }

  setObjective(o: { title: string; main: string; sub: string } | null) {
    const el = this.q('.hud-objective');
    el.classList.toggle('show', !!o);
    if (!o) return;
    this.q('.hud-objective .o-title').textContent = o.title;
    this.q('.hud-objective .o-main').textContent = o.main;
    const sub = this.q('.hud-objective .o-sub');
    if (sub.innerHTML !== o.sub) sub.innerHTML = o.sub;
  }

  setCountdown(text: string) {
    const el = this.q('.hud-countdown');
    if (el.textContent === text) return;
    el.textContent = text;
    el.classList.remove('pop');
    void el.offsetWidth; // restart the pop animation
    if (text) el.classList.add('pop');
  }

  setWarning(text: string) {
    const el = this.q('.hud-warning');
    el.textContent = text;
    el.classList.toggle('show', !!text);
  }

  /** Race standings list (null hides it). */
  setStandings(rows: { text: string; gap: string; me: boolean }[] | null) {
    const el = this.q('.hud-standings');
    el.classList.toggle('show', !!rows);
    if (!rows) return;
    const html = rows.map((r) => `<div class="${r.me ? 'me' : ''}"><span>${r.text}</span><span>${r.gap}</span></div>`).join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  setFreerideHelp(on: boolean) {
    this.el.classList.toggle('freeride', on);
  }

  private resultsKeys: ((e: KeyboardEvent) => void) | null = null;

  showResults(r: ResultsData) {
    const el = this.q('.hud-results');
    const medal = r.medal ? `<div class="r-medal"><span class="medal big ${r.medal}"></span>${r.medal.toUpperCase()}</div>` : '<div class="r-medal none">No medal</div>';
    el.innerHTML = `
      <div class="r-card">
        <div class="r-title">${r.title}</div>
        <div class="r-time">${r.time}</div>
        ${medal}
        <div class="r-sub">${r.subtitle}</div>
        <div class="r-cols">
          <div>
            <div class="r-h">${r.leaderboardTitle ?? 'Personal bests'}</div>
            ${r.leaderboard.map((l, i) => `<div class="r-row ${l.highlight ? 'hl' : ''}"><span>${i + 1}</span><span>${l.text}</span></div>`).join('')}
            ${r.medalTimes.length ? `<div class="r-h">Targets</div>${r.medalTimes.map(([m, t]) => `<div class="r-row"><span>${m}</span><span>${t}</span></div>`).join('')}` : ''}
          </div>
          <div>
            <div class="r-h">Rewards</div>
            ${r.rewards.map((w) => `<div class="r-row"><span>${w.label}</span><span>$${fmt(w.currency)} · ${fmt(w.xp)} XP</span></div>`).join('')}
            <div class="r-row total"><span>Total</span><span>$${fmt(r.total.currency)} · ${fmt(r.total.xp)} XP</span></div>
          </div>
        </div>
        <div class="r-actions">${r.actions.map((a, i) => `<button data-i="${i}" class="${a.primary ? 'primary' : ''}">${a.label} <kbd>${a.key}</kbd></button>`).join('')}</div>
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => r.actions[+b.dataset.i!].run()));
    el.classList.add('show');
    if (this.resultsKeys) window.removeEventListener('keydown', this.resultsKeys);
    this.resultsKeys = (e) => {
      const key = e.code === 'Escape' ? 'Esc' : e.code.replace('Key', '');
      const a = r.actions.find((x) => x.key === key);
      if (a) { e.stopImmediatePropagation(); a.run(); }
    };
    window.addEventListener('keydown', this.resultsKeys, true);
  }

  hideResults() {
    this.q('.hud-results').classList.remove('show');
    if (this.resultsKeys) window.removeEventListener('keydown', this.resultsKeys, true);
    this.resultsKeys = null;
  }

  get resultsOpen() {
    return this.q('.hud-results').classList.contains('show');
  }

  setWallet(currency: number, xp: number) {
    this.q('.hud-wallet').innerHTML = `<b>$${fmt(currency)}</b><span>${fmt(xp)} XP</span>`;
  }

  update(sled: Sled, dt: number) {
    const p = sled.physics;
    const st = sled.stunts;
    this.q('.hud-speed .val').textContent = String(Math.round(Math.abs(p.speed) * 3.6));
    const rpmFrac = Math.min(1, p.rpm / p.params.maxRpm);
    const fill = this.q('.hud-rpm .fill');
    fill.style.transform = `scaleX(${rpmFrac.toFixed(3)})`;
    fill.classList.toggle('redline', rpmFrac > 0.94);
    this.q('.hud-rpm-text').textContent = `${Math.round(p.rpm / 100) * 100} rpm${p.reversing ? ' · R' : ''}`;
    if (this.lastSurface !== p.surface.name) {
      this.lastSurface = p.surface.name;
      this.q('.hud-surface .name').textContent = p.surface.name;
      this.q('.hud-surface .dot').style.background = p.surface.color;
    }
    const t = sled.trailer;
    this.q('.hud-weight').textContent = `${fmt(p.params.mass)} kg${t ? ` + trailer ${fmt(t.mass)} kg` : ''}`;
    this.q('.hud-recover').classList.toggle('show', sled.flippedTime > 1.5);
    this.q('.hud-air').textContent = st.inAir && st.airTime > 0.4 ? `AIR ${st.airTime.toFixed(1)}s` : '';
    const pop = this.q('.hud-pop');
    pop.classList.toggle('show', st.rider.crouch > 0.02);
    (pop.firstElementChild as HTMLElement).style.transform = `scaleX(${st.rider.crouch.toFixed(2)})`;

    // combo feed
    const combo = this.q('.hud-combo');
    const active = st.combo.length > 0 || st.rider.pose;
    combo.classList.toggle('show', !!active);
    if (active) {
      this.q('.hud-combo .names').textContent = st.combo.map((c) => c.name).join(' + ');
      this.q('.hud-combo .pts').textContent = st.combo.length ? `${fmt(st.comboPoints)} × ${st.multiplier}` : '';
      const poseName = st.rider.pose && st.rider.poseAmount > 0.5 ? st.rider.pose.replace(/([A-Z])/g, ' $1').toUpperCase() : '';
      this.q('.hud-combo .pose').textContent = poseName;
    }

    // trailer panel
    const tp = this.q('.hud-trailer');
    tp.classList.toggle('show', !!t);
    if (t) {
      const fragile = t.cargo.filter((c) => c.def.fragile);
      const health = fragile.length ? fragile.reduce((a, c) => a + c.health, 0) / fragile.length : 1;
      this.q('.hud-trailer .t-line').textContent = t.cargo.length
        ? `${t.cargo.length} item${t.cargo.length > 1 ? 's' : ''} · ${fmt(t.payloadMass)} kg${fragile.length ? ` · fragile ${Math.round(health * 100)}%` : ''}`
        : 'Empty';
      const bar = this.q('.hud-trailer .t-bar span');
      bar.style.transform = `scaleX(${health.toFixed(3)})`;
      bar.classList.toggle('low', health < 0.5);
      const yawDeg = Math.round(Math.abs(t.hitchYaw) * 57.3);
      const flags = [t.flipped ? 'FLIPPED' : '', t.jackknifed ? 'JACKKNIFE' : yawDeg > 45 ? `SWING ${yawDeg}°` : ''].filter(Boolean).join(' · ');
      this.q('.hud-trailer .t-flags').textContent = flags;
    }

    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) this.q('.hud-toast').classList.remove('show');
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) this.q('.hud-banner').classList.remove('show');
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.q('.hud-fps').textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} fps`;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }
}
