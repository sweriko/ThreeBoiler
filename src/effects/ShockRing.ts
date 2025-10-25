import * as THREE from 'three/webgpu';
import { Fn, If, Break, float, vec2, vec3, vec4, smoothstep, texture3D, uniform } from 'three/tsl';
import { RaymarchingBox } from 'three/examples/jsm/tsl/utils/Raymarching.js';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';
import { LAYERS } from '../core/Layers';

export interface ShockRingOptions {
  color?: THREE.ColorRepresentation;
  lifeSeconds?: number;
  moveSpeed?: number; // world units per second
  startRadius?: number; // major radius in world units
  endRadius?: number; // major radius in world units at end of life
  thickness?: number; // minor radius in normalized object space (0..0.5 of unit cube)
  noiseScale?: number; // frequency of the 3D noise
  opacity?: number; // base opacity multiplier
  steps?: number; // raymarch steps
  softness?: number; // surface softness around torus iso (range uniform)
  spawnDistance?: number; // meters in front of camera
  fadeStart?: number; // life fraction where fade begins (0..1)
  fadeEnd?: number; // life fraction where fade reaches 0 (0..1)
  growthExponent?: number; // >1 slows early growth
  growthDelay?: number; // life fraction before growth starts
  growthMode?: 'default' | 'collapseThenGrow';
  collapseAt?: number; // life fraction when collapse reaches min
  collapseScale?: number; // min scale relative to start (0..1)
  recoverAt?: number; // life fraction when it returns to start size
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
  private moveSpeed: number;
  private fadeStart: number;
  private fadeEnd: number;
  private age = 0;
  private growthExponent: number;
  private growthDelay: number;
  private growthMode: 'default' | 'collapseThenGrow';
  private collapseAt: number;
  private collapseScale: number;
  private recoverAt: number;

  constructor(camera: THREE.Camera, opts: ShockRingOptions = {}) {
    const color = new THREE.Color(opts.color ?? 0xf0f2f7);
    this.lifeSeconds = Math.max(0.2, opts.lifeSeconds ?? 2.0);
    this.moveSpeed = opts.moveSpeed ?? 6.0;
    this.startRadiusWorld = Math.max(0.05, opts.startRadius ?? 0.8);
    this.endRadiusWorld = Math.max(this.startRadiusWorld, opts.endRadius ?? 2.0);
    const rMinor = Math.min(0.25, Math.max(0.0005, opts.thickness ?? 0.025));
    const opacity = Math.min(1.0, Math.max(0.0, opts.opacity ?? 0.9));
    const noiseScaleValue = Math.max(0.1, opts.noiseScale ?? 2.0);
    this.growthExponent = Math.max(0.1, opts.growthExponent ?? 6.0);
    this.growthDelay = THREE.MathUtils.clamp(opts.growthDelay ?? 0.1, 0, 0.95);
    this.growthMode = (opts.growthMode as any) ?? 'default';
    this.collapseAt = THREE.MathUtils.clamp(opts.collapseAt ?? 0.08, 0, 0.95);
    this.collapseScale = THREE.MathUtils.clamp(opts.collapseScale ?? 0.05, 0.0, 1.0);
    this.recoverAt = THREE.MathUtils.clamp(Math.max(opts.recoverAt ?? 0.2, (opts.collapseAt ?? 0.08) + 0.01), 0.0, 0.99);

    // Node uniforms
    const baseColor = uniform(color);
    const opacityU = uniform(opacity);
    const fadeU = uniform(1.0);
    const stepsU = uniform(Math.floor(opts.steps ?? 110));
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
        const density = shell.mul(n.mul(1.8));

        // Simple shading tint
        finalColor.rgb.addAssign(finalColor.a.oneMinus().mul(density).mul(this.uniforms.color));
        finalColor.a.addAssign(finalColor.a.oneMinus().mul(density).mul(this.uniforms.opacity).mul(this.uniforms.fade));

        If(finalColor.a.greaterThanEqual(0.995), () => {
          Break();
        });
      });
      return finalColor;
    });

    const rangeU = uniform(Math.max(0.001, Math.min(0.2, opts.softness ?? 0.02))); // softness around surface
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
    this.mesh.layers.set(LAYERS.OVERLAY);

    // Spawn in front of camera, facing the same direction (local +Z == camera forward)
    const spawnDir = new THREE.Vector3();
    camera.getWorldDirection(spawnDir).normalize();
    const spawnDist = Math.max(0, opts.spawnDistance ?? 1.5);
    const spawnPos = (camera as THREE.Camera).position.clone().add(spawnDir.clone().multiplyScalar(spawnDist));
    this.mesh.position.copy(spawnPos);
    const camQuat = new THREE.Quaternion();
    (camera as THREE.Object3D).getWorldQuaternion(camQuat);
    this.mesh.quaternion.copy(camQuat);

    // Scale the unit cube so max world radius maps to ~0.47 of the unit cube (within bounds)
    const initialScale = this.endRadiusWorld / 0.47;
    this.mesh.scale.setScalar(initialScale);

    // Initial torus major radius normalized to unit cube (0..0.5). We'll convert world radius to normalized each frame.
    this.uniforms.Rmajor.value = Math.min(0.45, this.startRadiusWorld / this.mesh.scale.x);

    // Movement data
    this.moveDir = spawnDir;
    this.fadeStart = THREE.MathUtils.clamp(opts.fadeStart ?? 0.5, 0, 1);
    this.fadeEnd = THREE.MathUtils.clamp(opts.fadeEnd ?? 0.8, 0, 1);
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

    // Compute major radius in world units, supporting optional collapse-then-grow behavior
    let currentWorldR: number;
    if (this.growthMode === 'collapseThenGrow') {
      const tc = Math.min(this.collapseAt, 0.95);
      const tr = Math.max(this.recoverAt, tc + 0.01);
      if (t < tc) {
        const u = t / Math.max(1e-5, tc);
        const ease = 1 - Math.pow(1 - u, 3); // easeOutCubic
        currentWorldR = THREE.MathUtils.lerp(this.startRadiusWorld, this.startRadiusWorld * this.collapseScale, ease);
      } else if (t < tr) {
        const u = (t - tc) / Math.max(1e-5, tr - tc);
        const ease = 1 - Math.pow(1 - u, 3);
        currentWorldR = THREE.MathUtils.lerp(this.startRadiusWorld * this.collapseScale, this.startRadiusWorld, ease);
      } else {
        const tDelayed2 = Math.max(0, t - this.growthDelay) / Math.max(1e-5, 1 - this.growthDelay);
        const growthT2 = Math.pow(THREE.MathUtils.clamp(tDelayed2, 0, 1), this.growthExponent);
        currentWorldR = THREE.MathUtils.lerp(this.startRadiusWorld, this.endRadiusWorld, growthT2);
      }
    } else {
      const tDelayed = Math.max(0, t - this.growthDelay) / Math.max(1e-5, 1 - this.growthDelay);
      const growthT = Math.pow(THREE.MathUtils.clamp(tDelayed, 0, 1), this.growthExponent);
      currentWorldR = THREE.MathUtils.lerp(this.startRadiusWorld, this.endRadiusWorld, growthT);
    }
    const normalizedR = Math.min(0.47, currentWorldR / this.mesh.scale.x);
    this.uniforms.Rmajor.value = normalizedR;

    // Fade out toward the end
    const fadeStart = this.fadeStart; // start fading after fadeStart fraction
    const fadeEnd = Math.max(fadeStart + 0.001, this.fadeEnd);
    const denom = Math.max(1e-5, fadeEnd - fadeStart);
    const fadeT = t <= fadeStart ? 1.0 : (t >= fadeEnd ? 0.0 : 1.0 - (t - fadeStart) / denom);
    this.uniforms.fade.value = Math.max(0, Math.min(1, fadeT));

    if (this.age >= this.lifeSeconds || this.uniforms.fade.value <= 0.01) {
      this.alive = false;
    }
  }

  public applyUniforms(settings: Partial<{ color: THREE.ColorRepresentation; opacity: number; softness: number; steps: number; noiseScale: number; thickness: number; }>): void {
    if (settings.color !== undefined) (this.uniforms.color as any).value.set(settings.color as any);
    if (settings.opacity !== undefined) this.uniforms.opacity.value = settings.opacity;
    if (settings.softness !== undefined) this.uniforms.range.value = Math.max(0.001, Math.min(0.2, settings.softness));
    if (settings.steps !== undefined) this.uniforms.steps.value = Math.floor(settings.steps);
    if (settings.noiseScale !== undefined) this.uniforms.noiseScale.value = settings.noiseScale;
    if (settings.thickness !== undefined) this.uniforms.Rminor.value = Math.max(0.001, Math.min(0.25, settings.thickness));
  }

  public setFadeStart(value: number): void {
    this.fadeStart = THREE.MathUtils.clamp(value, 0, 1);
  }

  public setFadeEnd(value: number): void {
    this.fadeEnd = THREE.MathUtils.clamp(value, 0, 1);
  }

  public setMoveSpeed(value: number): void {
    this.moveSpeed = value;
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
  private readonly pending: { delay: number; opts: ShockRingOptions }[] = [];
  public readonly params = {
    lifeSeconds: 7.2,
    startRadius: 4.2,
    endRadius: 12.0,
    thickness: 0.0008,
    moveSpeed: 0.0,
    color: '#ffffff',
    opacity: 1.0,
    steps: 110,
    softness: 0.02,
    noiseScale: 2.0,
    spawnDistance: 1.5,
    fadeStart: 0.6,
    fadeEnd: 0.9,
    growthExponent: 2.5,
    growthDelay: 0.02,
  };

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
  }

  spawn(opts: ShockRingOptions = {}): ShockRing {
    const p = this.params;
    const ring = new ShockRing(this.camera, {
      lifeSeconds: opts.lifeSeconds ?? p.lifeSeconds,
      startRadius: opts.startRadius ?? p.startRadius,
      endRadius: opts.endRadius ?? p.endRadius,
      thickness: opts.thickness ?? p.thickness,
      moveSpeed: opts.moveSpeed ?? p.moveSpeed,
      color: opts.color ?? p.color,
      opacity: opts.opacity ?? p.opacity,
      steps: opts.steps ?? p.steps,
      softness: opts.softness ?? p.softness,
      noiseScale: opts.noiseScale ?? p.noiseScale,
      spawnDistance: opts.spawnDistance ?? p.spawnDistance,
      fadeStart: opts.fadeStart ?? p.fadeStart,
      fadeEnd: opts.fadeEnd ?? p.fadeEnd,
      growthExponent: opts.growthExponent ?? p.growthExponent,
      growthDelay: opts.growthDelay ?? p.growthDelay,
    }).addTo(this.scene);
    this.rings.push(ring);
    return ring;
  }

  update(dt: number): void {
    // Handle scheduled spawns
    if (this.pending.length > 0) {
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const p = this.pending[i];
        p.delay -= dt;
        if (p.delay <= 0) {
          this.spawn(p.opts);
          this.pending.splice(i, 1);
        }
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.update(dt);
      if (!r.alive) {
        r.dispose(this.scene);
        this.rings.splice(i, 1);
      }
    }
  }

  private spawnAfter(delay: number, opts: ShockRingOptions): void {
    this.pending.push({ delay, opts });
  }

  public spawnAssembly(): void {
    const p = this.params;
    const move = -0.7; // slight backwards towards the player
    const mainStart = p.startRadius;
    const mainEnd = p.endRadius;
    const smallStart = mainStart / 3;
    const secondEnd = mainEnd * 0.5;
    const thirdEnd = mainEnd / 3;

    // Main (immediate)
    this.spawn({
      lifeSeconds: p.lifeSeconds,
      startRadius: mainStart,
      endRadius: mainEnd,
      thickness: p.thickness,
      moveSpeed: move,
      color: p.color,
      opacity: p.opacity,
      steps: p.steps,
      softness: p.softness,
      noiseScale: p.noiseScale,
      spawnDistance: p.spawnDistance,
      fadeStart: p.fadeStart,
      fadeEnd: p.fadeEnd,
      growthExponent: p.growthExponent,
      growthDelay: p.growthDelay,
    });

    // Second (slightly after, +2m)
    this.spawnAfter(0.06, {
      lifeSeconds: p.lifeSeconds,
      startRadius: smallStart,
      endRadius: secondEnd,
      thickness: p.thickness,
      moveSpeed: move,
      color: p.color,
      opacity: p.opacity,
      steps: p.steps,
      softness: p.softness,
      noiseScale: p.noiseScale,
      spawnDistance: p.spawnDistance + 2.0,
      fadeStart: Math.min(0.75, p.fadeStart + 0.05),
      fadeEnd: Math.min(0.95, p.fadeEnd + 0.05),
      growthExponent: 1.2,
      growthDelay: 0.02,
    });

    // Third (same time as second, +4.5m more, collapse-then-grow)
    this.spawnAfter(0.06, {
      lifeSeconds: p.lifeSeconds,
      startRadius: smallStart,
      endRadius: thirdEnd,
      thickness: p.thickness,
      moveSpeed: move,
      color: p.color,
      opacity: p.opacity,
      steps: p.steps,
      softness: p.softness,
      noiseScale: p.noiseScale,
      spawnDistance: p.spawnDistance + 6.5,
      fadeStart: Math.min(0.85, p.fadeStart + 0.15),
      fadeEnd: p.fadeEnd,
      growthMode: 'collapseThenGrow',
      collapseAt: 0.06,
      collapseScale: 0.05,
      recoverAt: 0.2,
      growthExponent: 2.0,
      growthDelay: 0.05,
    });
  }
}


