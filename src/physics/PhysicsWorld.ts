import RAPIER from '@dimforge/rapier3d-compat';
import { TerrainData } from '../world/TerrainData';
import { StaticCollider } from '../world/Scenery';

export type Rapier = typeof RAPIER;

export const GRAVITY = 9.81;
export const PHYSICS_DT = 1 / 60;

let initPromise: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

/** Owns the Rapier world plus the static terrain/scenery colliders. */
export class PhysicsWorld {
  readonly R = RAPIER;
  readonly world: RAPIER.World;
  terrainCollider!: RAPIER.Collider;
  /** Current gravity (m/s²); the handling model can scale it. */
  g = GRAVITY;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_DT;
  }

  setGravityScale(scale: number) {
    this.g = GRAVITY * scale;
    this.world.gravity = { x: 0, y: -this.g, z: 0 };
  }

  addTerrain(t: TerrainData) {
    // Rapier stores heights column-major: index = row(z) + col(x) * (nrows + 1).
    const n = t.hCells + 1;
    const h = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) h[iz + ix * n] = t.heights[iz * n + ix];
    const desc = RAPIER.ColliderDesc.heightfield(t.hCells, t.hCells, h, { x: t.size, y: 1, z: t.size })
      .setFriction(0.3)
      .setRestitution(0);
    this.terrainCollider = this.world.createCollider(desc);

    // invisible walls at the map edge
    const half = t.half;
    for (const [x, z, hx, hz] of [
      [half, 0, 1, half], [-half, 0, 1, half], [0, half, half, 1], [0, -half, half, 1],
    ]) {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 400, hz).setTranslation(x, 0, z));
    }
  }

  /** Sanity check that the heightfield orientation matches TerrainData. Returns max error (m). */
  verifyTerrain(t: TerrainData): number {
    let maxErr = 0;
    for (const [x, z] of [[-300, -250], [123, 77], [-411, 389], [250, -100], [0, 0]]) {
      const ray = new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 });
      const hit = this.terrainCollider.castRay(ray, 1000, true);
      if (hit === null) return Infinity;
      maxErr = Math.max(maxErr, Math.abs(500 - hit - t.heightAt(x, z)));
    }
    return maxErr;
  }

  addStatic(cols: StaticCollider[]) {
    for (const c of cols) {
      let desc: RAPIER.ColliderDesc;
      if (c.kind === 'cylinder') desc = RAPIER.ColliderDesc.cylinder(c.halfH, c.r);
      else if (c.kind === 'ball') desc = RAPIER.ColliderDesc.ball(c.r);
      else {
        desc = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz);
        const s = Math.sin(c.rotY / 2);
        desc.setRotation({ x: 0, y: s, z: 0, w: Math.cos(c.rotY / 2) });
      }
      desc.setTranslation(c.x, c.y, c.z).setFriction(0.4);
      this.world.createCollider(desc);
    }
  }

  addTrimesh(vertices: Float32Array, indices: Uint32Array) {
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(0.3));
  }

  step() {
    this.world.step();
  }
}
