import type * as THREE from 'three';

/** Minimal sled-physics shape the ghost recorder needs (keeps modes decoupled from SledPhysics). */
export interface PhysicsWorldLike {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  steerAngle: number;
}
