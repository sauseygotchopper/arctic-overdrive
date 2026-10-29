import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import type { Game } from '../core/Game';
import { GameMode } from './GameMode';
import freerideData from '../data/freeride.json';
import modesData from '../data/modes.json';

interface Crystal { id: string; mesh: THREE.Group; base: THREE.Vector3 }
interface Viewpoint { id: string; name: string; pos: THREE.Vector3; r: number }
interface TrickSpot { name: string; center: THREE.Vector3; r: number }

const R = modesData.freeride;

/** Open world: no clock. Frost crystals, viewpoints, trick spots, photo mode, replay, weather. */
export class Freeride implements GameMode {
  readonly id = 'freeride';
  readonly title = 'Freeride';
  readonly controlsEnabled = true;
  private group = new THREE.Group();
  private crystals: Crystal[] = [];
  private viewpoints: Viewpoint[] = [];
  private spots: TrickSpot[] = [];
  private t = 0;
  private inSpot: TrickSpot | null = null;

  constructor(private game: Game) {}

  private get progress() {
    return this.game.save.data.freeride;
  }

  enter() {
    const g = this.game;
    const sp = g.terrain.def.spawn;
    g.player.teleport(new THREE.Vector3(sp.x, g.terrain.heightAt(sp.x, sp.z) + 0.8, sp.z), Math.atan2(sp.headingTo[0] - sp.x, sp.headingTo[1] - sp.z));
    const crystalGeo = new THREE.OctahedronGeometry(0.42, 0);
    const crystalMat = new THREE.MeshStandardMaterial({ color: 0x8fe9ff, emissive: 0x31c6ff, emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.1 });
    const beamMat = new THREE.MeshBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending });
    for (const c of freerideData.collectibles as { id: string; x: number; z: number; y?: number }[]) {
      if (this.progress.crystals.includes(c.id)) continue;
      const base = new THREE.Vector3(c.x, (c.y ?? g.terrain.heightAt(c.x, c.z)) + 1.3, c.z);
      const m = new THREE.Group();
      const gem = new THREE.Mesh(crystalGeo, crystalMat);
      gem.scale.set(1, 1.6, 1);
      gem.name = 'gem';
      m.add(gem);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 40, 8, 1, true), beamMat);
      beam.position.y = 20;
      m.add(beam);
      m.position.copy(base);
      this.group.add(m);
      this.crystals.push({ id: c.id, mesh: m, base });
    }
    const signMat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.9 });
    const flagMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.6, side: THREE.DoubleSide });
    for (const v of freerideData.viewpoints as { id: string; name: string; x: number; z: number; r: number }[]) {
      const pos = new THREE.Vector3(v.x, g.terrain.heightAt(v.x, v.z), v.z);
      this.viewpoints.push({ id: v.id, name: v.name, pos, r: v.r });
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 3.2, 6), signMat);
      post.position.set(v.x, pos.y + 1.6, v.z);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), flagMat);
      flag.position.set(v.x + 0.55, pos.y + 2.8, v.z);
      this.group.add(post, flag);
    }
    for (const s of freerideData.trickSpots) {
      const j = g.jumps.list[s.jump];
      if (!j) continue;
      const center = j.start.clone().addScaledVector(j.dir, j.length / 2);
      center.y = g.terrain.heightAt(center.x, center.z);
      this.spots.push({ name: s.name, center, r: j.length / 2 + 35 });
      for (const side of [-1, 1]) {
        const right = new THREE.Vector3(j.dir.z, 0, -j.dir.x);
        const p = j.start.clone().addScaledVector(j.dir, -6).addScaledVector(right, side * (j.def.width / 2 + 2));
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 6), signMat);
        pole.position.set(p.x, g.terrain.heightAt(p.x, p.z) + 2, p.z);
        const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.6), flagMat);
        banner.position.set(p.x, g.terrain.heightAt(p.x, p.z) + 3.1, p.z);
        banner.lookAt(p.clone().sub(j.dir).setY(banner.position.y));
        this.group.add(pole, banner);
      }
    }
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    g.scene.add(this.group);
  }

  exit() {
    const g = this.game;
    disposeObject(this.group);
    g.player.stunts.bonusMultiplier = 1;
    g.hud.setObjective(null);
  }

  fixedUpdate() {
    const p = this.game.player.physics.position;
    this.inSpot = this.spots.find((s) => Math.hypot(p.x - s.center.x, p.z - s.center.z) < s.r) ?? null;
    this.game.player.stunts.bonusMultiplier = this.inSpot ? R.trickSpotMultiplier : 1;
  }

  update(dt: number) {
    const g = this.game;
    this.t += dt;
    const p = g.player.physics.position;
    for (const c of [...this.crystals]) {
      const gem = c.mesh.getObjectByName('gem')!;
      gem.rotation.y = this.t * 1.6;
      c.mesh.position.y = c.base.y + Math.sin(this.t * 2 + c.base.x) * 0.15;
      const d = c.mesh.position.distanceTo(p);
      (c.mesh.children[1] as THREE.Mesh).visible = d < 160;
      if (d < 3.4) this.collect(c);
    }
    for (const v of this.viewpoints) {
      if (this.progress.viewpoints.includes(v.id)) continue;
      if (Math.hypot(p.x - v.pos.x, p.z - v.pos.z) < v.r) {
        this.progress.viewpoints.push(v.id);
        g.addRewards(R.viewpoint.currency, R.viewpoint.xp);
        g.hud.banner(`Viewpoint: ${v.name}`, 'good', 2.6);
        g.hud.toast(`+$${R.viewpoint.currency} · +${R.viewpoint.xp} XP · press F for photo mode`, 3);
      }
    }
    const total = freerideData.collectibles.length;
    g.hud.setObjective({
      title: 'Freeride',
      main: `${this.progress.crystals.length}/${total} crystals`,
      sub: `${this.progress.viewpoints.length}/${freerideData.viewpoints.length} viewpoints${this.inSpot ? ` · <span class="ahead">${this.inSpot.name} ×${R.trickSpotMultiplier}</span>` : ''}`,
    });
  }

  private collect(c: Crystal) {
    const g = this.game;
    this.crystals.splice(this.crystals.indexOf(c), 1);
    c.mesh.removeFromParent();
    this.progress.crystals.push(c.id);
    g.addRewards(R.collectible.currency, R.collectible.xp);
    g.effects.burst(c.mesh.position, 6);
    g.audioCue?.('pickup');
    const total = freerideData.collectibles.length;
    const n = this.progress.crystals.length;
    if (n === total) {
      g.addRewards(R.allCollectibles.currency, R.allCollectibles.xp);
      g.hud.banner('All frost crystals found!', 'good', 3.5);
    } else {
      g.hud.toast(`Frost crystal ${n}/${total} · +$${R.collectible.currency}`, 2);
    }
  }

  drawMap(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]) {
    for (const s of this.spots) {
      const [x, y] = toMap(s.center.x, s.center.z);
      ctx.strokeStyle = 'rgba(255,90,31,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const v of this.viewpoints) {
      const [x, y] = toMap(v.pos.x, v.pos.z);
      const found = this.progress.viewpoints.includes(v.id);
      ctx.fillStyle = found ? '#ffd166' : 'rgba(255,209,102,0.35)';
      ctx.beginPath();
      ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y + 3); ctx.lineTo(x - 4, y + 3); ctx.closePath();
      ctx.fill();
    }
  }
}
