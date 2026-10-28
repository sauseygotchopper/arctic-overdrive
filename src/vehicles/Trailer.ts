import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import trailerData from '../data/trailers.json';
import { PhysicsWorld, GRAVITY } from '../physics/PhysicsWorld';
import { SURFACES, SurfaceDef, sinkTarget, sinkDragForce } from '../physics/Surfaces';
import { TerrainData } from '../world/TerrainData';
import { CargoItem, CargoType, LooseCargo } from './Cargo';
import { SledPhysics } from './SledPhysics';
import { box, cyl, skiMesh } from './geometry';
import { clamp, lerp, smoothstep } from '../world/Noise';
import H from '../data/handling.json';

type Upgrades = typeof trailerData.upgrades;
export type SuspensionId = Upgrades['suspension'][number]['id'];
export type SkisId = Upgrades['skis'][number]['id'];
export type TieDownId = Upgrades['tieDowns'][number]['id'];
export interface TrailerUpgrades { suspension: string; skis: string; tieDowns: string }
export const TRAILER = trailerData;

export type TrailerEvent =
  | { type: 'jackknife' }
  | { type: 'flipped'; spilled: number }
  | { type: 'hardLanding'; impact: number; spilled: number; damaged: boolean }
  | { type: 'bottomOut' };

interface TContact {
  local: THREE.Vector3;
  side: number;
  isSki: true;
  grounded: boolean;
  compression: number;
  prevCompression: number;
  load: number;
  sink: number;
  slip: number;
  surface: SurfaceDef;
  hitPoint: THREE.Vector3;
}

const BASE = 0.22;
const NOMINAL_PAYLOAD = 130; // kg the stock springs are sized for
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Tow-behind sled trailer: its own rigid body on two skis (raycast contacts), joined to the sled's
 * hitch with a spherical joint. Rapier's JS spherical joint has no angle limits, so yaw/pitch/roll
 * limits are soft torques applied here; hitting the yaw limit at speed is a jackknife.
 */
export class Trailer {
  readonly body: RAPIER.RigidBody;
  readonly root = new THREE.Group();
  readonly contacts: TContact[] = [];
  readonly cargo: CargoItem[] = [];
  readonly events: TrailerEvent[] = [];
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly forward = new THREE.Vector3();
  readonly up = new THREE.Vector3();
  readonly right = new THREE.Vector3();
  readonly anchorLocal: THREE.Vector3;
  sled: SledPhysics | null = null;
  hitchYaw = 0; // rad, + = trailer swung to sled's left
  jackknifed = false;
  flipped = false;

  private joint: RAPIER.ImpulseJoint | null = null;
  private cargoCollider: RAPIER.Collider | null = null;
  private cargoGroup = new THREE.Group();
  private strapGroup = new THREE.Group();
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private airTime = 0;
  private flipTime = 0;
  private jackCooldown = 0;
  private bottomCooldown = 0;
  private skiL = new THREE.Group();
  private skiR = new THREE.Group();
  private ray: RAPIER.Ray;
  private k = 0;
  private c = 0;
  private travel = 0.09;
  private skiWidth = 0.11;
  private latGrip = 1;
  private spillChance = 0.9;
  private damageMult = 1;
  private cargoTop = 0;

  constructor(private phys: PhysicsWorld, private terrain: TerrainData, private loose: LooseCargo, public upgrades: TrailerUpgrades, pos: THREE.Vector3, yaw: number) {
    const R = phys.R;
    const b = TRAILER.base;
    this.anchorLocal = new THREE.Vector3(0, 0.26, b.deckLength / 2 + b.tongueLength);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = phys.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setAngularDamping(0.8)
        .setLinearDamping(0.02)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    // deck collider sits a little high and slippery: in deep snow the trailer ploughs rather than high-centres
    phys.world.createCollider(R.ColliderDesc.cuboid(b.deckWidth / 2, 0.08, b.deckLength / 2).setTranslation(0, 0.18, 0).setDensity(0).setFriction(0.08), this.body);
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const hs = b.skiTrack / 2, hz = b.skiLength * 0.33;
    for (const [x, z] of [[hs, hz], [-hs, hz], [hs, -hz], [-hs, -hz]]) {
      this.contacts.push({
        local: new THREE.Vector3(x, 0, z), side: x > 0 ? -1 : 1, isSki: true, grounded: false, compression: 0, prevCompression: 0,
        load: 0, sink: 0, slip: 0, surface: SURFACES[0], hitPoint: new THREE.Vector3(),
      });
    }
    this.buildVisual();
    this.applyUpgrades();
    this.readState();
    this.prevPos.copy(this.position);
    this.prevQuat.copy(this.quaternion);
  }

  get skiWidthM(): number {
    return this.skiWidth;
  }

  get payloadMass(): number {
    return this.cargo.reduce((a, c) => a + c.def.massKg, 0);
  }
  get mass(): number {
    return TRAILER.base.emptyMassKg + this.payloadMass;
  }

  applyUpgrades() {
    const U = TRAILER.upgrades;
    const sus = U.suspension.find((x) => x.id === this.upgrades.suspension) ?? U.suspension[0];
    const ski = U.skis.find((x) => x.id === this.upgrades.skis) ?? U.skis[0];
    const tie = U.tieDowns.find((x) => x.id === this.upgrades.tieDowns) ?? U.tieDowns[0];
    this.travel = sus.travel;
    const designLoad = ((TRAILER.base.emptyMassKg + NOMINAL_PAYLOAD) * GRAVITY) / 4;
    this.k = (designLoad / (0.45 * this.travel)) * sus.stiffness;
    this.c = 2 * 0.55 * Math.sqrt(this.k * (designLoad / GRAVITY)) * sus.damping;
    this.skiWidth = ski.width;
    this.latGrip = ski.lateralGrip;
    this.spillChance = tie.spillChance;
    this.damageMult = tie.damageMult;
    for (const s of [this.skiL, this.skiR]) s.scale.x = ski.width / 0.11;
    this.strapGroup.visible = tie.id !== 'none';
    this.updateMass();
  }

  setCargo(types: CargoType[]) {
    for (const c of this.cargo) c.mesh.removeFromParent();
    this.cargo.length = 0;
    for (const t of types) this.cargo.push(new CargoItem(t));
    this.layoutCargo();
    this.updateMass();
  }

  /** Simple packing: rows of two across the deck, stacking up when the deck is full. */
  private layoutCargo() {
    const b = TRAILER.base;
    const cols = 2, rows = 3;
    const cellX = (b.deckWidth - 0.1) / cols, cellZ = (b.deckLength - 0.1) / rows;
    const heights = new Array(cols * rows).fill(0.11);
    this.cargo.forEach((c, i) => {
      const cell = i % (cols * rows);
      const cx = cell % cols, cz = Math.floor(cell / cols);
      const y = heights[cell];
      c.mesh.position.set((cx - 0.5) * cellX, y + c.def.size[1] / 2, (1 - cz) * cellZ);
      c.mesh.rotation.set(0, (Math.random() - 0.5) * 0.15, 0);
      heights[cell] = y + c.def.size[1];
      this.cargoGroup.add(c.mesh);
    });
    this.cargoTop = Math.max(0.11, ...heights);
    this.strapGroup.scale.y = Math.max(0.1, this.cargoTop - 0.1) / 0.5;
    this.strapGroup.position.y = 0.1;
  }

  private updateMass() {
    const m = this.mass;
    const b = TRAILER.base;
    const payload = this.payloadMass;
    // cargo raises the COM – stacked loads tip over sooner
    const comY = 0.05 + (payload / m) * (this.cargoTop * 0.45);
    const w = b.deckWidth, l = b.deckLength + 0.6, h = 0.3 + this.cargoTop;
    this.body.setAdditionalMassProperties(
      m, { x: 0, y: comY, z: 0.12 },
      { x: (m / 12) * (h * h + l * l), y: (m / 12) * (w * w + l * l), z: (m / 12) * (w * w + h * h) },
      { x: 0, y: 0, z: 0, w: 1 }, true,
    );
    // a box collider for the load so it hits things (and the ground when it rolls)
    if (this.cargoCollider) this.phys.world.removeCollider(this.cargoCollider, false);
    this.cargoCollider = null;
    if (this.cargoTop > 0.15) {
      const hh = (this.cargoTop - 0.1) / 2;
      this.cargoCollider = this.phys.world.createCollider(
        this.phys.R.ColliderDesc.cuboid(b.deckWidth / 2 - 0.05, hh, b.deckLength / 2 - 0.05).setTranslation(0, 0.1 + hh, 0).setDensity(0).setFriction(0.4),
        this.body,
      );
    }
  }

  // ---------- hitch ----------

  attach(sled: SledPhysics) {
    this.detach();
    this.sled = sled;
    const R = this.phys.R;
    const params = R.JointData.spherical(
      { x: sled.hitchLocal.x, y: sled.hitchLocal.y, z: sled.hitchLocal.z },
      { x: this.anchorLocal.x, y: this.anchorLocal.y, z: this.anchorLocal.z },
    );
    this.joint = this.phys.world.createImpulseJoint(params, sled.body, this.body, true);
    this.joint.setContactsEnabled(false);
    sled.towMass = this.mass;
  }

  detach() {
    if (this.joint) this.phys.world.removeImpulseJoint(this.joint, true);
    this.joint = null;
    if (this.sled) this.sled.towMass = 0;
    this.sled = null;
  }

  /** Place the trailer straight behind the sled's hitch (spawn / recover). */
  placeBehind(sled: SledPhysics) {
    sled.readState();
    const hitchW = sled.hitchLocal.clone().applyQuaternion(sled.quaternion).add(sled.position);
    const yaw = Math.atan2(sled.forward.x, sled.forward.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const pos = hitchW.clone().sub(this.anchorLocal.clone().applyQuaternion(q));
    pos.y = Math.max(pos.y, this.terrain.heightAt(pos.x, pos.z) + 0.45);
    this.body.setTranslation(pos, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel(sled.body.linvel(), true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.flipped = false;
    this.flipTime = 0;
    this.readState();
    this.prevPos.copy(this.position);
    this.prevQuat.copy(this.quaternion);
  }

  readState() {
    const t = this.body.translation(), r = this.body.rotation(), v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.velocity.set(v.x, v.y, v.z);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.right.set(-1, 0, 0).applyQuaternion(this.quaternion);
  }

  // ---------- simulation ----------

  fixedUpdate(dt: number) {
    this.prevPos.copy(this.position);
    this.prevQuat.copy(this.quaternion);
    this.readState();
    if (this.sled) this.sled.towMass = this.mass;
    const body = this.body;
    const m = this.mass;
    const speed = this.velocity.dot(this.forward);
    // unpowered skis plane far later than a driven track (planingMult) – expressed as lower flotation
    const flotation = (2 * this.skiWidth * TRAILER.base.skiLength) / m / 0.0023 / Math.pow(TRAILER.base.planingMult, 1.25);
    const maxLen = BASE + this.travel;
    let grounded = 0;
    const wasAir = this.airTime > 0.3;
    const designLoad = ((TRAILER.base.emptyMassKg + NOMINAL_PAYLOAD) * GRAVITY) / 4;

    for (const c of this.contacts) {
      const origin = _v.copy(c.local).applyQuaternion(this.quaternion).add(this.position);
      this.ray.origin = origin;
      this.ray.dir = { x: -this.up.x, y: -this.up.y, z: -this.up.z };
      const sledHandle = this.sled?.body.handle;
      const hit = this.phys.world.castRayAndGetNormal(this.ray, maxLen, true, undefined, undefined, undefined, body,
        sledHandle === undefined ? undefined : (col) => col.parent()?.handle !== sledHandle);
      c.prevCompression = c.compression;
      c.grounded = false;
      c.load = 0;
      if (!hit) { c.compression = 0; continue; }
      c.hitPoint.copy(origin).addScaledVector(this.up, -hit.timeOfImpact);
      c.surface = SURFACES[this.terrain.surfaceAt(c.hitPoint.x, c.hitPoint.z)];
      let st = sinkTarget(c.surface, Math.abs(speed), flotation, c.compression > 0 ? (c.compression * this.k) / designLoad : 1);
      st *= 1 - 0.75 * clamp(this.terrain.packedAt(c.hitPoint.x, c.hitPoint.z) / (c.surface.sinkDepth + 0.02), 0, 1); // following the sled's rut
      c.sink += (st - c.sink) * Math.min(1, dt * (st > c.sink ? 2.2 : 4));
      const comp = maxLen - hit.timeOfImpact - c.sink + (c.surface.roughness > 0 ? c.surface.roughness * Math.sin(c.hitPoint.x * 2.1) * Math.sin(c.hitPoint.z * 1.7) : 0);
      if (comp <= 0) { c.compression = 0; continue; }
      c.compression = comp;
      c.grounded = true;
      grounded++;
      const va = body.velocityAtPoint(origin);
      const compVel = -(va.x * this.up.x + va.y * this.up.y + va.z * this.up.z);
      let F = this.k * comp + this.c * compVel * (compVel < 0 ? H.suspension.reboundMult : 1);
      if (comp > this.travel) {
        F += this.k * 12 * (comp - this.travel);
        if (compVel > 2.2 && this.bottomCooldown <= 0) {
          // bottoming out rattles the load
          this.damageCargo((compVel - 2.2) * 0.05);
          this.bottomCooldown = 0.5;
          this.events.push({ type: 'bottomOut' });
        }
      }
      F = Math.max(0, F);
      c.load = F;
      body.applyImpulseAtPoint({ x: this.up.x * F * dt, y: this.up.y * F * dt, z: this.up.z * F * dt }, origin, true);
    }
    this.bottomCooldown -= dt;

    // ski friction: strong sideways bite (tracks behind the sled), little rolling drag, no brakes
    const mEff = m / Math.max(1, grounded);
    for (const c of this.contacts) {
      if (!c.grounded) continue;
      _f.copy(this.forward);
      const nrm = this.up;
      _f.addScaledVector(nrm, -_f.dot(nrm)).normalize();
      _r.crossVectors(nrm, _f);
      const vp = body.velocityAtPoint(c.hitPoint);
      const vLat = vp.x * _r.x + vp.y * _r.y + vp.z * _r.z;
      const vLong = vp.x * _f.x + vp.y * _f.y + vp.z * _f.z;
      // slip-angle curve like the sled's skis: grips, peaks, then slides (swing-out on ice)
      const slipAngle = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), 1));
      const peak = THREE.MathUtils.degToRad(H.slip.skiPeakDeg);
      const curve = slipAngle < peak ? slipAngle / peak : lerp(1, H.slip.slideRatio, smoothstep(peak, peak * 3, slipAngle));
      const k = Math.abs(vLat) < H.slip.lowSpeedGrip && Math.abs(vLong) < 3 ? 1 : curve;
      const latMax = c.surface.lateralGrip * this.latGrip * c.load * k * dt;
      const latJ = -Math.sign(vLat) * Math.min(Math.abs(vLat) * mEff, latMax);
      c.slip = smoothstep(peak, peak * 3, slipAngle);
      const ap = _v.copy(c.hitPoint).lerp(this.position, 0.4);
      body.applyImpulseAtPoint({ x: _r.x * latJ, y: _r.y * latJ, z: _r.z * latJ }, ap, true);
      const drag = c.surface.rollingDrag * c.load + sinkDragForce(c.surface, c.sink, c.load, vLong) * TRAILER.base.ploughDrag;
      const dJ = Math.min(drag * dt, Math.abs(vLong) * mEff) * -Math.sign(vLong);
      body.applyImpulseAtPoint({ x: _f.x * dJ, y: _f.y * dJ, z: _f.z * dJ }, ap, true);
    }

    // landing / airtime
    if (grounded === 0) this.airTime += dt;
    else {
      if (wasAir) {
        const impact = Math.max(0, -this.velocity.y);
        if (impact > 4) {
          this.damageCargo((impact - 4) * 0.1);
          const spilled = impact > 8 ? this.spill((impact - 8) * 0.15) : 0;
          this.events.push({ type: 'hardLanding', impact, spilled, damaged: this.cargo.some((c) => c.def.fragile) });
        }
      }
      this.airTime = 0;
    }

    // tipped over → load spills (once per flip)
    if (this.up.y < 0.15) {
      this.flipTime += dt;
      if (this.flipTime > 0.3 && !this.flipped) {
        this.flipped = true;
        this.events.push({ type: 'flipped', spilled: this.spill(1) });
      }
    } else if (this.up.y > 0.7) {
      this.flipped = false;
      this.flipTime = 0;
    }

    if (this.sled) this.hitchLimits(dt);
  }

  /** Soft angle limits at the hitch (equal and opposite torques on sled and trailer). */
  private hitchLimits(dt: number) {
    const s = this.sled!;
    const b = TRAILER.base;
    const sUp = s.up;
    // yaw: trailer forward vs sled forward, measured in the sled's plane
    const tf = this.forward.clone().addScaledVector(sUp, -this.forward.dot(sUp)).normalize();
    const cross = new THREE.Vector3().crossVectors(s.forward, tf);
    this.hitchYaw = Math.atan2(cross.dot(sUp), s.forward.dot(tf));
    // pitch/roll: trailer up vs sled up
    const pitch = Math.asin(clamp(this.forward.dot(sUp), -1, 1));
    const roll = Math.asin(clamp(this.right.dot(sUp), -1, 1));
    const torque = new THREE.Vector3();
    const wRel = new THREE.Vector3().copy(this.body.angvel() as THREE.Vector3Like).sub(s.body.angvel() as THREE.Vector3Like);
    const limit = (angle: number, max: number, axis: THREE.Vector3, k: number) => {
      const over = Math.abs(angle) - max;
      if (over <= 0) return false;
      const rate = wRel.dot(axis);
      torque.addScaledVector(axis, -Math.sign(angle) * over * k - rate * k * 0.08);
      return true;
    };
    const yawLim = THREE.MathUtils.degToRad(b.hitchYawLimitDeg);
    // a braced heavy-duty hitch damps the trailer's swing (less swing-out, fewer jackknifes)
    if (s.params.hitchYawBonus > 0) {
      const swing = wRel.dot(sUp);
      torque.addScaledVector(sUp, -swing * s.params.hitchYawBonus * 60);
    }
    const hitYaw = limit(this.hitchYaw, yawLim, sUp, 22000);
    limit(-pitch, THREE.MathUtils.degToRad(b.hitchPitchLimitDeg), s.right, 14000);
    limit(roll, THREE.MathUtils.degToRad(b.hitchRollLimitDeg), s.forward, 9000);
    if (torque.lengthSq() > 0) {
      this.body.applyTorqueImpulse({ x: torque.x * dt, y: torque.y * dt, z: torque.z * dt }, true);
      s.body.applyTorqueImpulse({ x: -torque.x * dt, y: -torque.y * dt, z: -torque.z * dt }, true);
    }
    // jackknife: folded against the limit while moving – skis scrub sideways, everything slows
    this.jackCooldown -= dt;
    const moving = s.velocity.length() > 4;
    this.jackknifed = hitYaw && Math.abs(this.hitchYaw) > yawLim - 0.05;
    if (this.jackknifed && moving && this.jackCooldown <= 0) {
      this.events.push({ type: 'jackknife' });
      this.jackCooldown = 3;
    }
    if (this.jackknifed) {
      const v = s.body.linvel();
      const k = Math.exp(-dt * 1.2);
      s.body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, true);
    }
  }

  damageCargo(amount: number) {
    for (const c of this.cargo) c.damage(amount * this.damageMult);
  }

  /** Each item spills with chance = severity × tie-down spill chance. Returns how many fell off. */
  spill(severity: number): number {
    let n = 0;
    const chance = clamp(severity, 0, 1) * this.spillChance;
    for (const c of [...this.cargo]) {
      if (Math.random() > chance) continue;
      const wp = c.mesh.getWorldPosition(new THREE.Vector3());
      const wq = c.mesh.getWorldQuaternion(new THREE.Quaternion());
      this.cargo.splice(this.cargo.indexOf(c), 1);
      this.loose.spill(c, wp, wq, this.velocity);
      n++;
    }
    if (n) this.updateMass();
    return n;
  }

  render(alpha: number) {
    this.readState();
    this.root.position.lerpVectors(this.prevPos, this.position, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQuat, this.quaternion, alpha);
    const maxLen = BASE + this.travel;
    const len = (i: number, j: number) => maxLen - (this.contacts[i].compression + this.contacts[j].compression) / 2;
    this.skiL.position.y = -len(0, 2);
    this.skiR.position.y = -len(1, 3);
  }

  // ---------- visual ----------

  private buildVisual() {
    const b = TRAILER.base;
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.85 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.6 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.5 });
    const strap = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.7 });
    const deck = box(b.deckWidth, 0.06, b.deckLength, wood);
    deck.position.y = 0.08;
    this.root.add(deck);
    const frame = box(b.deckWidth + 0.04, 0.08, b.deckLength + 0.04, steel);
    frame.position.y = 0.02;
    this.root.add(frame);
    for (const s of [-1, 1]) {
      const rail = box(0.04, 0.22, b.deckLength, yellow);
      rail.position.set(s * (b.deckWidth / 2), 0.2, 0);
      this.root.add(rail);
    }
    const front = box(b.deckWidth, 0.22, 0.04, yellow);
    front.position.set(0, 0.2, b.deckLength / 2);
    this.root.add(front);
    // A-frame tongue
    const tip = this.anchorLocal.clone();
    for (const s of [-1, 1]) {
      const from = new THREE.Vector3(s * 0.4, 0.05, b.deckLength / 2);
      const bar = cyl(0.025, 1, steel);
      const dir = tip.clone().sub(from);
      bar.position.copy(from).addScaledVector(dir, 0.5);
      bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      bar.scale.y = dir.length();
      this.root.add(bar);
    }
    const coupler = box(0.08, 0.08, 0.16, steel);
    coupler.position.copy(tip);
    this.root.add(coupler);
    // skis + posts
    const hs = b.skiTrack / 2;
    for (const [g, x] of [[this.skiL, hs], [this.skiR, -hs]] as const) {
      g.position.set(x, -0.3, 0);
      g.add(skiMesh(b.skiLength, 0.11, steel));
      for (const z of [-0.5, 0.5]) {
        const post = cyl(0.03, 0.32, steel);
        post.position.set(0, 0.17, z);
        g.add(post);
      }
      this.root.add(g);
    }
    // ratchet straps (visible with tie-down upgrades), scaled to the load height
    for (const z of [-0.55, 0.55]) {
      for (const s of [-1, 1]) {
        const st = box(0.015, 0.5, 0.05, strap);
        st.position.set(s * (b.deckWidth / 2 - 0.03), 0.25, z);
        this.strapGroup.add(st);
      }
    }
    this.root.add(this.cargoGroup, this.strapGroup);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
  }

  dispose(scene: THREE.Scene) {
    this.detach();
    for (const c of this.cargo) c.mesh.removeFromParent();
    this.phys.world.removeRigidBody(this.body);
    scene.remove(this.root);
  }
}
