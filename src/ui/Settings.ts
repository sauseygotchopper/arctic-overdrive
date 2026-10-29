import { Quality, QUALITIES } from '../core/Graphics';
import { TimeOfDay, TIMES_OF_DAY } from '../world/Sky';
import { CameraMode } from '../core/CameraRig';
import { HandlingMode, HANDLING_MODES, HANDLING } from '../physics/Handling';

export interface SettingsHooks {
  /** Back out of the panel (the opener decides where that lands). */
  back(): void;
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
  ['J K L I', 'Tricks'], ['H', 'Hitch trailer'], ['G', 'Cycle load'], ['C', 'Camera'], ['T', 'Time of day'], ['N', 'Day/night cycle'], ['Y', 'Weather'], ['F', 'Photo mode'], ['V', 'Replay'], ['R', 'Recover'], ['Esc', 'Pause'],
];

const HANDLING_NOTES: Record<HandlingMode, string> = {
  realistic: 'Planted rear, bogging, clutch & engine braking, wind crust',
  arcade: 'Original loose tuning, +15% gravity',
};

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Settings panel: handling model, graphics preset, time of day + cycle toggle, camera, controls. Opened from the title, the mode menu and the pause card. */
export class SettingsMenu {
  readonly el: HTMLDivElement;
  private open = false;

  constructor(parent: HTMLElement, private hooks: SettingsHooks) {
    this.el = document.createElement('div');
    this.el.className = 'settings';
    const seg = (name: string, items: readonly string[]) =>
      `<div class="set-seg" data-seg="${name}">${items.map((i) => `<button type="button" data-v="${i}">${label(i)}</button>`).join('')}</div>`;
    this.el.innerHTML = `
      <div class="set-col">
        <div class="set-title">Settings</div>
        <button class="set-back" type="button"><span>Back</span><kbd>ESC</kbd><i>↩</i></button>
        <section class="set-card">
          <h3>Handling model <small>applies instantly</small></h3>
          <div class="set-seg set-tiles" data-seg="handling">${HANDLING_MODES.map((m) =>
            `<button type="button" data-v="${m}"><b>${HANDLING[m].label}</b><small>${HANDLING_NOTES[m]}</small></button>`).join('')}</div>
        </section>
        <section class="set-card">
          <h3>Graphics <small>reloads the game</small></h3>
          ${seg('quality', QUALITIES)}
        </section>
        <section class="set-card">
          <h3>Time of day <small class="set-clock"></small></h3>
          ${seg('tod', TIMES_OF_DAY)}
          <label class="switch"><input type="checkbox" class="cycle" /><span class="track"><span class="knob"></span></span>Day/night cycle</label>
        </section>
        <section class="set-card">
          <h3>Camera</h3>
          ${seg('camera', ['chase', 'far', 'hood'])}
        </section>
        <section class="set-card controls">
          <h3>Controls</h3>
          <div class="keys">${CONTROLS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div>
        </section>
      </div>`;
    parent.appendChild(this.el);
    this.el.querySelector('.set-back')!.addEventListener('click', () => hooks.back());
    this.el.querySelectorAll<HTMLElement>('.set-seg').forEach((s) => {
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
    this.el.querySelector<HTMLInputElement>('.cycle')!.checked = h.dayCycle();
    this.el.querySelector('.set-clock')!.textContent = h.clock();
  }
}
