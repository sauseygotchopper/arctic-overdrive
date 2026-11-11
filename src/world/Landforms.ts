import { Noise2D, clamp, lerp, smoothstep } from './Noise';

/**
 * A landform is the large-scale shape of a map (before trails, lakes and detail are applied).
 * world.json picks one with `landform`; maps without one use the rolling valley built into TerrainData.
 */
export interface Landform {
  /** Large-scale height (m) – smooth enough for trails to follow. */
  low(n: Noise2D, x: number, z: number): number;
  /** Tree density multiplier (1 = the default forest noise decides). */
  forest?(n: Noise2D, x: number, z: number): number;
  /** Trees stop above this height (m). */
  treeline?: number;
}

// ---------------------------------------------------------------------------------------------
// Jackson Hole, Wyoming. +X is west, +Z is north.
// A dead-flat valley floor with the Teton Range standing straight up out of it along the west
// side – no foothills, just the fault scarp – cut by two glacial canyons that open onto lakes.
// ---------------------------------------------------------------------------------------------

/** Summits along the crest, north to south. */
const PEAKS = [
  { x: 395, z: 345, h: 175, r: 120 }, // Mount Moran
  { x: 372, z: 245, h: 150, r: 80 }, // Mount St. John
  { x: 368, z: 92, h: 190, r: 70 }, // Teewinot / Mount Owen
  { x: 388, z: 30, h: 245, r: 105 }, // Grand Teton
  { x: 380, z: -62, h: 200, r: 80 }, // Middle & South Teton
  { x: 385, z: -225, h: 170, r: 85 }, // Buck Mountain
];
/** U-shaped canyons through the range: centre z, half-width. */
const CANYONS = [
  { z: 152, w: 46 }, // Cascade Canyon → Jenny Lake
  { z: -150, w: 42 }, // Death Canyon → Phelps Lake
];
/** Isolated buttes standing on the valley floor. */
const BUTTES = [
  { x: -50, z: 190, rx: 78, rz: 70, h: 46 }, // Signal Mountain
  { x: -335, z: -150, rx: 62, rz: 95, h: 40 }, // Blacktail Butte
];
/** Rendezvous Mountain: the one face of the range gentle enough to ride (the resort). */
const RESORT = { z: -340, w: 120, top: 440, h: 135 };

/** Where the range front (the foot of the scarp) sits at this latitude. */
const frontX = (n: Noise2D, z: number) => 222 + 20 * n.noise(z / 170 + 4, 1.7);

const butteAt = (n: Noise2D, x: number, z: number) => {
  let h = 0;
  for (const b of BUTTES) {
    const d = Math.hypot((x - b.x) / b.rx, (z - b.z) / b.rz) * (1 + 0.12 * n.noise(x / 60 + 3, z / 60));
    if (d < 1) h += b.h * Math.pow(smoothstep(1, 0.15, d), 1.2);
  }
  return h;
};

const tetons: Landform = {
  treeline: 95,

  low(n, x, z) {
    // valley floor: glacial outwash, almost flat, tilting gently up toward the range
    let h = n.fbm(x / 260 + 7, z / 260, 2) * 2.6 + smoothstep(-80, 230, x) * 7 + butteAt(n, x, z);

    const xf = frontX(n, z);
    const t = (x - xf) / 150; // 0 at the foot of the range, 1 at the crest
    if (t > 0) {
      // the wall: a continuous ridge with jagged horns standing on it
      let crest = 92;
      for (const p of PEAKS) {
        const d = Math.hypot(x - p.x, (z - p.z) * 1.15) / p.r;
        if (d < 1) crest += (p.h - 92) * Math.pow(1 - d, 1.35);
      }
      const jag = 0.82 + 0.3 * n.ridged(x / 85 + 2, z / 85 - 6, 3);
      const rise = Math.pow(smoothstep(0, 1, Math.min(t, 1)), 1.15);
      let range = rise * crest * jag;

      // the resort face: one long even ramp instead of a cliff
      const rw = smoothstep(RESORT.w, RESORT.w * 0.45, Math.abs(z - RESORT.z));
      if (rw > 0) {
        const rt = clamp((x - xf) / (RESORT.top - xf), 0, 1);
        const ramp = RESORT.h * (rt * 0.82 + 0.18 * smoothstep(0, 1, rt)) + n.fbm(x / 55, z / 55, 2) * 3.5;
        range = lerp(range, ramp, rw);
      }

      // canyons: flat-floored troughs climbing gently to a headwall
      for (const c of CANYONS) {
        const off = Math.abs(z - c.z - 14 * n.noise(x / 90, c.z));
        const mask = smoothstep(c.w, c.w * 0.4, off) * smoothstep(xf + 215, xf + 165, x);
        if (mask > 0) range = lerp(range, 3 + (x - xf) * 0.17, mask);
      }
      h += range;
    }

    // the north, east and south rims of the hole
    const edge = Math.max(-x, Math.abs(z));
    h += smoothstep(395, 512, edge) * 125 * (0.75 + 0.25 * n.noise(x / 70, z / 70));
    return h;
  },

  forest(n, x, z) {
    // sagebrush flats are nearly treeless; timber hugs the foot of the range, the buttes and the rims
    const xf = frontX(n, z);
    const foot = smoothstep(xf - 95, xf - 25, x);
    const rim = smoothstep(350, 410, Math.max(-x, Math.abs(z)));
    const butte = butteAt(n, x, z) > 3 ? 0.75 : 0;
    return Math.max(0.05, foot, rim, butte);
  },
};

export const LANDFORMS: Record<string, Landform> = { tetons };
