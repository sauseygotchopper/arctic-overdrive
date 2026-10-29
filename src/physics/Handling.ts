export type HandlingMode = 'realistic' | 'arcade';
export const HANDLING_MODES: HandlingMode[] = ['realistic', 'arcade'];

/** Feature switches that make up a handling model. Arcade is the original tuning with a bit more gravity. */
export interface HandlingModel {
  label: string;
  /** Multiplies world gravity (snappier jumps and landings above 1). */
  gravityScale: number;
  /** Cap the steering assist's yaw rate at what the snow's lateral grip can hold (no spin-outs). */
  gripLimitedTurns: boolean;
  /** Sunk skis/track grip sideways harder; a spinning track loses side grip on hardpack. */
  snowKeel: boolean;
  /** Lateral grip acts at each contact's fore/aft position instead of being pulled toward the centre. */
  fullLeverArm: boolean;
  /** Throttle-squared trenching in soft snow and belly-pan high-centring. */
  bogging: boolean;
  /**
   * CVT drivetrain: the primary clutch grips the belt above engagement rpm (engine braking, track
   * can't turn backwards) and lets go near idle (track freewheels against driveline drag).
   */
  cvtDrivetrain: boolean;
  /** Wind crust gives way when contact pressure beats its strength. */
  crustBreak: boolean;
}

export const HANDLING: Record<HandlingMode, HandlingModel> = {
  realistic: {
    label: 'Realistic', gravityScale: 1,
    gripLimitedTurns: true, snowKeel: true, fullLeverArm: true, bogging: true, cvtDrivetrain: true, crustBreak: true,
  },
  arcade: {
    label: 'Arcade', gravityScale: 1.15,
    gripLimitedTurns: false, snowKeel: false, fullLeverArm: false, bogging: false, cvtDrivetrain: false, crustBreak: false,
  },
};

let mode: HandlingMode = 'realistic';

/** The active handling model, shared by sleds and trailers. */
export const handling = (): HandlingModel => HANDLING[mode];
export const handlingMode = (): HandlingMode => mode;
export function setHandlingMode(m: HandlingMode) {
  mode = HANDLING[m] ? m : 'realistic';
}
