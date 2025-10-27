import * as THREE from 'three/webgpu';
import { attribute, uniform, float, vec3, vec4, mix, clamp, max, min, cos, sin, rotate, positionLocal, smoothstep } from 'three/tsl';
import { LAYERS } from '../core/Layers';

export interface IcoRingOptions {
  color?: THREE.ColorRepresentation;
  lifeSeconds?: number;
  moveSpeed?: number; // world units per second (+ forward, - backward relative to camera at spawn)
  startRadius?: number; // world units
  endRadius?: number;   // world units
  spawnDistance?: number; // meters in front of camera
  initialPosition?: THREE.Vector3; // world-space origin at fire time
  initialQuaternion?: THREE.Quaternion; // world-space orientation at fire time
  direction?: THREE.Vector3; // world-space forward at fire time
  count?: number; // instances per ring
  detail?: number; // icosahedron subdivision detail (0..5)
  scaleMin?: number; // per-instance min scale multiplier
  scaleMax?: number; // per-instance max scale multiplier
  radialJitter?: number; // radial jitter amplitude in meters
  verticalJitter?: number; // thickness jitter amplitude along ring normal in meters
  angleJitter?: number; // radians of angular jitter
  spinSpeedMin?: number; // radians/sec minimum per-instance spin magnitude
  spinSpeedMax?: number; // radians/sec maximum per-instance spin magnitude
  fadeStart?: number; // life fraction
  fadeEnd?: number;   // life fraction
  growthExponent?: number; // >1 slows early growth
  growthDelay?: number; // life fraction before growth starts
  outline?: number; // deprecated with wireframe approach (kept for API stability)
  outlineOpacity?: number; // 0..1 wireframe opacity
  outlineEnabled?: boolean; // toggle edge rendering
}

// Shared geometry cache per detail level to reduce GPU buffers and memory.
const ICO_GEOMETRY_CACHE = new Map<number, THREE.IcosahedronGeometry>();
function getSharedIcoGeometry(detail: number): THREE.IcosahedronGeometry {
  let g = ICO_GEOMETRY_CACHE.get(detail);
  if (!g) {
    g = new THREE.IcosahedronGeometry(1, detail);
    ICO_GEOMETRY_CACHE.set(detail, g);
  }
  return g;
}

let SHARED_ICORING_MATERIAL: THREE.MeshBasicNodeMaterial | null = null;

function getSharedIcoRingMaterial(): THREE.MeshBasicNodeMaterial {
  if (SHARED_ICORING_MATERIAL) return SHARED_ICORING_MATERIAL;

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.alphaToCoverage = false;
  material.side = THREE.DoubleSide;

  // Per-object uniforms via onObjectUpdate
  const u_age = uniform(0).onObjectUpdate(({ object }: any) => object?.userData?.ico?.age ?? 0);
  const u_life = uniform(1).onObjectUpdate(({ object }: any) => object?.userData?.ico?.lifeSeconds ?? 1);
  const u_startR = uniform(0).onObjectUpdate(({ object }: any) => object?.userData?.ico?.startRadius ?? 0);
  const u_endR = uniform(0).onObjectUpdate(({ object }: any) => object?.userData?.ico?.endRadius ?? 0);
  const u_growthExp = uniform(2).onObjectUpdate(({ object }: any) => object?.userData?.ico?.growthExponent ?? 2);
  const u_growthDelay = uniform(0).onObjectUpdate(({ object }: any) => object?.userData?.ico?.growthDelay ?? 0);
  const u_fadeStart = uniform(0.65).onObjectUpdate(({ object }: any) => object?.userData?.ico?.fadeStart ?? 0.65);
  const u_fadeEnd = uniform(0.95).onObjectUpdate(({ object }: any) => object?.userData?.ico?.fadeEnd ?? 0.95);
  const u_color = uniform(new THREE.Color(0xffffff)).onObjectUpdate(({ object }: any) => object?.userData?.ico?.color ?? new THREE.Color(0xffffff));
  const u_edgeW = uniform(0.02).onObjectUpdate(({ object }: any) => object?.userData?.ico?.outline ?? 0.02);
  const u_edgeEnable = uniform(1.0).onObjectUpdate(({ object }: any) => (object?.userData?.ico?.outlineEnabled === false ? 0.0 : 1.0));
  const u_edgeOpacity = uniform(1.0).onObjectUpdate(({ object }: any) => object?.userData?.ico?.outlineOpacity ?? 1.0);

  // Base color; edges are mixed in later
  material.colorNode = vec4(u_color, float(1));

  // Vertex transform graph
  const t = clamp(u_age.div(u_life), 0, 1);
  const tDelayed = clamp(t.sub(u_growthDelay).div(float(1).sub(u_growthDelay)), 0, 1);
  const growthT = tDelayed.pow(u_growthExp);
  const currentR = mix(u_startR, u_endR, growthT);

  const v0 = attribute('i_v0', 'vec4');
  const v1 = attribute('i_v1', 'vec4');
  const aBase = v0.x;
  const rOffset = v0.y;
  const scl = v0.z;
  const zOffset = v0.w;
  const eulerBase = vec3(v1.x, v1.y, v1.z);
  const spinZ = v1.w;
  const eulerNow = eulerBase.add(vec3(float(0), float(0), spinZ.mul(u_age)));

  const rNow = max(float(0.001), currentR.add(rOffset));
  const px = rNow.mul(cos(aBase));
  const py = rNow.mul(sin(aBase));
  const pz = zOffset;

  const scaled = positionLocal.mul(scl);
  const rotated = rotate(scaled, eulerNow);
  material.positionNode = rotated.add(vec3(px, py, pz));

  const denom = max(float(1e-5), u_fadeEnd.sub(u_fadeStart));
  const fade = float(1).sub(clamp(u_age.div(u_life).sub(u_fadeStart).div(denom), 0, 1));
  material.opacityNode = fade;

  // Per-triangle edge factor from barycentric coordinates
  const bary = attribute('bary', 'vec3');
  const bmin = min(min(bary.x, bary.y), bary.z);
  const edge = float(1).sub(smoothstep(float(0), max(float(1e-4), u_edgeW), bmin));
  const edgeMask = clamp(edge.mul(u_edgeOpacity).mul(u_edgeEnable), 0, 1);
  const finalRGB = mix(u_color, vec3(float(0)), edgeMask);
  material.colorNode = vec4(finalRGB, float(1));

  SHARED_ICORING_MATERIAL = material;
  return material;
}

class IcoRing {
  public readonly group: THREE.Group;
  public alive = true;

  private readonly mesh: THREE.InstancedMesh;
  private instanceCount: number;
  private readonly lifeSeconds: number;
  private readonly startRadius: number;
  private readonly endRadius: number;
  private readonly moveDir: THREE.Vector3;
  private moveSpeed: number;
  private readonly fadeStart: number;
  private readonly fadeEnd: number;
  private readonly growthExponent: number;
  private readonly growthDelay: number;

  private age = 0;

  // Pool data
  private capacity: number;
  private instanceData: Float32Array;
  private interleaved: any;

  constructor(camera: THREE.Camera, opts: IcoRingOptions = {}) {
    const baseColor = new THREE.Color(opts.color ?? 0xffffff);

    this.lifeSeconds = Math.max(0.2, opts.lifeSeconds ?? 4.0);
    this.moveSpeed = opts.moveSpeed ?? 0.0;
    this.startRadius = Math.max(0.05, opts.startRadius ?? 3.0);
    this.endRadius = Math.max(this.startRadius, opts.endRadius ?? 10.0);
    this.fadeStart = THREE.MathUtils.clamp(opts.fadeStart ?? 0.65, 0, 1);
    this.fadeEnd = THREE.MathUtils.clamp(opts.fadeEnd ?? 0.95, 0, 1);
    this.growthExponent = Math.max(0.1, opts.growthExponent ?? 2.0);
    this.growthDelay = THREE.MathUtils.clamp(opts.growthDelay ?? 0.02, 0, 0.95);

    const count = Math.max(1, Math.floor(opts.count ?? 80));
    const detail = Math.max(0, Math.min(5, Math.floor(opts.detail ?? 0)));
    const scaleMin = Math.max(0.005, opts.scaleMin ?? 0.06);
    const scaleMax = Math.max(scaleMin, opts.scaleMax ?? 0.16);
    const radialJitter = Math.max(0, opts.radialJitter ?? 0.25);
    const verticalJitter = Math.max(0, opts.verticalJitter ?? 0.12);
    const angleJitter = Math.max(0, opts.angleJitter ?? 0.25);
    const spinMin = Math.max(0, opts.spinSpeedMin ?? 0.0);
    const spinMax = Math.max(spinMin, opts.spinSpeedMax ?? 1.5);

    // Scene objects
    this.group = new THREE.Group();
    this.group.layers.set(LAYERS.WORLD);

    // Use non-indexed geometry to assign barycentric per-triangle; clone if already non-indexed
    const base = getSharedIcoGeometry(detail);
    const geometry = (base as any).index ? base.toNonIndexed() : base.clone();

    // Drop normals/UVs for unlit material
    if (geometry.getAttribute('normal')) geometry.deleteAttribute('normal');
    if (geometry.getAttribute('uv')) geometry.deleteAttribute('uv');

    // Build barycentric attribute
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    const vcount = (posAttr as any).count as number;
    const triCount = Math.floor(vcount / 3);
    const bary = new Float32Array(vcount * 3);
    for (let i = 0; i < triCount; i++) {
      const o = i * 9;
      bary[o + 0] = 1; bary[o + 1] = 0; bary[o + 2] = 0;
      bary[o + 3] = 0; bary[o + 4] = 1; bary[o + 5] = 0;
      bary[o + 6] = 0; bary[o + 7] = 0; bary[o + 8] = 1;
    }
    geometry.setAttribute('bary', new (THREE as any).BufferAttribute(bary, 3));

    // Pack per-instance data into one interleaved instanced buffer
    // v0 = [ angle, radialOffset, scale, verticalOffset ]
    // v1 = [ eulerX, eulerY, eulerZ, spinSpeedZ ]
    const stride = 8; // floats per instance (2 x vec4)
    const data = new Float32Array(count * stride);
    for (let i = 0; i < count; i++) {
      const ti = (i + Math.random() * angleJitter) / count;
      const ang = ti * Math.PI * 2;
      const radial = (Math.random() * 2 - 1) * radialJitter;
      const vertical = (Math.random() * 2 - 1) * verticalJitter;
      const scl = THREE.MathUtils.lerp(scaleMin, scaleMax, Math.random());

      const eX = Math.random() * Math.PI * 2;
      const eY = Math.random() * Math.PI * 2;
      const eZ = Math.random() * Math.PI * 2;
      const spinZ = THREE.MathUtils.lerp(spinMin, spinMax, Math.random()) * (Math.random() < 0.5 ? -1 : 1);

      const baseIdx = i * stride;
      // v0
      data[baseIdx + 0] = ang;
      data[baseIdx + 1] = radial;
      data[baseIdx + 2] = scl;
      data[baseIdx + 3] = vertical;
      // v1
      data[baseIdx + 4] = eX;
      data[baseIdx + 5] = eY;
      data[baseIdx + 6] = eZ;
      data[baseIdx + 7] = spinZ;
    }
    const interleaved = new (THREE as any).InstancedInterleavedBuffer(data, stride);
    geometry.setAttribute('i_v0', new (THREE as any).InterleavedBufferAttribute(interleaved, 4, 0));
    geometry.setAttribute('i_v1', new (THREE as any).InterleavedBufferAttribute(interleaved, 4, 4));

    const material = getSharedIcoRingMaterial();

    this.instanceCount = count;
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = count;
    this.mesh.layers.set(LAYERS.WORLD);
    this.group.add(this.mesh);


    // Store pool data
    this.capacity = count;
    this.instanceData = data;
    this.interleaved = interleaved;

    // Spawn transform fixed to fire-time camera pose and direction (if provided)
    const capDir = new THREE.Vector3();
    if (opts.direction) capDir.copy(opts.direction).normalize(); else (camera as any).getWorldDirection(capDir).normalize();
    const spawnDist = Math.max(0, opts.spawnDistance ?? 1.5);
    const camQuat = new THREE.Quaternion();
    if (opts.initialQuaternion) camQuat.copy(opts.initialQuaternion); else (camera as any).getWorldQuaternion(camQuat);
    const camPos = new THREE.Vector3();
    if (opts.initialPosition) camPos.copy(opts.initialPosition); else (camera as any).getWorldPosition(camPos);
    const spawnPos = camPos.clone().add(capDir.clone().multiplyScalar(spawnDist));
    this.group.position.copy(spawnPos);
    this.group.quaternion.copy(camQuat);
    // Move strictly along the ring normal (group +Z) so no sideways drift
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(camQuat).normalize();
    this.moveDir = normal;

    // Initialize per-object uniform data to drive shared material
    (this.mesh as any).userData = (this.mesh as any).userData || {};
    (this.mesh as any).userData.ico = {
      age: 0,
      lifeSeconds: this.lifeSeconds,
      startRadius: this.startRadius,
      endRadius: this.endRadius,
      growthExponent: this.growthExponent,
      growthDelay: this.growthDelay,
      fadeStart: this.fadeStart,
      fadeEnd: this.fadeEnd,
      color: baseColor,
      outline: Math.max(0.001, Math.min(0.2, opts.outline ?? 0.02)),
      outlineOpacity: Math.max(0.0, Math.min(1.0, opts.outlineOpacity ?? 1.0)),
      outlineEnabled: opts.outlineEnabled ?? true,
    };
    // No extra wire mesh; edges are in-shader
  }

  addTo(scene: THREE.Scene): this {
    scene.add(this.group);
    return this;
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.age += dt;
    if (this.moveSpeed !== 0) {
      this.group.position.addScaledVector(this.moveDir, this.moveSpeed * dt);
    }
    // Update per-object uniform data
    const ud = (this.mesh as any).userData;
    if (ud && ud.ico) ud.ico.age = this.age;
    // uniforms already stored on mesh

    // Use per-object lifetime and fade settings (updated on restart)
    const life = (ud && ud.ico && ud.ico.lifeSeconds) ? ud.ico.lifeSeconds as number : this.lifeSeconds;
    const t = Math.min(1, this.age / Math.max(1e-5, life));
    if (this.age >= life) {
      this.alive = false;
      this.group.visible = false;
    }
  }

  dispose(scene?: THREE.Scene): void {
    if (scene) scene.remove(this.group);
    // Shared material is reused globally; do not dispose here
  }

  restart(camera: THREE.Camera, opts: IcoRingOptions): void {
    const targetCount = Math.max(1, Math.floor(opts.count ?? this.instanceCount));
    const count = Math.min(this.capacity, targetCount);

    // Refill instance data
    const scaleMin = Math.max(0.005, opts.scaleMin ?? 0.06);
    const scaleMax = Math.max(scaleMin, opts.scaleMax ?? 0.16);
    const radialJitter = Math.max(0, opts.radialJitter ?? 0.25);
    const verticalJitter = Math.max(0, opts.verticalJitter ?? 0.12);
    const angleJitter = Math.max(0, opts.angleJitter ?? 0.25);
    const spinMin = Math.max(0, opts.spinSpeedMin ?? 0.0);
    const spinMax = Math.max(spinMin, opts.spinSpeedMax ?? 1.5);
    const stride = 8;
    for (let i = 0; i < count; i++) {
      const ti = (i + Math.random() * angleJitter) / count;
      const ang = ti * Math.PI * 2;
      const radial = (Math.random() * 2 - 1) * radialJitter;
      const vertical = (Math.random() * 2 - 1) * verticalJitter;
      const scl = THREE.MathUtils.lerp(scaleMin, scaleMax, Math.random());
      const eX = Math.random() * Math.PI * 2;
      const eY = Math.random() * Math.PI * 2;
      const eZ = Math.random() * Math.PI * 2;
      const spinZ = THREE.MathUtils.lerp(spinMin, spinMax, Math.random()) * (Math.random() < 0.5 ? -1 : 1);
      const baseIdx = i * stride;
      this.instanceData[baseIdx + 0] = ang;
      this.instanceData[baseIdx + 1] = radial;
      this.instanceData[baseIdx + 2] = scl;
      this.instanceData[baseIdx + 3] = vertical;
      this.instanceData[baseIdx + 4] = eX;
      this.instanceData[baseIdx + 5] = eY;
      this.instanceData[baseIdx + 6] = eZ;
      this.instanceData[baseIdx + 7] = spinZ;
    }
    this.interleaved.needsUpdate = true;
    (this.mesh as any).count = count;
    this.instanceCount = count;

    // Update per-object uniforms
    const ud = (this.mesh as any).userData;
    if (ud && ud.ico) {
      ud.ico.age = 0;
      ud.ico.lifeSeconds = Math.max(0.2, opts.lifeSeconds ?? ud.ico.lifeSeconds);
      ud.ico.startRadius = Math.max(0.05, opts.startRadius ?? ud.ico.startRadius);
      ud.ico.endRadius = Math.max(ud.ico.startRadius, opts.endRadius ?? ud.ico.endRadius);
      ud.ico.growthExponent = Math.max(0.1, opts.growthExponent ?? ud.ico.growthExponent);
      ud.ico.growthDelay = THREE.MathUtils.clamp(opts.growthDelay ?? ud.ico.growthDelay, 0, 0.95);
      ud.ico.fadeStart = THREE.MathUtils.clamp(opts.fadeStart ?? ud.ico.fadeStart, 0, 1);
      ud.ico.fadeEnd = THREE.MathUtils.clamp(opts.fadeEnd ?? ud.ico.fadeEnd, 0, 1);
      if (opts.color) ud.ico.color = new THREE.Color(opts.color);
      ud.ico.outline = Math.max(0.001, Math.min(0.2, opts.outline ?? ud.ico.outline ?? 0.02));
      ud.ico.outlineOpacity = Math.max(0.0, Math.min(1.0, opts.outlineOpacity ?? ud.ico.outlineOpacity ?? 1.0));
      ud.ico.outlineEnabled = opts.outlineEnabled ?? ud.ico.outlineEnabled ?? true;
    }

    // Movement
    this.moveSpeed = opts.moveSpeed ?? this.moveSpeed;

    // Respawn using provided fire-time pose/direction if available
    const capDir = new THREE.Vector3();
    if (opts.direction) capDir.copy(opts.direction).normalize(); else (camera as any).getWorldDirection(capDir).normalize();
    const spawnDist = Math.max(0, opts.spawnDistance ?? 1.5);
    const camQuat = new THREE.Quaternion();
    if (opts.initialQuaternion) camQuat.copy(opts.initialQuaternion); else (camera as any).getWorldQuaternion(camQuat);
    const camPos = new THREE.Vector3();
    if (opts.initialPosition) camPos.copy(opts.initialPosition); else (camera as any).getWorldPosition(camPos);
    const spawnPos = camPos.clone().add(capDir.clone().multiplyScalar(spawnDist));
    this.group.position.copy(spawnPos);
    this.group.quaternion.copy(camQuat);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(camQuat).normalize();
    this.moveDir = normal;

    this.age = 0;
    this.alive = true;
    this.group.visible = true;
    // no wire material to update
  }
}

export class IcoRingsManager {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly rings: IcoRing[] = [];
  private readonly pending: { delay: number; opts: IcoRingOptions }[] = [];
  private readonly pool: IcoRing[] = [];

  public readonly params = {
    lifeSeconds: 6.0,
    startRadius: 3.5,
    endRadius: 11.0,
    moveSpeed: 0.7,
    color: '#ffffff',
    count: 84,
    detail: 0,
    scaleMin: 0.06,
    scaleMax: 0.16,
    radialJitter: 0.25,
    verticalJitter: 0.12,
    angleJitter: 0.25,
    spinSpeedMin: 0.0,
    spinSpeedMax: 1.8,
    spawnDistance: 1.5,
    fadeStart: 0.65,
    fadeEnd: 0.95,
    growthExponent: 2.0,
    growthDelay: 0.02,
    outline: 0.02,
    outlineOpacity: 1.0,
    outlineEnabled: true,
  };

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;

    // Prewarm pool
    const p = this.params;
    const poolSize = 6;
    for (let i = 0; i < poolSize; i++) {
      const ring = new IcoRing(this.camera, {
        lifeSeconds: 1.0,
        startRadius: p.startRadius,
        endRadius: p.endRadius,
        moveSpeed: 0.0,
        color: p.color,
        count: p.count,
        detail: p.detail,
        scaleMin: p.scaleMin,
        scaleMax: p.scaleMax,
        radialJitter: p.radialJitter,
        verticalJitter: p.verticalJitter,
        angleJitter: p.angleJitter,
        spinSpeedMin: p.spinSpeedMin,
        spinSpeedMax: p.spinSpeedMax,
        spawnDistance: p.spawnDistance,
        fadeStart: p.fadeStart,
        fadeEnd: p.fadeEnd,
        growthExponent: p.growthExponent,
        growthDelay: p.growthDelay,
        outline: p.outline,
        outlineOpacity: p.outlineOpacity,
        outlineEnabled: p.outlineEnabled,
      }).addTo(this.scene);
      ring['group'].visible = false;
      ring['alive'] = false;
      this.pool.push(ring);
    }

    // Prewarm render: draw one short-lived ring once
    const warm = this.acquire();
    warm.restart(this.camera, { lifeSeconds: 0.05, count: 1, moveSpeed: 0.0 });
    this.rings.push(warm);
  }

  private acquire(): IcoRing {
    if (this.pool.length > 0) return this.pool.pop() as IcoRing;
    // Fallback if pool exhausted
    const p = this.params;
    const ring = new IcoRing(this.camera, {
      lifeSeconds: p.lifeSeconds,
      startRadius: p.startRadius,
      endRadius: p.endRadius,
      moveSpeed: p.moveSpeed,
      color: p.color,
      count: p.count,
      detail: p.detail,
      scaleMin: p.scaleMin,
      scaleMax: p.scaleMax,
      radialJitter: p.radialJitter,
      verticalJitter: p.verticalJitter,
      angleJitter: p.angleJitter,
      spinSpeedMin: p.spinSpeedMin,
      spinSpeedMax: p.spinSpeedMax,
      spawnDistance: p.spawnDistance,
      fadeStart: p.fadeStart,
      fadeEnd: p.fadeEnd,
      growthExponent: p.growthExponent,
      growthDelay: p.growthDelay,
      outline: p.outline,
      outlineOpacity: p.outlineOpacity,
      outlineEnabled: p.outlineEnabled,
    }).addTo(this.scene);
    return ring;
  }

  private release(ring: IcoRing): void {
    ring['group'].visible = false;
    this.pool.push(ring);
  }

  spawn(opts: IcoRingOptions = {}): IcoRing {
    const p = this.params;
    const ring = this.acquire();
    ring.restart(this.camera, {
      lifeSeconds: opts.lifeSeconds ?? p.lifeSeconds,
      startRadius: opts.startRadius ?? p.startRadius,
      endRadius: opts.endRadius ?? p.endRadius,
      moveSpeed: opts.moveSpeed ?? p.moveSpeed,
      color: opts.color ?? p.color,
      count: opts.count ?? p.count,
      detail: opts.detail ?? p.detail,
      scaleMin: opts.scaleMin ?? p.scaleMin,
      scaleMax: opts.scaleMax ?? p.scaleMax,
      radialJitter: opts.radialJitter ?? p.radialJitter,
      verticalJitter: opts.verticalJitter ?? p.verticalJitter,
      angleJitter: opts.angleJitter ?? p.angleJitter,
      spinSpeedMin: opts.spinSpeedMin ?? p.spinSpeedMin,
      spinSpeedMax: opts.spinSpeedMax ?? p.spinSpeedMax,
      spawnDistance: opts.spawnDistance ?? p.spawnDistance,
      fadeStart: opts.fadeStart ?? p.fadeStart,
      fadeEnd: opts.fadeEnd ?? p.fadeEnd,
      growthExponent: opts.growthExponent ?? p.growthExponent,
      growthDelay: opts.growthDelay ?? p.growthDelay,
      outline: opts.outline ?? p.outline,
      outlineOpacity: opts.outlineOpacity ?? p.outlineOpacity,
      outlineEnabled: opts.outlineEnabled ?? p.outlineEnabled,
    });
    this.rings.push(ring);
    return ring;
  }

  update(dt: number): void {
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
        this.rings.splice(i, 1);
        this.release(r);
      }
    }
  }

  private spawnAfter(delay: number, opts: IcoRingOptions): void {
    this.pending.push({ delay, opts });
  }

  public spawnAssembly(): void {
    const p = this.params;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward).normalize();
    const camPos = new THREE.Vector3();
    (this.camera as any).getWorldPosition(camPos);
    const camQuat = new THREE.Quaternion();
    (this.camera as any).getWorldQuaternion(camQuat);
    const move = p.moveSpeed;
    const mainStart = p.startRadius;
    const mainEnd = p.endRadius;
    const smallStart = mainStart / 3;
    const secondEnd = mainEnd * 0.55;
    const thirdEnd = mainEnd / 3;

    this.spawn({
      lifeSeconds: p.lifeSeconds,
      startRadius: mainStart,
      endRadius: mainEnd,
      moveSpeed: move,
      color: p.color,
      count: p.count,
      detail: p.detail,
      scaleMin: p.scaleMin,
      scaleMax: p.scaleMax,
      radialJitter: p.radialJitter,
      verticalJitter: p.verticalJitter,
      angleJitter: p.angleJitter,
      spinSpeedMin: p.spinSpeedMin,
      spinSpeedMax: p.spinSpeedMax,
      spawnDistance: p.spawnDistance,
      fadeStart: p.fadeStart,
      fadeEnd: p.fadeEnd,
      growthExponent: p.growthExponent,
      growthDelay: p.growthDelay,
      direction: forward,
      initialPosition: camPos,
      initialQuaternion: camQuat,
    });

    this.spawnAfter(0.06, {
      lifeSeconds: p.lifeSeconds,
      startRadius: smallStart,
      endRadius: secondEnd,
      moveSpeed: move,
      color: p.color,
      count: Math.max(20, Math.floor(p.count * 0.75)),
      detail: p.detail,
      scaleMin: p.scaleMin * 0.8,
      scaleMax: p.scaleMax * 0.9,
      radialJitter: p.radialJitter * 0.9,
      verticalJitter: p.verticalJitter * 1.2,
      angleJitter: p.angleJitter,
      spinSpeedMin: p.spinSpeedMin,
      spinSpeedMax: p.spinSpeedMax,
      spawnDistance: p.spawnDistance + 2.0,
      fadeStart: Math.min(0.75, p.fadeStart + 0.05),
      fadeEnd: Math.min(0.95, p.fadeEnd + 0.05),
      growthExponent: 1.2,
      growthDelay: 0.02,
      direction: forward,
      initialPosition: camPos,
      initialQuaternion: camQuat,
    });

    this.spawnAfter(0.06, {
      lifeSeconds: p.lifeSeconds,
      startRadius: smallStart,
      endRadius: thirdEnd,
      moveSpeed: move,
      color: p.color,
      count: Math.max(16, Math.floor(p.count * 0.6)),
      detail: p.detail,
      scaleMin: p.scaleMin * 0.7,
      scaleMax: p.scaleMax * 0.8,
      radialJitter: p.radialJitter * 0.8,
      verticalJitter: p.verticalJitter * 1.3,
      angleJitter: p.angleJitter,
      spinSpeedMin: p.spinSpeedMin,
      spinSpeedMax: p.spinSpeedMax,
      spawnDistance: p.spawnDistance + 6.5,
      fadeStart: Math.min(0.85, p.fadeStart + 0.15),
      fadeEnd: p.fadeEnd,
      growthExponent: 2.0,
      growthDelay: 0.05,
      direction: forward,
      initialPosition: camPos,
      initialQuaternion: camQuat,
    });
  }
}


