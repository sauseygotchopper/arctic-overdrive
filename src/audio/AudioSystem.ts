import audioData from '../data/audio.json';

export interface Volumes { master: number; engine: number; effects: number; ambient: number; ui: number; muted: boolean }

/** What the player's sled is doing this frame (null = nothing driving: menus, garage, pause). */
export interface SledSound {
  rpm: number;
  idleRpm: number;
  maxRpm: number;
  throttle: number;
  speed: number; // m/s
  surface: string;
  grounded: boolean;
  /** 0..1 how much of the engine to hear (menus idle quietly). */
  presence: number;
}

/** Something positional relative to the listener: distance (m) and pan (-1 left .. 1 right). */
export interface Positional { dist: number; pan: number }

type Bus = 'engine' | 'effects' | 'ambient' | 'ui';
type SampleDef = { file: string; bus: Bus; gain: number };
type Loop = { src: AudioBufferSourceNode; gain: GainNode; pan?: StereoPannerNode };

/**
 * Sample-based audio. Every sound is a recording listed in audio.json and served from public/audio/;
 * a file that isn't there is simply silent, so the game runs fine with none at all. The engine loop is
 * pitched by rpm (playbackRate relative to the rpm it was recorded at), snow loops crossfade by surface,
 * wind rises with speed, and the chase adds a panned siren and rotor. Buses: engine, effects, ambient, ui.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: Record<Bus, GainNode>;
  private buffers = new Map<string, AudioBuffer | null>();
  private loops = new Map<string, Loop>();
  private lastHover = 0;

  constructor(private volumes: Volumes) {
    // browsers only allow audio after a user gesture
    const start = () => this.start();
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  private start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const mk = () => { const g = ctx.createGain(); g.connect(this.master); return g; };
    this.bus = { engine: mk(), effects: mk(), ambient: mk(), ui: mk() };
    this.applyVolumes();
    for (const name of Object.keys(audioData.samples)) void this.load(name);
  }

  private get samples() { return audioData.samples as Record<string, SampleDef>; }

  /** Fetch and decode a sample once; missing or undecodable files are remembered as silent. */
  private async load(name: string) {
    if (this.buffers.has(name) || !this.ctx) return;
    this.buffers.set(name, null);
    const def = this.samples[name];
    if (!def) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}audio/${def.file}`);
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio')) return;
      this.buffers.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()));
    } catch {
      // no file: stays silent
    }
  }

  setVolumes(v: Volumes) {
    this.volumes = v;
    this.applyVolumes();
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const v = this.volumes;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(v.muted ? 0 : v.master, t, 0.05);
    for (const b of ['engine', 'effects', 'ambient', 'ui'] as Bus[]) this.bus[b].gain.setTargetAtTime(v[b], t, 0.05);
  }

  /** A looping sample, started on first use (null while its file is missing). */
  private loop(name: string, panned = false): Loop | null {
    const have = this.loops.get(name);
    if (have) return have;
    const buf = this.buffers.get(name);
    if (!buf || !this.ctx) return null;
    const def = this.samples[name];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    let out: AudioNode = gain;
    let pan: StereoPannerNode | undefined;
    if (panned) { pan = this.ctx.createStereoPanner(); gain.connect(pan); out = pan; }
    src.connect(gain);
    out.connect(this.bus[def.bus]);
    src.start(0, Math.random() * buf.duration);
    const l = { src, gain, pan };
    this.loops.set(name, l);
    return l;
  }

  private setLoop(name: string, level: number, rate = 1, pan?: number) {
    const l = level > 0.001 ? this.loop(name, pan !== undefined) : this.loops.get(name);
    if (!l || !this.ctx) return;
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime(level * this.samples[name].gain, t, 0.08);
    l.src.playbackRate.setTargetAtTime(rate, t, 0.05);
    if (l.pan && pan !== undefined) l.pan.pan.setTargetAtTime(pan, t, 0.1);
  }

  /** One-shot sample. */
  private play(name: string, level = 1, rate = 1) {
    const buf = this.buffers.get(name);
    if (!buf || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = level * this.samples[name].gain;
    src.connect(g).connect(this.bus[this.samples[name].bus]);
    src.start();
  }

  /** Per rendered frame. */
  update(_dt: number, s: SledSound | null) {
    if (!this.ctx) return;
    const A = audioData;
    if (!s) {
      for (const name of ['engine', 'wind', ...Object.keys(A.surfaceLoops).map((k) => A.surfaceLoops[k as keyof typeof A.surfaceLoops])]) this.setLoop(name, 0);
      return;
    }
    // engine: one loop recorded at engineRecordedRpm, pitched to the current rpm
    const rpm = Math.max(s.idleRpm * 0.9, s.rpm);
    const r = Math.min(1, (rpm - s.idleRpm) / Math.max(1, s.maxRpm - s.idleRpm));
    this.setLoop('engine', (0.35 + r * 0.35 + s.throttle * 0.3) * s.presence, Math.min(2.5, Math.max(0.35, rpm / A.engineRecordedRpm)));
    // snow under the track: the current surface's loop, louder with speed
    const level = s.grounded ? Math.sqrt(Math.min(1, s.speed / 25)) * s.presence : 0;
    for (const [surf, name] of Object.entries(A.surfaceLoops)) this.setLoop(name, surf === s.surface ? level : 0, 0.8 + Math.min(1, s.speed / 30) * 0.4);
    // wind with the square of speed
    const w = Math.min(1, Math.max(0, (s.speed - 4) / 32));
    this.setLoop('wind', w * w * (s.grounded ? 1 : 1.3) * s.presence);
  }

  /** Landing thump scaled by impact (m/s). */
  land(impact: number, crash: boolean) {
    if (impact < 1.5) return;
    this.play(crash ? 'crash' : 'land', Math.min(1, 0.3 + impact / 12), 0.9 + Math.random() * 0.2);
  }

  /** Named one-shot (UI and mode events); silent without its sample. */
  cue(name: string) {
    if (!this.ctx) return;
    if (name === 'hover') {
      if (this.ctx.currentTime - this.lastHover < 0.06) return;
      this.lastHover = this.ctx.currentTime;
    }
    this.play(name);
  }

  /** Chase audio for Special Delivery: nearest agent's siren and the helicopter (null = off). */
  setChase(siren: Positional | null, heli: Positional | null) {
    if (!this.ctx) return;
    const C = audioData.chase;
    this.setLoop('siren', siren ? 1 / (1 + siren.dist / C.sirenFalloff) : 0, 1, siren ? siren.pan * 0.8 : 0);
    this.setLoop('helicopter', heli ? 1 / (1 + heli.dist / C.rotorFalloff) : 0, 1, heli ? heli.pan * 0.7 : 0);
  }
}
