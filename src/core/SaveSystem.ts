/** Versioned localStorage save. Phase 4 fills in currency/garage; the shape is fixed now. */
export interface SaveData {
  version: 1;
  currency: number;
  xp: number;
  ownedSleds: string[];
  currentSled: string;
  upgrades: Record<string, string[]>;
  bestTimes: Record<string, number>;
  settings: { quality: 'low' | 'medium' | 'high'; timeOfDay: string; camera: string };
  tutorialDone: boolean;
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
  settings: { quality: 'high', timeOfDay: 'morning', camera: 'chase' },
  tutorialDone: false,
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
      return { ...structuredClone(DEFAULT_SAVE), ...parsed, settings: { ...DEFAULT_SAVE.settings, ...parsed.settings } };
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
