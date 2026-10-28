import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld, GRAVITY } from '../physics/PhysicsWorld';
import { SURFACES, SurfaceDef, sinkTarget, sinkDragForce } from '../physics/Surfaces';
import tricksData from '../data/tricks.json';
import H from '../data/handling.json';
import { TerrainData } from '../world/TerrainData';
import { SledParams } from './SledSpec';
import { clamp, lerp, smoothstep } from '../world/Noise';

/** Control intent for one sled – produced by the player's Input or by AI. */
export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 left .. +1 right
  leanX: number; // -1 left .. +1 right
  leanZ: number; // -1 back .. +1 forward
}

interface Contact {
  local: THREE.Vector3;
  isSki: boolean;
  side: number; // -1 left, +1 right
  maxLen: number;
  travel: number;
  k: number;
  c: number;
  compression: number;
  prevCompression: number;
  grounded: boolean;
  load: number;
  nominalLoad: number;
  sink: number;
  surface: SurfaceDef;
  hitPoint: THREE.Vector3;
  slip: number;
}

const BASE_HEIGHT = 0.25; // ray length left when fully compressed
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Raycast snowmobile on a Rapier rigid body. Two steerable ski contacts + four track contacts,
 * each a spring-damper with surface-dependent grip, drag and sink. Mass (sled + rider + cargo)
 * feeds springs, inertia, traction, flotation and air rotation.
 *
 * Local frame: +Z forward, +Y up, +X is the rider's LEFT.
 */
export class SledPhysics {
  readonly body: RAPIER.RigidBody;
  readonly contacts: Contact[] = [];
  params!: SledParams;

  // telemetry for HUD / audio / effects
  speed = 0; // m/s along forward
  rpm = 0;
  steerAngle = 0;
  groundedCount = 0;
  airTime = 0;
  lastAirTime = 0;
  landingImpact = 0; // m/s vertical at last touchdown
  trackSlip = 0;
  trackSpeed = 0;
  surface: SurfaceDef = SURFACES[0];
  reversing = false;
  /** Mass hanging off the hitch (trailer + cargo) – softens steering assists so turns widen. */
  towMass = 0;
  /** Scales air-control torque (towing limits what the rider can do). */
  airControlScale = 1;
  /** Seconds left of a crash: no throttle, rider recovering. */
  crashTimer = 0;
  readonly groundNormal = new THREE.Vector3(0, 1, 0);
  /** Hitch point at the rear bumper, sled-local. */
  readonly hitchLocal = new THREE.Vector3();

  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly forward = new THREE.Vector3();
  readonly up = new THREE.Vector3();
  readonly right = new THREE.Vector3();

  private throttleS = 0;
  private steerS = 0;
  private leanXS = 0;
  private leanZS = 0;
  private brakeHold = 0;
  private comOffset = new THREE.Vector3();
  private massDirty = true;
  private ray: RAPIER.Ray;

  constructor(private phys: PhysicsWorld, private terrain: TerrainData, params: SledParams, pos: THREE.Vector3, yaw: number) {
    const R = phys.R;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.02)
      .setAngularDamping(0.6)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = phys.world.createRigidBody(desc);
    // chassis: tunnel + hood volume. Mass comes from setAdditionalMassProperties, so density 0.
    phys.world.createCollider(R.ColliderDesc.cuboid(0.46, 0.18, 1.3).setTranslation(0, 0.42, 0.05).setDensity(0).setFriction(0.08).setRestitution(0.02), this.body);
    phys.world.createCollider(R.ColliderDesc.cuboid(0.32, 0.25, 0.3).setTranslation(0, 0.75, -0.55).setDensity(0).setFriction(0.2), this.body); // seat/rider hip
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.setParams(params);
  }

  setParams(p: SledParams) {
    this.params = p;
    this.contacts.length = 0;
    const frontLoad = 0.32 * p.mass * GRAVITY;
    const rearLoad = 0.68 * p.mass * GRAVITY;
    const mk = (x: number, z: number, isSki: boolean, travel: number, load: number, zeta: number): Contact => {
      const sag = 0.42 * travel;
      const k = (load / sag) * p.springMult * (isSki ? p.springFront : p.springRear);
      const mEff = load / GRAVITY;
      return {
        local: new THREE.Vector3(x, 0, z), isSki, side: x > 0 ? -1 : 1,
        maxLen: BASE_HEIGHT + travel, travel, k, c: 2 * zeta * Math.sqrt(k * mEff) * p.dampMult,
        compression: 0, prevCompression: 0, grounded: false, load: 0, nominalLoad: load, sink: 0,
        surface: SURFACES[0], hitPoint: new THREE.Vector3(), slip: 0,
      };
    };
    const hs = p.stance / 2;
    this.contacts.push(mk(hs, 1.08, true, p.travelFront, frontLoad / 2, H.suspension.zetaFront));
    this.contacts.push(mk(-hs, 1.08, true, p.travelFront, frontLoad / 2, H.suspension.zetaFront));
    const tw = p.trackWidth * 0.38;
    const zf = 0.2;
    const zr = zf - p.trackContactLen;
    for (const z of [zf, zr]) for (const x of [tw, -tw]) this.contacts.push(mk(x, z, false, p.travelRear, rearLoad / 4, H.suspension.zetaRear));
    this.hitchLocal.set(0, 0.1, zr - 0.42); // matches the hitch block on the model's rear bumper
    this.massDirty = true;
  }

  /** Recompute mass properties: total mass, inertia and COM shifted by rider lean. */
  private updateMass() {
    const p = this.params;
    const m = p.mass;
    const w = 1.1, h = 1.0, l = 3.0;
    const I = { x: (m / 12) * (h * h + l * l), y: (m / 12) * (w * w + l * l), z: (m / 12) * (w * w + h * h) * 1.4 };
    const c = { x: this.comOffset.x, y: 0.12 + this.comOffset.y, z: -0.2 + this.comOffset.z };
    this.body.setAdditionalMassProperties(m, c, I, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.massDirty = false;
  }

  /** Hard reset (respawn/recover). */
  teleport(pos: THREE.Vector3, yaw: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation(pos, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const c of this.contacts) { c.compression = c.prevCompression = 0; c.sink = 0; }
    this.throttleS = 0;
    this.crashTimer = 0;
  }

  /** Spring off the suspension: preload charge 0..1. Fixed impulse, so heavier setups pop lower. */
  pop(charge: number) {
    const p = this.params;
    const travelK = (p.travelFront + p.travelRear) / 0.6;
    const J = tricksData.pop.impulse * charge * Math.min(1.4, travelK);
    const dir = this.up.clone().lerp(new THREE.Vector3(0, 1, 0), 0.5).normalize();
    this.body.applyImpulse(scale(dir, J), true);
    // a little nose-up so the sled leaves the ground level
    this.body.applyTorqueImpulse(scale(this.right, J * 0.12), true);
  }

  /** Bad landing: dump speed and lock the throttle while the rider gathers themselves. */
  crash() {
    const v = this.body.linvel();
    const k = tricksData.landing.crashSpeedKeep;
    this.body.setLinvel({ x: v.x * k, y: v.y * 0.4, z: v.z * k }, true);
    const w = this.body.angvel();
    this.body.setAngvel({ x: w.x * 0.3, y: w.y * 0.3, z: w.z * 0.3 }, true);
    this.crashTimer = tricksData.landing.crashLockSeconds;
  }

  /** Hard (but survivable) landing scrubs horizontal speed. */
  scrubSpeed(fraction: number) {
    const v = this.body.linvel();
    const k = 1 - fraction;
    this.body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, true);
  }

  readState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    const v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.velocity.set(v.x, v.y, v.z);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.right.set(-1, 0, 0).applyQuaternion(this.quaternion);
  }

  step(dt: number, input: DriveInput) {
    const p = this.params;
    const body = this.body;
    this.readState();

    // ---- input smoothing ----
    if (this.crashTimer > 0) {
      this.crashTimer -= dt;
      input = { ...input, throttle: 0 };
    }
    this.throttleS += (input.throttle - this.throttleS) * Math.min(1, dt * 7);
    this.steerS += (input.steer - this.steerS) * Math.min(1, dt * 9);
    const lx = this.leanXS, lz = this.leanZS;
    this.leanXS += (input.leanX - this.leanXS) * Math.min(1, dt * 6);
    this.leanZS += (input.leanZ - this.leanZS) * Math.min(1, dt * 6);
    if (Math.abs(lx - this.leanXS) + Math.abs(lz - this.leanZS) > 0.01 || this.massDirty) {
      // rider is ~25% of the mass and moves ~0.35 m: shift the COM accordingly
      const riderFrac = clamp(82 / p.mass, 0.15, 0.4) * H.lean.comShift;
      this.comOffset.set(-this.leanXS * 0.35 * riderFrac, 0, this.leanZS * 0.4 * riderFrac);
      this.updateMass();
    }

    const vLongBody = this.velocity.dot(this.forward);
    this.speed = vLongBody;
    const absV = Math.abs(vLongBody);
    const steerMax = lerp(p.steerMax, 0.12, smoothstep(0, 32, absV));
    this.steerAngle = this.steerS * steerMax;

    // ---- suspension rays ----
    const world = this.phys.world;
    let grounded = 0;
    let trackGrounded = 0;
    let trackLoad = 0;
    let maxLoad = -1;
    const nAvg = _v2.set(0, 0, 0);
    let wasAir = this.groundedCount === 0;
    for (const c of this.contacts) {
      const origin = _v.copy(c.local).applyQuaternion(this.quaternion).add(this.position);
      this.ray.origin = origin;
      this.ray.dir = { x: -this.up.x, y: -this.up.y, z: -this.up.z };
      const hit = world.castRayAndGetNormal(this.ray, c.maxLen, true, undefined, undefined, undefined, body);
      c.prevCompression = c.compression;
      c.grounded = false;
      c.load = 0;
      if (!hit) { c.compression = 0; continue; }
      const toi = hit.timeOfImpact;
      c.hitPoint.copy(origin).addScaledVector(this.up, -toi);
      const sid = this.terrain.surfaceAt(c.hitPoint.x, c.hitPoint.z);
      const s = SURFACES[sid];
      c.surface = s;

      // sinking: slow + heavy + small footprint sinks deeper; speed planes you up
      let sinkT = sinkTarget(s, absV, p.flotation, c.load > 0 ? c.load / c.nominalLoad : 1);
      // riding in an existing rut: that snow is already packed down
      sinkT *= 1 - 0.75 * clamp(this.terrain.packedAt(c.hitPoint.x, c.hitPoint.z) / (s.sinkDepth + 0.02), 0, 1);
      if (c.isSki) sinkT *= 1 + H.lean.forwardSkiSink * this.leanZS; // nose digs in when leaning forward, floats when leaning back
      if (!c.isSki && c.slip > 0.3 && s.sinkDepth > 0.1) sinkT += s.sinkDepth * H.bog.digPerSlip * (c.slip - 0.3); // wheelspin trenches the track
      sinkT = clamp(sinkT, 0, s.sinkDepth * 1.4);
      c.sink += (sinkT - c.sink) * Math.min(1, dt * (sinkT > c.sink ? 2.2 : 4));

      const bump = s.roughness > 0 ? s.roughness * (1 - p.roughAbsorb) * bumpNoise(c.hitPoint.x, c.hitPoint.z) : 0;
      const comp = c.maxLen - toi - c.sink + bump;
      if (comp <= 0) { c.compression = 0; continue; }
      c.compression = comp;
      c.grounded = true;
      grounded++;
      const n = hit.normal;
      nAvg.x += n.x; nAvg.y += n.y; nAvg.z += n.z;

      // compression speed from the body's real velocity at the attach point (no first-contact spike
      // after a teleport or touchdown, which a finite difference of compression would give)
      const va = body.velocityAtPoint(origin);
      const compVel = -(va.x * this.up.x + va.y * this.up.y + va.z * this.up.z);
      // stiffer rebound than compression so the rear doesn't buck back up after a hit
      let F = c.k * comp + c.c * compVel * (compVel < 0 ? H.suspension.reboundMult * p.reboundAdj : 1);
      if (comp > c.travel) F += c.k * 10 * (comp - c.travel) + c.c * 2 * Math.max(0, compVel); // bump stop
      F = Math.max(0, F);
      c.load = F;
      if (!c.isSki) { trackGrounded++; trackLoad += F; }
      if (!c.isSki && F > maxLoad) { maxLoad = F; this.surface = s; }
      body.applyImpulseAtPoint(scale(this.up, F * dt), origin, true);
    }
    if (grounded > 0) nAvg.normalize(); else nAvg.copy(this.up);
    this.groundNormal.copy(nAvg);
    if (trackGrounded === 0) {
      const ski = this.contacts.find((c) => c.grounded);
      if (ski) this.surface = ski.surface;
    }

    // landing detection
    if (grounded === 0) { this.airTime += dt; }
    else {
      if (wasAir && this.airTime > 0.25) {
        this.lastAirTime = this.airTime;
        this.landingImpact = Math.max(0, -this.velocity.y);
      }
      this.airTime = 0;
    }
    this.groundedCount = grounded;

    // ---- engine / CVT ----
    const reverseWanted = input.brake > 0.5 && absV < 1.2 && input.throttle < 0.1;
    this.brakeHold = reverseWanted ? this.brakeHold + dt : 0;
    if (this.brakeHold > 0.45) this.reversing = true;
    if (input.throttle > 0.1 || input.brake < 0.2) this.reversing = false;
    const thr = this.reversing ? input.brake : this.throttleS;
    const shiftRatio = clamp(absV / p.topSpeed, 0, 1.1);
    const freeSpin = trackGrounded === 0 ? 1 : this.trackSlip;
    let rpmTarget = thr > 0.02
      ? lerp(p.engageRpm, p.peakRpm, Math.min(1, thr * 1.25))
      : p.idleRpm + shiftRatio * 2500;
    rpmTarget = Math.max(rpmTarget, lerp(p.idleRpm, p.peakRpm, smoothstep(0.1, 0.9, shiftRatio)) * (thr > 0.02 ? 1 : 0.7));
    rpmTarget += (p.maxRpm - rpmTarget) * smoothstep(0.85, 1.0, shiftRatio) * thr;
    rpmTarget += freeSpin * thr * 900;
    rpmTarget = Math.min(rpmTarget, p.maxRpm + 200);
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * (rpmTarget > this.rpm ? 9 : 4));

    const r = this.rpm / p.peakRpm;
    const curve = clamp(1 - Math.pow((r - 1) / 0.5, 2), 0.2, 1);
    const engage = smoothstep(p.engageRpm - 400, p.engageRpm + 500, this.rpm);
    let driveF = (thr * p.powerW * curve * engage) / Math.max(absV, 3);
    // launch pull is limited by gearing (scales with engine output) and by the sled's weight on the track
    driveF = Math.min(driveF * (absV < 12 ? p.tractiveMult : 1), (p.powerW / 33) * p.tractiveMult, p.mass * GRAVITY * p.tractiveMult);
    const vTop = this.reversing ? 6 : p.topSpeed;
    driveF *= clamp((vTop - absV) / (vTop * 0.05), 0, 1);
    if (this.reversing) driveF *= -0.35;

    // ---- per-contact friction ----
    const mEff = p.mass / Math.max(1, grounded);
    let slipSum = 0;
    let surfCap = 0;
    const steerSign = Math.sign(this.steerS) || 0;
    const leanInto = clamp(this.leanXS * steerSign, -1, 1); // + leaning into the turn, - counter-leaning
    for (const c of this.contacts) {
      if (!c.grounded) { c.slip = trackGrounded === 0 && !c.isSki ? 1 : 0; continue; }
      const s = c.surface;
      surfCap += s.speedCap;
      _n.copy(nAvg);
      _f.copy(this.forward);
      if (c.isSki) _f.applyAxisAngle(this.up, -this.steerAngle);
      _f.addScaledVector(_n, -_f.dot(_n)).normalize();
      _r.crossVectors(_n, _f); // points to local +X (rider's left)
      const pt = c.hitPoint;
      const vp = body.velocityAtPoint(pt);
      const vLat = vp.x * _r.x + vp.y * _r.y + vp.z * _r.z;
      const vLong = vp.x * _f.x + vp.y * _f.y + vp.z * _f.z;
      const N = c.load;
      const softness = smoothstep(0.05, 0.3, s.sinkDepth);
      // apply forces near the roll centre (not at the snow) so the sled doesn't trip over itself
      const ap = _v.copy(pt).lerp(this.position, 0.55);

      // ---- longitudinal first (track), so the friction circle knows what's left for cornering ----
      let longF = 0;
      let longUsed = 0;
      const hard = s.sinkDepth < 0.05 && s.roughness < 0.1 && s.rollingDrag < 0.03; // ice / crust / groomed
      const icy = s.grip < 0.8 && hard; // ice and wind crust
      let mu = s.grip * lerp(1, p.powderTraction, softness) * (c.isSki ? 1 : 1 + H.lean.backTraction * -this.leanZS);
      if (!c.isSki && icy) mu += p.studGrip;
      if (!c.isSki) {
        const share = trackLoad > 0 ? N / trackLoad : 0;
        const cap = mu * N;
        const want = driveF * share;
        const applied = clamp(want, -cap, cap);
        c.slip = cap > 0 ? clamp((Math.abs(want) - cap) / cap, 0, 1) : 1;
        slipSum += c.slip;
        longF += applied;
        longUsed += Math.abs(applied);
        if (input.brake > 0 && !this.reversing) {
          const bF = Math.min(input.brake * p.mass * 7 * share, mu * N);
          const bApplied = Math.min(bF, (Math.abs(vLong) * mEff) / dt);
          longF -= Math.sign(vLong) * bApplied;
          longUsed += bApplied;
        }
      }
      const roll = (s.rollingDrag + (c.isSki ? 0 : (s.sinkDepth < 0.1 ? p.hardpackDrag : 0))) * N + sinkDragForce(s, c.sink, N, vLong);
      longF -= Math.sign(vLong) * Math.min(roll, (Math.abs(vLong) * mEff) / dt);
      body.applyImpulseAtPoint(scale(_f, longF * dt), ap, true);

      // ---- lateral: slip-angle curve (grip builds, peaks, then slides) ----
      let latMu = s.lateralGrip * (c.isSki ? 0.85 + p.handling * 0.35 : 0.9);
      if (icy) latMu = latMu * p.hardGrip + (c.isSki ? 0 : p.studGrip * 0.6);
      if (c.isSki && hard) latMu *= p.skiBite;
      if (c.isSki) {
        latMu *= leanInto >= 0 ? 1 + leanInto * H.lean.carveGrip : 1 + leanInto * H.lean.counterLeanPenalty;
        latMu *= 1 + H.lean.forwardSkiGrip * this.leanZS; // weight on the skis = more bite
      }
      let latCap = latMu * N;
      if (!c.isSki) latCap = Math.sqrt(Math.max(0, latCap * latCap - longUsed * longUsed * 0.8)); // spinning/braking track lets the rear step out
      const slipAngle = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), 1));
      const peak = THREE.MathUtils.degToRad(c.isSki ? H.slip.skiPeakDeg : H.slip.trackPeakDeg);
      const curve = slipAngle < peak ? slipAngle / peak : lerp(1, H.slip.slideRatio, smoothstep(peak, peak * 3, slipAngle));
      const k = Math.abs(vLat) < H.slip.lowSpeedGrip && Math.abs(vLong) < 3 ? 1 : curve;
      const latJ = -Math.sign(vLat) * Math.min(Math.abs(vLat) * mEff, latCap * k * dt);
      if (!c.isSki) c.slip = Math.max(c.slip, smoothstep(peak, peak * 3, slipAngle) * 0.6); // sideways slide sprays too
      body.applyImpulseAtPoint(scale(_r, latJ), ap, true);
    }
    this.trackSlip = trackGrounded > 0 ? slipSum / trackGrounded : 1;
    this.trackSpeed += ((trackGrounded > 0 ? vLongBody + this.trackSlip * 15 * Math.sign(driveF || 1) : thr * 25) - this.trackSpeed) * Math.min(1, dt * 6);

    // ---- aero + surface speed caps ----
    const vMag = this.velocity.length();
    if (vMag > 0.1) {
      let drag = 0.5 * 1.2 * p.dragArea * vMag * vMag;
      if (grounded > 0) {
        const cap = surfCap / grounded / 3.6;
        if (vMag > cap) drag += p.mass * (vMag - cap) * 0.9;
      }
      body.applyImpulse(scale(this.velocity, (-drag / vMag) * dt), true);
    }

    // ---- stability, steering assist, lean, air control ----
    const av = body.angvel();
    const angVel = new THREE.Vector3(av.x, av.y, av.z);
    const I = p.mass * 0.8; // rough inertia scale for assists
    if (grounded >= 3) {
      // steering assist toward the bicycle-model yaw rate, limited by front-ski grip
      const frontGrip = (this.contacts[0].surface.lateralGrip + this.contacts[1].surface.lateralGrip) / 2;
      // side lean steers by itself – a little on hardpack, a lot in powder where sleds are ridden on edge
      const soft = smoothstep(0.05, 0.3, this.surface.sinkDepth);
      const leanSteer = this.leanXS * lerp(H.lean.leanSteerHard, H.lean.leanSteerPowder, soft);
      const desiredYaw = (-vLongBody * Math.tan(clamp(this.steerAngle + leanSteer, -0.7, 0.7))) / 1.6;
      const yawNow = angVel.dot(this.up);
      const towK = p.mass / (p.mass + this.towMass * 1.6); // a trailer resists rotation: wider turns
      const yawT = (desiredYaw - yawNow) * I * H.assist.yawAssist * towK * clamp(frontGrip * 1.3, 0.15, 1) * smoothstep(0.5, 4, absV);
      // self-righting toward the ground normal, tilted by side lean (sidehilling / carving)
      _q.setFromAxisAngle(this.forward, -this.leanXS * H.lean.rollTargetRad);
      const desiredUp = _v.copy(nAvg).applyQuaternion(_q);
      const rightAxis = _v2.crossVectors(this.up, desiredUp);
      const rollAxisAmt = rightAxis.dot(this.forward);
      const rollRate = angVel.dot(this.forward);
      const rollT = (rollAxisAmt * H.assist.rollStiffness - rollRate * H.assist.rollDamping) * I;
      const torque = new THREE.Vector3()
        .addScaledVector(this.up, yawT)
        .addScaledVector(this.forward, rollT);
      body.applyTorqueImpulse(scale(torque, dt), true);
    } else if (grounded === 0) {
      // In the air the rider rotates the sled with body English plus track gyro (throttle = nose up,
      // brake = nose down). Torques are fixed, so heavier setups rotate slower.
      const air = tricksData.air;
      const k = this.airControlScale;
      const pitchIn = -this.leanZS + (this.throttleS - input.brake) * air.gyroThrottle;
      const t = new THREE.Vector3()
        .addScaledVector(this.right, pitchIn * air.pitchTorque * k)
        .addScaledVector(this.up, -this.steerS * air.yawTorque * k)
        .addScaledVector(this.forward, this.leanXS * air.rollTorque * k);
      // a sled flies roughly nose-first: weak pitch alignment with the flight path, faded out
      // while the rider is pitching so flips aren't fought
      const vLen = this.velocity.length();
      if (vLen > 5) {
        const pitchErr = new THREE.Vector3().crossVectors(this.forward, this.velocity.clone().multiplyScalar(1 / vLen)).dot(this.right);
        const settle = 1 - clamp(Math.abs(pitchIn), 0, 1);
        const pitchRate = new THREE.Vector3(body.angvel().x, body.angvel().y, body.angvel().z).dot(this.right);
        t.addScaledVector(this.right, (pitchErr * air.flightAlign - pitchRate * air.flightAlign * 0.25) * settle);
      }
      // let go of steer/side-lean and the rider checks the spin/roll (body English the other way)
      const w = body.angvel();
      const yawRate = w.x * this.up.x + w.y * this.up.y + w.z * this.up.z;
      const rollRate = w.x * this.forward.x + w.y * this.forward.y + w.z * this.forward.z;
      t.addScaledVector(this.up, -yawRate * air.spinCheck * (1 - Math.abs(this.steerS)) * k);
      t.addScaledVector(this.forward, -rollRate * air.spinCheck * (1 - Math.abs(this.leanXS)) * k);
      // arcade landing assist: coming down near the ground, rotate toward the slope you'll land on
      if (this.velocity.y < 0) {
        this.ray.origin = this.position;
        this.ray.dir = { x: 0, y: -1, z: 0 };
        const g = world.castRayAndGetNormal(this.ray, H.assist.landingRange, true, undefined, undefined, undefined, body);
        if (g) {
          const near = 1 - g.timeOfImpact / H.assist.landingRange;
          const busy = clamp(Math.abs(pitchIn) + Math.abs(this.steerS), 0, 1);
          const axis = new THREE.Vector3().crossVectors(this.up, new THREE.Vector3(g.normal.x, g.normal.y, g.normal.z));
          axis.addScaledVector(this.up, -axis.dot(this.up)); // pitch/roll only, never yaw
          const w2 = new THREE.Vector3(body.angvel().x, body.angvel().y, body.angvel().z);
          w2.addScaledVector(this.up, -w2.dot(this.up));
          t.addScaledVector(axis, H.assist.landingAssist * near * (1 - 0.7 * busy));
          t.addScaledVector(w2, -H.assist.landingAssist * 0.18 * near * (1 - 0.7 * busy));
        }
      }
      body.applyTorqueImpulse(scale(t, dt), true);
    }
    body.setAngularDamping(grounded === 0 ? 0.15 : 0.6);
  }

  /** Smoothed throttle 0..1 – drives spray and audio. */
  throttleSpray(): number {
    return this.throttleS;
  }

  /** Upside down or on its side for a while → Sled shows a recover prompt. */
  isFlipped(): boolean {
    return this.up.y < 0.25;
  }
}

function scale(v: THREE.Vector3, s: number) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/** Cheap pseudo-random bumps in roughly [-1, 1] for rough surfaces. */
function bumpNoise(x: number, z: number): number {
  return Math.sin(x * 1.9 + Math.sin(z * 0.7) * 2) * Math.sin(z * 2.3 + x * 0.4) * 0.7 + Math.sin(x * 5.1 - z * 4.3) * 0.3;
}
