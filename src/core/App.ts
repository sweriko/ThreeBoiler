import * as THREE from 'three/webgpu';
import Stats from 'stats.js';
import { GUI } from 'lil-gui';

export type UpdateFn = (delta: number) => void;

export interface AppOptions {
  fov?: number;
  near?: number;
  far?: number;
  toneMapping?: THREE.ToneMapping;
  exposure?: number;
}

export class App {
  public readonly renderer: THREE.WebGPURenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly gui: GUI;
  public readonly stats: Stats[];

  private readonly root: HTMLElement;
  private readonly updaters = new Set<UpdateFn>();
  private readonly clock = new THREE.Clock();

  private constructor(root: HTMLElement, renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, gui: GUI, stats: Stats[]) {
    this.root = root;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.gui = gui;
    this.stats = stats;

    window.addEventListener('resize', this.onResize);
  }

  public static async create(root: HTMLElement, opts: AppOptions = {}): Promise<App> {
    const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false });
    await renderer.init();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = opts.toneMapping ?? THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = opts.exposure ?? 1.0;
    root.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(
      opts.fov ?? 70,
      window.innerWidth / window.innerHeight,
      opts.near ?? 0.05,
      opts.far ?? 500
    );
    camera.position.set(0, 1.6, 4);

    const statsContainer = document.getElementById('stats');
    const stats: Stats[] = [];
    if (statsContainer) {
      const s0 = new Stats(); s0.showPanel(0);
      const s1 = new Stats(); s1.showPanel(1);
      const s2 = new Stats(); s2.showPanel(2);
      [s0, s1, s2].forEach(s => { s.dom.classList.add('stats-panel'); statsContainer.appendChild(s.dom); });
      stats.push(s0, s1, s2);
    }

    const guiContainer = document.getElementById('gui') as HTMLDivElement | null;
    const gui = new GUI({ title: 'Settings', width: 320, container: guiContainer ?? undefined });

    return new App(root, renderer, scene, camera, gui, stats);
  }

  public addUpdater(fn: UpdateFn): () => void {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  public setExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
  }

  public start(): void {
    const animate = () => {
      for (const s of this.stats) s.begin();

      const delta = Math.min(0.033, this.clock.getDelta());
      for (const fn of this.updaters) fn(delta);
      this.renderer.render(this.scene, this.camera);

      for (const s of this.stats) s.end();
      requestAnimationFrame(animate);
    };
    animate();
  }

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };
}



