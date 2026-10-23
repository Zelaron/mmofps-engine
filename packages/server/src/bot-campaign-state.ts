import type { CampaignOrder, Territory } from '@shared/frontier';
import type { ServerPlayer } from './game.js';

/** Each consecutive triplet belongs to the three factions. All three receive
 * the same distribution of pilots, sailors, infantry and support crew. */
export function botCampaignRole(id: number): 'pilot'|'aircrew'|'sailor'|'navalcrew'|'infantry'|'driver'|'gunner' {
  const role=Math.floor(Math.max(0,id-1)/3)%24;
  return role===0?'pilot':role===1?'aircrew':role===2?'sailor':role===3?'navalcrew':
    role%3===0?'infantry':role%3===2?'gunner':'driver';
}

/** Network entity allocation also serves projectiles and world objects. A
 * roster ordinal keeps campaign duties stable across reserved worker blocks. */
export function botRoleId(player: {id:number;botRosterIndex?:number}): number {
  return player.botRosterIndex===undefined?player.id:player.botRosterIndex+1;
}

/** Explicit orbital duties override local orders, including quiet guards. */
export const campaignTravelOrders = new WeakMap<ServerPlayer, {order:CampaignOrder;objective:Territory}>();
