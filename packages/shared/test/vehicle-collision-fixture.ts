import { World, type ColumnData } from '@shared/worldgen';
import type { TransportPlan } from '@shared/transport';

/** Analytic level terrain while retaining native sdf/sdfCol/gradient and the
 * scoped pedestrian union. Overriding sdf itself would bypass that union. */
export function vehicleCollisionWorld(world = new World(1337), floor = 0): World {
  const column: ColumnData = { h: floor, temp: .5, moist: .5, desert: 0, entr: 0,
    entrRaw: 0, volc: 0, lavaY: -1000 };
  const plan: TransportPlan = { routes: [], stations: [], harbors: [], solids: [],
    lifts: [], pods: [], bridges: [], accesses: [] };
  world.column = () => ({ ...column });
  world.regionAt = () => ({ sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [] });
  world.collectCities = () => [];
  world.collectCityLifts = () => [];
  world.collectTransportPlan = () => plan;
  world.liquidAt = () => undefined;
  const internals = world as unknown as {
    cachedColumn: (x: number, z: number) => ColumnData;
    terrainSdfCol: (x: number, y: number, z: number, col: ColumnData) => number;
    flatCityColumns: ColumnData[] | null;
  };
  internals.cachedColumn = () => column;
  internals.terrainSdfCol = (_x, y) => y - floor;
  internals.flatCityColumns = [];
  return world;
}
