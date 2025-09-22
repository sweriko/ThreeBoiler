import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';

export interface GroundOptions {
  size?: number;
  color?: number;
  texturePath?: string;
  textureFile?: string;
}

export function createGround(scene: THREE.Scene, world: RAPIER.World, opts: GroundOptions = {}): {
  mesh: THREE.Mesh;
} {
  const size = opts.size ?? 200;
  const groundGeo = new THREE.PlaneGeometry(size, size, 1, 1);
  const groundMat = new THREE.MeshStandardMaterial({ color: opts.color ?? 0xffffff, metalness: 0.0, roughness: 1.0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  if (opts.texturePath && opts.textureFile) {
    const texLoader = new THREE.TextureLoader();
    texLoader.setPath(opts.texturePath);
    texLoader.load(opts.textureFile, (tex) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      const tiles = size / 4;
      tex.repeat.set(tiles, tiles);
      tex.colorSpace = THREE.SRGBColorSpace;
      groundMat.map = tex;
      groundMat.needsUpdate = true;
    });
  }

  // Physics collider (trimesh) from plane geometry
  const pos = groundGeo.attributes.position.array as Float32Array;
  const vertices = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i + 0];
    const y = pos[i + 1];
    vertices[i + 0] = x;
    vertices[i + 1] = 0;
    vertices[i + 2] = -y;
  }
  let indices: Uint32Array;
  if (groundGeo.index) {
    const idx = groundGeo.index.array as unknown as ArrayLike<number>;
    indices = new Uint32Array(idx as any);
  } else {
    indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
  }
  const trimesh = RAPIER.ColliderDesc.trimesh(vertices, indices);
  trimesh.setRestitution(0.0).setFriction(1.0);
  const rb = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
  const body = world.createRigidBody(rb);
  world.createCollider(trimesh, body);

  return { mesh: ground };
}



