import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import { SledModel } from '../vehicles/SledModel';
import { SledSetup, deriveParams } from '../vehicles/SledSpec';

/**
 * Self-contained 3D garage scene: lit turntable, backdrop, and an orbitable sled preview.
 * Rendered instead of the world while the garage/dealership is open.
 */
export class Showroom {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private model: SledModel | null = null;
  private turntable = new THREE.Group();
  private yaw = 0.7;
  private pitch = 0.22;
  private dist = 7.2;
  private spin = 0.18;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private idle = 0;
  active = false;

  constructor(private renderer: THREE.WebGLRenderer) {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 256;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#0b1626');
    grd.addColorStop(0.55, '#1d3350');
    grd.addColorStop(1, '#0b1626');
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 256);
    const bg = new THREE.CanvasTexture(c);
    bg.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = bg;

    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1a2230, 1.1));
    const key = new THREE.SpotLight(0xfff4e6, 260, 30, 0.55, 0.6, 1.6);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.SpotLight(0x7fc4ff, 180, 30, 0.6, 0.7, 1.6);
    rim.position.set(-5, 4, -5);
    this.scene.add(rim);
    const accent = new THREE.PointLight(0xff5a1f, 12, 9, 1.8);
    accent.position.set(0, 0.4, 3.4);
    this.scene.add(accent);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(4.2, 64), new THREE.MeshStandardMaterial({ color: 0x1a2a40, roughness: 0.35, metalness: 0.3 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.turntable.add(floor);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.03, 8, 96), new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 2 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.01;
    this.turntable.add(ring);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 32), new THREE.MeshStandardMaterial({ color: 0x0b1626, roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground, this.turntable);

    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.active || !this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.007;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this.lastY) * 0.004, 0.02, 0.9);
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.idle = 0;
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.dist = THREE.MathUtils.clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.07), 3.5, 12);
    }, { passive: true });
  }

  /** Swap the sled on the turntable. */
  show(setup: SledSetup) {
    if (this.model) disposeObject(this.model.root); // a new model per preview (paint, parts): free the last one
    const params = deriveParams(setup);
    const m = new SledModel(setup.spec, params, setup.livery);
    // resting suspension pose and seated rider
    const rest = (t: number) => 0.25 + t * 0.6;
    m.setSuspension(rest(params.travelFront), rest(params.travelFront), rest(params.travelRear), rest(params.travelRear));
    for (let i = 0; i < 20; i++) m.setRider({ leanX: 0, leanZ: 0, crouch: 0, pose: null, poseSide: 1, poseAmount: 0 }, 0.1);
    m.root.position.y = rest(params.travelRear) + 0.02;
    m.root.traverse((o) => { if ((o as THREE.Light).isLight) o.visible = false; });
    this.turntable.add(m.root);
    this.model = m;
  }

  update(dt: number) {
    this.idle += dt;
    if (!this.dragging && this.idle > 2) this.yaw += dt * this.spin;
    const c = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * c * this.dist, 0.9 + Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * c * this.dist);
    this.camera.lookAt(0, 0.65, 0);
    const el = this.renderer.domElement;
    this.camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
    // keep the sled framed right-of-centre so the panels on the left don't cover it
    this.camera.setViewOffset(el.clientWidth, el.clientHeight, el.clientWidth > 900 ? -el.clientWidth * 0.12 : 0, 0, el.clientWidth, el.clientHeight);
    this.camera.updateProjectionMatrix();
  }

  render() {
    const tm = this.renderer.toneMappingExposure;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.render(this.scene, this.camera);
    this.renderer.toneMappingExposure = tm;
  }
}
