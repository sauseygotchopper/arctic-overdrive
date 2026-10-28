import { STARTER_SLED, Livery, DEFAULT_LIVERY, Tuning, DEFAULT_TUNING } from '../vehicles/SledSpec';

/** Per-sled garage state: parts bought, parts fitted (one per slot), cosmetics bought and the livery on it. */
export interface SledSave {
  parts: string[];
  installed: Record<string, string>;
  cosmetics: string[];
  livery: Livery;
  tuning: Tuning;
}

/** Versioned localStorage save. Version 2 added per-sled garages and trailer parts. */
export interface SaveData {
  version: 2;
  currency: number;
  xp: number;
  ownedSleds: string[];
  currentSled: string;
  sleds: Record<string, SledSave>;
  settings: { quality: 'low' | 'medium' | 'high'; timeOfDay: string; weather: string; camera: string };
  timeTrials: Record<string, { best: number | null; times: number[]; splits: number[]; medals: string[] }>;
  freeride: { crystals: string[]; viewpoints: string[] };
  delivery: { completed: number; jobs: Record<string, { done: number; bestPay: number; bestTime: number | null }> };
  snocross: Record<string, { best: number; wins: number; podiums: number; races: number }>;
  tutorialDone: boolean;
  trailer: { owned: boolean; upgrades: { suspension: string; skis: string; tieDowns: string }; ownedParts: string[] };
}

const KEY = 'arctic-overdrive-save';

export const newSledSave = (): SledSave => ({ parts: [], installed: {}, cosmetics: [], livery: { ...DEFAULT_LIVERY }, tuning: { ...DEFAULT_TUNING } });

export const DEFAULT_SAVE: SaveData = {
  version: 2,
  currency: 0,
  xp: 0,
  ownedSleds: [STARTER_SLED],
  currentSled: STARTER_SLED,
  sleds: { [STARTER_SLED]: newSledSave() },
  settings: { quality: 'high', timeOfDay: 'morning', weather: 'clear', camera: 'chase' },
  timeTrials: {},
  freeride: { crystals: [], viewpoints: [] },
  delivery: { completed: 0, jobs: {} },
  snocross: {},
  tutorialDone: false,
  trailer: { owned: true, upgrades: { suspension: 'stock', skis: 'stock', tieDowns: 'none' }, ownedParts: [] },
};

export class SaveSystem {
  data: SaveData;

  constructor() {
    this.data = this.load();
  }

  private load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULT_SAVE);
      return migrate(JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_SAVE);
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage full or blocked – progress just won't persist */
    }
  }
}

/** Bring any older save up to the current shape without losing progress. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrate(parsed: any): SaveData {
  const d: SaveData = {
    ...structuredClone(DEFAULT_SAVE),
    ...parsed,
    version: 2,
    settings: { ...DEFAULT_SAVE.settings, ...parsed.settings },
    freeride: { ...DEFAULT_SAVE.freeride, ...parsed.freeride },
    delivery: { ...DEFAULT_SAVE.delivery, ...parsed.delivery },
    snocross: parsed.snocross ?? {},
    trailer: {
      ...DEFAULT_SAVE.trailer, ...parsed.trailer,
      upgrades: { ...DEFAULT_SAVE.trailer.upgrades, ...parsed.trailer?.upgrades },
      ownedParts: parsed.trailer?.ownedParts ?? [],
    },
    sleds: parsed.sleds ?? {},
  };
  // v1 saves started on the crossover: keep it, and add the new starter sled
  if (!d.ownedSleds.includes(STARTER_SLED)) d.ownedSleds = [STARTER_SLED, ...d.ownedSleds];
  for (const id of d.ownedSleds) {
    d.sleds[id] = { ...newSledSave(), ...d.sleds[id] };
    d.sleds[id].tuning = { ...DEFAULT_TUNING, ...d.sleds[id].tuning };
  }
  // v1 trailer upgrades were set from the console: treat them as owned
  for (const [slot, id] of Object.entries(d.trailer.upgrades)) if (!['stock', 'none'].includes(id) && !d.trailer.ownedParts.includes(`${slot}:${id}`)) d.trailer.ownedParts.push(`${slot}:${id}`);
  delete (d as unknown as Record<string, unknown>).upgrades;
  delete (d as unknown as Record<string, unknown>).bestTimes;
  return d;
}
