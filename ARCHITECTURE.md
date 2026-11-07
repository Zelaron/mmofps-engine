# Architecture

How the client, server and worlds fit together. For running and hosting, see [DEPLOY.md](DEPLOY.md).

## Packages

- **`packages/shared`** is used by both sides. It holds deterministic world generation from a seed (terrain, caves, cities, roads, vegetation, boulders and the campaign layout's inputs), the movement and physics step, weapons and vehicles, and the binary network protocol (version 30). Because client and server run the same code on the same seed, the world never has to be downloaded and client prediction matches the server.
- **`packages/server`** runs the authoritative simulation, bots and the war campaign.
- **`packages/client`** is the browser game: Three.js on WebGL2. Every model and texture is generated in code.

## Processes

`npm start` launches a cluster (`MMOFPS_ROLE=cluster`):

- **Gateway** (`gateway.ts`) serves the client, gives each browser an anonymous session cookie and forwards its WebSocket to the world its character is on.
- **Coordinator** (`coordinator.ts`, `control-plane.ts`) is a private service that owns characters in SQLite (`data/universe.sqlite`): location, inventory, progress, and leases and epochs that stop a character from being live in two places.
- **World workers** (`world-node.ts`, one per enabled planet) each simulate one world. `cluster.ts` supervises the local workers and restarts one that crashes. Workers can also run on other machines (`MMOFPS_ROLE=world`).

`MMOFPS_ROLE=single` runs the older standalone server with no coordinator.

## A world worker

- **Simulation** (`game.ts`) runs at 60 Hz: input queues, movement, vehicles, projectiles, combat and lag compensation. It sends binary snapshots at 30 Hz, filtered by distance with a spatial index.
- **War campaign** (`frontier.ts`) steps at 5 Hz: capture progress, base ownership, supply cuts, the final push and war victory. It sends each player a JSON strategic snapshot once a second (territory, orders, reinforcement options, battles, airfields). `campaign-layout.ts` places the bases and controls, `campaign-director.ts` assigns bot squads to operations, and `reinforcements.ts` decides where soldiers deploy.
- **Bots** (`bots.ts`) are server-side soldiers. `bot-simulation.ts` moves distant bots through a cheaper path that hands back to full physics near anything complex. `adaptive-population.ts` and `bot-retirement.ts` resize the population under load.
- **Also on the worker:** wildlife and bosses (`wildlife.ts`), XP and daily orders (`progression.ts`), field camps (`outposts.ts`) and xenolite gathering (`gathering.ts`).
- Territory state is saved to the world's data directory every 30 seconds. Characters are checkpointed to the coordinator.

## The client

- **Rendering.** The client meshes nearby terrain in web workers (surface nets over the shared world field) and streams coarser terrain for distance. Scenery, road maps and map tiles are built in workers too. Shader variants are drawn once behind the loading screen, so first sights don't stall.
- **Movement.** The client predicts its own movement with the shared step and reconciles with the server. Other players are interpolated from snapshots.
- **Interface.** The HUD, tactical map, progression panels and capture panel are plain DOM, fed by the strategic snapshots.

## Travel between worlds

A character travels by charging a transit pod. The worker removes the character, and the coordinator moves it to the destination planet in one transaction, with its cargo. The browser then reconnects to the new world automatically.

## Limits

Each world has a single authority (one worker), with up to 64 human players and bots filling the population up to 192. Splitting a world into regions run by several workers is only groundwork so far (`region-transfers.ts`, `runtime-handoff.ts`). Nothing here is evidence of capacity for very large player counts.
