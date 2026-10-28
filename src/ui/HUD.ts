import { Sled } from '../vehicles/Sled';

/** Minimal driving HUD: speed, RPM, surface, objective + hints. Plain DOM, updated per frame. */
export class HUD {
  readonly el: HTMLDivElement;
  private speedEl: HTMLElement;
  private rpmFill: HTMLElement;
  private rpmText: HTMLElement;
  private surfEl: HTMLElement;
  private surfDot: HTMLElement;
  private fpsEl: HTMLElement;
  private toastEl: HTMLElement;
  private recoverEl: HTMLElement;
  private airEl: HTMLElement;
  private toastTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-tl">
        <div class="hud-surface"><span class="dot"></span><span class="name">—</span></div>
        <div class="hud-fps">-- fps</div>
      </div>
      <div class="hud-toast"></div>
      <div class="hud-air"></div>
      <div class="hud-recover">Stuck or flipped? Press <kbd>R</kbd> to recover</div>
      <div class="hud-br">
        <div class="hud-speed"><span class="val">0</span><span class="unit">km/h</span></div>
        <div class="hud-rpm"><div class="fill"></div></div>
        <div class="hud-rpm-text">0 rpm</div>
      </div>
      <div class="hud-help">
        <b>W/S</b> throttle/brake · <b>A/D</b> steer · <b>Arrows</b> lean · <b>C</b> camera · <b>T</b> time of day · <b>R</b> recover
      </div>`;
    parent.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.speedEl = q('.hud-speed .val');
    this.rpmFill = q('.hud-rpm .fill');
    this.rpmText = q('.hud-rpm-text');
    this.surfEl = q('.hud-surface .name');
    this.surfDot = q('.hud-surface .dot');
    this.fpsEl = q('.hud-fps');
    this.toastEl = q('.hud-toast');
    this.recoverEl = q('.hud-recover');
    this.airEl = q('.hud-air');
  }

  toast(text: string, seconds = 2) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTimer = seconds;
  }

  update(sled: Sled, dt: number) {
    const p = sled.physics;
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    this.speedEl.textContent = String(kmh);
    const rpmFrac = Math.min(1, p.rpm / p.params.maxRpm);
    this.rpmFill.style.transform = `scaleX(${rpmFrac.toFixed(3)})`;
    this.rpmFill.classList.toggle('redline', rpmFrac > 0.94);
    this.rpmText.textContent = `${Math.round(p.rpm / 100) * 100} rpm${p.reversing ? ' · R' : ''}`;
    if (this.surfEl.textContent !== p.surface.name) {
      this.surfEl.textContent = p.surface.name;
      this.surfDot.style.background = p.surface.color;
    }
    this.recoverEl.classList.toggle('show', sled.flippedTime > 1.5);
    this.airEl.textContent = p.groundedCount === 0 && p.airTime > 0.4 ? `AIR ${p.airTime.toFixed(1)}s` : '';

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} fps`;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }
}
