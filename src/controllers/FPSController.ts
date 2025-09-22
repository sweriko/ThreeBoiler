import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';

export interface FPSControllerOptions {
    moveSpeed?: number;
    sprintSpeed?: number;
    jumpSpeed?: number;
    eyeHeight?: number;
    capsuleRadius?: number;
    capsuleHeight?: number;
    mouseSensitivity?: number;
    rotationSmoothingTime?: number;
    invertY?: boolean;
    flyModeInitially?: boolean;
    getGroundHeight?: (x: number, z: number) => number;
}

export class FPSController {
    private world: RAPIER.World;
    private camera: THREE.PerspectiveCamera;
    private domElement: HTMLElement;

    private body!: RAPIER.RigidBody;

    private yaw = 0;
    private pitch = 0;

    private moveSpeed: number;
    private sprintSpeed: number;
    private jumpSpeed: number;
    private eyeHeight: number;
    private readonly radius: number;
    private halfHeight: number;
    private mouseSensitivity: number;
    private rotationSmoothingTime: number;
    private invertY: boolean;
    private readonly getGroundHeight?: (x: number, z: number) => number;

    private moveForward = false;
    private moveBackward = false;
    private moveLeft = false;
    private moveRight = false;
    private isSprinting = false;
    private jumpQueued = false;
    private pointerLocked = false;

    private isFlyMode = false;
    private flyUp = false;
    private flyDown = false;

    // Mouse input smoothing (accumulate per event, filter per frame)
    private accumDX = 0;
    private accumDY = 0;
    private emaDX = 0;
    private emaDY = 0;

    // Debug capsule visualization
    private debugMesh?: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshBasicMaterial>;

    constructor(world: RAPIER.World, camera: THREE.PerspectiveCamera, domElement: HTMLElement, opts: FPSControllerOptions = {}) {
        this.world = world;
        this.camera = camera;
        this.domElement = domElement;

        this.camera.rotation.order = 'YXZ';

        this.moveSpeed = opts.moveSpeed ?? 6.0;
        this.sprintSpeed = opts.sprintSpeed ?? 10.0;
        this.jumpSpeed = opts.jumpSpeed ?? 8.0;
        this.eyeHeight = opts.eyeHeight ?? 1.6;
        this.radius = opts.capsuleRadius ?? 0.35;
        const totalHeight = opts.capsuleHeight ?? 1.8;
        this.halfHeight = Math.max(0.1, (totalHeight - 2 * this.radius) * 0.5);
        this.mouseSensitivity = opts.mouseSensitivity ?? 0.0016;
        this.rotationSmoothingTime = opts.rotationSmoothingTime ?? 0.0;
        this.invertY = opts.invertY ?? false;
        this.getGroundHeight = opts.getGroundHeight;

        this.initPhysicsBody();
        this.initPointerLock();
        this.initKeyboard();

        this.yaw = this.camera.rotation.y;
        this.pitch = this.camera.rotation.x;

        if (opts.flyModeInitially) {
            this.setFlyMode(true);
        }

        // Debug capsule mesh
        this.createDebugMesh();
    }

    public getRigidBody(): RAPIER.RigidBody {
        return this.body;
    }

    public update(delta: number): void {
        // Backward-compatible single-call update: perform before/after with internal step.
        this.updateBeforePhysics(delta);
        this.world.step();
        this.updateAfterPhysics();
    }

    public updateBeforePhysics(delta: number): void {
        const speed = this.isSprinting ? this.sprintSpeed : this.moveSpeed;
        const inputX = (this.moveRight ? 1 : 0) - (this.moveLeft ? 1 : 0);
        const inputZ = (this.moveForward ? 1 : 0) - (this.moveBackward ? 1 : 0);

        let vx = 0;
        let vz = 0;
        if (inputX !== 0 || inputZ !== 0) {
            const sinY = Math.sin(this.yaw);
            const cosY = Math.cos(this.yaw);

            const forwardX = -sinY;
            const forwardZ = -cosY;
            const rightX = cosY;
            const rightZ = -sinY;

            const dirX = rightX * inputX + forwardX * inputZ;
            const dirZ = rightZ * inputX + forwardZ * inputZ;
            const len = Math.hypot(dirX, dirZ) || 1.0;
            vx = (dirX / len) * speed;
            vz = (dirZ / len) * speed;
        }

        const currentVel = this.body.linvel();
        let vy = currentVel.y;
        if (this.isFlyMode) {
            const flyInputY = (this.flyUp ? 1 : 0) - (this.flyDown ? 1 : 0);
            vy = flyInputY * speed;
            this.jumpQueued = false;
        } else {
            let grounded = false;
            const center = this.body.translation();
            if (this.getGroundHeight) {
                const bottomY = center.y - (this.halfHeight + this.radius);
                const groundY = this.getGroundHeight(center.x, center.z);
                grounded = (bottomY - groundY) <= 0.08;
            } else {
                const bottomY = center.y - (this.halfHeight + this.radius);
                grounded = bottomY <= 0.055;
            }

            if (this.jumpQueued && grounded) {
                vy = this.jumpSpeed;
            }
            this.jumpQueued = false;
        }

        // Apply velocity directly without extra damping to avoid sluggish feel
        this.body.setLinvel({ x: vx, y: vy, z: vz }, true);

        // Apply filtered mouse deltas into yaw/pitch
        const dx = this.accumDX;
        const dy = this.accumDY;
        this.accumDX = 0;
        this.accumDY = 0;

        const alpha = this.rotationSmoothingTime > 0
            ? 1 - Math.exp(-delta / this.rotationSmoothingTime)
            : 1;
        if (alpha >= 1) {
            this.emaDX = dx;
            this.emaDY = dy;
        } else {
            this.emaDX += alpha * (dx - this.emaDX);
            this.emaDY += alpha * (dy - this.emaDY);
        }

        this.yaw -= this.emaDX * this.mouseSensitivity;
        if (this.invertY) {
            this.pitch += this.emaDY * this.mouseSensitivity;
        } else {
            this.pitch -= this.emaDY * this.mouseSensitivity;
        }

        const pitchMin = -Math.PI / 2 + 0.0001;
        const pitchMax = Math.PI / 2 - 0.0001;
        this.pitch = Math.max(pitchMin, Math.min(pitchMax, this.pitch));

        // Keep yaw bounded to avoid precision drift
        if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
        else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

        const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(euler);
    }

    public updateAfterPhysics(): void {
        const t = this.body.translation();
        const newCamY = (t.y - (this.halfHeight + this.radius)) + this.eyeHeight;
        this.camera.position.set(t.x, newCamY, t.z);

        if (this.debugMesh) {
            this.debugMesh.position.set(t.x, t.y, t.z);
            this.debugMesh.rotation.set(0, this.yaw, 0);
        }
    }

    private shortestAngleDelta(from: number, to: number): number {
        let diff = (to - from + Math.PI) % (Math.PI * 2);
        if (diff < 0) diff += Math.PI * 2;
        return diff - Math.PI;
    }

    private initPhysicsBody(): void {
        const rbDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, this.eyeHeight + (this.halfHeight + this.radius), 0)
            .setCanSleep(false)
            .setCcdEnabled(true)
            .lockRotations();
        this.body = this.world.createRigidBody(rbDesc);

        const colDesc = RAPIER.ColliderDesc.capsule(this.halfHeight, this.radius)
            .setFriction(0.0)
            .setRestitution(0.0)
            .setActiveEvents(0);
        this.world.createCollider(colDesc, this.body);
    }

    private initPointerLock(): void {
        const onMouseMove = (event: MouseEvent) => {
            if (!this.pointerLocked) return;
            const movementX = event.movementX || 0;
            const movementY = event.movementY || 0;
            // Accumulate raw deltas; apply sensitivity and smoothing in update()
            // Clamp insane spikes from some drivers
            const MAX_DELTA = 2000;
            this.accumDX += Math.max(-MAX_DELTA, Math.min(MAX_DELTA, movementX));
            this.accumDY += Math.max(-MAX_DELTA, Math.min(MAX_DELTA, movementY));
        };

        const onPointerLockChange = () => {
            this.pointerLocked = document.pointerLockElement === this.domElement;
            if (this.pointerLocked) {
                document.addEventListener('mousemove', onMouseMove, false);
            } else {
                document.removeEventListener('mousemove', onMouseMove, false);
            }
        };

        this.domElement.addEventListener('click', () => {
            this.domElement.requestPointerLock();
        });
        document.addEventListener('pointerlockchange', onPointerLockChange, false);
    }

    private initKeyboard(): void {
        const onKeyDown = (event: KeyboardEvent) => {
            switch (event.code) {
                case 'KeyW': this.moveForward = true; break;
                case 'KeyS': this.moveBackward = true; break;
                case 'KeyA': this.moveLeft = true; break;
                case 'KeyD': this.moveRight = true; break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    if (this.isFlyMode) this.flyDown = true; else this.isSprinting = true; break;
                case 'ControlLeft':
                case 'ControlRight':
                    if (this.isFlyMode) this.isSprinting = true; break;
                case 'Space':
                    if (this.isFlyMode) this.flyUp = true; else this.jumpQueued = true; break;
                case 'KeyF':
                    this.setFlyMode(!this.isFlyMode); break;
                default: break;
            }
            if (['Space'].includes(event.code)) event.preventDefault();
        };
        const onKeyUp = (event: KeyboardEvent) => {
            switch (event.code) {
                case 'KeyW': this.moveForward = false; break;
                case 'KeyS': this.moveBackward = false; break;
                case 'KeyA': this.moveLeft = false; break;
                case 'KeyD': this.moveRight = false; break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    if (this.isFlyMode) this.flyDown = false; else this.isSprinting = false; break;
                case 'ControlLeft':
                case 'ControlRight':
                    if (this.isFlyMode) this.isSprinting = false; break;
                case 'Space':
                    if (this.isFlyMode) this.flyUp = false; break;
            }
        };
        document.addEventListener('keydown', onKeyDown, false);
        document.addEventListener('keyup', onKeyUp, false);
    }

    public setFlyMode(enabled: boolean): void {
        if (this.isFlyMode === enabled) return;
        this.isFlyMode = enabled;
        this.body.setGravityScale(enabled ? 0 : 1, true);
        const v = this.body.linvel();
        this.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
        this.jumpQueued = false;
        this.flyUp = false;
        this.flyDown = false;
    }

    public isFlyModeEnabled(): boolean {
        return this.isFlyMode;
    }

    public setMoveSpeed(value: number): void {
        this.moveSpeed = Math.max(0, value);
    }

    public setSprintSpeed(value: number): void {
        this.sprintSpeed = Math.max(0, value);
    }

    public setJumpSpeed(value: number): void {
        this.jumpSpeed = Math.max(0, value);
    }

    public setEyeHeight(value: number): void {
        this.eyeHeight = Math.max(0, value);
    }

    public setMouseSensitivity(value: number): void {
        this.mouseSensitivity = Math.max(0, value);
    }

    public setRotationSmoothingTime(value: number): void {
        this.rotationSmoothingTime = Math.max(0, value);
    }

    public setInvertY(enabled: boolean): void {
        this.invertY = !!enabled;
    }

    public enableDebugMesh(scene: THREE.Scene, visible: boolean = true): void {
        if (!this.debugMesh) this.createDebugMesh();
        if (!this.debugMesh) return;
        if (!this.debugMesh.parent) scene.add(this.debugMesh);
        this.debugMesh.visible = visible;
    }

    public disableDebugMesh(): void {
        if (!this.debugMesh) return;
        if (this.debugMesh.parent) this.debugMesh.parent.remove(this.debugMesh);
    }

    private createDebugMesh(): void {
        const cylLength = Math.max(0.001, this.halfHeight * 2);
        const radius = this.radius;
        // CapsuleGeometry(length) uses the length of the cylindrical part; ends are hemispheres
        const geo = new THREE.CapsuleGeometry(radius, cylLength, 8, 16);
        const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true, depthTest: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 9999;
        this.debugMesh = mesh;
    }
}


