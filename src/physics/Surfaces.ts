import surfaceData from '../data/surfaces.json';
import handling from '../data/handling.json';

export type SurfaceKey = 'groomed' | 'powder' | 'crust' | 'ice' | 'slush' | 'moguls';

export interface SurfaceDef {
  key: SurfaceKey;
  id: number;
  name: string;
  color: string;
  grip: number;
  lateralGrip: number;
  rollingDrag: number;
  sinkDepth: number;
  sinkDrag: number;
  planingSpeed: number;
  speedCap: number;
  roughness: number;
  spray: number;
  /** Crusts only: pressure (kPa) at which the crust gives way, before speed/patchiness scaling. */
  breakKPa?: number;
  /** Crusts only: the softer layer underneath, as overrides of this surface. */
  under?: Partial<SurfaceDef>;
}

export const SURFACE_KEYS: SurfaceKey[] = ['groomed', 'powder', 'crust', 'ice', 'slush', 'moguls'];

/** Surfaces indexed by their numeric id (the value stored in the terrain surface map). */
export const SURFACES: SurfaceDef[] = SURFACE_KEYS.map((key, id) => ({
  key,
  id,
  ...(surfaceData as unknown as Record<SurfaceKey, Omit<SurfaceDef, 'key' | 'id'>>)[key],
}));

/** For a crust surface: the same surface after it has broken (the layer underneath). */
export const BROKEN: (SurfaceDef | null)[] = SURFACES.map((s) => (s.under ? { ...s, ...s.under, under: undefined, breakKPa: undefined } : null));

/**
 * Crust strength multiplier at a point: wind crust is patchy, so some spots hold a sled and the
 * patch beside it doesn't. Roughly 0.6..1.4, varying over a few metres.
 */
export function crustPatchiness(x: number, z: number): number {
  const n = Math.sin(x * 0.37 + Math.sin(z * 0.21) * 2.1) * Math.sin(z * 0.29 - x * 0.13) * 0.65 + Math.sin(x * 1.3 + z * 0.9) * 0.25;
  return 1 + n * 0.45;
}

export const SURFACE_ID: Record<SurfaceKey, number> = Object.fromEntries(
  SURFACE_KEYS.map((k, i) => [k, i]),
) as Record<SurfaceKey, number>;

/**
 * How deep a ski/track sinks (m) on a surface. Speed planes you up; a small footprint relative to
 * the load (low flotation) or a contact carrying more than its design load sinks deeper.
 * Shared by sleds and trailers so they agree on what powder does.
 */
export function sinkTarget(s: SurfaceDef, speed: number, flotation: number, loadRatio: number): number {
  const plane = s.planingSpeed * Math.pow(1 / flotation, 0.8);
  const planing = Math.max(0, Math.min(1, 1 - speed / Math.max(plane, 0.01)));
  const load = Math.max(0.6, Math.min(1.8, Math.sqrt(Math.max(0.01, loadRatio))));
  const float = Math.max(0.6, Math.min(1.7, 1 / flotation));
  return Math.min(s.sinkDepth * planing * float * load, s.sinkDepth * 1.4);
}

/**
 * Drag (N) from ploughing through snow while sunk, for a contact carrying normal load N.
 * It fades toward `crawlFactor` near standstill: an overloaded sled bogs down to a crawl rather
 * than stopping dead (snow resists motion, it doesn't glue you in place).
 */
export function sinkDragForce(s: SurfaceDef, sink: number, normalLoad: number, speed: number): number {
  const v = Math.abs(speed);
  return s.sinkDrag * sink * normalLoad * Math.max(handling.bog.crawlFactor, Math.min(1, v / 5));
}
