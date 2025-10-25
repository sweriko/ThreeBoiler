import * as THREE from 'three/webgpu';
import { App } from './core/App';
import { Physics } from './core/Physics';
import { loadHDRI } from './utils/Environment';
import { createGround } from './world/ground';
import { FPSController, FPSControllerOptions } from './controllers/FPSController';
import { ShockRingManager } from './effects/ShockRing';

const root = document.getElementById('app') as HTMLDivElement;
const app = await App.create(root);
const physics = await Physics.create({ x: 0, y: -9.81, z: 0 });

// Lighting
const dirLight = new THREE.DirectionalLight(0xffffff, 3.0);
dirLight.position.set(5, 10, 5);
app.scene.add(dirLight);

// HDR Skybox/Env
const hdr = await loadHDRI('/assets/', 'skybox.hdr');
app.scene.environment = hdr;
app.scene.background = hdr;

// Ground
createGround(app.scene, physics.world, { size: 200, texturePath: '/assets/', textureFile: 'ground.png' });

// FPS Controller
const controllerOptions: FPSControllerOptions = {
  moveSpeed: 6,
  sprintSpeed: 10,
  jumpSpeed: 8,
  eyeHeight: 1.6,
  capsuleRadius: 0.35,
  capsuleHeight: 1.8,
  mouseSensitivity: 0.003,
  rotationSmoothingTime: 0.0,
  invertY: false,
  flyModeInitially: false,
  getGroundHeight: (x: number, z: number) => 0
};
const controller = new FPSController(physics.world, app.camera, app.renderer.domElement, controllerOptions);
controller.enableDebugMesh(app.scene, false);

// Shock rings
const shockRings = new ShockRingManager(app.scene, app.camera);

// Ambient light reference for GUI
const ambientLight = new THREE.AmbientLight(0xffffff, 0.05);
app.scene.add(ambientLight);

// GUI - Performance Controls
const perfParams = {
  pixelRatio: Math.min(window.devicePixelRatio, 2),
  renderScale: 1.0,
  maxFPS: 0,
  showStats: true,
  toneMapping: 'ACESFilmic',
  fov: 70,
  nearPlane: 0.05,
  farPlane: 500,
  physicsFPS: 60,
  physicsEnabled: true,
  gravity: -9.81,
  maxPhysicsAccum: 0.25,
};

const fPerf = app.gui.addFolder('⚡ Performance');
fPerf.add(perfParams, 'pixelRatio', 0.25, 3, 0.25).name('Pixel Ratio').onChange((v: number) => {
  app.renderer.setPixelRatio(v);
});
fPerf.add(perfParams, 'renderScale', 0.25, 2, 0.05).name('Render Scale').onChange((v: number) => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  app.renderer.setSize(w * v, h * v, false);
});
fPerf.add(perfParams, 'maxFPS', 0, 240, 10).name('Max FPS (0=unlimited)');
fPerf.add(perfParams, 'showStats').name('Show Stats').onChange((v: boolean) => {
  app.stats.forEach(s => s.dom.style.display = v ? 'block' : 'none');
});
fPerf.add(perfParams, 'toneMapping', ['None', 'Linear', 'Reinhard', 'Cineon', 'ACESFilmic', 'AgX', 'Neutral']).name('Tone Mapping').onChange((v: string) => {
  const mapping: Record<string, THREE.ToneMapping> = {
    'None': THREE.NoToneMapping,
    'Linear': THREE.LinearToneMapping,
    'Reinhard': THREE.ReinhardToneMapping,
    'Cineon': THREE.CineonToneMapping,
    'ACESFilmic': THREE.ACESFilmicToneMapping,
    'AgX': THREE.AgXToneMapping,
    'Neutral': THREE.NeutralToneMapping,
  };
  app.renderer.toneMapping = mapping[v];
});
fPerf.add(perfParams, 'fov', 30, 120, 1).name('FOV').onChange((v: number) => {
  app.camera.fov = v;
  app.camera.updateProjectionMatrix();
});
fPerf.add(perfParams, 'nearPlane', 0.01, 1, 0.01).name('Near Plane').onChange((v: number) => {
  app.camera.near = v;
  app.camera.updateProjectionMatrix();
});
fPerf.add(perfParams, 'farPlane', 50, 2000, 50).name('Far Plane').onChange((v: number) => {
  app.camera.far = v;
  app.camera.updateProjectionMatrix();
});
fPerf.add(perfParams, 'physicsFPS', 30, 240, 10).name('Physics FPS').onChange((v: number) => {
  fixedStep = 1 / v;
});
fPerf.add(perfParams, 'physicsEnabled').name('Physics Enabled').onChange((v: boolean) => {
  if (!v) {
    // Stop player from falling when physics disabled
    const vel = controller.getRigidBody().linvel();
    controller.getRigidBody().setLinvel({ x: 0, y: 0, z: 0 }, true);
  }
});
fPerf.add(perfParams, 'gravity', -30, 0, 0.5).name('Gravity Y').onChange((v: number) => {
  physics.world.gravity.y = v;
});
fPerf.add(perfParams, 'maxPhysicsAccum', 0.1, 1.0, 0.05).name('Max Physics Accum');
fPerf.add({ resetView: () => {
  app.camera.position.set(0, 1.6, 4);
  app.camera.rotation.set(0, 0, 0);
  controller.getRigidBody().setTranslation({ x: 0, y: 1.6, z: 4 }, true);
  controller.getRigidBody().setLinvel({ x: 0, y: 0, z: 0 }, true);
}}, 'resetView').name('Reset Camera/Player');

// Advanced rendering stats
const renderStats = {
  triangles: '0',
  drawCalls: '0',
  textures: '0',
  geometries: '0',
  programs: '0',
  sceneObjects: '0',
  activeRings: '0',
};

const fRenderStats = fPerf.addFolder('📊 Render Stats');
fRenderStats.add(renderStats, 'triangles').name('Triangles').listen().disable();
fRenderStats.add(renderStats, 'drawCalls').name('Draw Calls').listen().disable();
fRenderStats.add(renderStats, 'textures').name('Textures').listen().disable();
fRenderStats.add(renderStats, 'geometries').name('Geometries').listen().disable();
fRenderStats.add(renderStats, 'programs').name('Programs').listen().disable();
fRenderStats.add(renderStats, 'sceneObjects').name('Scene Objects').listen().disable();
fRenderStats.add(renderStats, 'activeRings').name('Active Rings').listen().disable();
fRenderStats.close();

// Memory stats (if available)
if ((performance as any).memory) {
  const memStats = { 
    usedJSHeap: '0 MB', 
    totalJSHeap: '0 MB',
    limit: '0 MB'
  };
  const fMemStats = fPerf.addFolder('💾 Memory');
  fMemStats.add(memStats, 'usedJSHeap').name('JS Heap Used').listen().disable();
  fMemStats.add(memStats, 'totalJSHeap').name('JS Heap Total').listen().disable();
  fMemStats.add(memStats, 'limit').name('JS Heap Limit').listen().disable();
  fMemStats.close();
  
  app.addUpdater(() => {
    const mem = (performance as any).memory;
    if (mem) {
      memStats.usedJSHeap = (mem.usedJSHeapSize / 1048576).toFixed(1) + ' MB';
      memStats.totalJSHeap = (mem.totalJSHeapSize / 1048576).toFixed(1) + ' MB';
      memStats.limit = (mem.jsHeapSizeLimit / 1048576).toFixed(1) + ' MB';
    }
  });
}

// Update render stats periodically (every 10 frames to reduce overhead)
let frameCount = 0;
app.addUpdater(() => {
  frameCount++;
  if (frameCount % 10 === 0) {
    const info = app.renderer.info;
    renderStats.triangles = info.render.triangles.toLocaleString();
    renderStats.drawCalls = info.render.calls.toLocaleString();
    renderStats.textures = info.memory.textures.toLocaleString();
    renderStats.geometries = info.memory.geometries.toLocaleString();
    renderStats.programs = ((info as any).programs?.length || 0).toLocaleString();
    
    // Count scene objects
    let objectCount = 0;
    app.scene.traverse(() => objectCount++);
    renderStats.sceneObjects = objectCount.toLocaleString();
    
    renderStats.activeRings = shockRings.getActiveCount().toString();
  }
});

fPerf.close();

// GUI - Lighting
const lightParams = { 
  directionX: 5, 
  directionY: 10, 
  directionZ: 5, 
  dirIntensity: 3.0,
  ambientIntensity: 0.05, 
  exposure: 1.0, 
  envBackground: true,
  envIntensity: 1.0
};
const fLight = app.gui.addFolder('💡 Lighting');
fLight.add(lightParams, 'dirIntensity', 0, 10, 0.1).name('DirLight Intensity').onChange((v: number) => dirLight.intensity = v);
fLight.add(lightParams, 'ambientIntensity', 0, 2, 0.01).name('Ambient Intensity').onChange((v: number) => ambientLight.intensity = v);
fLight.add(lightParams, 'exposure', 0, 2, 0.01).name('Tone Exposure').onChange((v: number) => app.setExposure(v));
fLight.add(lightParams, 'envIntensity', 0, 3, 0.1).name('Env Map Intensity').onChange((v: number) => {
  app.scene.environmentIntensity = v;
});
fLight.add(lightParams, 'envBackground').name('Env as Background').onChange((v: boolean) => app.scene.background = v ? hdr : new THREE.Color(0x000000));
const fDirPos = fLight.addFolder('Directional Light Position');
fDirPos.add(lightParams, 'directionX', -20, 20, 0.1).name('X').onChange((v: number) => dirLight.position.x = v);
fDirPos.add(lightParams, 'directionY', -20, 20, 0.1).name('Y').onChange((v: number) => dirLight.position.y = v);
fDirPos.add(lightParams, 'directionZ', -20, 20, 0.1).name('Z').onChange((v: number) => dirLight.position.z = v);
fDirPos.close();
fLight.close();

const ctrlParams = {
  moveSpeed: controllerOptions.moveSpeed!,
  sprintSpeed: controllerOptions.sprintSpeed!,
  jumpSpeed: controllerOptions.jumpSpeed!,
  eyeHeight: controllerOptions.eyeHeight!,
  radius: controllerOptions.capsuleRadius!,
  height: controllerOptions.capsuleHeight!,
  mouseSensitivity: controllerOptions.mouseSensitivity!,
  smoothingTime: controllerOptions.rotationSmoothingTime!,
  invertY: controllerOptions.invertY!,
  flyMode: controllerOptions.flyModeInitially!
};
const fCtrl = app.gui.addFolder('Controller');
fCtrl.add({ debugCapsule: false }, 'debugCapsule').name('Show Capsule').onChange((v: boolean) => controller.enableDebugMesh(app.scene, v));
fCtrl.add(ctrlParams, 'moveSpeed', 1, 20, 0.1).onChange((v: number) => controller.setMoveSpeed(v));
fCtrl.add(ctrlParams, 'sprintSpeed', 1, 40, 0.1).onChange((v: number) => controller.setSprintSpeed(v));
fCtrl.add(ctrlParams, 'jumpSpeed', 1, 30, 0.1).onChange((v: number) => controller.setJumpSpeed(v));
fCtrl.add(ctrlParams, 'eyeHeight', 0.4, 2.6, 0.01).onChange((v: number) => controller.setEyeHeight(v));
fCtrl.add(ctrlParams, 'mouseSensitivity', 0.0005, 0.01, 0.0001).onChange((v: number) => controller.setMouseSensitivity(v));
fCtrl.add(ctrlParams, 'smoothingTime', 0, 0.3, 0.005).onChange((v: number) => controller.setRotationSmoothingTime(v));
fCtrl.add(ctrlParams, 'invertY').onChange((v: boolean) => controller.setInvertY(v));
fCtrl.add({ toggleFly: () => controller.setFlyMode(!(controller as any).isFlyModeEnabled()) }, 'toggleFly').name('Toggle Fly (F)');
fCtrl.close();

// Shock Ring Controls
const fRing = app.gui.addFolder('⭕ Shock Ring');
const ringParams = shockRings.params;

// Ring management controls
const ringManagement = {
  maxRings: 100,
  autoSpawn: true,
};
fRing.add({ spawn: () => shockRings.spawnAssembly() }, 'spawn').name('🎆 Spawn Assembly');
fRing.add({ clearAll: () => shockRings.clearAll() }, 'clearAll').name('🗑️ Clear All Rings');
fRing.add(ringManagement, 'maxRings', 1, 500, 1).name('Max Rings Limit').onChange((v: number) => {
  shockRings.setMaxRings(v);
});
fRing.add(ringManagement, 'autoSpawn').name('Auto Spawn on Click').onChange((v: boolean) => {
  if (v) {
    app.renderer.domElement.addEventListener('mousedown', handleMouseDown);
  } else {
    app.renderer.domElement.removeEventListener('mousedown', handleMouseDown);
  }
});

// Visual parameters
const fRingVisuals = fRing.addFolder('Visual Parameters');
fRingVisuals.add(ringParams, 'lifeSeconds', 0.3, 20.0, 0.05).name('Life (s)');
fRingVisuals.add(ringParams, 'startRadius', 0.05, 4.0, 0.01).name('Start Radius');
fRingVisuals.add(ringParams, 'endRadius', 0.2, 20.0, 0.1).name('End Radius');
fRingVisuals.add(ringParams, 'thickness', 0.0003, 0.05, 0.0001).name('Thickness');
fRingVisuals.add(ringParams, 'moveSpeed', -5.0, 10.0, 0.1).name('Move Speed');
fRingVisuals.addColor(ringParams, 'color').name('Color');
fRingVisuals.add(ringParams, 'opacity', 0.05, 1.0, 0.01).name('Opacity');
fRingVisuals.close();

// Performance parameters
const fRingPerf = fRing.addFolder('Performance');
fRingPerf.add(ringParams, 'steps', 20, 220, 1).name('Raymarch Steps');
fRingPerf.add(ringParams, 'softness', 0.001, 0.2, 0.001).name('Softness');
fRingPerf.add(ringParams, 'noiseScale', 0.2, 6.0, 0.1).name('Noise Scale');
fRingPerf.close();

// Animation parameters
const fRingAnim = fRing.addFolder('Animation');
fRingAnim.add(ringParams, 'spawnDistance', 0.0, 10.0, 0.1).name('Spawn Distance');
fRingAnim.add(ringParams, 'fadeStart', 0.0, 0.95, 0.01).name('Fade Start');
fRingAnim.add(ringParams, 'fadeEnd', 0.05, 0.99, 0.01).name('Fade End');
fRingAnim.add(ringParams, 'growthDelay', 0.0, 0.9, 0.01).name('Growth Delay');
fRingAnim.add(ringParams, 'growthExponent', 0.1, 12.0, 0.1).name('Growth Expo');
fRingAnim.close();

fRing.close();

// Store mouse handler reference for toggling
function handleMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  shockRings.spawnAssembly();
}
app.renderer.domElement.addEventListener('mousedown', handleMouseDown);

// Update loop with fixed-step physics
let accumulator = 0;
let fixedStep = 1 / 60;
let lastFrameTime = performance.now();
app.addUpdater((dt) => {
  // FPS limiter
  if (perfParams.maxFPS > 0) {
    const now = performance.now();
    const minFrameTime = 1000 / perfParams.maxFPS;
    if (now - lastFrameTime < minFrameTime) {
      return; // Skip this frame
    }
    lastFrameTime = now;
  }

  if (perfParams.physicsEnabled) {
    accumulator += dt;
    const maxAccum = perfParams.maxPhysicsAccum;
    if (accumulator > maxAccum) accumulator = maxAccum;
    while (accumulator >= fixedStep) {
      controller.updateBeforePhysics(fixedStep);
      physics.step();
      controller.updateAfterPhysics();
      accumulator -= fixedStep;
    }
  } else {
    // Update camera position even without physics
    controller.updateAfterPhysics();
  }
  shockRings.update(dt);
});
app.start();


