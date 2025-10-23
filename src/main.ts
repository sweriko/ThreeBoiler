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
app.scene.add(new THREE.AmbientLight(0xffffff, 0.05));

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
app.renderer.domElement.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button !== 0) return;
  shockRings.spawn({
    lifeSeconds: 2.4,
    startRadius: 0.7,
    endRadius: 6.0,
    thickness: 0.03,
    moveSpeed: 4.0,
    opacity: 0.95,
    color: 0xe8eef9,
  });
});

// GUI
const lightParams = { directionX: 5, directionY: 10, directionZ: 5, intensity: 3.0, exposure: 1.0, envBackground: true };
const fLight = app.gui.addFolder('Lighting');
fLight.add(lightParams, 'intensity', 0, 10, 0.1).name('DirLight Intensity').onChange((v: number) => dirLight.intensity = v);
fLight.add(lightParams, 'exposure', 0, 2, 0.01).name('Tone Exposure').onChange((v: number) => app.setExposure(v));
fLight.add(lightParams, 'envBackground').name('Env as Background').onChange((v: boolean) => app.scene.background = v ? hdr : new THREE.Color(0x000000));
fLight.add(lightParams, 'directionX', -20, 20, 0.1).name('Dir X').onChange((v: number) => dirLight.position.x = v);
fLight.add(lightParams, 'directionY', -20, 20, 0.1).name('Dir Y').onChange((v: number) => dirLight.position.y = v);
fLight.add(lightParams, 'directionZ', -20, 20, 0.1).name('Dir Z').onChange((v: number) => dirLight.position.z = v);
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

// Update loop with fixed-step physics
let accumulator = 0;
const fixedStep = 1 / 60;
const maxAccum = 0.25;
app.addUpdater((dt) => {
  accumulator += dt;
  if (accumulator > maxAccum) accumulator = maxAccum;
  while (accumulator >= fixedStep) {
    controller.updateBeforePhysics(fixedStep);
    physics.step();
    controller.updateAfterPhysics();
    accumulator -= fixedStep;
  }
  shockRings.update(dt);
});
app.start();


