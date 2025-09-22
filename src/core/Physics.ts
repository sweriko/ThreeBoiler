import RAPIER from '@dimforge/rapier3d-compat';

export class Physics {
  public readonly world: RAPIER.World;

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  public static async create(gravity: { x: number; y: number; z: number } = { x: 0, y: -9.81, z: 0 }): Promise<Physics> {
    await RAPIER.init();
    const world = new RAPIER.World(gravity);
    return new Physics(world);
  }

  public step(): void {
    this.world.step();
  }
}



