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
