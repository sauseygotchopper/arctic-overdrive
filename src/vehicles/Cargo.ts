import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import cargoData from '../data/cargo.json';
import { PhysicsWorld } from '../physics/PhysicsWorld';

export type CargoType = keyof typeof cargoData.types;
export interface CargoDef { name: string; massKg: number; size: number[]; fragile: boolean; color: string; value: number }

export const CARGO_TYPES = cargoData.types as Record<CargoType, CargoDef>;
export const TEST_LOADS = cargoData.testLoads as CargoType[][];

let nextId = 1;

/** One piece of cargo. Health drops from hard handling if fragile; it can end up loose in the world. */
export class CargoItem {
  readonly id = nextId++;
  readonly def: CargoDef;
  health = 1;
  readonly mesh: THREE.Mesh;

  constructor(readonly type: CargoType) {
    this.def = CARGO_TYPES[type];
    const [x, y, z] = this.def.size;
    const mat = new THREE.MeshStandardMaterial({ color: this.def.color, roughness: 0.8 });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    if (type === 'medical') {
      const cross = new THREE.MeshStandardMaterial({ color: 0xd8262a, roughness: 0.6 });
      for (const [w, h] of [[0.18, 0.06], [0.06, 0.18]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.005, h), cross);
        bar.position.y = y / 2 + 0.003;
        this.mesh.add(bar);
      }
    }
  }

  damage(amount: number) {
    if (this.def.fragile) this.health = Math.max(0, this.health - amount);
  }
}

/** Cargo that fell off – simulated as free rigid bodies (Delivery mode can pick them back up). */
export class LooseCargo {
  readonly items: { item: CargoItem; body: RAPIER.RigidBody }[] = [];

  constructor(private phys: PhysicsWorld, private scene: THREE.Scene) {}

  spill(item: CargoItem, worldPos: THREE.Vector3, worldQuat: THREE.Quaternion, vel: THREE.Vector3) {
    const R = this.phys.R;
    const body = this.phys.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(worldPos.x, worldPos.y, worldPos.z)
        .setRotation({ x: worldQuat.x, y: worldQuat.y, z: worldQuat.z, w: worldQuat.w })
        .setLinvel(vel.x + (Math.random() - 0.5) * 3, vel.y + 1.5 + Math.random() * 2, vel.z + (Math.random() - 0.5) * 3)
        .setAngvel({ x: Math.random() * 4 - 2, y: Math.random() * 4 - 2, z: Math.random() * 4 - 2 })
        .setLinearDamping(0.3),
    );
    const [x, y, z] = item.def.size;
    this.phys.world.createCollider(R.ColliderDesc.cuboid(x / 2, y / 2, z / 2).setMass(item.def.massKg).setFriction(0.6), body);
    item.mesh.removeFromParent();
    this.scene.add(item.mesh);
    this.items.push({ item, body });
    // cap the number of loose bodies
    while (this.items.length > 40) this.remove(this.items[0].item);
  }

  remove(item: CargoItem) {
    const i = this.items.findIndex((e) => e.item === item);
    if (i < 0) return;
    this.phys.world.removeRigidBody(this.items[i].body);
    item.mesh.removeFromParent();
    this.items.splice(i, 1);
  }

  sync() {
    for (const { item, body } of this.items) {
      const t = body.translation();
      const r = body.rotation();
      item.mesh.position.set(t.x, t.y, t.z);
      item.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}
