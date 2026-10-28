import * as THREE from 'three';
import { TerrainData } from '../world/TerrainData';

export interface Gate {
  pos: THREE.Vector3;
  dir: THREE.Vector3; // travel direction through the gate
  halfWidth: number;
  group: THREE.Group;
  kind: 'checkpoint' | 'finish' | 'start';
}

const accent = new THREE.Color(0xff5a1f);

/** Inflatable-arch style gates; the next one glows and throws a light pillar so it reads from afar. */
export class Checkpoints {
  readonly group = new THREE.Group();
  readonly gates: Gate[] = [];
  private beam: THREE.Mesh;
  private postMat = new THREE.MeshStandardMaterial({ color: 0x1d3350, roughness: 0.6 });
  private bannerMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6, roughness: 0.5 });
  private dimMat = new THREE.MeshStandardMaterial({ color: 0x9cc3e6, transparent: true, opacity: 0.35, roughness: 0.6 });
  private finishMat: THREE.MeshStandardMaterial;
  private t = 0;

  constructor(private terrain: TerrainData) {
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffa060, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 120, 12, 1, true), beamMat);
    this.beam.position.y = 60;
    this.finishMat = new THREE.MeshStandardMaterial({ map: checkerTexture(), emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.6 });
  }

  add(pos: THREE.Vector3, dir: THREE.Vector3, width: number, kind: Gate['kind']) {
    const g = new THREE.Group();
    const hw = width / 2;
    const h = 4.2;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, h, 10), this.postMat);
      post.position.set(s * hw, h / 2, 0);
      g.add(post);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.25, 10), this.postMat);
      base.position.set(s * hw, 0.12, 0);
      g.add(base);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(width + 0.6, 0.9, 0.18), kind === 'finish' ? this.finishMat : this.bannerMat);
    banner.position.y = h - 0.2;
    banner.name = 'banner';
    g.add(banner);
    const y = Math.min(this.terrain.heightAt(pos.x + dir.z * hw, pos.z - dir.x * hw), this.terrain.heightAt(pos.x - dir.z * hw, pos.z + dir.x * hw), this.terrain.heightAt(pos.x, pos.z));
    g.position.set(pos.x, y - 0.1, pos.z);
    g.rotation.y = Math.atan2(dir.x, dir.z);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.group.add(g);
    this.gates.push({ pos: new THREE.Vector3(pos.x, y, pos.z), dir: dir.clone(), halfWidth: hw, group: g, kind });
  }

  /** Highlight gate `next`; hide passed ones. */
  setNext(next: number) {
    this.gates.forEach((gate, i) => {
      gate.group.visible = i >= next;
      const banner = gate.group.getObjectByName('banner') as THREE.Mesh;
      if (gate.kind !== 'finish') banner.material = i === next ? this.bannerMat : this.dimMat;
    });
    const g = this.gates[next];
    this.beam.removeFromParent();
    if (g) g.group.add(this.beam);
  }

  /** Did the segment a→b pass through gate i (within its width, plus a little slack)? */
  crossed(i: number, a: THREE.Vector3, b: THREE.Vector3): boolean {
    const g = this.gates[i];
    if (!g) return false;
    const da = (a.x - g.pos.x) * g.dir.x + (a.z - g.pos.z) * g.dir.z;
    const db = (b.x - g.pos.x) * g.dir.x + (b.z - g.pos.z) * g.dir.z;
    const lat = Math.abs((b.x - g.pos.x) * g.dir.z - (b.z - g.pos.z) * g.dir.x);
    if (da <= 0 && db > 0 && lat < g.halfWidth + 3) return true; // generous: clipping a post still counts
    return Math.hypot(b.x - g.pos.x, b.z - g.pos.z) < 2.5;
  }

  update(dt: number) {
    this.t += dt;
    this.bannerMat.emissiveIntensity = 0.5 + 0.35 * Math.sin(this.t * 4);
    (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.06 * Math.sin(this.t * 2);
  }

  dispose() {
    this.group.removeFromParent();
  }
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 16;
  const ctx = c.getContext('2d')!;
  for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
    ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f6f8';
    ctx.fillRect(x * 8, y * 8, 8, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}
