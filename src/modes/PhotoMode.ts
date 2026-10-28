import * as THREE from 'three';
import type { Game } from '../core/Game';

/** Paused free-orbit camera around the sled with time-of-day/weather control and PNG capture. */
export class PhotoMode {
  active = false;
  private yaw = 0;
  private pitch = 0.25;
  private dist = 6;
  private fov = 55;
  private target = new THREE.Vector3();
  private panel: HTMLDivElement;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(private game: Game) {
    this.panel = document.createElement('div');
    this.panel.className = 'photo-panel';
    this.panel.innerHTML = `
      <div class="photo-title">PHOTO MODE</div>
      <div>Drag / <b>WASD</b> orbit · Wheel / <b>Q E</b> zoom · <b>Z X</b> lens</div>
      <div><b>T</b> time of day · <b>Y</b> weather · <b>H</b> hide this · <b>P</b> save photo</div>
      <div><b>F</b> / <b>Esc</b> exit</div>`;
    game.container.appendChild(this.panel);
    const el = game.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.active || !this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this.lastY) * 0.005, -0.15, 1.45);
      this.lastX = e.clientX; this.lastY = e.clientY;
    });
    el.addEventListener('pointerup', () => { this.dragging = false; });
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.dist = THREE.MathUtils.clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.08), 2, 40);
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'KeyP') this.capture();
      if (e.code === 'KeyH') this.panel.classList.toggle('hidden');
    });
  }

  enter() {
    const g = this.game;
    this.active = true;
    const root = g.player.visual.root;
    this.target.copy(root.position).add(new THREE.Vector3(0, 0.8, 0));
    const off = g.camera.position.clone().sub(this.target);
    this.dist = THREE.MathUtils.clamp(off.length(), 3, 20);
    this.yaw = Math.atan2(off.x, off.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(off.y / Math.max(off.length(), 1e-3), -0.15, 1.4));
    this.fov = g.camera.fov;
    g.hud.el.classList.add('photo');
    this.panel.classList.add('show');
  }

  exit() {
    this.active = false;
    this.game.hud.el.classList.remove('photo');
    this.panel.classList.remove('show');
  }

  update(dt: number) {
    const inp = this.game.input;
    const k = (code: string) => inp.isKeyDown(code);
    if (k('KeyA') || k('ArrowLeft')) this.yaw += dt * 1.2;
    if (k('KeyD') || k('ArrowRight')) this.yaw -= dt * 1.2;
    if (k('KeyW') || k('ArrowUp')) this.pitch = Math.min(1.45, this.pitch + dt * 0.8);
    if (k('KeyS') || k('ArrowDown')) this.pitch = Math.max(-0.15, this.pitch - dt * 0.8);
    if (k('KeyQ')) this.dist = Math.max(2, this.dist - dt * 6);
    if (k('KeyE')) this.dist = Math.min(40, this.dist + dt * 6);
    if (k('KeyZ')) this.fov = Math.max(18, this.fov - dt * 25);
    if (k('KeyX')) this.fov = Math.min(90, this.fov + dt * 25);
    const cam = this.game.camera;
    const c = Math.cos(this.pitch);
    cam.position.set(
      this.target.x + Math.sin(this.yaw) * c * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * c * this.dist,
    );
    cam.position.y = Math.max(cam.position.y, this.game.terrain.heightAt(cam.position.x, cam.position.z) + 0.3);
    cam.lookAt(this.target);
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
  }

  /** Render a clean frame and download it as PNG. */
  private capture() {
    const g = this.game;
    g.snow.flush();
    g.renderer.render(g.scene, g.camera);
    const url = g.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `arctic-overdrive-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    g.hud.toast('Photo saved');
  }
}
