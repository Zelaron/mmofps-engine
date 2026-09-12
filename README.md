# THE MMOFPS

Latest verified update: [continuous road rendering and faster startup](docs/PERFORMANCE.md#roads-and-background-scenery--2026-09-12) — protocol 25, 746 passing tests, and verified desktop/touch scenery loading and worker recovery. [Renewable xenolite gathering](docs/RESOURCES.md) funds persistent camps.

A browser FPS built around a large, connected frontier: cities, wilderness, caves, railways, ferries, aircraft, ground vehicles and gunboats. Open the URL and arrive as an independent explorer. Enlist in the Terran Accord or Helix Combine from the in-game atlas whenever you want to fight over territory.

The complete client, server and shared world/movement code are in `packages/client`, `packages/server` and `packages/shared`. Build and verification tools are in `scripts`; server setup is described in [DEPLOY.md](DEPLOY.md).

## Run locally

Requires Node.js 22.11 or newer. Start/test scripts enable the built-in SQLite module (experimental in Node 22.11).

```sh
git clone https://github.com/Zelaron/mmofps-engine.git
cd mmofps-engine
npm ci
npm run build
npm start
```

The repository is private, so Git needs your GitHub credentials when cloning. Open **http://localhost:8080** after startup. `npm run dev` rebuilds the client and server while editing.

The build downloads the two versioned Barlow fonts and verifies their SHA-256 checksums. `npm run assets` can fetch them separately; subsequent builds reuse the verified cache. All other game models and textures are generated from source. Dependencies, downloaded font binaries, built bundles, saved worlds and diagnostic captures are excluded from Git. The dependency lockfile and third-party license texts are included.

Run `npm run check` for type checking and the automated tests. Browser checks additionally need `npx playwright install chromium` (on a Linux machine missing browser libraries, use `npx playwright install --with-deps chromium`). `npm run test:browser` expects a local game at port 8081 or the URL in `GAME_URL`; the specialized scenery/resource fixtures create their own isolated worlds. Performance documents refer to local `artifacts/` captures, which are not part of the repository and can be regenerated with the documented scripts.

`npm start` launches a gateway and three separate world processes: Meridian, Cinder and Nacre. Each has the complete world, including cities, caves, vehicles and scheduled transport. Different seeds produce different terrain and underground layouts; city names also differ. One command runs the whole cluster locally, and workers can use the same private interfaces on other machines.

There is no login or deployment screen. Desktop browsers require one click to capture the mouse; mobile controls are immediately active. The browser receives an anonymous HttpOnly session cookie. Allegiance, ammunition, health, discoveries, salvage, position and current planet are saved in `data/universe.sqlite`. Territory ownership is saved under `data/<planet>/`. Keeping the cookie is necessary to return to the same identity. Earlier Meridian character files are imported on first connection.

For repeatable CPU measurements, run `npm run profile:simulation`. The fixture saves a bundled baseline, V8 profile, timing report and checked state under `artifacts/`. See [simulation profiling](docs/PERFORMANCE.md) for parameters and the three-planet city-collision comparison.

## Play

- **WASD / mouse:** move and aim. **Space:** jump. **Double-tap a direction:** dodge, with the original air control and momentum.
- **Mouse / touch FIRE:** shoot. **R:** reload. **1–9, 0, wheel:** choose weapons.
- **E:** enter a vehicle, join a compatible crew, or open a nearby airlift pod's destination map.
- **B / FIELD CAMP:** open construction, choose a module, rotate its preview and build ahead of you. Close the panel to move and aim.
- **Hold F / HOLD TO EXTRACT:** gather a nearby glowing xenolite seam on foot. Three seconds yields 12 salvage; the shared deposit regrows after three minutes. Moving, fighting or releasing cancels a partial extraction.
- **G:** world atlas and faction enlistment. **O:** star system and orbital travel. **M:** minimap and compass. **Tab:** scores. **T / Enter:** chat.
- Mobile has separate movement, look/fire, jump, dodge, weapon, reload and interaction controls.

Independent explorers and faction allies cannot damage each other. Wildlife, falls, drowning, lava and self damage still matter. Faction combatants capture ground-level districts by occupying their marked radius. Both sides present means a contested site. Human presence counts five times as much as AI presence. Friendly controlled districts accelerate healing after combat. Standing down or switching factions requires leaving combat and waiting for the allegiance cooldown.

Each world retains the original 22.528 km square envelope (including ocean), four cities, cave networks, moving trains and ferries, launch pods, vehicle variants and ten infantry weapons. Discovering cities and extracting renewable xenolite award persistent salvage for field-camp modules. Deposits occur on supported gentle ground; their depletion and rewards survive reconnects and restarts. Crafting, trading and the wider economy remain outstanding.

Build outside cities and away from roads and transit stops. A **trail shelter costs 20 salvage**, a **medical station 25**, and an **ammo fabricator 30**. Shelters have a ramp, deck, roof and solid cover. Within 5 m and with a clear line of sight, medical stations add 6 health per second and fabricators replenish ordinary weapon reserves after combat. Services support the owner and players matching the module's allegiance when built; neutral modules support independent explorers. Rare ammunition still requires exploration.

Modules and their payments are saved together in the universe database. They remain after logout, restart and planetary travel. Each character may own six modules across the universe; each 128 m cell allows four. Owners can pack modules from nearby after everyone steps clear; packing does not refund salvage. This construction system uses the default universe launcher. The legacy standalone mode has no construction service. Modules currently have no destruction, decay, respawn binding or distant atlas markers.

Open the star chart from the HUD or with **O**, choose a planet, and mark the nearest transit pod. Reach that physical pod on foot to launch. The 5-second charge cancels when you move, take damage or board a vehicle. A committed launch automatically reconnects you at the destination's spaceport with your supplies and discoveries. Ordinary connection interruptions also reconnect automatically; opening another tab intentionally closes the older session.

## Current implementation and verification

- Original 60 Hz shared movement, prediction/reconciliation, dodge, air control, lag compensation, terrain streaming and transit physics retained.
- Automatic desktop/mobile arrival; full-world atlas; two optional factions and objective-seeking AI; capture at city districts and harbors.
- Three world processes, gateway routing, SQLite character ownership, epoch-fenced checkpoints, destination reservations and idempotent transfers. The source character stops simulating before its transfer commits. Workers pause simulation when coordinator authority expires.
- World-worker supervision, automatic browser reconnect and tested recovery after a worker crash. Private HTTP/WS addresses allow placing workers on other machines; see [DEPLOY.md](DEPLOY.md).
- Protocol 25 carries persistent simulation time, safe-integer entity references, authoritative base teleporter layouts and bounded resource snapshots. Characters keep their database ID through reconnects, restarts and planetary travel. Coordinated workers reserve durable ID batches that are never reissued, protecting hulls and projectiles that outlive their source worker elsewhere. Existing saves migrate automatically; clients, workers and coordinator must update together.
- Persistent planetary clocks and durable world authority epochs. Workers initialize time before admission, retain bounded simulation debt, and restart safely when they cannot catch up. Coordinator restart and host clock changes cannot forget an outstanding authority or rewind issued planetary time. These are prerequisites for geographic regions, which are still not enabled.
- Complete simulation handoff records retain movement, reloads, queued input, crews, hulls, projectiles and recent collision history. Failed planetary launches use them for local rollback. The coordinator now supports geographic authority layouts, local capacity reservations and atomic human-crew/hull ownership transfers. Automatic worker/browser handoff and neighbor combat are still required; see [docs/REGIONAL-HANDOFF.md](docs/REGIONAL-HANDOFF.md).
- Persistent camp construction with server placement checks, epoch and world-authority fencing, idempotent spending, and recovery when a commit response is lost. Workers load their geographic camp view and nearby boundary structures. Complete cell receipts keep delayed snapshots from erasing new walls or restoring packed modules; expired views pause simulation. Regional refresh is every two seconds, while local committed builds update immediately. Seamless regional gameplay still requires orchestration and synchronized collision activation.
- Spatial broad-phase queries for player/projectile replication, bounded remote snapshots, separate 1 Hz strategic messages, and stale-input stopping.
- Terrain relief with blended world-space projections, physical rock and vehicle materials, industrial panel detail and reflective canopies. Orbital terminals have lit decks, framed boarding gantries and signs. Procedural clouds, a rocky moon, a binary companion star, sky reflections and nearby desktop sun shadows provide lighting without downloaded texture packs. Mobile keeps bounded rendering budgets.
- Nearby surfaces receive soft contact shading from the world's depth buffer, including cave interiors. The HDR path retains cave stencil masks and antialiasing; `?quality=low` uses direct rendering. The pulse rifle has rounded casing, an open cooling cage, induction rings and separate reload parts. Generated grain gives metal and composite weapons distinct finishes without asset downloads.
- Native fanwood canopies and layered blue fronds replace the terrestrial leaf clusters. Distant trees retain open silhouettes, and nearby desktop plants cast wind-matched sun shadows. Their geometry and two tiny vein textures are generated locally. `npm run test:flora:browser` captures actual groves on desktop and touch layouts, with `--low` selecting the rendering fallback.
- Coordinated workers yield through the event loop when catching up, then schedule against the remaining shared tick phase. All physics ticks, authority fencing and overload limits remain intact. Private timing diagnostics, retained real-time CPU profiles and a local universe monitor support further investigation.
- Building collision uses packed double-precision geometry with conservative search bounds. Final local 15-bot fixtures show 19–22% lower average tick cost with identical saved simulation states and combat counters. The latest six-minute live run had no worker replacements and at most 150 ms of recorded backlog under host load. It was not a controlled replay of the earlier workload and does not establish population capacity. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
- **746 tests passed** in the full regression run (`artifacts/roads-resume-tests.log`), with typecheck and build passing. The latest checks cover road material boundaries, bounded scenery queries, stale travel replies, worker failure and nearby terrain priority. Existing extraction, persistence, movement, world, foliage, camp, ownership, clock and transfer checks also pass. The preceding resource checkpoint's desktop/touch extraction and construction evidence remains in [docs/RESOURCES.md](docs/RESOURCES.md). These checks do not prove automatic regional browser crossings or production capacity.
- Roads now blend continuously into their biome, removing the white triangular fringe in volcanic terrain. Scenery queries run in a background worker, with existing cover retained until replacement data arrives and a synchronous fallback if the worker fails. `npm run test:scenery:browser` verifies real road/forest travel, matching scenery, high/low rendering, worker failure and reload on desktop and touch emulation.
- Browser checks pass automatic entry, original running pace, jumping, firing, reloading, faction selection and refresh persistence. Touch emulation also passes simultaneous movement/fire and portrait rotation (`artifacts/roads-final-browser.json`). The latest paired local high-quality captures reduced mean first presentation from 3.05 to 2.65 seconds on desktop and 2.79 to 2.33 seconds in touch emulation. Nearby terrain detail arrives in about 2.1 seconds, previously 6.1/4.1 seconds respectively. Each comparison has two runs per version, with the same saved character and no CPU profiler. Distant terrain continues streaming afterward. `npm run profile:startup` captures first presentation and remaining main-thread stalls; see [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for methodology and final-build checks. Physical-phone performance and the requested final art quality still need substantial work.
- `npm run test:entities:browser` verifies the negotiated protocol and reserved IDs above 32 bits in real WebSocket frames and visible vehicle models on desktop and touch emulation. Portrait chat/pause controls are separated from navigation and field-camp buttons.
- Ownership, clock, transfer and restart tests are in `packages/server/test/{coordinator,planet-clock,clock-recovery,planetary,cluster,runtime-handoff}.test.ts`. `npm run test:planets:browser` passed real orbital launches, stable character IDs, arrival/cargo preservation and automatic reconnects on desktop and mobile emulation. Mouse/touch restoration between maps also passed.
- The build reports about **511 KiB Brotli** for all current scripts, workers, fonts, HTML and CSS, including the new scenery worker. Terrain, models and orbital globe portraits are generated locally.

## Full objective remains active

This implementation is not yet the completed massively distributed game. It runs one authority per planet, with a default admission limit of 64 humans per planet. Bots fill a target population of 15 and step aside as humans join. The gateway and SQLite coordinator share one process. Neither these limits nor the spatial index are **evidence of 100,000-player capacity**.

Outstanding work includes geographic regions within popular planets, neighbor simulation and vehicle handoff, coordinator throughput/availability at scale, spherical traversal, expanded construction, survival and a broader crafting and trade economy, squads and wider logistics, richer alien art and encounters, physical-mobile profiling, and realistic load/soak/failure testing. Surfaces remain bounded planar regions; orbital globe portraits do not imply spherical traversal. See [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

See [DEPLOY.md](DEPLOY.md) for Node, Docker and systemd setup. Production hosting, domain configuration and an automated release/update workflow remain separate deployment steps.
