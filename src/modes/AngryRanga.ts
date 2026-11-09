import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import type { Game } from '../core/Game';
import { RangaModel } from './RangaModel';
import freerideData from '../data/freeride.json';

const C = freerideData.ranga;
const LEAP_SECONDS = 0.55;
/** Feet sit on the bar just inboard of the rider's hands. */
const STANCE = 0.26;

type State = 'lurk' | 'chase' | 'leapOn' | 'ride' | 'leapOff' | 'sulk';

/**
 * Freeride's resident menace. He lurks somewhere in the valley flexing; ride close and he gives chase on
 * foot, grunting. Caught, he leaps onto the handlebars and does deep squats facing the rider.
 */
export class AngryRanga {
  private model = new RangaModel(C.scale);
  private state: State = 'lurk';
  private pos = new THREE.Vector3();
  private yaw = 0;
  private t = 0;
  private stateT = 0;
  private gruntIn = 2;
  private phase = 0;
  private squats = 0;
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private barPos = new THREE.Vector3();
  private barQuat = new THREE.Quaternion();

  constructor(private game: Game) {}

  enter() {
    const g = this.game;
    g.scene.add(this.model.root);
    const sp = g.terrain.def.spawn;
    this.place(sp.x, sp.z, Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z), 0.9, C.firstDistance);
  }

  exit() {
    disposeObject(this.model.root);
  }

  /** Stand him somewhere clear, `range` metres from (x, z) within `spread` radians of `heading`. */
  private place(x: number, z: number, heading: number, spread: number, range: number[]) {
    const g = this.game;
    const lim = g.terrain.half - 90;
    for (let i = 0; i < 16; i++) {
      const a = heading + (Math.random() * 2 - 1) * spread;
      const d = range[0] + Math.random() * (range[1] - range[0]);
      this.pos.set(THREE.MathUtils.clamp(x + Math.sin(a) * d, -lim, lim), 0, THREE.MathUtils.clamp(z + Math.cos(a) * d, -lim, lim));
      let clear = true;
      g.scenery.obstacles.forEachNear(this.pos.x, this.pos.z, 3, () => { clear = false; });
      if (clear) break;
    }
    this.pos.y = g.terrain.heightAt(this.pos.x, this.pos.z);
    this.set('lurk');
  }

  private set(s: State) {
    this.state = s;
    this.stateT = 0;
  }

  /** Grunt from wherever he is, panned and faded around the camera. */
  private grunt(level: number, deep = false) {
    const g = this.game;
    const d = this.model.root.position.clone().sub(g.camera.position);
    const dist = d.length();
    const pan = dist > 0.1 ? d.normalize().dot(new THREE.Vector3(1, 0, 0).applyQuaternion(g.camera.quaternion)) : 0;
    g.audio.grunt(level / (1 + dist / 30), pan * 0.8, deep);
  }

  /** Per rendered frame, after the player's sled has been posed. */
  update(dt: number) {
    const g = this.game;
    const root = this.model.root;
    const sled = g.player.visual.root;
    const pp = g.player.physics.position;
    const dx = pp.x - this.pos.x, dz = pp.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.t += dt;
    this.stateT += dt;
    this.gruntIn -= dt;

    // where his feet go on the handlebars, in world space
    g.player.visual.barsLocal(this.barPos, this.barQuat);
    this.barPos.applyQuaternion(sled.quaternion).add(sled.position);
    this.barQuat.premultiply(sled.quaternion);

    switch (this.state) {
      case 'lurk':
      case 'sulk': {
        this.yaw = turnToward(this.yaw, Math.atan2(dx, dz), dt * 2.5);
        this.model.flex(this.t);
        if (dist < C.hearRange && this.gruntIn <= 0) {
          this.grunt(0.5);
          this.gruntIn = 2.2 + Math.random() * 2;
        }
        if (this.state === 'sulk') {
          // once he's cooled off and you've moved on, he turns up somewhere new
          if (this.stateT > C.cooldownSeconds && dist > 80) this.place(pp.x, pp.z, Math.random() * Math.PI * 2, Math.PI, C.respawnDistance);
        } else if (dist < C.spotRange) {
          g.hud.banner('Oh no! The angry ranga found you!', 'bad', 3.4);
          this.grunt(1.2, true);
          this.gruntIn = 0.45;
          this.set('chase');
        }
        break;
      }
      case 'chase': {
        this.yaw = turnToward(this.yaw, Math.atan2(dx, dz), dt * 6);
        const step = Math.min(dist, C.runSpeed * dt);
        this.pos.x += Math.sin(this.yaw) * step;
        this.pos.z += Math.cos(this.yaw) * step;
        // shoulder round trees, rocks and cabins rather than running through them
        g.scenery.obstacles.forEachNear(this.pos.x, this.pos.z, 1.6, (ox, oz) => {
          const ax = this.pos.x - ox, az = this.pos.z - oz;
          const d = Math.hypot(ax, az) || 1e-3;
          this.pos.x += (ax / d) * (1.6 - d);
          this.pos.z += (az / d) * (1.6 - d);
        });
        this.pos.y = g.terrain.heightAt(this.pos.x, this.pos.z);
        const before = this.phase;
        this.phase += step * 1.05;
        if (Math.floor(before / Math.PI) !== Math.floor(this.phase / Math.PI)) g.effects.burst(this.pos, 0.25);
        this.model.run(this.phase);
        if (this.gruntIn <= 0) {
          this.grunt(1);
          this.gruntIn = 0.7 + Math.random() * 0.7;
        }
        if (dist < C.catchRange && Math.abs(pp.y - this.pos.y) < 3.5) {
          this.from.copy(this.pos);
          this.grunt(1.3, true);
          this.set('leapOn');
        } else if (dist > C.loseRange || this.stateT > C.chaseSeconds) {
          g.hud.toast('You lost the angry ranga… for now', 3);
          this.set('sulk');
        }
        break;
      }
      case 'leapOn': {
        const k = Math.min(1, this.stateT / LEAP_SECONDS);
        this.pos.lerpVectors(this.from, this.barPos, k);
        this.pos.y += Math.sin(k * Math.PI) * 1.5;
        this.yaw = Math.atan2(dx, dz);
        this.model.leap();
        if (k >= 1) {
          g.hud.toast('He’s doing squats on your handlebars!', 3.5);
          g.effects.burst(this.barPos, 1.5);
          this.squats = 0;
          this.set('ride');
        }
        break;
      }
      case 'ride': {
        // one squat per cycle, lingering at the bottom
        const cycle = this.stateT * C.squatsPerSecond;
        const depth = THREE.MathUtils.smoothstep(0.5 - 0.5 * Math.cos(cycle * Math.PI * 2), 0.05, 0.8);
        this.model.squat(depth, STANCE / C.scale);
        if (Math.floor(cycle + 0.5) > this.squats) {
          this.squats = Math.floor(cycle + 0.5);
          this.grunt(1.4, true);
        }
        this.pos.copy(this.barPos);
        if (this.stateT > C.squatSeconds || g.player.flippedTime > 0.4) {
          // hop off to the side and sulk
          const side = new THREE.Vector3(2.6, 0, 0).applyQuaternion(sled.quaternion);
          this.from.copy(this.pos);
          this.to.set(pp.x + side.x, 0, pp.z + side.z);
          this.to.y = g.terrain.heightAt(this.to.x, this.to.z);
          this.set('leapOff');
        }
        break;
      }
      case 'leapOff': {
        const k = Math.min(1, this.stateT / LEAP_SECONDS);
        this.pos.lerpVectors(this.from, this.to, k);
        this.pos.y += Math.sin(k * Math.PI) * 1.2;
        this.model.leap();
        if (k >= 1) {
          g.effects.burst(this.pos, 1);
          this.grunt(0.9);
          this.gruntIn = 3;
          this.set('sulk');
        }
        break;
      }
    }

    root.position.copy(this.pos);
    if (this.state === 'ride') {
      // facing the rider, turning with the bars
      root.quaternion.copy(this.barQuat).multiply(FACE_RIDER);
      this.yaw = Math.atan2(-dx, -dz);
    } else {
      root.rotation.set(0, this.yaw, 0);
    }
  }

  /** He shows on the minimap once he's after you. */
  drawMap(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]) {
    if (this.state === 'lurk' || this.state === 'sulk') return;
    const [x, y] = toMap(this.pos.x, this.pos.z);
    ctx.fillStyle = '#ff5a1f';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 4.5 + Math.sin(this.t * 10) * 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

const FACE_RIDER = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

function turnToward(yaw: number, target: number, maxStep: number) {
  const d = Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw));
  return yaw + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}
