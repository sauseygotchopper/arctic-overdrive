import surfaceData from '../data/surfaces.json';

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
}

export const SURFACE_KEYS: SurfaceKey[] = ['groomed', 'powder', 'crust', 'ice', 'slush', 'moguls'];

/** Surfaces indexed by their numeric id (the value stored in the terrain surface map). */
export const SURFACES: SurfaceDef[] = SURFACE_KEYS.map((key, id) => ({
  key,
  id,
  ...(surfaceData as unknown as Record<SurfaceKey, Omit<SurfaceDef, 'key' | 'id'>>)[key],
}));

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

/** Drag (N) from ploughing through snow while sunk, for a contact carrying normal load N. */
export function sinkDragForce(s: SurfaceDef, sink: number, normalLoad: number, speed: number): number {
  return s.sinkDrag * sink * normalLoad * Math.max(0.25, Math.min(1, Math.abs(speed) / 4));
}
