import sledData from '../data/sleds.json';
import partsData from '../data/parts.json';

/** Raw sled spec as authored in data/sleds.json. */
export interface SledSpec {
  id: string;
  brand: string;
  model: string;
  tier: number;
  class: string;
  reference: string;
  style: 'trail' | 'crossover' | 'mountain' | 'race' | 'turbo';
  price: number;
  unlock: { xp?: number; medals?: number; gold?: number; crystals?: number };
  powerKW: number;
  peakRpm: number;
  idleRpm: number;
  engageRpm: number;
  maxRpm: number;
  topSpeedKmh: number;
  dryWeightKg: number;
  trackLengthIn: number;
  trackWidthIn: number;
  lugHeightIn: number;
  suspensionTravelFront: number;
  suspensionTravelRear: number;
  springRate: number;
  damping: number;
  skiStance: number;
  skiWidth: number;
  handling: number;
  hardGrip: number;
  durability: number;
  dragArea: number;
  maxPartTier: number;
  colors: { body: string; accent: string; seat: string; ski: string };
}

export interface PartEffects {
  powerPct?: number; topSpeedPct?: number; tractivePct?: number; weightKg?: number; trackLengthIn?: number;
  lugHeightSet?: number; studGrip?: number; springPct?: number; dampingPct?: number; travelFront?: number;
  travelRear?: number; roughAbsorb?: number; skiWidthAdd?: number; skiBitePct?: number; durabilityAdd?: number;
  peakRpmAdd?: number; maxRpmAdd?: number;
}
export interface PartDef { id: string; slot: string; name: string; desc: string; price: number; tier: number; effects: PartEffects }

export const SLEDS: SledSpec[] = sledData.sleds as SledSpec[];
export const STARTER_SLED: string = sledData.starter;
export const RIDER_MASS: number = sledData.rider.massKg;
export const PARTS: PartDef[] = partsData.parts as PartDef[];
export const PART_CATEGORIES = partsData.categories;
export const SLOT_NAMES = partsData.slotNames as Record<string, string>;
export const COSMETICS = partsData.cosmetics;

export function getSled(id: string): SledSpec {
  const s = SLEDS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sled ${id}`);
  return s;
}

export function getPart(id: string): PartDef | undefined {
  return PARTS.find((p) => p.id === id);
}

/** A part fits a sled if its tier is within the sled's tier and the sled's part-tier ceiling. */
export function partFits(part: PartDef, spec: SledSpec): boolean {
  return part.tier <= spec.tier && part.tier <= spec.maxPartTier;
}

export interface Livery { paint: string; wrap: string; number: number; gear: string }
export const DEFAULT_LIVERY: Livery = { paint: 'stock', wrap: 'none', number: 7, gear: 'stock' };

/** Everything that adds up to the physical setup: base sled, installed parts, rider, cargo. */
export interface SledSetup {
  spec: SledSpec;
  riderMass: number;
  cargoMass: number;
  parts?: string[];
  livery?: Livery;
}

/** Physics values derived from a setup – the single place where specs + parts turn into simulation numbers. */
export interface SledParams {
  mass: number;
  dryMass: number;
  powerW: number;
  idleRpm: number;
  engageRpm: number;
  peakRpm: number;
  maxRpm: number;
  topSpeed: number; // m/s
  trackLengthIn: number;
  lugHeightIn: number;
  trackContactLen: number; // m of track on the snow
  trackWidth: number;
  skiWidth: number;
  flotation: number; // 1 = reference crossover with rider
  powderTraction: number; // lug bite multiplier in soft snow
  hardpackDrag: number; // extra rolling drag from tall lugs on hard snow
  travelFront: number;
  travelRear: number;
  springMult: number;
  dampMult: number;
  stance: number;
  steerMax: number; // rad at standstill
  handling: number;
  hardGrip: number; // lateral grip multiplier on ice/crust
  studGrip: number; // added track grip on ice/crust
  skiBite: number; // ski lateral grip multiplier on hard snow
  tractiveMult: number; // clutch/gearing low-end pull
  roughAbsorb: number; // 0..1 less chatter on rough surfaces
  durability: number;
  dragArea: number;
  springZetaFront: number;
  springZetaRear: number;
}

const REF_FLOAT_AREA_PER_KG = 0.0023;

/** Sum the effects of installed parts. */
export function combinedEffects(partIds: string[] = []): Required<PartEffects> {
  const e: Required<PartEffects> = {
    powerPct: 0, topSpeedPct: 0, tractivePct: 0, weightKg: 0, trackLengthIn: 0, lugHeightSet: 0, studGrip: 0,
    springPct: 0, dampingPct: 0, travelFront: 0, travelRear: 0, roughAbsorb: 0, skiWidthAdd: 0, skiBitePct: 0,
    durabilityAdd: 0, peakRpmAdd: 0, maxRpmAdd: 0,
  };
  for (const id of partIds) {
    const p = getPart(id);
    if (!p) continue;
    for (const [k, v] of Object.entries(p.effects) as [keyof PartEffects, number][]) {
      if (k === 'lugHeightSet') e.lugHeightSet = v;
      else e[k] += v;
    }
  }
  return e;
}

export function deriveParams(setup: SledSetup): SledParams {
  const s = setup.spec;
  const e = combinedEffects(setup.parts);
  const dryMass = s.dryWeightKg + e.weightKg;
  const mass = dryMass + setup.riderMass + setup.cargoMass;
  const trackLengthIn = s.trackLengthIn + e.trackLengthIn;
  const lugHeightIn = e.lugHeightSet || s.lugHeightIn;
  const trackContactLen = (trackLengthIn * 0.0254) / 2.75;
  const trackWidth = s.trackWidthIn * 0.0254;
  const skiWidth = s.skiWidth + e.skiWidthAdd;
  const area = trackContactLen * trackWidth + 2 * skiWidth * 0.9;
  return {
    mass,
    dryMass,
    powerW: s.powerKW * 1000 * (1 + e.powerPct / 100),
    idleRpm: s.idleRpm,
    engageRpm: s.engageRpm,
    peakRpm: s.peakRpm + e.peakRpmAdd,
    maxRpm: s.maxRpm + e.maxRpmAdd,
    topSpeed: (s.topSpeedKmh * (1 + e.topSpeedPct / 100)) / 3.6,
    trackLengthIn,
    lugHeightIn,
    trackContactLen,
    trackWidth,
    skiWidth,
    flotation: area / mass / REF_FLOAT_AREA_PER_KG,
    powderTraction: 1 + (lugHeightIn - 1.25) * 0.55,
    hardpackDrag: Math.max(0, lugHeightIn - 1.0) * 0.006 + Math.max(0, trackLengthIn - 137) * 0.0002,
    travelFront: s.suspensionTravelFront + e.travelFront,
    travelRear: s.suspensionTravelRear + e.travelRear,
    springMult: s.springRate * (1 + e.springPct / 100),
    dampMult: s.damping * (1 + e.dampingPct / 100),
    stance: s.skiStance,
    // shorter tracks turn quicker
    steerMax: 0.42 + s.handling * 0.12 + (137 - trackLengthIn) * 0.0012,
    handling: s.handling,
    hardGrip: s.hardGrip,
    studGrip: e.studGrip,
    skiBite: 1 + e.skiBitePct / 100,
    tractiveMult: 1 + e.tractivePct / 100,
    roughAbsorb: Math.min(0.8, e.roughAbsorb),
    durability: Math.min(1, Math.max(0.3, s.durability + e.durabilityAdd)),
    dragArea: s.dragArea,
    springZetaFront: 0.32,
    springZetaRear: 0.38,
  };
}

// ---------- display stats (garage / dealership bars) ----------

export interface StatLine { key: string; label: string; value: string; bar: number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The ten headline stats, each with a display value and a 0..1 bar. Computed from derived params. */
export function displayStats(setup: SledSetup): StatLine[] {
  const p = deriveParams({ ...setup, cargoMass: 0 });
  const hp = (p.powerW / 745.7);
  const kmh = p.topSpeed * 3.6;
  return [
    { key: 'power', label: 'Power', value: `${Math.round(hp)} hp`, bar: clamp01(hp / 300) },
    { key: 'top', label: 'Top speed', value: `${Math.round(kmh)} km/h`, bar: clamp01((kmh - 90) / 110) },
    { key: 'weight', label: 'Weight', value: `${Math.round(p.dryMass)} kg`, bar: clamp01((300 - p.dryMass) / 120) },
    { key: 'track', label: 'Track length', value: `${Math.round(p.trackLengthIn)} in`, bar: clamp01((p.trackLengthIn - 110) / 75) },
    { key: 'lugs', label: 'Lug height', value: `${p.lugHeightIn.toFixed(2)} in`, bar: clamp01((p.lugHeightIn - 0.8) / 2.4) },
    { key: 'travel', label: 'Suspension', value: `${Math.round((p.travelFront + p.travelRear) * 100)} cm · ${p.springMult.toFixed(2)}×`, bar: clamp01((p.travelFront + p.travelRear - 0.4) / 0.45 * 0.7 + (p.dampMult - 0.8) * 0.5) },
    { key: 'stance', label: 'Ski stance', value: `${Math.round(p.stance * 100)} cm`, bar: clamp01((p.stance - 0.9) / 0.25) },
    { key: 'handling', label: 'Handling', value: `${Math.round(p.handling * p.skiBite * p.hardGrip * 100)}`, bar: clamp01(p.handling * (0.6 + 0.4 * p.skiBite) * (0.7 + 0.3 * p.hardGrip) + p.studGrip * 0.3) },
    { key: 'flotation', label: 'Flotation', value: `${p.flotation.toFixed(2)}×`, bar: clamp01((p.flotation * p.powderTraction - 0.6) / 1.6) },
    { key: 'durability', label: 'Durability', value: `${Math.round(p.durability * 100)}`, bar: clamp01(p.durability) },
  ];
}
