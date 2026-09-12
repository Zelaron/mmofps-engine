# Performance

## Roads and background scenery — 2026-09-12

Terrain meshes now retain their underlying biome material beneath roads. The world-space road shader draws the gravel and a continuous, softly blended shoulder. Previously, a road triangle in volcanic terrain could receive the snow-colored fallback palette, exposing white teeth outside the road shader's coverage. Both heightfield previews and final terrain meshes use the corrected palette. Gameplay still classifies the same surface as a road for footsteps; collision and movement are unchanged.

Vegetation, structure and rock queries now run in `scenery.worker.js`. The client keeps one query in flight and at most one latest request per scenery pool, ignores obsolete replies, and retains existing instances while replacements arrive. Worker creation failure, errors or a 15-second unanswered query switch the renderers to synchronous generation. Admission/reconnection disposes the previous worker and creates one for the welcomed planet's seed. The shared sampling path retains the same placement, colors, foundations and bounded caches.

Session acquisition overlaps initial CPU/GPU setup. Terrain dispatch covers the nearby landscape, then refines the nine columns around the player before processing hundreds of distant previews. Underground enclosure and flight's reserved coverage worker remain covered by the existing tests.

`artifacts/roads-final-comparison.json` records two alternating runs per version and device, using a fresh Chromium process, fixed high quality, one saved isolated character and the same running three-world gateway. The baseline is `artifacts/roads-startup-before/client`; current assets come from `packages/client/dist`. Both use real loopback HTTP fixtures. CPU profiling and other project tests/builds were stopped; OS/GPU caches were not cleared. Bundle hashes and the character, seed and horizontal position match their expected versions across all eight captures.

| Workstation browser | Previous first presentation | Current first presentation | Reduction | Previous first nearby detail | Current first nearby detail |
| --- | ---: | ---: | ---: | ---: | ---: |
| Desktop, 1440 × 900 | 3.046 s | 2.653 s | 12.9% | 6.060 s | 2.146 s |
| Touch emulation, 844 × 390 | 2.792 s | 2.334 s | 16.4% | 4.149 s | 2.080 s |

First presentation ends two animation frames after the initialized world has been drawn. Nearby detail is the first installed LOD0 tile, not completion of terrain streaming. The mean longest recorded main-thread task fell from 570 to 428 ms on desktop and 528 to 476 ms in touch emulation. All eight captures have no browser errors. These are small local samples; network latency, physical-phone performance and population capacity are not measured. The additional worker increases complete client assets from about 472 to **511 KiB Brotli**, which can offset part of the CPU improvement on a slow connection.

Final verification:

- `artifacts/roads-resume-tests.log`: **746/746 tests pass**, zero failures/skips/cancellations, in 228.85 seconds. Typecheck and production build pass (`roads-resume-typecheck.log`, `roads-final-build.log`).
- `npm run test:scenery:browser`: real road and forest travel in desktop high quality, touch high quality, desktop low quality and unavailable-worker scenarios. Worker and fallback scenery match synchronous world generation. Terminating the real touch scenery worker retains existing cover until its watchdog switches to the fallback, verified after 15.79 seconds; reload creates a healthy replacement. All four cases have no browser errors. Evidence is `artifacts/scenery-final.json` and its road PNGs; `scenery-before-desktop-high-road.png` shows the original white fringe at the same camera position. These screenshots were visually inspected.
- `artifacts/roads-final-browser.json`: automatic entry, desktop movement/jump/fire/reload, faction persistence, simultaneous touch movement/fire and portrait sizing pass with no browser errors. Desktop entry took 2.604 seconds in this separate gameplay check.
- `artifacts/roads-final-verification.json`: all four served client/worker bundles match the production build; original `movement.ts` and `physics.ts` match the preserved engine; all three worlds are available. The restored loopback preview uses the existing saves at **http://127.0.0.1:8081**. `artifacts/roads-resume-universe-2026-09-12T14-51-51Z.sqlite` is a checked consistent backup from before startup.

To recapture the visual baseline, set `SCENERY_CLIENT_DIR=artifacts/roads-startup-before/client` and run `node --experimental-sqlite --import tsx scripts/scenery-browser-check.ts --baseline --label=before`. The fixture owns an in-memory world and does not change user saves. The earlier interrupted `roads-paired-*` series is retained as historical evidence; the complete `roads-final-*` series above is the reported comparison.

Protocol remains 25 and the resource/camp checkpoint remains intact. Geographic handoffs, distributed capacity, broader gameplay and final art quality remain separate unfinished objectives.

## Earlier shader startup and graphics recovery

Initial shader programs are now submitted together in the same HDR/direct render-target contexts used by the actual frame. When `KHR_parallel_shader_compile` is available, later animation frames poll all linked program variants before the first world draw. The client continues receiving state and building scenery while compilation is pending. Devices without the extension use synchronous preparation. The material shaders, shadow settings, world size and movement are unchanged.

`artifacts/startup-paired-comparison.json` compares two local runs per device and version. Each device used the same saved test character at the same surface position, fixed `quality=high`, a fresh browser process, and the same running gateway. Order was before/after, then after/before. CPU profiling was disabled and other project workloads were quiet. OS and driver caches were not cleared. Timing ends two animation frames after an initialized world has been drawn; screenshots occur afterward.

| Workstation browser | Previous mean first draw | Prepared mean first draw | Reduction | Longest main-thread task, mean before/after |
| --- | ---: | ---: | ---: | ---: |
| Desktop, 1440 x 900 | 6.406 s | 3.866 s | 39.7% | 2.668 / 1.118 s |
| Touch emulation, 844 x 390 | 5.221 s | 3.751 s | 28.2% | 2.158 / 1.140 s |

All eight captures have no browser errors. Terrain detail and distant scenery continue streaming after this timestamp. The comparison archives are `artifacts/startup-before-client` and `artifacts/startup-shader-first-client`; their hashes are verified in the report. These captures precede the subsequent context-loss recovery fix. They are small local samples, not network latency, physical-phone performance, or population-capacity measurements. Entry still takes several seconds.

The real-SceneMgr GPU fixture exposed an existing recovery defect: generated sky reflections vanished after a WebGL context loss. The client now releases that target during loss, regenerates its pixels after restoration, and prepares the restored programs before presenting the world. `npm run test:shaders:browser` checks high quality, low/direct rendering, and an unavailable parallel-compilation extension. Ordinary and instanced objects share a physical material, exercising multiple variants. First draw, reseeding, admission transitions and restoration must preserve the framebuffer checksum; lost contexts cannot report a presented world. The passing evidence is `artifacts/shader-preparation-browser-check.json` with paired PNGs and no GL/browser errors.

Final validation: 726/726 tests pass in 246.43 seconds, with typecheck/build passing at 470 KiB Brotli. Desktop and touch gameplay checks pass with no errors (`artifacts/startup-final-browser.json`); default-quality desktop entry took 4.125 seconds. Single final-build high-quality captures measured 3.763/4.064 seconds on desktop/touch respectively (`startup-final-desktop.json`, `startup-final-touch.json`). The served client and source-map contents match this build; the server and original movement/physics hashes are unchanged. `artifacts/startup-final-verification.json` records all three workers ready at their existing epochs with zero final tick debt. No server restart or population benchmark was performed in this checkpoint.

Capture startup with the loopback preview running:

```sh
npm run profile:startup
node scripts/profile-startup.mjs --no-cpu --label startup-desktop
node scripts/profile-startup.mjs --no-cpu --mobile --label startup-touch
```

Set `GAME_URL=http://127.0.0.1:8081/?quality=high` for fixed quality. `--client-dir` serves an archived build through a real loopback HTTP fixture, forwarding its local API/socket traffic to that gateway. This avoids Chromium's local-network blocking of synthetically intercepted documents. `--storage-state <path>` retains an isolated test character and preferences across changing fixture ports; the resulting file contains authentication cookies and must remain private. The profiler records resource timings, main-thread CPU samples mapped through the exact bundle source map, long tasks, state, and first/settled screenshots. It never records WebSocket payloads or headers.

The diagnostic CPU captures point to `generateTeleporters(world)` inside `onWelcome` as substantial remaining cold main-thread work, particularly its cave-floor and surface searches. `RoadField` construction itself is cheap; road queries made by those searches and subsequent scenery updates are costly. Moving base-pad generation requires preserving deterministic static-world queries, reconnect fencing and the current base-pad fallback if the encounter worker fails. No such move is included in this checkpoint.

## Simulation profiling

The current bottleneck investigation uses the actual `Game`, shared world field, movement, weapons, vehicles and bot controllers. It is a local CPU workload, not a network or player-capacity test.

Run the default Cinder fixture:

```sh
npm run profile:simulation
```

Choose a planet and retain a separately named capture with the portable direct launcher:

```sh
node scripts/profile-simulation.mjs --seed 7331 --bots 15 --warmup 1200 --ticks 1800 --label cinder-before
```

Seeds are Meridian `1337`, Cinder `7331`, and Nacre `20077`. The launcher bundles the fixture with the server's Node target before executing it. Running the TypeScript file through `tsx` also measures development-only function-name wrappers and gives different timings.

Each run saves these files under `artifacts/`:

- `<label>.runner.mjs` and its source map: the bundled code used for that capture. Retain this bundle to rerun a baseline after editing the source.
- `<label>.cpuprofile`: a standard Node/V8 CPU profile.
- `<label>.json`: tick quantiles, CPU and elapsed time, stage costs, entity counts, combat counters and a state hash.
- `<label>-state.json`: player movement/health/ammunition, vehicles, projectiles and territory state used for that hash.

The fixture uses an isolated entity allocation pool and never connects to a server or writes character saves. It advances a fixed number of simulation ticks. For repeatability it disables the encounter generator's elapsed-time early exit while retaining its eight-candidate upper bound. Otherwise, faster machines can discover a district on a different tick and allocate later vehicle IDs in a different order. The production generator retains its time budget.

Compare equivalent captures with the same seed, population, warmup and measured ticks. Run them sequentially with other heavy workloads paused. Inspect state hashes and combat results as well as timings. A change to generation or gameplay can legitimately change the hash; investigate that difference before treating a faster workload as an optimization.

## Engineered city floors

The shared world field can evaluate fully graded city terrain as its exact authored plane. It uses that path only inside the district boundary, above the deep-cave threshold, and outside transport grading and procedural cave approaches. The Vesper abyss, wilderness and transition shoulders retain their complete terrain columns. Structures, cuts, vegetation, camps and moving transport are evaluated on every query.

Fully graded heights are assigned directly. Interpolating from a natural hill with weight one previously retained rounding differences on the order of `1e-14` metres. Direct assignment makes the canonical column and plane shortcut agree exactly. No terrain coordinates are quantized. Movement and physics code remain unchanged.

This optimization reduces repeated noise and road queries during city movement and visibility checks. The regression tests compare the shortcut with the complete field at ordinary city and capital borders, stations, cave approaches, abyss floors and multiple probe heights. They also check deep-rock fallback and immediate camp addition/removal.

## Local comparison

The following paired captures use 1,200 warmup ticks and 1,800 measured ticks, with 15 bots on each planet. The three preview worlds were paused during measurement. Times are milliseconds per simulation tick.

| Planet | Mean before | Mean after | p95 before | p95 after | Mean reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Meridian | 8.17 | 4.56 | 13.25 | 6.18 | 44% |
| Cinder | 11.39 | 6.45 | 18.41 | 9.06 | 43% |
| Nacre | 6.76 | 4.86 | 10.10 | 6.39 | 28% |

Every pair had identical saved fixture state and combat counters, checked with both SHA-256 and a full structural comparison. A second Cinder measurement also showed a substantial reduction. The source data and capture labels are in `artifacts/city-floor-comparison.json`; these are workstation observations, not promised service limits.

## Packed static collision bounds

The building collision hierarchy stores its leaf geometry in one `Float64Array`, six original doubles per solid. Query traversal reads this consistent layout and rejects individual leaf boxes with conservative signed axis bounds before evaluating the exact distance primitive. Tree structure, world geometry and the movement/physics algorithms are retained. The geometry storage costs 48 bytes per indexed box; its lifetime follows the existing weak cache of immutable regional solid arrays. No query allocates another buffer.

The new face/corner/penetration test also found a pre-existing hierarchy rounding error at fractional coordinates about eight kilometres from the origin. The unchanged implementation returned `3.6426145041463583e-13` metres where the direct box union returned `2.575717417130363e-13`. Both were extremely close to the surface, but the acceleration structure should not discard the better result. Hierarchy half-extents now include a floating-point allowance proportional to their coordinate magnitude. Only the search bounds expand; the packed geometry retains its original doubles. `artifacts/box-packed-rounding-witness.json` records the old result and the exact primitive result. The precision test includes empty geometry, overlapping thin floors/walls, positive and negative limits, and face/corner probes at both positive and negative world coordinates.

Final-source comparisons use the same 1,200-tick warmup, 1,800 measured ticks and 15 bots as the city-floor fixture. Preview worlds were paused during each sequential measurement. Times are milliseconds per simulation tick:

| Planet | Mean before | Mean after | p95 before | p95 after | Mean reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Meridian | 4.64 | 3.77 | 6.43 | 5.41 | 19% |
| Cinder | 6.11 | 4.77 | 8.14 | 6.74 | 22% |
| Nacre | 5.03 | 4.05 | 6.87 | 5.67 | 19% |

Every pair had identical full saved fixture state and combat counters, checked structurally and by SHA-256. `artifacts/box-packed-final-comparison.json` identifies all final captures, including the search-bound rounding correction. The original `box-leaf-before-cinder.runner.mjs` was reused with each planet's seed for the baselines. Earlier packed captures in `box-packed-comparison.json` predate the rounding correction and are not final-source timings. These measurements demonstrate lower cost in these local fixtures; they do not establish live battle or network capacity.

The first shared-helper leaf filter was discarded after increasing Cinder's mean cost from 6.11 to 10.61 ms per tick despite identical simulation state. An intermediate inline filter measured 5.74 ms. Those historical captures are `box-leaf-after-cinder` and `box-leaf-inline-cinder`; neither is the final packed implementation.

The repeated packed Cinder fixture measured 5.90/4.32 ms per tick before/after with identical full state and combat counters. In those runs, forced garbage collection occurred only after all timing and CPU sampling ended. Retained JavaScript heap was about 44.65/44.15 MiB and ArrayBuffer storage about 0.024/1.378 MiB. Their combined measured increase was about 0.86 MiB. RSS fluctuated and does not establish a lower total memory requirement. This memory capture preceded the search-bound rounding allowance, which adds no new storage. Retained runners and results are in `artifacts/box-packed-memory-comparison.json` and the associated memory reports.

### Live observation with packed collision bounds

The final preview was monitored for six minutes, overlapping desktop/touch checks and the full 723-test regression run. The first roughly 40 seconds preceded the regression workload. All 358 samples per worker were ready, with unchanged Meridian/Cinder/Nacre epochs 25/39/20 and no restart events. Host CPU reached 100%. Peak sampled debt was 4/1/9 ticks respectively, with sampled p95 of one tick on each world. Per-callback counters recorded peaks of 7/6/9 ticks, at most 150 ms of backlog. Final health was ready with 0–1 ticks of debt. See `artifacts/box-packed-soak.json`, `box-packed-soak-samples.json` and `box-packed-verification.json`.

This run had substantially less backlog than the earlier catch-up observation, but it was not a controlled replay of the same host load and bot state. It does not prove that all overload causes are resolved, establish a battle population limit or measure physical-phone performance. Browser checks passed, with automatic entry taking 8.16 seconds under concurrent regression load; startup remains too slow for the intended immediate-entry experience. The production client is 470 KiB Brotli. The full suite passed 723/723 in 267.67 seconds, and final typecheck/build pass. Source maps verify that both running build artifacts contain the current collision source, and original movement/physics hashes remain unchanged.

## Mixed-load observation

The rebuilt preview was also sampled once a second for 180 samples while the browser check and part of the regression suite ran. All three workers remained available with unchanged authority epochs, but Meridian accumulated up to 133 ticks of debt and Nacre 137 ticks (about 2.3 seconds). Their sampled p95 debt was 105 and 112 ticks; these were sustained catch-up periods, not just isolated bad samples. Cinder's maximum was 15 ticks and p95 was two ticks.

The workers recovered without replacement. The final health capture showed 0–1 ticks of debt. The cause of the mixed-load stalls remains unresolved: the offline city fixture is useful evidence of a specific improvement, but does not reproduce every production workload. Full samples are in `artifacts/city-floor-soak.json` and the final check in `artifacts/city-floor-final-health.json`.

## Coordinated catch-up scheduling

Workers now use `setImmediate` between overdue, productive simulation batches. Each batch still yields after four ticks or eight milliseconds, and every owed physics tick is consumed in order. A caught-up worker sleeps only until the next shared tick deadline; a paused authority uses a timer so missing coordinator or camp state cannot cause an immediate loop. The five-second overload ceiling and lease fencing are unchanged.

The timer investigation found that a requested 1 ms catch-up timer could consume much of a frame on this Windows host. In a synthetic eight-second probe with 9 ms of work per tick and an initial 120-tick backlog, the old timer strategy ended 94 ticks behind. Immediate yields recovered the backlog in 2.43 seconds and ended one tick behind. Median catch-up wait fell from 6.80 ms to 0.090 ms. This probe isolates scheduling behavior; it does not represent a player population. Raw results are in `artifacts/catchup-timer-probe.json`.

The real Cinder worker was then profiled in an isolated in-memory universe with 15 bots. Both sequential 60-second runs used a two-second warmup, a controlled 1,200 ms host pause, and an 11 ms minimum `Game.step` cost. The cost floor is diagnostic busy work; actual bot thinking is additional work. The first sampled backlog of at most two ticks occurred after 10.85 seconds with the old scheduler and 6.98 seconds with the new scheduler. Both preserved every tick and recovered without failure. Actual mean `Game.step` cost was 6.02/5.92 ms before/after, while total process CPU was 47.75/48.55 seconds. The preview was paused; some typecheck/test work ran late in the second capture, so this is not a tightly isolated CPU benchmark. See `artifacts/catchup-cinder-comparison.json` and the retained `catchup-{before,after}-cinder` runners, profiles and health samples.

The reusable real-time fixture runs the production encounter time budget, scheduler, bots, physics and coordinator heartbeats:

```sh
node scripts/profile-realtime.mjs --seed 7331 --bots 15 --warmup 10 --seconds 90 --label cinder-realtime
```

`npm run profile:realtime` runs its defaults. Optional `--pause-ms` (0–2,000) and `--step-floor-ms` (0–15) introduce bounded diagnostic stress; neither is a production setting. The profiler writes a retained runner, CPU profile, health samples and timing report under `artifacts/`. It uses no character saves or live workers. Unlike the fixed-tick fixture, elapsed-time encounter slicing and scheduler timing mean equivalent runs need not create identical entity states.

Private worker `/healthz` responses now include cumulative simulation batch/tick work, process CPU, peak clock debt, timer overshoot and immediate-yield delay. Counters reset with a worker replacement; interpret them alongside its authority epoch. An immediate-yield delay includes any host pause, including the deliberately injected pause in the diagnostic fixture. Worker overload and cluster restart messages include timestamps, and overload messages retain a timing snapshot. These measurements help distinguish simulation work from time waiting to resume; they do not independently attribute a stall to a particular host process.

For a finite, read-only monitor of the local running universe:

```sh
node --experimental-sqlite scripts/universe-soak.mjs 360 catchup-soak
```

It follows local worker URLs and epochs from the directory, samples health and aggregate host CPU once a second, and writes raw samples periodically plus a final report. An unavailable/replaced worker remains visible in the evidence instead of being hidden by a final healthy response.

### Three-world observation after the scheduling change

The six-minute monitor produced 358 samples per world. It overlapped the desktop/touch browser check, type checking and part of the full regression suite; its earlier samples were relatively quiet. Aggregate host CPU reached 100%. Every health sample was ready, with no epoch changes or worker replacements:

| Planet | Authority epoch | Peak sampled debt (ticks) | p95 sampled debt (ticks) |
| --- | ---: | ---: | ---: |
| Meridian | 23 | 163 | 11 |
| Cinder | 37 | 67 | 2 |
| Nacre | 18 | 41 | 2 |

The workers' per-callback counters recorded somewhat higher peaks of 167/70/44 ticks respectively. The once-a-second monitor can miss short peaks. Meridian's backlog was therefore still about 2.8 seconds at worst, which is noticeable simulation lag. `artifacts/catchup-soak.json` and `catchup-soak-samples.json` retain both forms of measurement. The end-of-suite check (`catchup-verification.json`) found the same epochs and zero debt on all three workers. The preview log contains no overload/restart event in this run.

This supports the scheduling fix but does not establish that the six earlier overload episodes are all resolved. Host saturation, collision-query costs and workload distribution still need investigation. Both paired Cinder captures recovered even with the old scheduler, so they did not reproduce the earlier failure. No bot population, world extent, physics behavior or overload threshold was reduced for this change.

## Limits

These fixtures have 15 AI players, no connected browsers, and no live persistence or network traffic. They do not exercise regional browser handoffs, a distributed coordinator, a popular battle with many humans, or a physical phone. Hundreds of thousands of players still require geographic orchestration and realistic distributed load and failure tests. A lower average tick cost alone does not establish that capacity or sustained real-time stability.


### Follow-up during native foliage work

`artifacts/regional-camps-preview.log` records six worker overload/restart episodes after the previously verified 20/33/16 epochs: Meridian twice, Cinder three times and Nacre once. Each worker exceeded the five-second catch-up ceiling at 301–303 ticks of debt. `artifacts/flora-preview-health.json` later shows all worlds ready at epochs 22/36/17 with 1–2 ticks of debt. The log has no per-event timestamps; browser fixtures, builds and regression tests were run during this interval, so the exact trigger is not isolated. No server code changed in this pass. This unresolved live simulation problem needs profiling with bot/encounter state and host-load measurements. Neither recovery nor the earlier isolated city-floor benchmark demonstrates sustained capacity.

The final native foliage browser fixture (`artifacts/flora-final.json`) records six desktop/touch-emulated views with no browser errors and p95 RAF intervals of 16.7–16.8 ms. Geometry/vein textures are generated locally and the compressed client remains 469 KiB. These short workstation samples are limited by vsync. Streaming and wildlife change draw/triangle counts between captures; they are not a controlled GPU speedup measurement, physical-phone test or server capacity result.
