import frostpineWorld from '../data/world.json';
import frostpineFreeride from '../data/freeride.json';
import jacksonWorld from '../data/world-jackson.json';
import jacksonFreeride from '../data/freeride-jackson.json';
import type { WorldDef } from './TerrainData';
import type { JumpDef } from './Jumps';

export interface FreerideDef {
  collectibles: { id: string; x: number; z: number; y?: number }[];
  viewpoints: { id: string; name: string; x: number; z: number; r: number }[];
  trickSpots: { jump: number; name: string }[];
}

export interface MapDef {
  id: string;
  name: string;
  region: string;
  description: string;
  features: string[];
  world: WorldDef;
  jumps: JumpDef[];
  freeride: FreerideDef;
}

const map = (m: Omit<MapDef, 'world' | 'jumps'> & { world: unknown }): MapDef => ({
  ...m,
  world: m.world as WorldDef,
  jumps: (m.world as { jumps?: JumpDef[] }).jumps ?? [],
});

/** Every rideable world. The first is the home map: races, deliveries and the arena all live there. */
export const MAPS: MapDef[] = [
  map({
    id: 'frostpine',
    name: 'Frostpine Valley',
    region: 'Home valley',
    description: 'Rolling pine forest, three frozen lakes and the snocross arena. Every race and delivery runs here.',
    features: ['Pine forest', 'Ridge trail', 'Frostpine Arena'],
    world: frostpineWorld,
    freeride: frostpineFreeride as FreerideDef,
  }),
  map({
    id: 'jackson',
    name: 'Jackson Hole',
    region: 'Wyoming, USA',
    description: 'Wide-open flats under the wall of the Teton Range. Ride the frozen Snake River, cross Jenny Lake into Cascade Canyon, or switchback up Rendezvous Mountain under the tram and point it back down.',
    features: ['Teton Range', 'Frozen Snake River', 'Cascade & Death Canyons', 'Rendezvous Mountain tram'],
    world: jacksonWorld,
    freeride: jacksonFreeride as FreerideDef,
  }),
];

export const HOME_MAP = MAPS[0];
export const getMap = (id: string | null | undefined): MapDef => MAPS.find((m) => m.id === id) ?? HOME_MAP;

/** What to do once a freshly loaded map is ready (set just before the reload that switches maps). */
export interface PendingStart { map: string; mode?: string; arg?: string; view?: string }
const PENDING_KEY = 'arctic-overdrive-pending';

export function setPendingStart(p: PendingStart) {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* blocked storage: the reload just lands on the title */ }
}

/** One-shot: a manual page reload always comes back to the home map and the title screen. */
export function takePendingStart(): PendingStart | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingStart) : null;
  } catch {
    return null;
  }
}
