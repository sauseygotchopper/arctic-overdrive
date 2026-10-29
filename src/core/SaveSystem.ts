import type { Quality } from './Graphics';
import type { HandlingMode } from '../physics/Handling';

/** Versioned localStorage save. Phase 4 fills in currency/garage; the shape is fixed now. */
export interface SaveData {
  version: 1;
  currency: number;
  xp: number;
  ownedSleds: string[];
  currentSled: string;
  upgrades: Record<string, string[]>;
  bestTimes: Record<string, number>;
  settings: { quality: Quality; timeOfDay: string; camera: string; dayCycle: boolean; handling: HandlingMode };
  tutorialDone: boolean;
  trailer: { owned: boolean; upgrades: { suspension: string; skis: string; tieDowns: string } };
}

const KEY = 'arctic-overdrive-save';

export const DEFAULT_SAVE: SaveData = {
  version: 1,
  currency: 0,
  xp: 0,
  ownedSleds: ['ravik-crossfire-850'],
  currentSled: 'ravik-crossfire-850',
  upgrades: {},
  bestTimes: {},
  settings: { quality: 'high', timeOfDay: 'morning', camera: 'chase', dayCycle: false, handling: 'realistic' },
  tutorialDone: false,
  trailer: { owned: true, upgrades: { suspension: 'stock', skis: 'stock', tieDowns: 'none' } },
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
      const parsed = JSON.parse(raw);
      return {
        ...structuredClone(DEFAULT_SAVE), ...parsed,
        settings: { ...DEFAULT_SAVE.settings, ...parsed.settings },
        trailer: { ...DEFAULT_SAVE.trailer, ...parsed.trailer, upgrades: { ...DEFAULT_SAVE.trailer.upgrades, ...parsed.trailer?.upgrades } },
      };
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
