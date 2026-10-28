import { TerrainData } from '../world/TerrainData';
import { SURFACE_ID } from '../physics/Surfaces';

const SIZE = 180; // css px
const VIEW_RADIUS = 170; // metres shown from centre to edge

/** Rotating, heading-up minimap: pre-rendered valley image + live overlays from the active mode. */
export class MiniMap {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private acc = 0;

  constructor(parent: HTMLElement, private terrain: TerrainData, trees: number[], cabins: { x: number; z: number }[]) {
    this.el = document.createElement('canvas');
    this.el.className = 'hud-minimap';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.width = this.el.height = SIZE * dpr;
    this.ctx = this.el.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    parent.appendChild(this.el);
    this.base = this.renderBase(trees, cabins);
  }

  /** One-off 512² map: surface colours + hillshade, forest dots, trails, cabins. */
  private renderBase(trees: number[], cabins: { x: number; z: number }[]): HTMLCanvasElement {
    const t = this.terrain;
    const N = 512;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(N, N);
    const m = t.size / N;
    const col: Record<number, number[]> = {
      [SURFACE_ID.powder]: [226, 234, 244], [SURFACE_ID.groomed]: [190, 200, 214], [SURFACE_ID.crust]: [208, 216, 228],
      [SURFACE_ID.ice]: [120, 170, 205], [SURFACE_ID.slush]: [160, 168, 176], [SURFACE_ID.moguls]: [200, 205, 222],
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * m - t.half, z = j * m - t.half;
        const s = col[t.surfaceAt(x, z)];
        const shade = 1 + ((t.heightAt(x - 2, z - 2) - t.heightAt(x + 2, z + 2)) / 4) * 0.35;
        const o = (j * N + i) * 4;
        img.data[o] = s[0] * shade; img.data[o + 1] = s[1] * shade; img.data[o + 2] = s[2] * shade; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = 'rgba(40,80,64,0.55)';
    for (let k = 0; k < trees.length; k += 2) ctx.fillRect((trees[k] + t.half) / m - 0.8, (trees[k + 1] + t.half) / m - 0.8, 1.6, 1.6);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineCap = 'round';
    for (const p of t.trailPaths) {
      ctx.lineWidth = Math.max(1.5, p.width / m * 0.5);
      ctx.beginPath();
      p.pts.forEach((q, i) => (i ? ctx.lineTo((q.x + t.half) / m, (q.z + t.half) / m) : ctx.moveTo((q.x + t.half) / m, (q.z + t.half) / m)));
      ctx.stroke();
    }
    ctx.fillStyle = '#7a4a2a';
    for (const cb of cabins) ctx.fillRect((cb.x + t.half) / m - 3, (cb.z + t.half) / m - 3, 6, 6);
    return c;
  }

  /** Redraw at ~20 Hz. `overlay` lets the active mode draw route lines, checkpoints, markers. */
  update(dt: number, px: number, pz: number, fx: number, fz: number, overlay?: (ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]) => void) {
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const ctx = this.ctx;
    const t = this.terrain;
    const r = SIZE / 2;
    const s = r / VIEW_RADIUS;
    const th = Math.atan2(fx, fz);
    const ct = Math.cos(th), st = Math.sin(th);
    // world (x,z) → screen: rider's right is screen +x, travel direction is screen up
    const a = -s * ct, b = -s * st, c = s * st, d = -s * ct;
    const toMap = (x: number, z: number): [number, number] => [a * (x - px) + c * (z - pz) + r, b * (x - px) + d * (z - pz) + r];

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#0b1626';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const dpr = this.el.width / SIZE;
    ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, (r - (a * px + c * pz)) * dpr, (r - (b * px + d * pz)) * dpr);
    ctx.drawImage(this.base, -t.half, -t.half, t.size, t.size);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlay?.(ctx, toMap);
    // player arrow
    ctx.fillStyle = '#ff5a1f';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(r, r - 8); ctx.lineTo(r + 5.5, r + 6); ctx.lineTo(r, r + 3); ctx.lineTo(r - 5.5, r + 6); ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.stroke();
  }
}
