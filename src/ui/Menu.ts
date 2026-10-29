import { Quality, QUALITIES } from '../core/Graphics';
import { TimeOfDay, TIMES_OF_DAY } from '../world/Sky';
import { CameraMode } from '../core/CameraRig';
import { HandlingMode, HANDLING_MODES } from '../physics/Handling';

export interface MenuHooks {
  resume(): void;
  quality(): Quality;
  setQuality(q: Quality): void;
  timeOfDay(): TimeOfDay;
  setTimeOfDay(t: TimeOfDay): void;
  dayCycle(): boolean;
  setDayCycle(on: boolean): void;
  camera(): CameraMode;
  setCamera(m: CameraMode): void;
  clock(): string;
  handling(): HandlingMode;
  setHandling(m: HandlingMode): void;
}

const CONTROLS: [string, string][] = [
  ['W / S', 'Throttle / brake'], ['A / D', 'Steer · spin in air'], ['Arrows', 'Lean · flip'], ['Space', 'Hold + release to pop'],
  ['J K L I', 'Tricks'], ['H', 'Hitch trailer'], ['G', 'Cycle load'], ['C', 'Camera'], ['T', 'Time of day'], ['N', 'Day/night cycle'], ['R', 'Recover'],
];

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Pause menu: resume card, graphics preset, time of day + cycle toggle, camera, controls. */
export class Menu {
  readonly el: HTMLDivElement;
  private open = false;

  constructor(parent: HTMLElement, private hooks: MenuHooks) {
    this.el = document.createElement('div');
    this.el.className = 'menu';
    const seg = (name: string, items: readonly string[]) =>
      `<div class="seg" data-seg="${name}">${items.map((i) => `<button type="button" data-v="${i}">${label(i)}</button>`).join('')}</div>`;
    this.el.innerHTML = `
      <div class="menu-col">
        <div class="menu-title">Paused</div>
        <button class="menu-resume" type="button"><span>Resume</span><kbd>ESC</kbd><i>↗</i></button>
        <section class="card">
          <h3>Handling <small class="menu-handling-note"></small></h3>
          ${seg('handling', HANDLING_MODES)}
        </section>
        <section class="card">
          <h3>Graphics <small>reloads the game</small></h3>
          ${seg('quality', QUALITIES)}
        </section>
        <section class="card">
          <h3>Time of day <small class="menu-clock"></small></h3>
          ${seg('tod', TIMES_OF_DAY)}
          <label class="switch"><input type="checkbox" class="cycle" /><span class="track"><span class="knob"></span></span>Day/night cycle</label>
        </section>
        <section class="card">
          <h3>Camera</h3>
          ${seg('camera', ['chase', 'far', 'hood'])}
        </section>
        <section class="card controls">
          <h3>Controls</h3>
          <div class="keys">${CONTROLS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div>
        </section>
      </div>`;
    parent.appendChild(this.el);
    this.el.querySelector('.menu-resume')!.addEventListener('click', () => hooks.resume());
    this.el.querySelectorAll<HTMLElement>('.seg').forEach((s) => {
      s.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b) return;
        const v = b.dataset.v!;
        if (s.dataset.seg === 'quality') hooks.setQuality(v as Quality);
        else if (s.dataset.seg === 'tod') hooks.setTimeOfDay(v as TimeOfDay);
        else if (s.dataset.seg === 'handling') hooks.setHandling(v as HandlingMode);
        else hooks.setCamera(v as CameraMode);
        this.refresh();
      });
    });
    const cycle = this.el.querySelector<HTMLInputElement>('.cycle')!;
    cycle.addEventListener('change', () => { hooks.setDayCycle(cycle.checked); this.refresh(); });
  }

  get visible() { return this.open; }

  show(on: boolean) {
    this.open = on;
    this.el.classList.toggle('show', on);
    if (on) this.refresh();
  }

  private refresh() {
    const h = this.hooks;
    const mark = (seg: string, v: string) =>
      this.el.querySelectorAll<HTMLElement>(`[data-seg="${seg}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    mark('quality', h.quality());
    mark('tod', h.dayCycle() ? '' : h.timeOfDay());
    mark('camera', h.camera());
    mark('handling', h.handling());
    this.el.querySelector('.menu-handling-note')!.textContent =
      h.handling() === 'realistic' ? 'grip, bogging, clutch, crust' : 'original tuning, +15% gravity';
    this.el.querySelector<HTMLInputElement>('.cycle')!.checked = h.dayCycle();
    this.el.querySelector('.menu-clock')!.textContent = h.clock();
  }
}
