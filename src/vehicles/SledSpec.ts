import sledData from '../data/sleds.json';

/** Raw sled spec as authored in data/sleds.json. */
export interface SledSpec {
  id: string;
  brand: string;
  model: string;
  tier: number;
  class: string;
  reference: string;
  price: number;
  powerKW: number;
  peakRpm: number;
  idleRpm: number;
  engageRpm: number;
  engineType: '2-stroke' | '4-stroke';
  maxRpm: number;
  topSpeedKmh: number;
  dryWeightKg: number;
  trackLengthIn: number;
  trackWidthIn: number;
  lugHeightIn: number;
  suspensionTravelFront: number;
  suspensionTravelRear: number;
  skiStance: number;
  skiWidth: number;
  handling: number;
  durability: number;
  dragArea: number;
  colors: { body: string; accent: string; seat: string; ski: string };
}

export const SLEDS: SledSpec[] = sledData.sleds as SledSpec[];
export const RIDER_MASS: number = sledData.rider.massKg;

export function getSled(id: string): SledSpec {
  const s = SLEDS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sled ${id}`);
  return s;
}

/** Everything that adds up to the physical setup: base sled, rider, cargo (and later parts/skills). */
export interface SledSetup {
  spec: SledSpec;
  riderMass: number;
  cargoMass: number;
}

/** Physics values derived from a setup – the single place where specs turn into simulation numbers. */
export interface SledParams {
  mass: number;
  powerW: number;
  idleRpm: number;
  engageRpm: number;
  peakRpm: number;
  maxRpm: number;
  topSpeed: number; // m/s
  trackContactLen: number; // m of track on the snow
  trackWidth: number;
  skiArea: number; // m² footprint of one ski
  trackArea: number; // m² of track carried by one of the four track contacts
  /** Engine braking at full belt engagement, as a fraction of weight (4-strokes brake harder). */
  engineBrakeG: number;
  flotation: number; // 1 = reference crossover with rider
  powderTraction: number; // lug bite multiplier in soft snow
  hardpackDrag: number; // extra rolling drag from tall lugs on hard snow
  travelFront: number;
  travelRear: number;
  stance: number;
  steerMax: number; // rad at standstill
  handling: number;
  dragArea: number;
  springZetaFront: number;
  springZetaRear: number;
}

const REF_FLOAT_AREA_PER_KG = 0.0023;

export function deriveParams(setup: SledSetup): SledParams {
  const s = setup.spec;
  const mass = s.dryWeightKg + setup.riderMass + setup.cargoMass;
  const trackContactLen = (s.trackLengthIn * 0.0254) / 2.75;
  const trackWidth = s.trackWidthIn * 0.0254;
  const area = trackContactLen * trackWidth + 2 * s.skiWidth * 0.9;
  return {
    mass,
    powerW: s.powerKW * 1000,
    idleRpm: s.idleRpm,
    engageRpm: s.engageRpm,
    peakRpm: s.peakRpm,
    maxRpm: s.maxRpm,
    topSpeed: s.topSpeedKmh / 3.6,
    trackContactLen,
    trackWidth,
    skiArea: s.skiWidth * 0.9,
    trackArea: (trackContactLen * trackWidth) / 4,
    engineBrakeG: s.engineType === '4-stroke' ? 0.09 : 0.045,
    flotation: area / mass / REF_FLOAT_AREA_PER_KG,
    powderTraction: 1 + (s.lugHeightIn - 1.25) * 0.55,
    hardpackDrag: Math.max(0, s.lugHeightIn - 1.0) * 0.006,
    travelFront: s.suspensionTravelFront,
    travelRear: s.suspensionTravelRear,
    stance: s.skiStance,
    steerMax: 0.42 + s.handling * 0.12,
    handling: s.handling,
    dragArea: s.dragArea,
    springZetaFront: 0.32,
    springZetaRear: 0.38,
  };
}
