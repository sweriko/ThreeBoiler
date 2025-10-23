import * as THREE from 'three/webgpu';
import { Fn, If, Break, float, vec2, vec3, vec4, smoothstep, texture3D, uniform } from 'three/tsl';
import { RaymarchingBox } from 'three/examples/jsm/tsl/utils/Raymarching.js';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';

export interface ShockRingOptions {
  color?: THREE.ColorRepresentation;
  lifeSeconds?: number;
  moveSpeed?: number; // world units per second
  startRadius?: number; // major radius in world units
  endRadius?: number; // major radius in world units at end of life
  thickness?: number; // minor radius in normalized object space (0..0.5 of unit cube)
  noiseScale?: number; // frequency of the 3D noise
  opacity?: number; // base opacity multiplier
}

function getSharedNoise3D(): THREE.Data3DTexture {
  // Singleton 3D noise texture to modulate density
  // 128^3 Uint8 perlin volume
  // Cache on globalThis to reuse between rings
  const key = '__SHOCK_RING_NOISE_3D__';
  const cached = (globalThis as any)[key] as THREE.Data3DTexture | undefined;
  if (cached) return cached;

  const size = 128;
  const data = new Uint8Array(size * size * size);
  let i = 0;
  const scale = 0.05;
  const perlin = new ImprovedNoise();
  const v = new THREE.Vector3();
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = 1.0 - v.set(x, y, z).subScalar(size / 2).divideScalar(size).length();
        data[i++] = (128 + 128 * perlin.noise((x * scale) / 1.5, y * scale, (z * scale) / 1.5)) * d * d;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  (globalThis as any)[key] = tex;
  return tex;
}

export class ShockRing {
  public readonly mesh: THREE.Mesh;
  public alive = true;

  private readonly material: THREE.NodeMaterial;
  private readonly uniforms: {
    color: ReturnType<typeof uniform>;
    range: ReturnType<typeof uniform>;
    steps: ReturnType<typeof uniform>;
    opacity: ReturnType<typeof uniform>;
    fade: ReturnType<typeof uniform>;
    Rmajor: ReturnType<typeof uniform>;
    Rminor: ReturnType<typeof uniform>;
    noiseScale: ReturnType<typeof uniform>;
    noiseTex: ReturnType<typeof texture3D>;
  };

  private readonly lifeSeconds: number;
  private readonly startRadiusWorld: number;
  private readonly endRadiusWorld: number;
  private readonly moveDir: THREE.Vector3;
  private readonly moveSpeed: number;
  private age = 0;

  constructor(camera: THREE.Camera, opts: ShockRingOptions = {}) {
    const color = new THREE.Color(opts.color ?? 0xf0f2f7);
    this.lifeSeconds = Math.max(0.2, opts.lifeSeconds ?? 2.0);
    this.moveSpeed = opts.moveSpeed ?? 6.0;
    this.startRadiusWorld = Math.max(0.05, opts.startRadius ?? 0.8);
    this.endRadiusWorld = Math.max(this.startRadiusWorld, opts.endRadius ?? 2.0);
    const rMinor = Math.min(0.25, Math.max(0.005, opts.thickness ?? 0.025));
    const opacity = Math.min(1.0, Math.max(0.0, opts.opacity ?? 0.9));
    const noiseScaleValue = Math.max(0.1, opts.noiseScale ?? 2.0);

    // Node uniforms
    const baseColor = uniform(color);
    const opacityU = uniform(opacity);
    const fadeU = uniform(1.0);
    const stepsU = uniform(110);
    const RmajorU = uniform(0.35); // normalized to unit cube radius (scaled in update)
    const RminorU = uniform(rMinor);
    const noiseScaleU = uniform(noiseScaleValue);
    const noiseTexNode = texture3D(getSharedNoise3D(), null, 0);

    // Raymarch in unit cube in object space. Torus axis aligned with +Z.
    const torusRaymarch = Fn(({ noiseTex, steps = float(110) }) => {
      const finalColor = vec4(0).toVar();
      RaymarchingBox(steps, ({ positionRay }) => {
        // Torus SDF (axis Z): q = (length(xy) - R, z)
        const rxy = vec2(positionRay.x, positionRay.y).length();
        const q = vec2(rxy.sub(this.uniforms.Rmajor), positionRay.z);
        const dist = q.length().sub(this.uniforms.Rminor);

        // Thin shell near surface; invert smoothstep for peak at dist=0
        const shell = smoothstep(float(0.0), this.uniforms.range, dist.abs()).oneMinus();

        // Noise modulation
        const n = float(noiseTex.sample(positionRay.mul(this.uniforms.noiseScale).add(0.5)).r);
        const density = shell.mul(n.mul(1.3));

        // Simple shading tint
        finalColor.rgb.addAssign(finalColor.a.oneMinus().mul(density).mul(this.uniforms.color));
        finalColor.a.addAssign(finalColor.a.oneMinus().mul(density).mul(this.uniforms.opacity).mul(this.uniforms.fade));

        If(finalColor.a.greaterThanEqual(0.995), () => {
          Break();
        });
      });
      return finalColor;
    });

    const rangeU = uniform(0.02); // softness around surface
    this.uniforms = {
      color: baseColor,
      range: rangeU,
      steps: stepsU,
      opacity: opacityU,
      fade: fadeU,
      Rmajor: RmajorU,
      Rminor: RminorU,
      noiseScale: noiseScaleU,
      noiseTex: noiseTexNode,
    };

    const ringRGBA = torusRaymarch({ noiseTex: noiseTexNode, steps: stepsU });
    const material = new THREE.NodeMaterial();
    material.colorNode = ringRGBA;
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.BackSide;
    this.material = material;

    // Simple unit cube; world scale defines the volume bounds
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.Mesh(geo, material);

    // Spawn in front of camera, facing the same direction (local +Z == camera forward)
    const spawnDir = new THREE.Vector3();
    camera.getWorldDirection(spawnDir).normalize();
    const spawnPos = (camera as THREE.Camera).position.clone().add(spawnDir.clone().multiplyScalar(1.5));
    this.mesh.position.copy(spawnPos);
    const camQuat = new THREE.Quaternion();
    (camera as THREE.Object3D).getWorldQuaternion(camQuat);
    this.mesh.quaternion.copy(camQuat);

    // Scale the unit cube to a comfortable world volume; XY governs ring world radius
    const initialScale = this.endRadiusWorld * 1.2; // generous bounds for march volume
    this.mesh.scale.setScalar(initialScale);

    // Initial torus major radius normalized to unit cube (0..0.5). We'll convert world radius to normalized each frame.
    this.uniforms.Rmajor.value = Math.min(0.45, this.startRadiusWorld / this.mesh.scale.x);

    // Movement data
    this.moveDir = spawnDir;
  }

  addTo(scene: THREE.Scene): this {
    scene.add(this.mesh);
    return this;
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.age += dt;
    const t = Math.min(1, this.age / this.lifeSeconds);

    // Move forward
    this.mesh.position.addScaledVector(this.moveDir, this.moveSpeed * dt);

    // Expand major radius from start to end in world units, but clamp to cube bounds
    const currentWorldR = THREE.MathUtils.lerp(this.startRadiusWorld, this.endRadiusWorld, t);
    const normalizedR = Math.min(0.47, currentWorldR / this.mesh.scale.x);
    this.uniforms.Rmajor.value = normalizedR;

    // Fade out toward the end
    const fadeStart = 0.5; // start fading after 50% life
    const fadeT = t <= fadeStart ? 1.0 : 1.0 - (t - fadeStart) / (1.0 - fadeStart);
    this.uniforms.fade.value = Math.max(0, Math.min(1, fadeT));

    if (this.age >= this.lifeSeconds || this.uniforms.fade.value <= 0.01) {
      this.alive = false;
    }
  }

  dispose(scene?: THREE.Scene): void {
    if (scene) scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export class ShockRingManager {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly rings: ShockRing[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
  }

  spawn(opts: ShockRingOptions = {}): ShockRing {
    const ring = new ShockRing(this.camera, opts).addTo(this.scene);
    this.rings.push(ring);
    return ring;
  }

  update(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.update(dt);
      if (!r.alive) {
        r.dispose(this.scene);
        this.rings.splice(i, 1);
      }
    }
  }
}


