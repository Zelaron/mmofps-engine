import { World, type ColumnData } from '@shared/worldgen';
import type { TransportRoute, TransportPlan } from '@shared/transport';
import { transitDistance } from '@shared/transit-motion';

/** An actual moving train over a level track bed, without unrelated scenery. */
export function transportField(world = new World(1337), yaw = 0, speed = 62) {
  const a = { id: 1, name: 'A', x: 0, y: 320, z: 0 };
  const b = { id: 2, name: 'B', x: -Math.sin(yaw) * 4000, y: 320, z: -Math.cos(yaw) * 4000 };
  const route: TransportRoute = { id: 991, name: 'Collision test', kind: 'train', speed, dwell: 22, phase: 0,
    stops: [a,b], carOffsets: [0,28,56,84], legs: [
      { points:[a,b], distances:[0,4000], length:4000, from:a, to:b, reverse:false },
      { points:[b,a], distances:[0,4000], length:4000, from:b, to:a, reverse:true },
    ] };
  const plan: TransportPlan = { routes:[route], stations:[], harbors:[], solids:[], lifts:[], pods:[], bridges:[], accesses:[] };
  const column = { h:318.8, temp:.5, moist:.5, desert:0, entr:0, entrRaw:0, volc:0, lavaY:-1000 } as ColumnData;
  world.collectTransportPlan = () => plan;
  world.collectCityLifts = () => [];
  world.column = () => column;
  world.regionAt = () => ({ sites:[], pads:[], solids:[], cuts:[], boulders:[], vegetation:[] });
  world.liquidAt = () => undefined;
  world.sdf = (x,y,z) => transitDistance(world, world.motionTime ?? 0, x,y,z,y-318.8);
  world.sdfCol = (x,y,z) => world.sdf(x,y,z);
  return { world, route };
}
