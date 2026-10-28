import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld, GRAVITY } from '../physics/PhysicsWorld';
import { SURFACES, SurfaceDef } from '../physics/Surfaces';
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
    phys.world.createCollider(R.ColliderDesc.cuboid(0.5, 0.22, 1.35).setTranslation(0, 0.27, 0.05).setDensity(0).setFriction(0.25).setRestitution(0.05), this.body);
    phys.world.createCollider(R.ColliderDesc.cuboid(0.32, 0.25, 0.3).setTranslation(0, 0.65, -0.55).setDensity(0).setFriction(0.3), this.body); // seat/rider hip
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
      const k = load / sag;
      const mEff = load / GRAVITY;
      return {
        local: new THREE.Vector3(x, 0, z), isSki, side: x > 0 ? -1 : 1,
        maxLen: BASE_HEIGHT + travel, travel, k, c: 2 * zeta * Math.sqrt(k * mEff),
        compression: 0, prevCompression: 0, grounded: false, load: 0, sink: 0,
        surface: SURFACES[0], hitPoint: new THREE.Vector3(), slip: 0,
      };
    };
    const hs = p.stance / 2;
    this.contacts.push(mk(hs, 1.08, true, p.travelFront, frontLoad / 2, p.springZetaFront));
    this.contacts.push(mk(-hs, 1.08, true, p.travelFront, frontLoad / 2, p.springZetaFront));
    const tw = p.trackWidth * 0.38;
    const zf = 0.2;
    const zr = zf - p.trackContactLen;
    for (const z of [zf, zr]) for (const x of [tw, -tw]) this.contacts.push(mk(x, z, false, p.travelRear, rearLoad / 4, p.springZetaRear));
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
    this.throttleS += (input.throttle - this.throttleS) * Math.min(1, dt * 7);
    this.steerS += (input.steer - this.steerS) * Math.min(1, dt * 9);
    const lx = this.leanXS, lz = this.leanZS;
    this.leanXS += (input.leanX - this.leanXS) * Math.min(1, dt * 6);
    this.leanZS += (input.leanZ - this.leanZS) * Math.min(1, dt * 6);
    if (Math.abs(lx - this.leanXS) + Math.abs(lz - this.leanZS) > 0.01 || this.massDirty) {
      // rider is ~25% of the mass and moves ~0.35 m: shift the COM accordingly
      const riderFrac = clamp(82 / p.mass, 0.15, 0.4) * 1.6;
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
      const plane = s.planingSpeed * Math.pow(1 / p.flotation, 0.8);
      let sinkTarget = s.sinkDepth * clamp(1 - absV / Math.max(plane, 0.01), 0, 1) * clamp(1 / p.flotation, 0.6, 1.6);
      if (!c.isSki && c.slip > 0.5 && s.sinkDepth > 0.1) sinkTarget += s.sinkDepth * 0.3 * (c.slip - 0.5); // trenching from wheelspin
      sinkTarget = Math.min(sinkTarget, s.sinkDepth * 1.3);
      c.sink += (sinkTarget - c.sink) * Math.min(1, dt * (sinkTarget > c.sink ? 2.2 : 4));

      const bump = s.roughness > 0 ? s.roughness * bumpNoise(c.hitPoint.x, c.hitPoint.z) : 0;
      const comp = c.maxLen - toi - c.sink + bump;
      if (comp <= 0) { c.compression = 0; continue; }
      c.compression = comp;
      c.grounded = true;
      grounded++;
      const n = hit.normal;
      nAvg.x += n.x; nAvg.y += n.y; nAvg.z += n.z;

      const compVel = (c.compression - c.prevCompression) / dt;
      let F = c.k * comp + c.c * compVel;
      if (comp > c.travel) F += c.k * 10 * (comp - c.travel) + c.c * 2 * Math.max(0, compVel); // bump stop
      F = Math.max(0, F);
      c.load = F;
      if (!c.isSki) { trackGrounded++; trackLoad += F; }
      if (!c.isSki && F > maxLoad) { maxLoad = F; this.surface = s; }
      body.applyImpulseAtPoint(scale(this.up, F * dt), origin, true);
    }
    if (grounded > 0) nAvg.normalize(); else nAvg.copy(this.up);
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
    driveF = Math.min(driveF, p.mass * GRAVITY * 1.0);
    const vTop = this.reversing ? 6 : p.topSpeed;
    driveF *= clamp((vTop - absV) / (vTop * 0.05), 0, 1);
    if (this.reversing) driveF *= -0.35;

    // ---- per-contact friction ----
    const mEff = p.mass / Math.max(1, grounded);
    let slipSum = 0;
    let surfCap = 0;
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

      // lateral: kill sideways velocity up to the friction limit
      let latMu = s.lateralGrip * (c.isSki ? 0.85 + p.handling * 0.35 : 0.9);
      if (c.isSki) {
        // leaning into the turn makes the inside ski bite (carving)
        const carve = clamp(this.leanXS * Math.sign(this.steerS || 1), 0, 1);
        latMu *= 1 + carve * 0.35;
      }
      const latNeed = -vLat * mEff;
      const latMax = latMu * N * dt;
      const latJ = clamp(latNeed, -latMax, latMax);
      // apply lateral force near roll centre (not at the snow) so the sled doesn't trip over itself
      const ap = _v.copy(pt).lerp(this.position, 0.55);
      body.applyImpulseAtPoint(scale(_r, latJ), ap, true);

      // longitudinal: drive (track), brake, rolling + sink drag
      let longF = 0;
      const sinkDrag = s.sinkDrag * c.sink * N * clamp(Math.abs(vLong) / 4, 0.25, 1);
      const roll = (s.rollingDrag + (c.isSki ? 0 : (s.sinkDepth < 0.1 ? p.hardpackDrag : 0))) * N + sinkDrag;
      if (!c.isSki) {
        const share = trackLoad > 0 ? N / trackLoad : 0;
        const softness = smoothstep(0.05, 0.3, s.sinkDepth);
        const mu = s.grip * lerp(1, p.powderTraction, softness);
        const cap = mu * N;
        const want = driveF * share;
        const applied = clamp(want, -cap, cap);
        c.slip = cap > 0 ? clamp((Math.abs(want) - cap) / cap, 0, 1) : 1;
        slipSum += c.slip;
        longF += applied;
        // brakes act on the track/driveshaft
        if (input.brake > 0 && !this.reversing) {
          const bF = Math.min(input.brake * p.mass * 7 * share, mu * N);
          longF -= Math.sign(vLong) * Math.min(bF, (Math.abs(vLong) * mEff) / dt);
        }
      }
      const rollF = Math.min(roll, (Math.abs(vLong) * mEff) / dt);
      longF -= Math.sign(vLong) * rollF;
      body.applyImpulseAtPoint(scale(_f, longF * dt), ap, true);
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
      const desiredYaw = (-vLongBody * Math.tan(this.steerAngle)) / 1.6;
      const yawNow = angVel.dot(this.up);
      const yawT = (desiredYaw - yawNow) * I * 3.5 * clamp(frontGrip * 1.3, 0.15, 1) * smoothstep(0.5, 4, absV);
      // self-righting toward the ground normal, tilted by side lean (sidehilling / carving)
      _q.setFromAxisAngle(this.forward, -this.leanXS * 0.32);
      const desiredUp = _v.copy(nAvg).applyQuaternion(_q);
      const rightAxis = _v2.crossVectors(this.up, desiredUp);
      const rollAxisAmt = rightAxis.dot(this.forward);
      const rollRate = angVel.dot(this.forward);
      const rollT = (rollAxisAmt * 9 - rollRate * 1.6) * I;
      const torque = new THREE.Vector3()
        .addScaledVector(this.up, yawT)
        .addScaledVector(this.forward, rollT);
      body.applyTorqueImpulse(scale(torque, dt), true);
    } else if (grounded === 0) {
      // in the air the rider can pitch the sled with body + throttle/brake (gyro of the track)
      const airTorque = 900; // N·m the rider can generate – fixed, so heavier sleds rotate slower
      const pitchIn = this.leanZS + (this.throttleS - input.brake) * 0.35;
      const t = new THREE.Vector3().addScaledVector(this.right, pitchIn * airTorque);
      body.applyTorqueImpulse(scale(t, dt), true);
    }
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
