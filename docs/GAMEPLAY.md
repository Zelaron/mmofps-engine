# Gameplay reference

The rules in detail. The [README](../README.md) has the short version.

## Arriving

- There is no menu, login or deployment screen. Open the URL and you join the Terran Accord, the Helix Combine or the Vanguard Pact at random, beside a friendly staging point. You can change allegiance later on the tactical map, after leaving combat and waiting out the allegiance cooldown.
- Desktop browsers need one click to capture the mouse; mobile controls are active immediately.
- Your identity is an anonymous HttpOnly session cookie. Keep the cookie to return as the same character.
- Allegiance, ammunition, health, discoveries, salvage, position, current planet, XP and your last chosen respawn point are saved in `data/universe.sqlite`. Territory ownership is saved under `data/<planet>/`.
- Older saves migrate automatically: earlier Meridian character files are imported on first connection, and old neutral or Independent characters receive a fighting allegiance without losing anything. "Unclaimed" is a territory state, not a faction.

## Controls

| Key | Action |
|---|---|
| WASD, mouse | Move and aim |
| Space | Jump (in a jet: throttle) |
| C | Jet airbrake |
| Double-tap a direction | Dodge, with the original air control and momentum |
| Mouse / touch FIRE | Shoot |
| R | Reload |
| 1-9, 0, mouse wheel | Choose a weapon |
| E | Enter a vehicle, join a compatible crew, or open a nearby airlift pod's destination map |
| B / FIELD CAMP | Open construction: choose a module, rotate its preview and build ahead of you |
| Hold F | Extract a nearby glowing xenolite seam (see [Salvage](#salvage-and-field-camps)) |
| G | Tactical map: territory, battles, your next respawn point, DEPLOY NOW, fighter jet, allegiance |
| Hold Q | DEPLOY NOW toward your squad's order without opening the map |
| M | Minimap and compass |
| O | Star chart and travel to other worlds |
| Tab | Scores |
| T / Enter | Chat |
| [ ] | Mouse sensitivity |
| F3 | Debug overlay |

Mobile has separate movement, look/fire, jump, dodge, weapon, reload and interaction controls. During airlift pod travel you can look around the cabin normally.

Playtest hyperspeed (H: 10× running speed and invulnerability) is disabled: the key does nothing and the server ignores it. Set `HYPERSPEED_ENABLED` in `packages/shared/src/movement.ts` to bring it back.

Allies cannot damage each other; the other two factions are enemies. Wildlife, falls, drowning, lava and your own explosives can all kill you.

## Wars

- **Homes and fronts.** Each faction starts with a home city, the harbor behind it and a forward base on a road facing the middle of the three homes. On Meridian: the Accord at Meridian city and Southwatch, the Helix Combine at Vesper Reach and Northstar, and the Vanguard Pact at Aurelia Bastion and Estuary. Ironhaven, Westgate Harbor and Halcyon Quay start neutral. Bases are linked into a front-line lattice: squads attack bases next to their own territory (or where they already hold a foothold), and mass two squads on one control before opening another.
- **Winning.** Holding **8 of the 12 bases** wins outright. Otherwise, after **2 hours**, the faction holding the most bases (then the most controls) wins, with sudden death on an exact tie.
- **Final push.** If no base changes hands for **15 minutes**, a **3-minute final push** starts. The war strip shows the countdown and everyone is told. Taking a base calls it off ("DEADLOCK BROKEN"); otherwise the faction holding the most territory wins when it ends. The clock counts from the war's last base flip, or from minute 5 if there has been none.
- **The next war.** Everyone gets a victory or service bonus, a 30-second intermission follows, and the next war begins with the home regions rotated between the factions. Everyone redeploys (this is not a death). War number and wins persist across restarts.
- The war strip at the top of the screen shows the clock, the bases each faction holds and the number needed to win.

## Capturing

- Each city, harbor and forward base has **three linked controls**. Holding **two** secures the base and unlocks reinforcements there; taking one control shows how many more you need.
- Capture a control by staying inside its ring on foot. The capture panel shows the distance to the ring, progress, time remaining and anything stopping you.
- One unopposed player claims neutral ground in **60 seconds**. A fully held enemy control first takes **60 seconds to neutralize**, then **60 seconds to capture**.
- When several factions stand in a ring, the one that clearly outnumbers the others keeps progressing at the rate of its margin; a narrow lead holds the ring contested. A human counts as much as four bots, and the advantage speeds capture up to three human equivalents. Leaving the ring pauses your contribution, and progress resumes where it stopped.
- **Height.** On a hillside ring, a player counts anywhere on the open ground inside it, uphill or downhill; bots count only near the flag's height. Roofs and caves don't count, and the panel says how far above or below the ground you are. Where the flag stands on a street or a deck (cities, harbor quays and approaches), only its level counts, within 6 m. Harbors use the walkable quay, not the submerged ferry berth.
- Friendly controlled districts heal you faster after combat. Neutralizations and captures are announced on screen.
- Regional city controls are roughly 385-576 m apart; capital controls sit in districts 905-1,902 m apart. Capture rings never overlap.
- A base whose control has been held by an attacker for 150 seconds has its **supply cut**: its own rally closes and its defenders stage farther out (about 650 m) until the control is retaken.

## Respawning and reinforcements

- The respawn timer is **10 seconds**: a 1.8-second death camera, then the map for the rest. Pick an available base or mobile rally jeep, or leave the choice automatic. Your choice is remembered for later deaths.
- A red cross marks your last death, including after respawn and reconnect. Recent fighting shows as fading battle areas in the participating factions' colors for 30 seconds.
- Assaults and threatened defenses reinforce at **forward staging points about 300 m from the contested control**, on level ground on the side facing the faction's own territory.
- Otherwise reinforcements arrive at a rally approach at least 80 m outside every capture ring and 180 m from nearby enemies. A threatened control can't supply reinforcements until its approach has been clear for 12 seconds; another quiet owned control, a different safe base or a coastal reserve is used instead, and the map row explains why. Recent fighting also excludes nearby rally positions. These checks are repeated at the actual spawn, including for bots.
- A base whose control is being taken by a real force (a human, or four bots) stops deploying defenders right beside the fight; they use the defense staging instead, so the larger force decides the zone.
- A faction that loses every base keeps coastal reinforcements for a comeback. If every approach is unsafe, deployment waits instead of placing you inside the fight.
- Spawn protection lasts three seconds and ends when you fire or board a vehicle.

## Getting to the fight

- New players spawn at their faction's most active operation: recent combat, contested controls and assaults first. The squad order on the HUD points there and suggests **DEPLOY NOW** when it is more than 700 m away. After a minute that far away, a one-time reminder per life says so too.
- **DEPLOY NOW** (tactical map): when you haven't been hit for six seconds, move straight to an available reinforcement point instead of walking. A 15-second cooldown follows. Unless you picked a point on the map, it takes you to your order's staging, or to the nearest point that gets you at least 250 m closer. Holding **Q** for half a second does the same without opening the map. Deploying doesn't change your remembered respawn point.
- **FIGHTER JET** (tactical map): under the same out-of-combat rule, launch in a fighter that is already flying over your nearest base, heading for your order. There is a 45-second cooldown and a limit of four human fighters per faction at once; the button says when it is ready. The same option appears in the respawn list.
- The tactical map marks every airfield and whether a jet is parked there.
- A stationary, healthy friendly **jeep** away from friendly bases becomes a mobile rally point when its approach passes the same capture-zone, enemy-distance and recent-combat checks. Drive it forward, park, and let reinforcements spawn beside it.

## Vehicles

- Jeeps, tanks, fighter jets, Nocturne bombers and gunboats. Driver and gunner are separate seats on compatible vehicles; bots wait briefly for nearby friendly passengers, including humans.
- Live vehicles block walking and swimming, and you can stand on their hoods, roofs and decks. Destroyed vehicles stop blocking movement.
- Boats follow ferry water lanes. Aircraft crews fly real runway hulls and return for replacements after destruction. Ground transports unload near city fighting.
- Fighters have 600 health and Nocturne bombers 1,000. Anti-air specialists need a real rocket lock and space their launches at least seven seconds apart; a healthy fighter survives two direct locked hits. Both seats get escalating acquisition, lock and incoming-missile warnings with bearing and time to impact. Missiles turn wider against aircraft than ground targets: flying straight is dangerous, while a timed bank can break the seeker.
- City arcades give 4.6 m of clearance for ordinary tanks.
- Hostile creatures attack reachable vehicles, including tanks and landed aircraft, but ordinary undead can't reach aircraft overhead.

## Bots and population

- Each world adapts its population between **96 and 192 soldiers** (including humans) across the three factions. Humans replace bots. `BOTS` changes the maximum.
- Under sustained server load, safe distant reserves are retired first; nearby battles, vehicle crews and expeditions are protected.
- Six-soldier squads share a base objective, assemble, and use transport and airlift links for long trips. Out-of-sight bots far from their objective redeploy at forward staging instead of marching across the map; bots near a player always move physically.
- Bots react 0.3-0.65 s before their first shot at a new target, aim tighter the longer they track, keep pushing onto nearby objectives while fighting, back off when badly hurt and engage enemies within 120 m on the march. They fight dangerous creatures they meet but don't organize creature hunts.

## Experience, ranks and daily orders

- XP is awarded immediately with an on-screen ribbon: enemy kills (100, or 150 for a human), assists (40), killstreaks, revenge and shutdowns, kills near an objective (defender 50, attacker 30), destroying a crewed vehicle (150), neutralizing (150) or capturing (250) a control, securing a base (300), and war victory (1,500) or service (400).
- Sixty ranks run from Recruit I to Warlord III; promotions get a banner and fanfare.
- Three **daily orders** a day (UTC, the same for everyone; one is always a kill order) pay 300-1,300 XP each. The rank panel shows the next one; the tactical map lists all three.
- When a war is decided, a **debrief** card shows the result, your eliminations, deaths, captures and XP for that war, and the war's top soldier.
- XP, career kills, captures, wars won and best streak are saved with your character.

## Creatures and bosses

- **Meridian** has shamblers, fast revenants and heavy plague brutes, plus the rare **Ossuary Titan**. **Cinder** has ash crawlers and the **Cinder Colossus**; **Nacre** has reef prowlers and the **Tide Behemoth**. Native fauna remain everywhere.
- Bosses have 12,000-15,000 health, name and health plates, and recovery windows. Damaging a boss provokes faster pursuit up to 1,200 m for 45 seconds, refreshed by further hits.
- Bosses fire ranged blasts up to 950-1,100 m, with a fixed target marker, visible charging and an incoming-impact warning. Move out of the marked area or take solid cover; owned-base safe zones stay protected.
- Boss kills pay **salvage to every qualifying hunter**: 500 for an Ossuary Titan, 650 for a Cinder Colossus, 600 for a Tide Behemoth. You qualify with at least 1% of the boss's health in damage and a hit within the last two minutes; dying before the kill doesn't forfeit it.
- Each kill leaves a shared, loaded **Nuke Launcher**, two ammunition crates and health at the corpse. Participants have 90 seconds to claim the cache before it becomes public; the drops last five minutes.
- Creature rosters and rewards are defined per planet in `packages/shared/src/wildlife.ts`.

## Civilians

City civilians go about their routines. They fall when shot or caught in a blast, and return a little over a minute later. The server doesn't simulate civilians, so each player's game runs this from the shots and blasts it sees, which usually agrees between players.

## Maps

- **M** shows a local tactical view: friendly and enemy contacts, available vehicles, hostile creatures, weapon caches, capture rings, your squad direction and your last death.
- **G** adds named bases, capture status, faction borders, recent fighting, airfields and major-monster reports; select an objective or report to focus it. Zoom and drag to look around.

## Salvage and field camps

- Discovering cities and extracting xenolite earn **salvage**. Hold F at a glowing seam on foot: three seconds yields 12 salvage, and the shared deposit regrows after three minutes. Moving, fighting or releasing cancels it.
- Build outside cities, away from roads and transit stops: a **trail shelter** (20 salvage), a **medical station** (25) or an **ammo fabricator** (30). Shelters have a ramp, deck, roof and solid cover. Within 5 m and in line of sight, medical stations heal 6 health per second and fabricators refill ordinary weapon reserves after combat. Services support the owner and players of the module's allegiance.
- Modules are saved with their payments and survive logout, restarts and planetary travel. Each character may own six modules in total, and each 128 m cell allows four. Owners can pack modules up once everyone steps clear; packing doesn't refund salvage. Modules don't yet decay, get destroyed or show on the distant atlas.
- Crafting, trading and a wider economy are not implemented yet.

## Terrain and climate

Terrain, trees and grass share one climate model. Warm hills and rainforests stay green; cold regions and alpine summits keep their snow, with conifers above the broadleaf frost line. Volcanic provinces are black basalt with lava pools, fading into the surrounding ground. Roads relocate flooded junctions and detour around lava and lake or river banks.

## Other worlds

- Meridian runs alone by default. **Cinder** and **Nacre** are fully implemented, with their own terrain, cities and creatures: start them with `PLANETS=all npm start` (or a list such as `PLANETS=meridian,cinder`). Characters saved on a world that isn't running return to Meridian with their inventory and progress.
- To travel, open the star chart (O), choose a planet and mark the nearest transit pod. Reach the pod on foot to launch. The 5-second charge cancels if you move, take damage or board a vehicle. You arrive at the destination's spaceport with your supplies and discoveries.
- Each world is a 22.5 km square (including ocean) with four cities, cave networks, moving trains and ferries, launch pods, vehicles and ten infantry weapons.
