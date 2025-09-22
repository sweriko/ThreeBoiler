import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export async function loadHDRI(path: string, file: string): Promise<THREE.DataTexture> {
  const loader = new HDRLoader();
  loader.setPath(path);
  const hdr = await loader.loadAsync(file);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  return hdr as THREE.DataTexture;
}



