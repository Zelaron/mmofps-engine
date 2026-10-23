import type { Faction, FrontierState, Territory } from '@shared/frontier';
import { ENT_PLAYER, PICKUP_WEAPON, type Snapshot } from '@shared/protocol';
import { CREATURE_DEFS } from '@shared/wildlife';
import { NUKE_LAUNCHER_ID, WEAPONS } from '@shared/weapons';

export interface MapContact {
  id: string; x: number; z: number; yaw: number;
  kind: 'infantry' | 'vehicle' | 'aircraft' | 'creature' | 'boss' | 'loot';
  relation: 'friendly' | 'hostile' | 'unknown' | 'available';
  faction: Faction; label: string; health?: number; engaged?: boolean; weapon?: number;
}
export interface MapIntel { contacts: readonly MapContact[]; vehicle: number }
export const EMPTY_MAP_INTEL: MapIntel = { contacts: [], vehicle: 0 };
export const MAP_CONTACT_LIMIT = 256;
const vehicles = ['Infantry', 'Jeep', 'Tank', 'Aircraft', 'Gunboat'];
const validPosition = (p: { x: number; z: number }) => Number.isFinite(p.x) && Number.isFinite(p.z);

/** Draw only replicated contacts. Strategic boss reports are explicit public
 * intelligence; unidentified players must never be painted as enemies. */
export function buildMapIntel(snapshot: Snapshot, frontier: FrontierState | null, myId?: number): MapIntel {
  const contacts: MapContact[] = [], factions = new Map(frontier?.nearby.map(p => [p.id, p.faction]) ?? []);
  const ownFaction = frontier?.you.faction, seenVehicles = new Set<number>();
  if (snapshot.you.vehicleId !== undefined) seenVehicles.add(snapshot.you.vehicleId);
  const relation = (faction: Faction) => !faction || !ownFaction ? 'unknown' : faction === ownFaction ? 'friendly' : 'hostile';
  for (const entity of snapshot.ents) {
    if (entity.kind !== ENT_PLAYER || entity.dead || entity.id === myId || !validPosition(entity)) continue;
    if (entity.vehicle && entity.vehicleId !== undefined) {
      if (seenVehicles.has(entity.vehicleId)) continue;
      seenVehicles.add(entity.vehicleId);
    }
    const faction = factions.get(entity.id) ?? 0;
    contacts.push({ id: entity.vehicleId !== undefined && entity.vehicle ? `vehicle:${entity.vehicleId}` : `player:${entity.id}`,
      x: entity.x, z: entity.z, yaw: entity.vehicle ? entity.heading : entity.yaw,
      kind: entity.vehicle === 3 ? 'aircraft' : entity.vehicle ? 'vehicle' : 'infantry', relation: relation(faction), faction,
      label: `${vehicles[entity.vehicle] ?? 'Vehicle'} · ${relation(faction) === 'unknown' ? 'Unidentified' : relation(faction)}` });
  }
  for (const vehicle of snapshot.vehicles ?? []) {
    if (vehicle.health <= 0 || seenVehicles.has(vehicle.id) || !validPosition(vehicle)) continue;
    seenVehicles.add(vehicle.id);
    contacts.push({ id: `vehicle:${vehicle.id}`, x: vehicle.x, z: vehicle.z, yaw: vehicle.heading,
      kind: vehicle.type === 3 ? 'aircraft' : 'vehicle', relation: 'available', faction: 0,
      label: `${vehicles[vehicle.type] ?? 'Vehicle'} · Available` });
  }
  const bosses = new Map<number, MapContact>();
  for (const threat of frontier?.threats ?? []) {
    const species = CREATURE_DEFS[threat.species];
    if (!species?.boss || !validPosition(threat) || threat.health <= 0) continue;
    bosses.set(threat.id, { id: `creature:${threat.id}`, x: threat.x, z: threat.z, yaw: 0, kind: 'boss',
      relation: 'hostile', faction: 0, label: species.name, health: Math.min(1, threat.health), engaged: threat.engaged });
  }
  for (const creature of snapshot.creatures ?? []) {
    const species = CREATURE_DEFS[creature.species];
    if (!species || !validPosition(creature)) continue;
    if (creature.dead) { bosses.delete(creature.id); continue; }
    // Peaceful wildlife is scenery, not an enemy contact.
    if (!species.damage) continue;
    const contact: MapContact = { id: `creature:${creature.id}`, x: creature.x, z: creature.z, yaw: creature.yaw,
      kind: species.boss ? 'boss' : 'creature', relation: 'hostile', faction: 0, label: species.name,
      health: creature.health, engaged: creature.alert };
    if (species.boss) bosses.set(creature.id, contact); else contacts.push(contact);
  }
  for (const pickup of snapshot.pickups ?? []) {
    if (pickup.kind !== PICKUP_WEAPON || !validPosition(pickup)) continue;
    contacts.push({ id: `loot:${pickup.id}`, x: pickup.x, z: pickup.z, yaw: 0, kind: 'loot', relation: 'available',
      faction: 0, weapon: pickup.weapon, label: WEAPONS[pickup.weapon]?.name ?? 'Weapon cache' });
  }
  const distance = (contact: MapContact) => (contact.x - snapshot.you.px) ** 2 + (contact.z - snapshot.you.pz) ** 2;
  contacts.sort((a, b) => distance(a) - distance(b));
  return { contacts: [...[...bosses.values()].sort((a,b)=>distance(a)-distance(b)), ...contacts].slice(0, MAP_CONTACT_LIMIT), vehicle: snapshot.you.vehicle };
}

export function contactColor(contact: MapContact): string {
  return contact.kind === 'boss' ? '#ffbd67' : contact.kind === 'loot' ? '#ffe49a' : contact.kind === 'creature' ? '#ebba73'
    : contact.relation === 'friendly' ? '#83f0de' : contact.relation === 'hostile' ? '#ff7778'
    : contact.relation === 'available' ? '#cbd7ed' : '#b7c4c6';
}
/** Cache piles share a map glyph. Keep the nuke first, then the nearest caches;
 * this changes display density only, never the snapshot or pickup behavior. */
export function declutterMapLoot(contacts: readonly MapContact[], x:number,z:number,spacing:number,limit=6):MapContact[] {
  const loot=contacts.filter(contact=>contact.kind==='loot').sort((a,b)=>Number(b.weapon===NUKE_LAUNCHER_ID)-Number(a.weapon===NUKE_LAUNCHER_ID)
    ||(a.x-x)**2+(a.z-z)**2-((b.x-x)**2+(b.z-z)**2)),selected:MapContact[]=[];
  for(const contact of loot){if(selected.length>=limit)break;if(selected.every(prior=>Math.hypot(prior.x-contact.x,prior.z-contact.z)>=spacing))selected.push(contact);}
  return [...selected,...contacts.filter(contact=>contact.kind!=='loot')];
}
export function controlReadout(site: Territory): string {
  if (site.contested) return 'CONTESTED';
  if ((site.progressRate ?? site.captureRate ?? 0) !== 0) {
    const neutralizing=!!site.captureFaction&&!!site.pressureFaction&&site.captureFaction!==site.pressureFaction;
    const progress=Math.max(0,Math.min(1,site.captureProgress??0));
    return `${neutralizing?'NEUTRALIZING':'CAPTURING'} ${Math.round((neutralizing?1-progress:progress)*100)}%`;
  }
  return site.owner ? 'HELD' : 'UNCLAIMED';
}

/** Clamp an offscreen objective to the compass rim without moving its bearing. */
export function localMapPoint(x: number, z: number, centerX: number, centerZ: number, span: number, size = 256, inset = 16) {
  const dx = (x - centerX) / span * size, dy = (z - centerZ) / span * size, limit = size / 2 - inset;
  const scale = Math.min(1, limit / Math.max(Math.abs(dx), Math.abs(dy), .001));
  return { x: size / 2 + dx * scale, y: size / 2 + dy * scale, offscreen: scale < 1 };
}
