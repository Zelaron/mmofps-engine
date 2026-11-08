# THE MMOFPS

A browser first-person shooter set in one large, persistent world at war, playable now at **[mmofps.com](https://mmofps.com)**. Three factions (the Terran Accord, the Helix Combine and the Vanguard Pact) fight over cities, harbors and forward bases with infantry, vehicles, boats and fighter jets, while bots fill each world with up to 192 soldiers. Designed to be playable within seconds, with as few clicks as possible. The site runs this repository's `main` branch and redeploys automatically every Monday at 08:00 UTC.

## Quick start

Requires Node.js 22.11 or newer.

```sh
git clone https://github.com/Zelaron/mmofps-engine.git
cd mmofps-engine
npm ci
npm run build
npm start
```

Then open http://localhost:8080.

| Command | What it does |
|---|---|
| `npm start` | Runs the server with the Meridian world |
| `npm run dev` | Rebuilds client and server as you edit |
| `PLANETS=all npm start` | Also runs the Cinder and Nacre worlds |
| `BOTS=96 npm start` | Changes the population cap per world (default 192) |

Characters are tied to an anonymous browser cookie and saved in `data/`. Hosting, Docker and configuration: [DEPLOY.md](DEPLOY.md).

## How to play

| Key | Action |
|---|---|
| WASD, mouse | Move and aim |
| Space / double-tap a direction | Jump / dodge |
| Left mouse, R | Shoot, reload |
| 1-9, 0, mouse wheel | Choose a weapon |
| E | Enter a vehicle or join its crew |
| G | Tactical map: respawn point, DEPLOY NOW, fighter jet |
| Hold Q | DEPLOY NOW toward your squad's order |
| M / O | Minimap / star chart |
| B / hold F | Build a field camp / gather salvage |
| Tab, T | Scores, chat |

Phones get on-screen controls automatically.

**The war.** Each faction starts with a home city, a harbor and a forward base; the rest of the map is up for grabs. Every base has three capture points, and holding two of them makes it yours. Stand in a capture ring to take it, and outnumber the enemy to keep the capture going. A faction wins by holding 8 of the 12 bases, or the most bases when 2 hours run out. If no base changes hands for 15 minutes, a 3-minute final push decides it sooner. Then a new war starts with the home regions rotated.

**Getting to the fight.** You spawn at your faction's busiest operation, and the order panel shows where to go. Out of combat, hold **Q** (or use **G → DEPLOY NOW**) to go straight to the front, and **G → FIGHTER JET** puts you in a jet on a runway, ready to take off.

**Progression.** XP for kills, captures, vehicles and wars, 60 ranks, three daily orders and a debrief after each war, all saved with your character.

The full rules are in the [gameplay reference](docs/GAMEPLAY.md).

## The world

- Meridian: an island of bays and headlands, with three small offshore islands, in a 22.5 km sea: four cities, wilderness, caves, rail lines, ferries, runways and harbors. Cinder and Nacre are two more worlds, with their own terrain, cities and creatures.
- Ten infantry weapons, plus jeeps, tanks, fighter jets, bombers, gunboats and destroyers.
- Wildlife and undead, plus bosses that drop a shared Nuke Launcher when killed.
- Field camps: shelters, medical stations and ammo fabricators, paid for with salvage.
- Every model and texture is generated in code. The build downloads only two fonts.

## Development

| Path | Contents |
|---|---|
| `packages/client` | Browser client (Three.js, WebGL2) |
| `packages/server` | Authoritative 60 Hz server, bots and the war campaign |
| `packages/shared` | World generation, movement, physics and the network protocol |
| `scripts` | Build, test and diagnostic tools |

| Command | Purpose |
|---|---|
| `npm run check` | Typecheck and run the unit tests |
| `npm run test:war -- --seconds=7200` | Simulate a 2-hour war headlessly and report how much the front moves |
| `npm run test:play:browser` | A scripted player session in a real browser |
| `npm run test:<name>:browser` | Browser checks; run `npx playwright install chromium` first |

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the client, server and worlds fit together.

## Contributing

Pull requests are welcome. Whatever is on `main` goes live on [mmofps.com](https://mmofps.com) every Monday at 08:00 UTC, once it builds and the tests pass.

## Status

Playable and under active development. Each world runs on one server process with up to 64 human players, and bots fill the rest. The long-term goal, splitting a world across many servers for very large player counts, isn't built yet.
