# Planetary campaign

## Front-line wars

The campaign was redesigned around one question: is there a fight within reach of every player, and does it go somewhere? Previously all three factions' forward bases sat within about 800 m of Meridian city while every other holding was 3–10 km away, so armies converged on one city, any second faction in a ring froze its capture, and a fresh player's order was typically 3–8 km away. A ten-minute, 192-bot headless run of that design produced 19 kills per minute, 8 control changes, one base change, a median of about 100 s from spawn to first fight, and orders whose median distance was 3–5 km (`npm run test:war -- --seconds=600`).

**Layout.** `campaignHomes` picks the three most widely separated cities as homes (the suspended capital for the Helix Combine, the fortified capital for the Vanguard Pact, the remaining city for the Terran Accord) and gives each the harbor behind it. Each forward base sits on a road beyond its city's edge, facing the middle of the three homes, at least 2.6 km from the others. Every other base starts neutral. `campaignLattice` links bases into a Gabriel graph (no third base inside the circle on each link, links up to 9.5 km, joined if disconnected).

**Strategy.** Squads only attack bases next to their own territory, or where they already hold a control; defense is always allowed. Assaults mass two squads on one control before opening another; busy fronts take up to four squads; a base two rival factions are already brawling over is avoided; a base within 1.6 km of any human scores higher, so the war comes to players; reassigned squads strongly prefer fronts within reach. Humans get the operation with the most action (recent combat near the target, contested or attacked controls, assaults, and enemy soldiers present near it) rather than the nearest one.
- **While alive:** an operation more than 1.2 km away costs heavily, since on foot the only way to reach it is to die. Recent fighting at one of the faction's own holdings counts as a defense in progress.
- **Holding the order:** a pick is held for 45 s, and extended while the soldier is within 600 m of it.
- **While deploying:** a soldier waiting to deploy is not held to an order. They go to the hottest fight anywhere, because the deployment lands at its staging.
- **New war:** held picks are cleared when a war starts. Choices made while everyone is down (before the bots have deployed) would otherwise point at empty objectives.

Scripted browser sessions measured the effect. The old choice swung a living player's order between a defense 300 m away and an attack 4.7 km away. After a war rotation, the old choice sent the player to an undefended objective, with first contact 35–104 s after the war started; it is now 22–32 s.

| Ten-minute mid-war session (`npm run test:play:browser`, 80 bots) | Before these changes (three runs) | After (four runs) |
|---|---|---|
| Time within 120 m of an enemy while alive | 23–38% | 59%, 22%, 48%; 2% in a run hit by the DEPLOY NOW pinning bug below (fixed) |
| Longest quiet stretch while alive | 37–64 s | 17 s, 76 s, 22 s; about 8 minutes in the pinned run |
| Kills / deaths | 6/8, 7/13, 3/7 | 10/10, 3/10, 7/10; 0/2 in the pinned run |

Runs vary a lot: each joins a different war at a different front. Until the pinned run exposed it, the session script counted a quiet stretch only when it ended at a sighting, not at a death or the end of the session (now fixed). So the quiet-stretch values here are lower bounds; the pinned run's script reported 21 s. The scripted player is a stand-in: it doesn't take cover or use vehicles, and it can't say whether a human finds this fun.

When the order is out of walking range, the order panel shows "G → DEPLOY NOW". The map's DEPLOY NOW now goes to that order's staging (unless the soldier picked another point), not the nearest rally as before, which could leave a player kilometres from the fight the hint pointed to. `npm run test:progression:browser` checks this end to end on desktop (G) and touch (map button): from 3.6 km and 9.2 km away, the player arrived 6 m and 12 m from the order's assault staging.

If that staging is unsafe for the moment, DEPLOY NOW goes to the usable point nearest the order, but only if that brings the soldier at least 250 m closer. Otherwise the button says nothing is closer yet. A deployment also no longer becomes the remembered respawn choice; only a pick on the map does. It used to, and a ten-minute scripted session showed the cost. After its first deployment, all 22 deployments went to the same point, 2.4–4 km from every fight, for eight minutes. Its respawns would have gone there too, since the choice was remembered. The progression check now asserts that a deployment leaves the respawn choice unchanged.

**Capture.** Bots weigh 0.25 and humans 1. The faction with the most weight in a ring progresses whenever it leads the runner-up by at least 0.35, at the rate of its margin (up to three human equivalents); a narrower lead holds the ring contested. Playtest hyperspeed never counts.

**Capture height.** A soldier counts toward a capture within 6 m of the flag's height. On a control whose flag stands on open ground, a human player also counts within 6 m of that ring's ground band. The ground band is the height range of the dry open ground inside the ring, scanned when the layout is built (`captureGround`: every 4 m along 32 directions, skipping roofs, decks, rocks and water). So a player anywhere on the hillside of a sloping relay counts, while high roofs and deep caves still do not. Bots keep the flag band (see below). City streets are graded level, and harbor quays and approaches stand on decks, so they keep the flag band for everyone. The capture panel applies the player's rule (`captureHeightGap`) and says how far above or below the ground the player is.

Under the flag band alone, part of every sloping ring was dead. Here is the share of each ring's dry open ground where a standing player captured nothing, measured on a finer grid (every 3 m along 48 directions):

| Control (Meridian, seed 1337) | Dead before | After |
|---|---|---|
| Aurelia Bastion Forward Base · West relay | 44% | 0% |
| Vesper Reach Forward Base · East relay | 34% | 0% |
| Northstar Harbor · Coast relay | 25% | 0% |
| Vesper Reach Forward Base · West relay | 17% | 0% |
| Westgate Harbor · Coast relay | 15% | 0% |
| Six other relays | 6–13% | 0% |

On the worlds of seeds 7 and 2024 the worst rings were 56% and 51% dead before, and 0% after. `campaign-layout.test.ts` checks on Meridian that no dry open ground in such a ring is dead for a player, that high roofs and deep caves still do not count, and that bots keep the flag band.

An earlier version of this note reported 44–49% of each harbor approach as dead. That measurement counted the seabed. The approach rings are about half water and half deck, and the deck lies within the flag band. One deck-flag case remains: Northstar Harbor's approach flag stands on a deck about 45 m above a beach, and the beach does not count. The cost of the ground band is that a low roof or a shallow cave inside a steep ring now counts for a player. The widest band on Meridian spans 44 m (Aurelia Bastion's West relay).

**Why bots keep the flag band.** The ground band was first applied to every soldier and tested on three worlds (`npm run test:war -- --seconds=600 --seed=N`; the seed also picks the world). The war did not move faster:

| Seed | Control flips | Base flips | Median siege | 90th-percentile siege | Mean contested controls |
|---|---|---|---|---|---|
| 1337 (Meridian) | 18 → 22 | 6 → 6 | 94 → 112 s | 285 → 290 s | 0.03 → 0.03 |
| 7 | 13 → 7 | 1 → 1 | 172 → 124 s | 376 → 584 s | 0.08 → 0.30 |
| 2024 | 14 → 15 | 3 → 5 | 91 → 138 s | 432 → 292 s | 0.10 → 0.12 |

Captures at the sloped controls completed no more often (6 → 6, 4 → 2 and 4 → 3), and the median siege lengthened on two seeds of three. The likely mechanism is that soldiers on the slopes now counted on both sides, so more captures stalled as contested. Bots walk to the flag anyway, so the band now applies to human players only. A war without humans is then unchanged: the seed-1337 run reproduces the earlier one exactly. The cost is that a player on a slope can see enemy bots on the same slope that do not contest the capture. That was already true before, when nobody on the dead slope counted.

**Reinforcement.** Each assault (and each defense whose control is actually under attack) has forward staging: up to three supported, level points about 300 m from the target control on the side facing the faction's nearest other base, outside every capture ring and subject to the usual enemy/recent-combat safety checks. A base whose control is being taken by a real force (capture weight of at least 1) stops spawning defenders at its own approaches. Bots wait up to eight seconds for an unsafe staging to clear. Out-of-sight bots (no human within 900 m) that are more than 1.2 km from their objective, out of combat and marching for 20 s redeploy at that staging through the ordinary respawn path; at most six per second.

**Sieges.** A base keeps its own rally while it holds its required controls, so an evenly matched siege can grind on. A 10-minute 192-bot run had one siege lasting all 600 s: the attackers held one of three controls and could never take a second while defenders kept respawning beside them.

The fix is a supply cut. If any control of a held base stays lost (neutralized or captured) for 150 s:
- the base's own rally closes;
- its defense staging moves out from about 300 m to about 650 m, so defenders arrive after the attackers;
- the world is told "SUPPLY CUT · <base>".

A first version closed the defense staging entirely. A scripted session then showed defenders being sent back to a base kilometres away, which is the long walk this design exists to prevent.

Retaking the control in time resets the timer, so a foothold becomes a race for both sides. On the same seed and duration, with the final rule (defense staged farther out):

| | Before | With supply cut |
|---|---|---|
| Bases changing hands | 4 | 6 |
| Controls changing hands | 18 | 18 |
| Longest siege | 600 s, unresolved | 322 s, resolved |
| Median siege | 83 s | 94 s |
| Kills per minute | 40.4 | 39.9 |
| Median time to first fight | 34 s | 37.5 s |

In the scripted browser session at the same contested forward base, the player now fights there for the whole session. Before, it was shuttled back to a home base 3 km away.

**The full war: a correction.** Every war measurement above covers the first 10 minutes, but a war lasts 45. Run to its end on Meridian (`npm run test:war -- --seconds=2700`), the same war froze. The last base changed hands at minute 7, and none changed hands for the remaining 38 minutes. Fighting went on at 22–49 kills per minute, but the front did not move. Each faction held a neighbour's forward base, and all three kept sending squads to Halcyon Quay. Its supply was cut at minute 9 and never restored, yet it never fell, and the war ran out the clock. So the claim that the war moves held for its first 7 minutes, not for the whole war.

**Final push.** If no base changes hands for 6 minutes, the war enters a final push. The clock counts from the war's last base flip, or from minute 5 if there has been none, so an opening is never cut short. During the push, the war strip shows a 3-minute countdown and everyone is told "FINAL PUSH". Taking a base calls it off ("DEADLOCK BROKEN") and restarts the clock. When the countdown ends, the time-limit rule decides the war: the most bases win, then the most controls, with sudden death on an exact tie. A frozen front thus ends in a climax and a new war with rotated homes, instead of grinding on. Bots don't react to the push, so a war is unchanged until its first push starts.

Full 45-minute runs on three worlds (`--seconds=2700`; the seed also picks the world) compare the two rules. The old rule was run with the stalemate clock disabled. Base flips are counted per war, excluding the reassignment at each war start:

| 45-minute war | Wars decided | Longest stretch with no base changing hands | Base flips per war | Kills per minute |
|---|---|---|---|---|
| Meridian (seed 1337), old rule | 0 | 38.0 min | 6 (unfinished) | 35.7 |
| Meridian, final push | 2 | 9.0 min | 6, 5, 3 (unfinished) | 43.9 |
| Seed 7, old rule | 0 | 15.5 min | 15 (unfinished) | 59.8 |
| Seed 7, final push | 1 | 9.1 min | 1, 9 (unfinished) | 70.3 |
| Seed 2024, old rule | 0 | 16.6 min | 13 (unfinished) | 76.5 |
| Seed 2024, final push | 1 | 9.0 min | 12, 2 (unfinished) | 71.8 |

The earliest push came 12.5 minutes into a war, and a base flip called one off (seed 7). On Meridian the run is identical to the old one until its first push starts, and the bots are unaffected until that war ends. Total base flips over the 45 minutes went 6 → 14, 15 → 10 and 13 → 14. The 9-minute ceiling is the rule itself (6 minutes of stall plus the 3-minute push). So fronts still stall; they just can't stay frozen for long, and each stall ends in a decision and a fresh war. Whether that feels like a climax is a question for a playtest. `war-campaign.test.ts` covers the clock, the call-off, the decision and the sudden-death tie, and the browser check shows the countdown and both banners on desktop and mobile.

**Wildlife at deployment points.** Creatures neither linger nor attack within 80 m of held bases. They now also keep 60 m away from the forward staging points of every current operation, where soldiers deploy and respawn. One scripted session had been drawn into repeated deaths near a forward staging point, with eleven of twelve deaths scored as self-kills; creature damage was the leading suspect, though that run's causes were not recorded. A creature's kill now counts as a death but no longer as a suicide (it used to cost a frag, like a fall), and the kill feed names it "wildlife".

**Bot launchers (two experiments, both reverted).** In the scripted sessions' death logs, launchers caused most deaths. In one run they caused 6 of 10, four of them 125-damage direct grenade hits from bots up to 320 m away. Two bot rules looked unfair to a human:
- A bot's lob misses by at most 0.8 m sideways at any range, so a 300 m shot is as precise as a 60 m one.
- Rockets and grenades skip the 0.3–0.65 s reaction time that a bot's first rifle shot at a newly seen soldier waits for.

Two variants were run on the supply-cut table's seed and duration. The first combined two changes: a lob miss radius that grows with range (1.5 m plus 1.5% of the range, so the mean sideways miss on flat ground became 1.3 m at 100 m and 2.7 m at 300 m), and the reaction time for launchers aimed at soldiers on foot. The second used the reaction time alone.

| | Supply cut (above) | Scatter + launcher reaction | Launcher reaction only |
|---|---|---|---|
| Kills per minute | 39.9 | 34.3 | 49.5 |
| Controls changing hands | 18 | 23 | 16 |
| Bases changing hands | 6 | 5 | 2 |
| Median siege | 94 s | 164 s | 194 s |
| Longest siege | 322 s, resolved | 376 s, unresolved at the end | 420 s, resolved (another at 249 s unresolved at the end) |
| Median time to first fight | 37.5 s | 43.5 s | 35 s |

Both were reverted: sieges ran longer in both runs, and the standstill is the problem this design exists to fix. One seed is a weak measurement, though. Re-running the final code reproduced the supply-cut column exactly (the same kills, flips and sieges), so the harness is deterministic and these differences do come from the changes. But any change to the bots' random draws also sends the war down a different course, and the two runs even disagree in direction on several metrics. A fair test of a bot change needs several seeds per variant (`npm run test:war -- --seed=N`). The scripted player walks in straight lines at constant speed, the easiest target for a leading lob, so its deaths overstate what a moving human faces.

**Wars.** A faction holding two thirds of the bases wins. Otherwise the war is decided by the most bases (then controls) at 45 minutes, or at the end of a final push once no base has changed hands for 6 minutes, with sudden death on a tie. Victory and service XP are paid, a 30-second intermission follows, then every soldier redeploys (a deployment, not a death) and the home regions rotate between the factions. Saves record the war number, elapsed time and wins; worlds saved before this redesign start war 1.

**Result.** Same seed, population (192 bots) and duration (600 s) as the baseline above: **38.6 kills per minute** (was 19.4), **19 control changes** (was 8) and **6 base changes** (was 1), with ownership swinging through six front-line states; a median of **36.5 s** (p75 74 s) from spawn to first fight (was about 100 s / 150 s); one to ten simultaneous battles; and 1–10 soldiers crossing open country at a time (was 25–51). The busier war costs about 11 ms per 60 Hz tick without a human present; a stand-in human in the hottest battle costs about 12 ms after lowering the exact supported-ground radius for bots from 200 m to 110 m (about 14 ms before). These are single-machine measurements from `npm run test:war`, not capacity guarantees.

## Population and simulation

The default maximum is 192 rostered participants per planet, including humans. Each planet adapts its target between 96 and 192 under sustained server load. Humans replace bots, and soldiers waiting to respawn remain on the roster. Startup, departures and replacement delays can briefly leave fewer participants; this is not a promise of exactly 192 living bots on each planet. `BOTS` overrides the maximum; the adaptive floor is half that maximum, bounded below by 48 unless the configured maximum itself is smaller. The default human admission limit remains 64.

Sustained expensive ticks or a growing backlog lower the target in steps of 24 at the default setting. Recovery adds six places only after twenty seconds of low work, nearly zero backlog and adequate simulation progress. Already dead bots without remaining projectiles retire first, followed by quiet distant infantry, then active infantry in unobserved bot-only fights. Living retirements stay more than 1,200 metres from every human and outside projectile hazards, including the remaining reach of human-fired projectiles. Vehicle crews, airlift passengers, active expedition members and recently arrived reinforcements remain protected. A squad keeps at least one living member; reductions also retain faction presence in actual capture volumes and active 512-metre battle sectors. If safe retirements are unavailable, actual population can temporarily exceed the adaptive target; humans and nearby battles are never removed merely to satisfy that target. The authoritative simulation remains at 60 Hz. `/healthz` reports the maximum, current target, actual population, cumulative adaptive retirements and load-control reason separately. Its retirement details describe the last selection attempt, identified by its simulation tick; they are not a continuously updated census of blocked retirements.

A new bot receives its faction and squad identity before choosing its first spawn. Its temporary first-base coordinates do not count as battlefield presence or pull its squad order toward Meridian. Successful placement activates the soldier; a blocked placement waits for the ordinary retry.

Human movement uses the normal 60 Hz controller. Supported, grounded bot infantry may reuse checked ground outside 110 metres (200 metres before the front-line redesign); other bot movement and vehicles retain their 300-metre human-interest boundary. Distant infantry reuse checked ground corridors or resolve swept movement at least every fourth tick; they keep participating in weapons, damage, capture, breathing, and timers on every tick. Clear-water movement can reuse a conservatively checked volume while integrating currents and buoyancy each tick. Close interactions, fresh damage, airborne movement, nearby moving hulls, trains, and orbital pods retain the detailed movement path. Distant bot jeeps and tanks can resolve movement every three or four ticks, with a displacement bound relative to hull size. Human crews, enemies within 20 metres, fresh hull damage, fast or boosted driving, airborne hulls, and aircraft retain normal vehicle movement. Quiet remote vehicle decisions run at five Hz; firing or opposing bots within 150 metres raise aiming decisions to ten Hz. Human interest, enemies within 20 metres, fresh hull damage, boost, flight and immediate actions restore normal decisions. Bot-only ranged fighting therefore accepts up to 100 ms between new aim decisions and up to four ticks between bounded movement updates; weapons, projectiles, damage, crew attachment and swept runover checks still run every authoritative tick. The simulation clock never skips time, and connecting humans continue to replace bots within the population target.

Grounded same-faction bot driver/gunner pairs in ordinary jeeps and tanks now share a nominated gunner's sightings. Both aim at a copied last-observed position; unseen target motion does not update the report. Nearby crews scan on a nine-tick deadline, remote eligible crews on twenty-four ticks, with one scan per hull per tick across lifecycle changes. Changed crew/target identities, range, damage and eligibility revoke or refresh reports before deferred input can be reused. Unsupported, solo or mixed human crews retain individual acquisition. Current weapon collision still blocks shots through new cover. This is a cooperation change; the bounded cost replay gives no capacity improvement claim.

For individual acquisition outside shared spotting, distant grounded bot jeep and tank occupants in campaigns with at least 48 bots use a 24-tick deadline for repeated enemy visibility checks. Their existing decision cadence services that deadline, so an off-phase wake can postpone the next check until an ordinary thought; this is a deliberate remote perception approximation. Every human still registered in the world, including dead characters and those without an active connection, must be farther than 1,170 metres horizontally, protecting the full 390-metre acquisition range from the 780-metre observer boundary. Human crew, close retained threats, fast or invalid motion, airlift, aircraft, naval vehicles, custom bot observers and replaced trace or field providers retain the baseline policy. The first scan's staggering and two-candidate rotation stay unchanged. Observer or target transitions wake perception immediately; a first damage event also wakes it, then normal 9/18-tick visibility deadlines apply until sixty ticks pass without another soldier or hull damage event. Repeated hits cannot force a scan on every hit. Physics, aim-decision cadence, weapon collision, damage, projectiles and capture timers retain their existing authoritative behavior.

Checked infantry corridors can include authored city streets and elevated decks when one canonical solid box supports the entire capsule footprint. Exact ground-level city planes also qualify when the complete footprint lies inside the flat core, with matching height throughout and no cave, temple, or station grading. The abyss never qualifies as a city plane. The proof uses actual support height, checks curved capital shells and all intervening cover, and rejects deck edges, platform gaps, lift shafts, water, and unsafe terrain. Cached movement still checks live camps and nearby moving hazards. This allows clear Vesper bridges and Aurelia streets or promenades to reuse support without treating the whole city or its abyss as a flat floor.

Open natural ground in a capital's broad outskirts can also qualify when conservative bounds exclude every nearby tapered shell. Missing metadata, replaced geometry providers and actual obstacles retain full collision. Stationary remote squads beside static orbital pods may reuse their unchanged ground contact for twelve ticks; moving approaches, charging, flight and live hazards still promote them immediately.

Ordinary thin bot shots outside every human's 780-metre interest radius first check their complete range against rewound infantry, vehicle hulls and wildlife. Only a whole shot proven to miss every damageable body can omit its cosmetic terrain impact. Possible hits, nearby shots, special weapons and custom observers keep the original trace and events; ammunition, firing timers and damage rules are unchanged. Fast or nonfinite human motion and airlift travel disable the shortcut. A player who teleports, respawns or arrives after firing may miss that already-fired cosmetic miss report.

Admitted distant ground convoys omit the extra arcade impulse that launches a fast vehicle from a hill crest. They keep ordinary slope collision, acceleration, steering, gravity and landing behavior, which helps them stay on their route. Human crews, nearby interest, boost, airborne movement and other promotion conditions retain normal crest assistance. This is an explicit bot travel policy; the default shared controller and client prediction keep the original behavior.

Six-person faction squads have separate objectives. The director weighs threatened controls, friendly footholds, recently lost territory, enemy presence, supply distance, and other squads' assignments. Objectives remain stable during travel unless a meaningful strategic change justifies reassignment. Quiet outlying cities and harbors receive expeditions, and recently captured bases receive garrisons. A larger battle can receive a second squad; it does not automatically consume the whole army.

A faction can now retain one already-present squad as a persistent alert garrison at a quiet base whose controls it fully owns. At least three available living ground-capable squads are required, leaving two for other operations. The guard squad needs at least four ground-duty roster members forming a majority, at least three living eligible members, and three grounded infantry physically inside the same control's capture cylinder. Every living ground-duty member must already be within the base's existing 850-metre presence radius; the reservation does not recall a split squad from elsewhere. Aircraft or naval duties do not supply the ground quota; a living ground-duty member riding an aircraft or boat disqualifies the squad, and explicit orbital travel or airlift duty takes precedence.

An eligible existing guard keeps its assignment through reassessment. Threat or ownership loss suppresses quiet reservations so the original response auction can act; departure, loss of the presence quorum or a travel assignment also releases the reservation. The policy leaves ordinary infantry arrival, stationary scanning, resupply, combat and collision unchanged. It reserves one quiet squad, without changing the separate threatened-base and overflow defenses. Fully owned means control ownership, not necessarily completely restored capture progress.

Capturing one of a base's three controls creates a foothold that attracts friendly support. Holding two unlocks local reinforcements. Bot respawns choose a safe approach near their assigned operation, including eligible mobile rally jeeps. Enemy proximity, capture-ring separation, recent fighting, and the twelve-second quiet period still apply. Owning a base never permits spawning directly into its contested flag.

All four cities, five harbors, and three forward bases have ground-vehicle depots on each planet. City depots provide three jeeps and a tank; harbor depots provide a jeep. Depot stock respawns at its original location. Parked, unmanned depot vehicles follow a base's current owner, while deployed vehicles and their crews retain their allegiance. Drivers and passengers reserve compatible seats, wait for nearby squadmates, and dismount to capture. They continue toward their assignment while firing at incidental enemies along the route. Marching infantry check live hull geometry and projected vehicle movement so they can walk around traffic; boarding approaches retain their reserved destination.

Blocked vehicles complete a bounded reverse-and-turn maneuver before retrying their route. Repeated obstacle reports cannot keep restarting a straight reverse, and consecutive attempts retain their escape direction. Armor that reaches its assigned cover position stops and keeps firing without mistaking its deliberate stop for an obstruction. New orders restore travel, and damaged crews can still evacuate. Quiet infantry finish topping off a launcher, then ready a loaded rifle or sidearm for travel. Actual combat and anti-air duty select their appropriate weapon again immediately.

Infantry also track progress toward their route waypoint. On ordinary surface terrain, a soldier that keeps circling can follow short, checked detour legs while retaining one side of the obstruction. Support across the walking footprint, body/head clearance, water, slope and live vehicle checks prevent choosing an unsupported shortcut. Recovery ends after regaining supported progress toward the blocked waypoint, a changed order, combat, boarding, death, or its sixty-second/400-metre limit. Each planned leg stays within sixteen metres; ordinary movement and collision remain authoritative.

Cave recovery takes precedence. A soldier circling inside a hillside cave while trying to reach the surface follows the cave gallery back through its mouth, then replans the march. Cave-bearing and underground starts do not use the new surface detour. The escape uses ordinary walking and collision; changing the order or boarding a vehicle clears it.

On elevated Vesper decks, quiet grounded infantry also check that actual connected deck boxes support their complete course and stopping distance. They brake before an unsupported edge, can follow joined bridge sections, and abandon a pickup or vehicle that remains unreachable. This bounded policy applies only to native authored decks in the deep city core; ordinary terrain, cave routes and physical collision retain their existing behavior.

## Interplanetary operations

Live worlds exchange strategic reports every five seconds. Each world can dispatch one squad of three to six soldiers at a time, rotating factions and retaining a home force. Threatened friendly bases and partial footholds take priority over unclaimed or enemy bases; a destination already hosting a large friendly army is less attractive. Stale reports cannot launch an expedition.

An expedition assembles at a physical orbital pod. Every member must arrive alive, on foot, and out of immediate combat, then remain still and undamaged through the five-second charge. A killed squadmate or an assembly that exceeds six minutes cancels the operation. At the destination, the squad arrives at a clear pod and travels toward its assigned base. Arrivals replace available reserve bots within the population cap, and receive a protected deployment period before they can be reassigned to another planet. Vehicles support planetary travel; orbital transfers carry infantry.

The coordinator commits squad transfers durably before destination admission. Lost responses are reconciled against the same transfer receipt; they cannot leave two active copies of a soldier. When an ambiguous departure must be abandoned, durable cancellation decides the race with the original request before the source squad resumes. A delayed request cannot commit after that cancellation. Transfer identity, faction, equipment, and inventory are retained. Full or unavailable destinations defer or reject the operation. Retiring an imported reserve records a tombstone so a later worker restart cannot restore it again.

## Captures and travel incentives

A lone human needs sixty seconds to capture a neutral control. A fully held hostile control takes sixty seconds to neutralize and another sixty to capture. Allies accelerate progress up to three human equivalents. Opposing presence pauses it only while no side clearly outnumbers the others (see Front-line wars). Bots contribute one quarter of a human's capture weight.

Helping finish a control capture awards a one-time 150-salvage contract on that planet. A participant must be on foot inside the winning control when it changes ownership. Each of the three planets has an independent contract, retained in character saves and transfers. Repeated captures on the same planet cannot repeat the bonus.

## Daily orders and war debriefs

Every UTC day brings three daily orders, the same for everyone. One is always a kill order (10, 20 or 30 eliminations); the other two are distinct kinds:
- assists;
- captures;
- kills at your own holdings or during assaults;
- a kill streak;
- destroying a vehicle;
- helping secure a base;
- taking revenge.

Progress is counted inside the existing reward events. Each order pays its bonus (300–1,300 XP) once, with a ribbon and an "order complete" banner. Progress is saved with the character and resets at UTC midnight. The rank panel shows one line (orders done and the next order with its progress); the tactical map lists all three with progress bars and the time until new orders. Bots have none.

When a war is decided, each human sees a debrief card beside the action for the 30-second intermission. It shows the result, their own eliminations, deaths, K/D, captures and XP for that war, and the war's top soldier on the world. Nothing blocks input, and the counts start again with the next war. `npm run test:progression:browser` checks the daily line, the completion banner and the debrief on desktop and touch layouts.

**World generation changed after these runs** (2026-11: boulders rest on their footing, trunks reach the ground, volcanic ground fades out before the shore; see the README). Every war run in this document predates that change, so re-running one now gives a different war, not the same numbers. Establish new baselines before comparing a change.

## Reading the war

The G tactical map uses a muted strategic basemap. Ownership areas, capture arcs, contested rings, active-objective reports, and status labels take precedence over terrain. Unit contacts appear at local zoom; planet zoom emphasizes bases and operations. Unchanged strategic packets reuse the existing map, hidden maps defer work, and panning is coalesced into animation frames. Its opaque panel also reduces background WebGL draws to ten per second while gameplay and map updates continue. Closing the map restores normal rendering immediately. The M minimap rasterizes its background once and keeps local capture state prominent.

The O star chart shows each destination's conquest contract, reported deployed population, threatened bases, and inbound squads. Attack announcements name the base, planet, and attacking faction. A continuous attack announces once; it must go quiet before another start announcement can be sent.

## Verification

**Current verification, 2026-09-20:** sustained 192-participant capacity remains unqualified. The source-matched terrain-dependency build fails the strict 600-second Node 22, windowed Firefox 4K drive after **177.86168 seconds of rendered play**, with Meridian/Cinder/Nacre at **99/0/1 ticks of debt**. Browser play averages **48.25 FPS**, with a 516.66 ms maximum frame and no browser errors. Ordinary controls complete **71.87 driver seconds and 1.634 km**, followed by death and respawn; reboarding, complete driving coverage and the map phase are not reached. The new spawn, cohort and trajectory differ from earlier runs, so this is not a paired speedup or regression result. All owned processes stop; eighteen source-save files, six bundles and 190 current source hashes remain unchanged/matched (`artifacts/campaign-terrain-dependency-drive-summary.json`, `campaign-terrain-dependency-drive-external-audit.json`, `campaign-terrain-dependency-build-check.json`).

The final 10.10 seconds reach **18.74 ms of Meridian work per tick at 50.60 Hz**, versus 14.48 ms at 60.00 Hz during sampled driving. The final thirty-second span averages 14.90 ms at 56.79 Hz and masks that late rise. Current/ahead coarse ground remains present in all 169 play observations; three current/ahead canonical misses occur on foot, while all 67 driver observations have canonical coverage. All 159 living-camera samples retain pitch between -0.0814 and -0.0792 radians, verifying the ordinary-input horizon correction at sampled times; visibility and focus remain present. These sparse observations do not establish continuous terrain or camera coverage (`artifacts/campaign-terrain-dependency-drive-window-review.json`).

The exact qualified terrain-dependency implementation now passes **141/141 related tests**, full typecheck, the unminified build and all six source-map checks, each with native exit 0. The initial 139/141 result is preserved; its two failures required only the missing canonical-request state in synthetic test fixtures, with no runtime correction. Earlier bounded native witnesses reach Meridian's 9/9 canonical neighborhood by 7.776 seconds before walking, and the Vesper 20 FPS route has zero current-ground misses in 561 frames with three directed rock contacts. These checks do not qualify all scenery, sustained full-game capacity or a full current integrated-suite run (`artifacts/campaign-terrain-dependency-production-r2-qualification.json`).

**Historical operator-body checkpoint:** sustained 192-participant capacity remains unqualified. The preceding installed-Node-22, source-matched operator-body build fails the strict 600-second Firefox 4K check after **11.61636 seconds of rendered play** (10.59495 seconds between the first and last play health samples). Meridian/Cinder/Nacre finish at **126/1/1 ticks of debt**; browser play averages **37.1889 FPS**, with a **366.66 ms** maximum frame and no browser errors. The actor stays on foot approaching a vehicle, with 16-25 nearby snapshot actors; no boarding, driving or map phase is reached. All owned processes stop, all eighteen source-save files and six bundles remain unchanged, and all six source maps/190 current source hashes match. The failure image shows an upward camera view; these FPS values are not a road-view rendering benchmark, and the same limitation applies to the following native profile. The authoritative server-debt failure remains valid. This unpaired run uses a different actor cohort and trajectory; it establishes no capacity gain or causal comparison with the earlier failures (`artifacts/campaign-operator-body-drive-summary.json`, `campaign-operator-body-drive-external-audit.json`, `campaign-operator-body-build-check.json`).

The operator-body production promotion passes **29/29 focused render tests**, full typecheck, an unminified build and all six source-map parity checks, each with native exit 0. Fifteen articulated body parts now share one actor-local skinned mesh; the tests cover fixed-scale skinning normals and positions, current bounds, 24 shared variant geometries, private skeleton state and owned-resource cleanup. These rendering checks do not qualify sustained server capacity or replace a full current integrated-suite run (`artifacts/campaign-operator-body-production-qualification.json`, `operator-body-production-equivalence.json`).

**Historical alert-garrison checkpoint:** sustained 192-participant capacity remains unqualified. The preceding installed-Node-22, source-matched alert-garrison build fails the strict 600-second Firefox 4K check after **7.02056 seconds of rendered play** (5.83385 seconds between the first and last play health samples). Meridian/Cinder/Nacre finish at **145/37/38 ticks of debt**; browser play averages **16.24 FPS**, with a 437 ms maximum frame and no browser errors. The actor remains on foot searching for a depot; boarding, driving coverage and the map phase are never reached. Startup, play and final visibility evidence is visible and focused, with no hidden/blur transition or dropped event. Four of five current-foot samples lack canonical ground while all five retain coarse coverage; these are sparse samples, not gap durations. All owned processes stop, all eighteen source-save files and six bundles remain unchanged, and the six source maps/189 current source hashes match (`artifacts/campaign-alert-garrison-drive-summary.json`, `campaign-alert-garrison-drive-external-audit.json`, `campaign-alert-garrison-build-check.json`).

The alert-garrison correction passes 72 related tests; after a test-fixture typing correction, the affected six-test rerun, full typecheck, unminified build and all six source-map checks also pass. That alert-garrison live failure leaves sustained qualification unresolved and provides no measured capacity benefit (`artifacts/campaign-alert-garrison-final-checks.json`). The current terrain upload-fairness implementation separately passes its bounded 20/30 FPS route witnesses and 135 related tests; those checks do not qualify full-game capacity or all scenery. The older failures and historical test checkpoints below remain evidence for their own scenarios. See [PERFORMANCE.md](PERFORMANCE.md) for the browser-phase work/host comparison and its unpaired-run limitations.

The separate source-identical host-observation diagnostic also fails, after 5.68454 rendered seconds at 121 Meridian ticks of debt and 19.88 FPS. Its measured sampler overhead and concurrent process activity prevent a clean causal comparison; it does not replace the plain result above. All owned processes stop and all eighteen saves/six bundles remain unchanged (`artifacts/campaign-startup-host-observation-cpu-review.json`).

**Historical box-cache/rectangle checkpoint:** the unprofiled Firefox attempt runs **241.34 of 600 requested play seconds at 55.52 FPS**, then fails the strict Meridian cadence gate. After the human dies near Southwatch and respawns on foot elsewhere, debt rises **2 to 93 in 10.65 seconds** at 51.45 Hz; Cinder/Nacre end at 1/1. Subsequent native diagnostics still show material movement, navigation, visibility and garbage-collection costs. The actor completes **181.39 seconds driving 4.232 km**, and both ordinary reverse-turn recoveries restore progress. All driving coverage requirements would pass at the stop. Canonical current ground is present in **172/172 driver samples**, but five ahead samples and eight living-foot current samples lack canonical ground; these observations do not guarantee continuous terrain coverage. No map phase is reached (`artifacts/campaign-box-rectangle-drive-summary.json`). Later fixes to that checkpoint's terrain boundary cracks and their bounded qualifications are tracked in [PERFORMANCE.md](PERFORMANCE.md); sustained full-game capacity remains unresolved.

At that historical checkpoint, all owned processes stop normally, there are no worker exits or browser errors, and source save-copy hashes match before/after copying. All six served bundle hashes and 185 unique current source hashes match the source-map build check (`artifacts/campaign-box-rectangle-build-check.json`). Current-foot terrain priority passes 25 focused tests; remote ground-crew policy and related regressions pass 49; the box cache and authored rectangle changes pass 37 and 46 focused checks respectively, with typecheck passing. The preceding integrated suite completed at 1,243/1,244; its sole obsolete cave-upgrade scheduling assertion was corrected and passed the focused rerun. A full integrated rerun and sustained 600-second qualification were outstanding at that checkpoint. The short historical passes below establish their own scenarios only; see [PERFORMANCE.md](PERFORMANCE.md).

The earlier bounded fresh-world production check passed at 192 participants per planet through 120 seconds of bots, 15 seconds of raw-client input, 180 seconds of rendered play and 10 seconds of the map. Play/map average 59.62/60.00 FPS with no browser errors or worker restarts; Meridian/Cinder/Nacre peak at 54/21/15 ticks of backlog and finish at 4/1/0. All fixture services stop, and orbital arrivals are observed on every planet. Nearby snapshot infantry range from zero to eleven (mean 3.96), so this is not a sustained dense-combat guarantee (`artifacts/campaign-final-fresh-summary.json`).

The preceding saved-world check also passes 120 seconds of bots, 120 seconds of play and 10 seconds of the map, averaging 59.50/60.00 FPS. Its backlogs peak at 119/26/17 and finish at 2/2/1, with source saves unchanged. Meridian has little margin in that copied-world scenario. See [PERFORMANCE.md](PERFORMANCE.md) and `artifacts/campaign-stable-state-saved-realtime.json` for evidence and earlier failures.

The historical integrated checkpoint passed **1,189/1,189 tests**, with no skips or cancellations. The subsequent friendly-restoration map labels passed thirteen focused tests and the desktop/mobile map DOM fixture; capture mechanics were unchanged. That checkpoint's typecheck/build passed at 616 KiB Brotli, and all 94 server and 139 client source-map modules matched its source. Logs are `artifacts/campaign-final-{integrated-tests,map-wording-tests,map-browser,typecheck,build}.log`; these are not results for the current candidate.

- `npm run check` runs TypeScript and the repository regression suite.
- `node --no-warnings --experimental-sqlite --import tsx --test packages/server/test/bot-ground-navigation.test.ts packages/server/test/bot-cave-navigation.test.ts` checks captured hillside travel, supported detours, mutable obstructions, cancellation and cave recovery.
- `node --import tsx scripts/map-readability-browser-check.ts` checks map readability, persistent geometry, hidden-map work, and desktop/mobile layouts.
- `node --import tsx scripts/orbital-campaign-browser-check.ts` checks contracts, planetary dispatches, and launch controls on desktop/mobile layouts.
- `npm run test:campaign:simulation -- --population=192 --seconds=60` runs actual bots, movement, vehicles, combat, and captures on generated terrain.
- `npm run profile:simulation -- --seed 1337 --bots 192 --warmup 300 --ticks 600 --label campaign-profile` records an offline CPU profile. It does not establish real-time capacity for all three world processes.
- After a production build, `node --no-warnings --experimental-sqlite scripts/campaign-realtime-check.mjs --population 192 --seconds 120 --client-seconds 15 --browser-seconds 30 --label campaign-realtime` runs isolated world workers, verifies their clocks and population, then checks connected play. It uses temporary saves.

The deterministic map fixture reduced the basemap from approximately 565 KB to 46 KB. Its unchanged strategic updates averaged about 0.25 ms, with no hidden-map DOM mutations, at 1440×900, 844×390, and 390×844. These measurements isolate map code and do not imply that the full WebGL game or server has the same frame cost.
