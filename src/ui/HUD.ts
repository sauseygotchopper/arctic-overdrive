import { Sled } from '../vehicles/Sled';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

const THREE_smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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

/**
 * Driving HUD: zone name top-left, menu + wallet top-right, minimap with altitude and clock bottom-left, big speed
 * readout bottom-right; trick/combo feedback centred, plus the mode overlays (objective, countdown, standings,
 * results). Plain DOM.
 */
export class HUD {
  readonly el: HTMLDivElement;
  onMenu: () => void = () => {};
  private q: <T extends HTMLElement = HTMLElement>(s: string) => T;
  private toastTimer = 0;
  private bannerTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private lastSurface = '';
  private bogTime = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-tl">
        <div class="hud-zone"><span class="name">—</span><span class="dot"></span></div>
        <div class="hud-sub"><span class="hud-weight"></span><span class="hud-fps">-- fps</span></div>
      </div>
      <div class="hud-tr">
        <button class="hud-menu" type="button"><span class="burger"><i></i><i></i><i></i></span>MENU<kbd>ESC</kbd></button>
        <div class="hud-wallet"></div>
        <div class="hud-standings"></div>
        <div class="hud-wanted"><div class="stars"></div><div class="status"></div><div class="meter"><span></span></div><div class="bust"><label>BOXED IN</label><div><span></span></div></div></div>
      </div>
      <div class="hud-objective"><div class="o-title"></div><div class="o-main"></div><div class="o-sub"></div></div>
      <div class="hud-speedlines"></div>
      <div class="hud-countdown"></div>
      <div class="hud-warning"></div>
      <div class="hud-replay-tag">● REPLAY <span>V / Esc to exit</span></div>
      <div class="hud-results"></div>
      <div class="hud-combo"><div class="names"></div><div class="pts"></div><div class="pose"></div></div>
      <div class="hud-banner"></div>
      <div class="hud-toast"></div>
      <div class="hud-air"></div>
      <div class="hud-recover">Stuck or flipped? Press <kbd>R</kbd> to recover</div>
      <div class="hud-bogged"><b>Bogged down</b><span>Rock side to side <kbd>←</kbd><kbd>→</kbd>, back out <kbd>S</kbd>, or feather the throttle</span></div>
      <div class="hud-trailer">
        <div class="t-title">TRAILER <span class="t-flags"></span></div>
        <div class="t-line"></div>
        <div class="t-bar"><span></span></div>
      </div>
      <div class="hud-bl">
        <div class="hud-alt"><b>0 m</b><span class="clock">--:--</span></div>
      </div>
      <div class="hud-br">
        <div class="hud-pop"><span></span></div>
        <label>SPEED</label>
        <div class="hud-speed"><span class="val">0</span><span class="unit">KM/H</span></div>
        <div class="hud-rpm"><div class="fill"></div></div>
        <div class="hud-rpm-text">0 rpm</div>
      </div>
      <div class="hud-help">
        <b>W/S</b> throttle/brake · <b>A/D</b> steer (spin in air) · <b>Arrows</b> lean / flip · <b>Space</b> hold+release to pop ·
        <b>J K L I</b> tricks (+A/D Can-Can, Nac-Nac) · <b>C</b> camera · <b>R</b> recover · <b>Esc</b> pause<span class="help-free"> · <b>H</b> trailer · <b>G</b> load · <b>T</b> time · <b>Y</b> weather · <b>F</b> photo · <b>V</b> replay</span>
      </div>`;
    parent.appendChild(this.el);
    this.q = <T extends HTMLElement = HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.q('.hud-menu').addEventListener('click', () => this.onMenu());
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

  /** Called when a new countdown number or GO! appears (sound). */
  onCountdown?: (text: string) => void;

  setCountdown(text: string) {
    const el = this.q('.hud-countdown');
    if (el.textContent === text) return;
    el.textContent = text;
    if (text) this.onCountdown?.(text);
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

  /** Wanted level panel (null hides it). meter 0..1 is the evade/search progress; bust 0..1 the boxed-in meter. */
  setWanted(w: { stars: number; max: number; status: string; kind: 'chase' | 'evade' | 'search' | 'clear'; meter: number; bust: number } | null) {
    const el = this.q('.hud-wanted');
    el.classList.toggle('show', !!w);
    if (!w) return;
    el.dataset.kind = w.kind;
    const stars = Array.from({ length: w.max }, (_, i) => `<i class="${i < w.stars ? 'on' : ''}">★</i>`).join('');
    const st = this.q('.hud-wanted .stars');
    if (st.innerHTML !== stars) st.innerHTML = stars;
    this.q('.hud-wanted .status').textContent = w.status;
    this.q('.hud-wanted .meter').style.visibility = w.kind === 'evade' || w.kind === 'search' ? 'visible' : 'hidden';
    this.q('.hud-wanted .meter span').style.width = `${Math.round(w.meter * 100)}%`;
    const b = this.q('.hud-wanted .bust');
    b.classList.toggle('show', w.bust > 0.01);
    this.q('.hud-wanted .bust span').style.width = `${Math.round(w.bust * 100)}%`;
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
            <div class="r-row total"><span>Total</span><span>$<b class="r-count" data-to="${r.total.currency}">0</b> · <b class="r-count" data-to="${r.total.xp}">0</b> XP</span></div>
          </div>
        </div>
        <div class="r-actions">${r.actions.map((a, i) => `<button data-i="${i}" class="${a.primary ? 'primary' : ''}">${a.label} <kbd>${a.key}</kbd></button>`).join('')}</div>
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => r.actions[+b.dataset.i!].run()));
    el.classList.add('show');
    // the total counts up
    const counters = [...el.querySelectorAll<HTMLElement>('.r-count')];
    const t0 = performance.now();
    const tickUp = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      for (const c of counters) c.textContent = fmt(Number(c.dataset.to) * e);
      if (k < 1 && el.classList.contains('show')) requestAnimationFrame(tickUp);
    };
    requestAnimationFrame(tickUp);
    // land on the real numbers even if frames aren't running (background tab)
    setTimeout(() => { for (const c of counters) c.textContent = fmt(Number(c.dataset.to)); }, 950);
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
    this.q('.hud-wallet').innerHTML = `<label>CASH</label><b>$${fmt(currency)}</b><span>${fmt(xp)} XP</span>`;
  }

  setClock(text: string) {
    this.q('.hud-alt .clock').textContent = text;
  }

  update(sled: Sled, dt: number) {
    const p = sled.physics;
    const st = sled.stunts;
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    this.q('.hud-speed .val').textContent = String(kmh);
    // speed lines creep in from the edges above ~85 km/h
    const sl = THREE_smooth(kmh, 85, 140);
    const lines = this.q('.hud-speedlines');
    lines.style.opacity = (sl * 0.55).toFixed(2);
    if (sl > 0) lines.style.transform = `rotate(${(Math.random() * 4).toFixed(1)}deg) scale(${(1.05 + Math.random() * 0.04).toFixed(3)})`;
    const rpmFrac = Math.min(1, p.rpm / p.params.maxRpm);
    const fill = this.q('.hud-rpm .fill');
    fill.style.transform = `scaleX(${rpmFrac.toFixed(3)})`;
    fill.classList.toggle('redline', rpmFrac > 0.94);
    this.q('.hud-rpm-text').textContent = `${Math.round(p.rpm / 100) * 100} rpm${p.reversing ? ' · R' : ''}`;
    if (this.lastSurface !== p.surface.name) {
      this.lastSurface = p.surface.name;
      this.q('.hud-zone .name').textContent = p.surface.name;
      this.q('.hud-zone .dot').style.background = p.surface.color;
    }
    const t = sled.trailer;
    this.q('.hud-weight').textContent = `${fmt(p.params.mass)} kg${t ? ` + ${fmt(t.mass)} kg trailer` : ''}`;
    this.q('.hud-alt b').textContent = `${fmt(p.position.y + 1200)} m`;
    this.q('.hud-recover').classList.toggle('show', sled.flippedTime > 1.5);
    this.bogTime = p.bog > 0.6 && Math.abs(p.speed) < 1.5 ? this.bogTime + dt : 0;
    this.q('.hud-bogged').classList.toggle('show', this.bogTime > 0.8 && sled.flippedTime < 1.5);
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
