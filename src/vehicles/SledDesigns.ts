import * as THREE from 'three';
import type { Section } from './geometry';
import type { SledSpec } from './SledSpec';

const ss = THREE.MathUtils.smoothstep;

/** A lens, vent or trim panel laid on the hull between z0..z1 and contour t0..t1 (see Hull.skin). */
export interface Patch {
  z0: number; z1: number; t0: number; t1: number;
  /** ellipse = rounded lens, taper = pointed at both ends, rect = straight band */
  shape: 'ellipse' | 'taper' | 'rect';
  /** contour shift per metre of z, for slanted strips */
  slant?: number;
  mat: 'lamp' | 'drl' | 'dark' | 'chrome';
}

export interface Design {
  /** Real sled family the body loosely follows (kept here for whoever tweaks the shapes). */
  inspiredBy: string;
  hull: Section[];
  /** Contour where the painted hood starts (side panels below it, belly pan below `belt`). */
  hoodFrom: (z: number) => number;
  belt: number;
  /** How far the dark belly pan climbs the nose into a front fascia. */
  chin: number;
  console: Section[];
  consoleMat: 'paint' | 'trim';
  seat: Section[];
  windshield: { z: number; halfW: number; height: number; rake: number; wrap: number; taper?: number; top?: (u: number) => number; tint: number; opacity: number } | null;
  patches: Patch[];
  barY: number;
  barExtras: ('strap' | 'pad')[];
  bumper: 'chrome' | 'trim' | 'race';
  shocks: { body: number; spring: number; piggyback: boolean };
  /** Running board cutouts: 0 = small drain holes, 1 = big open mountain cutouts. */
  boardOpen: number;
  sideArt: 'swoosh' | 'shards' | 'topo' | 'race' | 'carbon';
  scoop: boolean;
  lightBar: boolean;
  helmet: 'modular' | 'mx';
  pack: boolean;
}

const hull = (n: number, nb: number, s: Section[]) => s.map((x) => ({ n, nb, ...x }));

const DESIGNS: Record<SledSpec['style'], Design> = {
  trail: {
    inspiredBy: 'Ski-Doo Renegade / MXZ Sport',
    hull: hull(3.6, 5, [
      { z: 0.25, yt: 0.5, yb: -0.24, w: 0.36, ym: 0.04, ridge: 0.01 },
      { z: 0.55, yt: 0.57, yb: -0.26, w: 0.42, ym: 0.05, ridge: 0.02 },
      { z: 0.85, yt: 0.51, yb: -0.26, w: 0.43, ym: 0.03, ridge: 0.03 },
      { z: 1.15, yt: 0.39, yb: -0.25, w: 0.37, ym: 0.0, ridge: 0.035 },
      { z: 1.4, yt: 0.26, yb: -0.22, w: 0.26, ym: -0.03, ridge: 0.03 },
      { z: 1.6, yt: 0.13, yb: -0.16, w: 0.15, ym: -0.05, ridge: 0.02 },
      { z: 1.74, yt: 0.02, yb: -0.1, w: 0.04, ym: -0.06 },
    ]),
    hoodFrom: (z) => 0.6 - 0.16 * ss(z, 0.9, 1.5),
    belt: 0.27,
    chin: 0.3,
    console: hull(3, 3, [
      { z: -0.02, yt: 0.46, yb: 0.12, w: 0.15 },
      { z: 0.25, yt: 0.53, yb: 0.1, w: 0.2 },
      { z: 0.55, yt: 0.6, yb: 0.1, w: 0.24 },
    ]),
    consoleMat: 'paint',
    seat: hull(4, 4, [
      { z: -1.0, yt: 0.39, yb: 0.13, w: 0.16 },
      { z: -0.9, yt: 0.44, yb: 0.12, w: 0.2 },
      { z: -0.3, yt: 0.43, yb: 0.12, w: 0.2 },
      { z: 0.02, yt: 0.46, yb: 0.12, w: 0.18 },
      { z: 0.14, yt: 0.43, yb: 0.14, w: 0.12 },
    ]),
    windshield: { z: 0.6, halfW: 0.37, height: 0.44, rake: 0.8, wrap: 0.13, top: (u) => 1 - 0.28 * u * u, tint: 0x2a3a4c, opacity: 0.4 },
    patches: [
      { z0: 1.26, z1: 1.5, t0: 0.81, t1: 0.9, shape: 'taper', slant: 0.32, mat: 'lamp' },
      { z0: 1.18, z1: 1.46, t0: 0.69, t1: 0.72, shape: 'taper', slant: 0.32, mat: 'drl' },
      { z0: 0.66, z1: 0.92, t0: 0.6, t1: 0.68, shape: 'taper', slant: 0.2, mat: 'dark' },
    ],
    barY: 0.52,
    barExtras: [],
    bumper: 'chrome',
    shocks: { body: 0x2b2f36, spring: 0xf6c400, piggyback: false },
    boardOpen: 0,
    sideArt: 'swoosh',
    scoop: false,
    lightBar: false,
    helmet: 'modular',
    pack: false,
  },
  crossover: {
    inspiredBy: 'Polaris Switchback Assault',
    hull: hull(3.8, 5, [
      { z: 0.25, yt: 0.48, yb: -0.24, w: 0.35, ym: 0.05, ridge: 0.02 },
      { z: 0.55, yt: 0.55, yb: -0.26, w: 0.41, ym: 0.07, ridge: 0.03 },
      { z: 0.9, yt: 0.48, yb: -0.26, w: 0.42, ym: 0.05, ridge: 0.05 },
      { z: 1.2, yt: 0.35, yb: -0.25, w: 0.34, ym: 0.02, ridge: 0.06 },
      { z: 1.45, yt: 0.2, yb: -0.21, w: 0.23, ym: -0.01, ridge: 0.05 },
      { z: 1.64, yt: 0.06, yb: -0.14, w: 0.12, ym: -0.04, ridge: 0.03 },
      { z: 1.76, yt: -0.04, yb: -0.09, w: 0.035, ym: -0.06, ridge: 0 },
    ]),
    // black side panels climb the nose, leaving a painted arrowhead on top
    hoodFrom: (z) => 0.56 + 0.08 * ss(z, 0.3, 0.7) + 0.16 * ss(z, 0.95, 1.6),
    belt: 0.26,
    chin: 0.34,
    console: hull(3.5, 3, [
      { z: -0.02, yt: 0.45, yb: 0.12, w: 0.14 },
      { z: 0.25, yt: 0.52, yb: 0.1, w: 0.19 },
      { z: 0.55, yt: 0.57, yb: 0.1, w: 0.23, ridge: 0.02 },
    ]),
    consoleMat: 'trim',
    seat: hull(4, 4, [
      { z: -0.98, yt: 0.4, yb: 0.13, w: 0.15 },
      { z: -0.88, yt: 0.45, yb: 0.12, w: 0.19 },
      { z: -0.3, yt: 0.44, yb: 0.12, w: 0.19 },
      { z: 0.02, yt: 0.47, yb: 0.12, w: 0.17 },
      { z: 0.14, yt: 0.44, yb: 0.14, w: 0.11 },
    ]),
    windshield: { z: 0.6, halfW: 0.33, height: 0.27, rake: 0.95, wrap: 0.12, top: (u) => 0.7 + 0.3 * (1 - Math.abs(u)), tint: 0x1a2430, opacity: 0.55 },
    patches: [
      { z0: 1.36, z1: 1.58, t0: 0.955, t1: 1.0, shape: 'taper', mat: 'lamp' },
      { z0: 1.2, z1: 1.56, t0: 0.83, t1: 0.86, shape: 'taper', slant: 0.15, mat: 'drl' },
      { z0: 0.72, z1: 1.0, t0: 0.74, t1: 0.84, shape: 'taper', slant: 0.25, mat: 'dark' },
    ],
    barY: 0.54,
    barExtras: [],
    bumper: 'trim',
    shocks: { body: 0x16181d, spring: 0xe8432e, piggyback: false },
    boardOpen: 0.4,
    sideArt: 'shards',
    scoop: false,
    lightBar: false,
    helmet: 'modular',
    pack: false,
  },
  mountain: {
    inspiredBy: 'Arctic Cat M-series / Polaris RMK',
    hull: hull(3.2, 4.5, [
      { z: 0.25, yt: 0.47, yb: -0.22, w: 0.3, ym: 0.06, ridge: 0.01 },
      { z: 0.5, yt: 0.55, yb: -0.24, w: 0.35, ym: 0.08, ridge: 0.015 },
      { z: 0.85, yt: 0.5, yb: -0.24, w: 0.36, ym: 0.08, ridge: 0.02 },
      { z: 1.15, yt: 0.41, yb: -0.23, w: 0.31, ym: 0.06, ridge: 0.025 },
      { z: 1.42, yt: 0.31, yb: -0.19, w: 0.22, ym: 0.04, ridge: 0.02 },
      { z: 1.62, yt: 0.2, yb: -0.11, w: 0.12, ym: 0.03, ridge: 0.01 },
      { z: 1.75, yt: 0.1, yb: -0.03, w: 0.03, ym: 0.04 },
    ]),
    hoodFrom: (z) => 0.58 - 0.12 * ss(z, 1.0, 1.6),
    belt: 0.3,
    chin: 0.22,
    console: hull(3, 3, [
      { z: -0.02, yt: 0.45, yb: 0.12, w: 0.13 },
      { z: 0.25, yt: 0.52, yb: 0.1, w: 0.17 },
      { z: 0.5, yt: 0.56, yb: 0.1, w: 0.2 },
    ]),
    consoleMat: 'trim',
    seat: hull(4, 4, [
      { z: -0.8, yt: 0.4, yb: 0.13, w: 0.13 },
      { z: -0.7, yt: 0.45, yb: 0.12, w: 0.16 },
      { z: -0.3, yt: 0.45, yb: 0.12, w: 0.16 },
      { z: 0.02, yt: 0.48, yb: 0.12, w: 0.15 },
      { z: 0.14, yt: 0.45, yb: 0.14, w: 0.1 },
    ]),
    windshield: { z: 0.56, halfW: 0.24, height: 0.13, rake: 1.05, wrap: 0.08, top: (u) => 1 - 0.5 * u * u, tint: 0x10161c, opacity: 0.7 },
    patches: [
      { z0: 1.5, z1: 1.7, t0: 0.84, t1: 1.0, shape: 'taper', mat: 'lamp' },
      { z0: 1.32, z1: 1.6, t0: 0.71, t1: 0.74, shape: 'taper', slant: 0.22, mat: 'drl' },
    ],
    barY: 0.68,
    barExtras: ['strap'],
    bumper: 'trim',
    shocks: { body: 0x2b2f36, spring: 0x7ac943, piggyback: false },
    boardOpen: 1,
    sideArt: 'topo',
    scoop: false,
    lightBar: false,
    helmet: 'mx',
    pack: true,
  },
  race: {
    inspiredBy: 'Ski-Doo MXZ X-RS / Arctic Cat ZR SX',
    hull: hull(3.8, 5, [
      { z: 0.25, yt: 0.46, yb: -0.24, w: 0.36, ym: 0.05 },
      { z: 0.55, yt: 0.5, yb: -0.26, w: 0.42, ym: 0.06, ridge: 0.02 },
      { z: 0.9, yt: 0.44, yb: -0.26, w: 0.43, ym: 0.04, ridge: 0.03 },
      { z: 1.2, yt: 0.33, yb: -0.25, w: 0.36, ym: 0.02, ridge: 0.03 },
      { z: 1.45, yt: 0.2, yb: -0.22, w: 0.26, ym: -0.01, ridge: 0.015 },
      { z: 1.64, yt: 0.07, yb: -0.15, w: 0.15, ym: -0.04 },
      { z: 1.75, yt: -0.03, yb: -0.09, w: 0.04, ym: -0.06 },
    ]),
    hoodFrom: (z) => 0.62 - 0.2 * ss(z, 0.8, 1.5),
    belt: 0.26,
    chin: 0.3,
    console: hull(3.5, 3, [
      { z: -0.02, yt: 0.47, yb: 0.12, w: 0.14 },
      { z: 0.25, yt: 0.5, yb: 0.1, w: 0.19 },
      { z: 0.55, yt: 0.52, yb: 0.1, w: 0.23 },
    ]),
    consoleMat: 'trim',
    seat: hull(4.5, 4, [
      { z: -0.86, yt: 0.44, yb: 0.13, w: 0.15 },
      { z: -0.76, yt: 0.49, yb: 0.12, w: 0.18 },
      { z: -0.3, yt: 0.47, yb: 0.12, w: 0.18 },
      { z: 0.02, yt: 0.49, yb: 0.12, w: 0.16 },
      { z: 0.14, yt: 0.46, yb: 0.14, w: 0.1 },
    ]),
    windshield: { z: 0.62, halfW: 0.27, height: 0.15, rake: 1.0, wrap: 0.1, top: (u) => 1 - 0.6 * u * u, tint: 0x10161c, opacity: 0.75 },
    patches: [
      { z0: 1.5, z1: 1.66, t0: 0.55, t1: 0.62, shape: 'taper', slant: 0.3, mat: 'drl' },
    ],
    barY: 0.58,
    barExtras: ['pad'],
    bumper: 'race',
    shocks: { body: 0xd8a419, spring: 0x16181d, piggyback: true },
    boardOpen: 0.6,
    sideArt: 'race',
    scoop: false,
    lightBar: false,
    helmet: 'mx',
    pack: false,
  },
  turbo: {
    inspiredBy: 'Ski-Doo Summit X Turbo, aftermarket build',
    hull: hull(4, 5, [
      { z: 0.25, yt: 0.49, yb: -0.24, w: 0.36, ym: 0.05, ridge: 0.025 },
      { z: 0.55, yt: 0.55, yb: -0.26, w: 0.42, ym: 0.07, ridge: 0.035 },
      { z: 0.9, yt: 0.47, yb: -0.26, w: 0.43, ym: 0.05, ridge: 0.05 },
      { z: 1.2, yt: 0.34, yb: -0.25, w: 0.36, ym: 0.02, ridge: 0.055 },
      { z: 1.45, yt: 0.2, yb: -0.21, w: 0.25, ym: -0.01, ridge: 0.045 },
      { z: 1.64, yt: 0.06, yb: -0.14, w: 0.13, ym: -0.04, ridge: 0.02 },
      { z: 1.76, yt: -0.04, yb: -0.09, w: 0.035, ym: -0.06 },
    ]),
    hoodFrom: (z) => 0.58 + 0.06 * ss(z, 0.3, 0.7) - 0.22 * ss(z, 0.95, 1.55),
    belt: 0.26,
    chin: 0.36,
    console: hull(3.5, 3, [
      { z: -0.02, yt: 0.46, yb: 0.12, w: 0.14 },
      { z: 0.25, yt: 0.52, yb: 0.1, w: 0.19 },
      { z: 0.55, yt: 0.57, yb: 0.1, w: 0.23, ridge: 0.02 },
    ]),
    consoleMat: 'trim',
    seat: hull(4, 4, [
      { z: -0.95, yt: 0.4, yb: 0.13, w: 0.15 },
      { z: -0.85, yt: 0.45, yb: 0.12, w: 0.18 },
      { z: -0.3, yt: 0.45, yb: 0.12, w: 0.18 },
      { z: 0.02, yt: 0.48, yb: 0.12, w: 0.16 },
      { z: 0.14, yt: 0.45, yb: 0.14, w: 0.1 },
    ]),
    windshield: { z: 0.6, halfW: 0.3, height: 0.19, rake: 1.0, wrap: 0.11, top: (u) => 0.75 + 0.25 * (1 - Math.abs(u)), tint: 0x0c0f12, opacity: 0.8 },
    patches: [
      { z0: 1.3, z1: 1.58, t0: 0.78, t1: 0.86, shape: 'taper', slant: 0.3, mat: 'lamp' },
      { z0: 1.0, z1: 1.3, t0: 0.5, t1: 0.6, shape: 'taper', slant: 0.3, mat: 'dark' },
      { z0: 0.68, z1: 0.92, t0: 0.66, t1: 0.74, shape: 'taper', slant: 0.25, mat: 'dark' },
    ],
    barY: 0.6,
    barExtras: ['strap'],
    bumper: 'trim',
    shocks: { body: 0x16181d, spring: 0xff5a1f, piggyback: true },
    boardOpen: 0.8,
    sideArt: 'carbon',
    scoop: true,
    lightBar: true,
    helmet: 'mx',
    pack: false,
  },
};

export function designFor(style: SledSpec['style']): Design {
  return DESIGNS[style] ?? DESIGNS.trail;
}

/** Contour range of a patch at z (shape + slant). */
export function patchRange(p: Patch): { from: (z: number) => number; to: (z: number) => number } {
  const zc = (p.z0 + p.z1) / 2, hz = (p.z1 - p.z0) / 2;
  const k = (z: number) => {
    const u = Math.min(1, Math.abs(z - zc) / hz);
    return p.shape === 'ellipse' ? Math.sqrt(Math.max(0, 1 - u * u)) : p.shape === 'taper' ? Math.pow(1 - u, 0.6) : 1;
  };
  const tc = (p.t0 + p.t1) / 2, ht = (p.t1 - p.t0) / 2;
  if (p.t1 >= 1) {
    // patches reaching the centreline grow down from it, so the halves meet
    return { from: (z) => 1 - (1 - p.t0) * k(z), to: () => 1 };
  }
  const c = (z: number) => tc + (p.slant ?? 0) * (z - zc);
  return { from: (z) => c(z) - ht * k(z), to: (z) => c(z) + ht * k(z) };
}
