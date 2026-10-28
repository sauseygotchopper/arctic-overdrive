import tricksData from '../data/tricks.json';
import { SledPhysics } from './SledPhysics';
import { PoseName, RiderState } from './Rider';

export type TrickButton = 'trick1' | 'trick2' | 'trick3' | 'trick4';

export interface TrickControls {
  jumpHeld: boolean;
  buttons: Record<TrickButton, boolean>;
  steer: number;
  leanX: number;
  leanZ: number;
}

export type LandingQuality = 'clean' | 'sketchy' | 'crash';

export type StuntEvent =
  | { type: 'trick'; name: string; points: number }
  | { type: 'landed'; quality: LandingQuality; airTime: number; impact: number }
  | { type: 'banked'; points: number; multiplier: number; names: string[]; currency: number; xp: number }
  | { type: 'lost'; points: number }
  | { type: 'blocked'; reason: string };

interface ComboEntry { name: string; points: number }

const POSE_KEYS = Object.keys(tricksData.poses) as PoseName[];
type PoseDef = (typeof tricksData.poses)[keyof typeof tricksData.poses];

/**
 * Pop/preload, air tracking, pose tricks, rotation detection, landing evaluation and combo scoring.
 * Runs at the physics rate alongside SledPhysics.
 */
export class StuntSystem {
  /** Tricks are disabled while towing (small jumps still score airtime). */
  towing = false;
  /** Set by modes (e.g. Freeride trick spots) – multiplies banked points. */
  bonusMultiplier = 1;
  readonly rider: RiderState = { leanX: 0, leanZ: 0, crouch: 0, pose: null, poseSide: 1, poseAmount: 0 };
  readonly events: StuntEvent[] = [];

  combo: ComboEntry[] = [];
  comboTimer = 0;
  inAir = false;
  airTime = 0;

  private charge = 0;
  private wasJumpHeld = false;
  private sinceGround = 0;
  private pitchAcc = 0;
  private yawAcc = 0;
  private poseHold = 0;
  private blockedNotice = 0;

  constructor(private phys: SledPhysics) {}

  get comboPoints(): number {
    return this.combo.reduce((a, c) => a + c.points, 0);
  }
  get multiplier(): number {
    return Math.max(1, this.combo.length);
  }

  fixedUpdate(dt: number, c: TrickControls) {
    const p = this.phys;
    const grounded = p.groundedCount > 0;
    this.sinceGround = grounded ? 0 : this.sinceGround + dt;
    this.blockedNotice = Math.max(0, this.blockedNotice - dt);

    // ---- pop: hold to preload, release to spring off the suspension ----
    if (c.jumpHeld && grounded && p.crashTimer <= 0) this.charge = Math.min(1, this.charge + dt / tricksData.pop.chargeTime);
    if (!c.jumpHeld && this.wasJumpHeld && this.charge > 0.1 && this.sinceGround < 0.15) p.pop(this.charge);
    if (!c.jumpHeld) this.charge = Math.max(0, this.charge - dt * 6);
    this.wasJumpHeld = c.jumpHeld;
    this.rider.crouch = this.charge;
    this.rider.leanX = c.leanX;
    this.rider.leanZ = c.leanZ;

    // ---- take-off ----
    if (!this.inAir && this.sinceGround > 0.12) {
      this.inAir = true;
      this.airTime = this.sinceGround;
      this.pitchAcc = this.yawAcc = 0;
    }

    if (this.inAir) {
      this.airTime += dt;
      const w = p.body.angvel();
      this.pitchAcc += (w.x * p.right.x + w.y * p.right.y + w.z * p.right.z) * dt;
      this.yawAcc += w.y * dt;
      this.updatePose(dt, c);
      if (grounded) this.land();
    } else {
      // on the ground the rider is always back in the seat
      this.releasePose(dt, true);
      if (this.combo.length && this.comboTimer > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) this.bank(1);
      }
    }
  }

  private requestedPose(c: TrickControls): { pose: PoseName; side: number } | null {
    for (const key of POSE_KEYS) {
      const d = tricksData.poses[key as keyof typeof tricksData.poses] as PoseDef;
      if (!c.buttons[d.button as TrickButton]) continue;
      const dirHeld = Math.abs(c.steer) > 0.5;
      if (d.dir === 1 && dirHeld) return { pose: key, side: c.steer > 0 ? 1 : -1 };
      if (d.dir === 0 && !dirHeld) return { pose: key, side: 1 };
    }
    // button held with a direction but no directional variant → plain version
    for (const key of POSE_KEYS) {
      const d = tricksData.poses[key as keyof typeof tricksData.poses] as PoseDef;
      if (c.buttons[d.button as TrickButton] && d.dir === 0) return { pose: key, side: 1 };
    }
    return null;
  }

  private updatePose(dt: number, c: TrickControls) {
    const req = this.airTime > 0.15 ? this.requestedPose(c) : null;
    if (req && this.towing) {
      if (this.blockedNotice <= 0) this.events.push({ type: 'blocked', reason: 'Tricks disabled while towing' });
      this.blockedNotice = 3;
      this.releasePose(dt, false);
      return;
    }
    const r = this.rider;
    if (req && (r.pose === req.pose || r.poseAmount <= 0.01)) {
      if (r.pose !== req.pose) { r.pose = req.pose; r.poseSide = req.side; this.poseHold = 0; }
      const d = tricksData.poses[req.pose as keyof typeof tricksData.poses] as PoseDef;
      r.poseAmount = Math.min(1, r.poseAmount + dt / d.blendIn);
      if (r.poseAmount >= 0.95) this.poseHold += dt;
    } else {
      this.releasePose(dt, false);
    }
  }

  /** Blend the rider back to the seat; award the pose trick once fully released. */
  private releasePose(dt: number, instant: boolean) {
    const r = this.rider;
    if (!r.pose) return;
    const d = tricksData.poses[r.pose as keyof typeof tricksData.poses] as PoseDef;
    r.poseAmount = instant ? 0 : Math.max(0, r.poseAmount - dt / (d.blendIn * 0.9));
    if (r.poseAmount <= 0) {
      if (!instant && this.poseHold >= d.minHold) {
        const pts = Math.round(d.points + d.perSecond * (this.poseHold - d.minHold));
        this.addTrick(d.name, pts);
      }
      r.pose = null;
      this.poseHold = 0;
    }
  }

  private addTrick(name: string, points: number) {
    const repeats = this.combo.filter((e) => e.name === name).length;
    const pts = Math.round(points * Math.pow(tricksData.combo.repeatPenalty, repeats));
    this.combo.push({ name, points: pts });
    this.events.push({ type: 'trick', name, points: pts });
  }

  private land() {
    const p = this.phys;
    const L = tricksData.landing;
    const airTime = this.airTime;
    this.inAir = false;
    this.airTime = 0;
    const align = p.up.dot(p.groundNormal);
    const impact = Math.max(0, -p.velocity.dot(p.groundNormal));
    const maxImpact = L.maxImpactBase + (p.params.travelFront + p.params.travelRear) * L.impactPerTravel;
    const posing = this.rider.poseAmount > L.poseCrashAmount;

    let quality: LandingQuality = 'clean';
    if (posing || align < L.sketchyAlign || impact > maxImpact * 1.3) quality = 'crash';
    else if (align < L.cleanAlign || impact > maxImpact) quality = 'sketchy';
    this.events.push({ type: 'landed', quality, airTime, impact });

    if (quality === 'crash') {
      p.crash();
      this.rider.pose = null;
      this.rider.poseAmount = 0;
      const lost = this.comboPoints;
      this.combo = [];
      if (lost > 0) this.events.push({ type: 'lost', points: lost });
      return;
    }
    // hard landings bleed speed
    p.scrubSpeed(Math.min(0.35, Math.max(0, (impact - 6) * 0.035)));

    // rotations + airtime score on landing (tricks need to be ridden away)
    if (!this.towing) {
      const flips = Math.floor((Math.abs(this.pitchAcc) + 1.0) / (Math.PI * 2));
      for (let i = 0; i < flips; i++) {
        const k = this.pitchAcc > 0 ? 'backflip' : 'frontflip';
        this.addTrick(tricksData.rotations[k].name, tricksData.rotations[k].points);
      }
      const spins = Math.floor((Math.abs(this.yawAcc) + 0.9) / (Math.PI * 2));
      if (spins > 0) this.addTrick(spins === 1 ? '360' : `${spins * 360}`, tricksData.rotations.spin.points * spins * (spins > 1 ? 1.3 : 1));
    }
    const A = tricksData.airtime;
    if (airTime >= A.minSeconds) {
      const big = airTime >= A.bigAir;
      this.addTrick(big ? 'Big Air' : 'Air', Math.round(airTime * A.pointsPerSecond + (big ? A.bigAirBonus : 0)));
    }
    if (quality === 'sketchy') this.bank(0.75);
    else this.comboTimer = tricksData.combo.window;
  }

  private bank(factor: number) {
    if (!this.combo.length) return;
    const raw = this.comboPoints * this.multiplier * this.bonusMultiplier;
    const points = Math.round(raw * factor);
    const R = tricksData.rewards;
    this.events.push({
      type: 'banked', points, multiplier: this.multiplier, names: this.combo.map((c) => c.name),
      currency: Math.round(points * R.currencyPerPoint), xp: Math.round(points * R.xpPerPoint),
    });
    this.combo = [];
    this.comboTimer = 0;
  }

  /** Drop any combo silently (respawn/recover). */
  reset() {
    this.combo = [];
    this.comboTimer = 0;
    this.inAir = false;
    this.rider.pose = null;
    this.rider.poseAmount = 0;
  }
}
