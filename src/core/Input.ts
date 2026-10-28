import { DriveInput } from '../vehicles/SledPhysics';
import { TrickControls } from '../vehicles/Tricks';

export type Action =
  | 'throttle' | 'brake' | 'steerLeft' | 'steerRight'
  | 'leanLeft' | 'leanRight' | 'leanForward' | 'leanBack'
  | 'jump' | 'trick1' | 'trick2' | 'trick3' | 'trick4'
  | 'camera' | 'reset' | 'pause' | 'timeOfDay' | 'dayCycle' | 'photo' | 'hitch' | 'cargo' | 'weather' | 'replay';

export const DEFAULT_KEYS: Record<Action, string[]> = {
  throttle: ['KeyW'],
  brake: ['KeyS'],
  steerLeft: ['KeyA'],
  steerRight: ['KeyD'],
  leanLeft: ['ArrowLeft'],
  leanRight: ['ArrowRight'],
  leanForward: ['ArrowUp'],
  leanBack: ['ArrowDown'],
  jump: ['Space'],
  trick1: ['KeyJ'],
  trick2: ['KeyK'],
  trick3: ['KeyL'],
  trick4: ['KeyI'],
  camera: ['KeyC'],
  reset: ['KeyR'],
  pause: ['Escape', 'KeyP'],
  timeOfDay: ['KeyT'],
  dayCycle: ['KeyN'],
  photo: ['KeyF'],
  hitch: ['KeyH'],
  cargo: ['KeyG'],
  weather: ['KeyY'],
  replay: ['KeyV'],
};

// Standard Gamepad mapping button indices
const PAD_BUTTONS: Partial<Record<Action, number[]>> = {
  jump: [0], trick1: [2], trick2: [3], trick3: [1], trick4: [5],
  camera: [8], reset: [4], pause: [9], timeOfDay: [12], photo: [13], hitch: [14], cargo: [15], replay: [10], weather: [11],
};

/** Keyboard + Gamepad input mapped to actions. Bindings are data so the settings screen can remap them. */
export class Input {
  keys: Record<Action, string[]> = structuredClone(DEFAULT_KEYS);
  private down = new Set<string>();
  private pressedThisFrame = new Set<Action>();
  private prevPad = new Map<string, boolean>();
  padConnected = false;
  private pad: Gamepad | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      for (const a of Object.keys(this.keys) as Action[]) if (this.keys[a].includes(e.code)) this.pressedThisFrame.add(a);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  /** Poll gamepads; call once per rendered frame before reading. */
  update() {
    const pads = navigator.getGamepads?.() ?? [];
    this.pad = null;
    for (const p of pads) if (p && p.connected) { this.pad = p; break; }
    this.padConnected = !!this.pad;
    if (!this.pad) return;
    for (const [a, idxs] of Object.entries(PAD_BUTTONS) as [Action, number[]][]) {
      for (const i of idxs) {
        const now = !!this.pad.buttons[i]?.pressed;
        const key = `${a}:${i}`;
        if (now && !this.prevPad.get(key)) this.pressedThisFrame.add(a);
        this.prevPad.set(key, now);
      }
    }
  }

  /** Actions pressed since the last call (edge-triggered). */
  consumePressed(a: Action): boolean {
    const had = this.pressedThisFrame.has(a);
    this.pressedThisFrame.delete(a);
    return had;
  }

  endFrame() {
    this.pressedThisFrame.clear();
  }

  isKeyDown(code: string): boolean {
    return this.down.has(code);
  }

  held(a: Action): boolean {
    if (this.keys[a].some((k) => this.down.has(k))) return true;
    const idx = PAD_BUTTONS[a];
    return !!(this.pad && idx?.some((i) => this.pad!.buttons[i]?.pressed));
  }

  private axis(neg: Action, pos: Action): number {
    return (this.held(pos) ? 1 : 0) - (this.held(neg) ? 1 : 0);
  }

  tricks(steer: number, leanX: number, leanZ: number): TrickControls {
    return {
      jumpHeld: this.held('jump'),
      buttons: { trick1: this.held('trick1'), trick2: this.held('trick2'), trick3: this.held('trick3'), trick4: this.held('trick4') },
      steer, leanX, leanZ,
    };
  }

  drive(): DriveInput {
    let throttle = this.held('throttle') ? 1 : 0;
    let brake = this.held('brake') ? 1 : 0;
    let steer = this.axis('steerLeft', 'steerRight');
    let leanX = this.axis('leanLeft', 'leanRight');
    let leanZ = this.axis('leanBack', 'leanForward');
    const p = this.pad;
    if (p) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      throttle = Math.max(throttle, p.buttons[7]?.value ?? 0);
      brake = Math.max(brake, p.buttons[6]?.value ?? 0);
      if (steer === 0) steer = dz(p.axes[0] ?? 0);
      if (leanX === 0) leanX = dz(p.axes[2] ?? 0);
      if (leanZ === 0) leanZ = -dz(p.axes[3] ?? 0);
    }
    return { throttle, brake, steer, leanX, leanZ };
  }
}
