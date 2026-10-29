import * as THREE from 'three';
import type { TerrainData } from '../world/TerrainData';

export interface HelicopterOptions { altitude: number; speed: number; beamRadius: number; beamTrack: number; beamReach: number }

/**
 * Pursuit helicopter: flies kinematically above the terrain, sweeps a searchlight that tracks its
 * target at a limited rate (you can outrun the beam for a moment). The light is a real SpotLight so it
 * lights the snow at night; it stays in the scene at zero intensity when idle to avoid shader rebuilds.
 */
export class Helicopter {
  readonly root = new THREE.Group();
  readonly beamPoint = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private rotor: THREE.Object3D;
  private tail: THREE.Object3D;
  private cone: THREE.Mesh;
  private light: THREE.SpotLight;
  private yaw = 0;
  active = false;

  constructor(private scene: THREE.Scene, private terrain: TerrainData, private opts: HelicopterOptions) {
    const body = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.5, metalness: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0d1a26, roughness: 0.1, metalness: 0.6 });
    const cabin = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), body);
    cabin.scale.set(1, 0.9, 1.7);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.1, 1.5);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.35, 5, 8), body);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 0.3, -3.6);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.7), body);
    fin.position.set(0, 0.85, -5.9);
    const skidMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const skids = new THREE.Group();
    for (const sx of [-0.9, 0.9]) {
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.4, 6), skidMat);
      skid.rotation.x = Math.PI / 2;
      skid.position.set(sx, -1.45, 0.2);
      skids.add(skid);
    }
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, transparent: true, opacity: 0.75 });
    this.rotor = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.04, 9), bladeMat);
      b.rotation.y = (i * Math.PI) / 2;
      this.rotor.add(b);
    }
    this.rotor.position.y = 1.45;
    this.tail = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.14), bladeMat);
      b.rotation.x = (i * Math.PI) / 2;
      this.tail.add(b);
    }
    this.tail.position.set(0.18, 0.85, -5.9);
    // nav lights
    const red = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
    red.position.set(-1.3, 0, 0);
    const green = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), new THREE.MeshBasicMaterial({ color: 0x20ff40 }));
    green.position.set(1.3, 0, 0);
    this.root.add(cabin, nose, boom, fin, skids, this.rotor, this.tail, red, green);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });

    // searchlight: spot light + a soft additive cone so the beam reads at dusk and night
    this.light = new THREE.SpotLight(0xf2f6ff, 0, 0, Math.atan(opts.beamRadius / opts.altitude) * 1.25, 0.45, 2);
    this.light.castShadow = false;
    const coneGeo = new THREE.CylinderGeometry(0.25, 1, 1, 24, 1, true);
    coneGeo.translate(0, -0.5, 0); // apex at the origin, opening downward
    this.cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      color: 0xe8f0ff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.cone.frustumCulled = false;
    this.scene.add(this.light, this.light.target);
  }

  /** Bring it in from the valley's edge toward a point. */
  enter(from: THREE.Vector3) {
    this.active = true;
    this.root.position.set(from.x, this.terrain.heightAt(from.x, from.z) + this.opts.altitude + 25, from.z);
    this.beamPoint.copy(from);
    this.velocity.set(0, 0, 0);
    this.scene.add(this.root, this.cone);
  }

  exit() {
    this.active = false;
    this.root.removeFromParent();
    this.cone.removeFromParent();
    this.light.intensity = 0;
  }

  /** Fly toward `follow` (a point a little behind the target, so the beam angles forward) and swing the beam to `aim`. */
  update(dt: number, follow: THREE.Vector3, aim: THREE.Vector3, night: number, viewer?: THREE.Vector3) {
    if (!this.active) return;
    const o = this.opts;
    const pos = this.root.position;
    // steer the velocity toward the follow point, with arrival slowdown
    const to = new THREE.Vector3(follow.x - pos.x, 0, follow.z - pos.z);
    const d = to.length();
    const want = to.normalize().multiplyScalar(Math.min(o.speed, d * 0.6));
    this.velocity.lerp(want, 1 - Math.exp(-dt * 0.9));
    pos.addScaledVector(this.velocity, dt);
    // hold altitude over the highest ground nearby
    let ground = this.terrain.heightAt(pos.x, pos.z);
    ground = Math.max(ground, this.terrain.heightAt(pos.x + this.velocity.x * 2, pos.z + this.velocity.z * 2));
    pos.y += (ground + o.altitude - pos.y) * (1 - Math.exp(-dt * 0.8));
    // face the direction of travel (or the target when hovering), nose down when fast
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    const faceYaw = hs > 3 ? Math.atan2(this.velocity.x, this.velocity.z) : Math.atan2(aim.x - pos.x, aim.z - pos.z);
    let dy = faceYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * (1 - Math.exp(-dt * 1.5));
    this.root.rotation.set(0, 0, 0);
    this.root.rotateY(this.yaw);
    this.root.rotateX(Math.min(0.3, hs / o.speed * 0.25));
    this.rotor.rotation.y += dt * 30;
    this.tail.rotation.x += dt * 45;

    // the beam spot slews toward the aim point at a limited speed
    const bd = new THREE.Vector3(aim.x - this.beamPoint.x, 0, aim.z - this.beamPoint.z);
    const step = Math.min(bd.length(), (o.beamTrack + Math.hypot(this.velocity.x, this.velocity.z)) * dt);
    if (bd.lengthSq() > 1e-6) this.beamPoint.addScaledVector(bd.normalize(), step);
    // the light can only reach so far out from under the helicopter
    const off = new THREE.Vector3(this.beamPoint.x - pos.x, 0, this.beamPoint.z - pos.z);
    if (off.length() > o.beamReach) this.beamPoint.set(pos.x + off.x * (o.beamReach / off.length()), 0, pos.z + off.z * (o.beamReach / off.length()));
    this.beamPoint.y = this.terrain.heightAt(this.beamPoint.x, this.beamPoint.z);

    const src = pos.clone().add(new THREE.Vector3(0, -1.3, 0));
    this.light.position.copy(src);
    this.light.target.position.copy(this.beamPoint);
    this.light.intensity = THREE.MathUtils.lerp(15, 140, night) * 40;
    const len = src.distanceTo(this.beamPoint);
    this.cone.position.copy(src);
    this.cone.scale.set(o.beamRadius, len, o.beamRadius);
    this.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this.beamPoint.clone().sub(src).normalize());
    // fade the cone out when the camera is inside it (chasing right under the light), so it doesn't fog the view
    let inside = 1;
    if (viewer) {
      const axis = this.beamPoint.clone().sub(src);
      const k = THREE.MathUtils.clamp(viewer.clone().sub(src).dot(axis) / axis.lengthSq(), 0, 1);
      const r = o.beamRadius * (0.25 + 0.75 * k);
      inside = THREE.MathUtils.smoothstep(viewer.distanceTo(src.clone().addScaledVector(axis, k)), r * 0.8, r * 2.2);
    }
    (this.cone.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.lerp(0.03, 0.12, night) * inside;
  }

  /** Is (x, z) inside the beam's footprint on the ground? */
  inBeam(x: number, z: number): boolean {
    return this.active && Math.hypot(x - this.beamPoint.x, z - this.beamPoint.z) < this.opts.beamRadius;
  }

  dispose() {
    this.exit();
    this.light.removeFromParent();
    this.light.target.removeFromParent();
  }
}
