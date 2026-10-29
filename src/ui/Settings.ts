import { Quality, QUALITIES } from '../core/Graphics';
import { TimeOfDay, TIMES_OF_DAY } from '../world/Sky';
import { CameraMode } from '../core/CameraRig';
import { HandlingMode, HANDLING_MODES, HANDLING } from '../physics/Handling';
import type { Volumes } from '../audio/AudioSystem';
import { Action, DEFAULT_KEYS } from '../core/Input';

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
  volumes(): Volumes;
  setVolumes(v: Volumes): void;
  keys(): Record<Action, string[]>;
  setKeys(k: Record<Action, string[]>): void;
}

/** Remappable actions in the order the controls list shows them. */
const REMAP: [Action, string][] = [
  ['throttle', 'Throttle'], ['brake', 'Brake / reverse'], ['steerLeft', 'Steer left'], ['steerRight', 'Steer right'],
  ['leanLeft', 'Lean left'], ['leanRight', 'Lean right'], ['leanForward', 'Lean forward'], ['leanBack', 'Lean back'],
  ['jump', 'Pop (hold, release)'], ['trick1', 'Trick 1'], ['trick2', 'Trick 2'], ['trick3', 'Trick 3'], ['trick4', 'Trick 4'],
  ['camera', 'Camera'], ['reset', 'Recover'], ['hitch', 'Hitch trailer'], ['cargo', 'Cycle load'], ['timeOfDay', 'Time of day'],
  ['dayCycle', 'Day/night cycle'], ['weather', 'Weather'], ['photo', 'Photo mode'], ['replay', 'Replay'],
];

const VOLUMES: [keyof Omit<Volumes, 'muted'>, string][] = [['master', 'Master'], ['engine', 'Engine'], ['effects', 'Effects'], ['ambient', 'Wind & ambience'], ['ui', 'Menus']];

/** Readable key name for a KeyboardEvent.code. */
export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt', Enter: 'Enter', Tab: 'Tab', Backspace: '⌫', Escape: 'Esc' };
  return map[code] ?? code.replace(/^Numpad/, 'Num ');
}

const HANDLING_NOTES: Record<HandlingMode, string> = {
  realistic: 'Planted rear, bogging, clutch & engine braking, wind crust',
  arcade: 'Original loose tuning, +15% gravity',
};

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Settings panel: handling model, graphics preset, time of day + cycle toggle, camera, audio volumes, key remapping. Opened from the title, the mode menu and the pause card. */
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
        <section class="set-card audio">
          <h3>Audio <label class="mute"><input type="checkbox" class="muted" /> Mute</label></h3>
          ${VOLUMES.map(([k, n]) => `<label class="vol"><span>${n}</span><input type="range" min="0" max="100" step="1" data-vol="${k}" /><b data-vol-val="${k}"></b></label>`).join('')}
        </section>
        <section class="set-card controls">
          <h3>Controls <small>click a key to rebind · Esc cancels</small></h3>
          <div class="keys">${REMAP.map(([a, n]) => `<span>${n}</span><button type="button" class="rebind" data-action="${a}"></button>`).join('')}</div>
          <div class="keys-foot"><span>Esc / P pause · gamepad: triggers throttle/brake, sticks steer & lean, A pop</span><button type="button" class="keys-reset">Reset to defaults</button></div>
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
    this.el.querySelectorAll<HTMLInputElement>('[data-vol]').forEach((r) => r.addEventListener('input', () => {
      hooks.setVolumes({ ...hooks.volumes(), [r.dataset.vol!]: Number(r.value) / 100 });
      this.refresh();
    }));
    this.el.querySelector<HTMLInputElement>('.muted')!.addEventListener('change', (e) => {
      hooks.setVolumes({ ...hooks.volumes(), muted: (e.target as HTMLInputElement).checked });
    });
    this.el.querySelectorAll<HTMLButtonElement>('.rebind').forEach((b) => b.addEventListener('click', () => this.capture(b)));
    this.el.querySelector('.keys-reset')!.addEventListener('click', () => {
      hooks.setKeys(structuredClone(DEFAULT_KEYS));
      this.refresh();
    });
    const cycle = this.el.querySelector<HTMLInputElement>('.cycle')!;
    cycle.addEventListener('change', () => { hooks.setDayCycle(cycle.checked); this.refresh(); });
  }

  get visible() { return this.open; }

  /** True while waiting for a key to bind (Esc then cancels instead of closing the panel). */
  capturing = false;

  /** Wait for the next key and bind it to the button's action; a key already in use swaps over. */
  private capture(b: HTMLButtonElement) {
    if (this.capturing) return;
    this.capturing = true;
    b.classList.add('wait');
    b.textContent = 'Press a key…';
    const action = b.dataset.action as Action;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.removeEventListener('keydown', onKey, true);
      setTimeout(() => { this.capturing = false; }, 0);
      b.classList.remove('wait');
      if (e.code !== 'Escape' && e.code !== 'KeyP') {
        const keys = structuredClone(this.hooks.keys());
        const old = keys[action][0];
        for (const a of Object.keys(keys) as Action[]) {
          if (a !== action && keys[a].includes(e.code)) keys[a] = keys[a].map((k) => (k === e.code ? old : k)).filter(Boolean);
        }
        keys[action] = [e.code];
        this.hooks.setKeys(keys);
      }
      this.refresh();
    };
    window.addEventListener('keydown', onKey, true);
  }

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
    const v = h.volumes();
    this.el.querySelectorAll<HTMLInputElement>('[data-vol]').forEach((r) => {
      const k = r.dataset.vol as keyof Omit<Volumes, 'muted'>;
      r.value = String(Math.round(v[k] * 100));
      this.el.querySelector(`[data-vol-val="${k}"]`)!.textContent = `${Math.round(v[k] * 100)}`;
    });
    this.el.querySelector<HTMLInputElement>('.muted')!.checked = v.muted;
    const keys = h.keys();
    this.el.querySelectorAll<HTMLButtonElement>('.rebind:not(.wait)').forEach((b) => {
      b.textContent = (keys[b.dataset.action as Action] ?? []).map(keyName).join(' / ') || '—';
    });
  }
}
