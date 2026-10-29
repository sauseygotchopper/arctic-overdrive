export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];

/** Everything the renderer scales by preset. Low skips post-processing entirely and renders straight to screen. */
export interface GraphicsPreset {
  pixelRatio: number;
  antialias: boolean;
  shadowSize: number; // 0 = no shadows
  softShadows: boolean;
  terrainTex: number;
  post: boolean;
  msaa: number;
  bloom: boolean;
  ssao: boolean;
  shafts: boolean;
  motionBlur: boolean;
  sparkle: boolean;
  snowflakes: number;
  lampLights: number; // real point lights shared between the nearest lamps
  trackPoints: number; // cross-sections kept per rut (0.4 m apart) before the oldest are reused
}

export const GRAPHICS: Record<Quality, GraphicsPreset> = {
  low: {
    pixelRatio: 1, antialias: false, shadowSize: 0, softShadows: false, terrainTex: 1024,
    post: false, msaa: 0, bloom: false, ssao: false, shafts: false, motionBlur: false, sparkle: false,
    snowflakes: 1500, lampLights: 0, trackPoints: 1500,
  },
  medium: {
    pixelRatio: 1.25, antialias: true, shadowSize: 1024, softShadows: false, terrainTex: 2048,
    post: true, msaa: 2, bloom: true, ssao: false, shafts: false, motionBlur: true, sparkle: true,
    snowflakes: 3500, lampLights: 2, trackPoints: 3000,
  },
  // high = ultra without ambient occlusion: GTAO re-draws the whole scene for its normal pass, which was
  // about half the frame (measured ~14.8 ms → ~6.7 ms per frame on an M-series Mac at 1.5× pixel ratio)
  high: {
    pixelRatio: 1.5, antialias: true, shadowSize: 2048, softShadows: true, terrainTex: 2048,
    post: true, msaa: 4, bloom: true, ssao: false, shafts: true, motionBlur: true, sparkle: true,
    snowflakes: 6000, lampLights: 6, trackPoints: 6000,
  },
  ultra: {
    pixelRatio: 1.5, antialias: true, shadowSize: 2048, softShadows: true, terrainTex: 2048,
    post: true, msaa: 4, bloom: true, ssao: true, shafts: true, motionBlur: true, sparkle: true,
    snowflakes: 6000, lampLights: 6, trackPoints: 6000,
  },
};
