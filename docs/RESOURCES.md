# Renewable xenolite

Approach a glowing seam on foot, leave combat, and hold **F** or **HOLD TO EXTRACT** on touch for three seconds. A complete extraction awards **12 salvage**. The shared deposit becomes a short, dull cluster and regrows after **180 seconds** of persistent planetary time. Salvage can fund field camps repeatedly.

Movement commands, firing, interaction, damage, boarding, release, blocked line of sight or leaving reach cancel partial extraction. Small passive ground corrections are tolerated. Held-input updates expire after 850 ms. The UI shows progress, saving, synchronization, combat restrictions and regrowth time, with separate landscape and portrait touch placement.

## Placement and rendering

Each 128 m cell has one deterministic candidate per planet seed. Workers resolve candidates around connected humans. Surface rays, surface normals, surrounding slopes, liquids and solid-space checks exclude unsupported, submerged, steep and obstructed sites. At most nine deposits are sent per observer, with a 1,024-cell geometry cache. Movement and physics source is unchanged.

Two shared geometries and three instanced meshes render dark host rock, growing crystals and depleted stubs. A complete nearby field needs at most three draw calls. These nonblocking props are generated locally, without downloaded models or textures.

## Persistence

Gathering uses the default universe launcher. Legacy standalone mode has no resource service. Protocol **25** adds the hold message and bounded resource snapshots while retaining the authoritative teleporter bootstrap from protocol 24. Clients, workers and coordinator must update together.

One coordinator transaction commits the depletion deadline, receipt, cumulative salvage credit and character checkpoint. `salvage_earnings` complements the spending ledger. Saved characters and regional handoffs retain both watermarks, so delayed checkpoints and spending cannot overwrite or duplicate completed credits. Old characters start with zero previously accounted extraction credits.

Depletion is shared per planet and persists through restart. Different planets have independent cycles. Extraction requires current character/world ownership and the resource's geographic owner. Neighbor views are readable within a bounded margin; cross-boundary mutations wait for future regional routing.

Retries retain the receipt ID and observed growth-cycle deadline. Competing extractions cannot both win, and expired receipts cannot replay an older cycle. A lost response is retried; an unresolved commit reconnects the character to its saved balance. Delayed views cannot reverse local depletion. A view older than five seconds disables extraction while other world activity continues.

## Verification and continuation

`npm run test:resources:browser` runs an isolated universe with fresh zero-salvage characters. Actual desktop and touch controls cancel a partial hold, complete two extractions, preserve depletion after reload, and spend 20 of the earned 24 salvage on a shelter. Desktop also loses a successful commit response and replaces its world worker under a fresh identity. Touch includes a 393 px portrait hit-target check. Both pass without browser errors in `artifacts/resources-browser.json`; the `resources-` ready/extracting/depleted/camp screenshots were visually inspected.

Tests cover placement/cache limits, wire validation, model budgets/disposal, renewal, competing claimants, expired receipts, ownership, delayed credits/spending, coordinator restart, planetary travel, stale input/views and cancellation. Results are in `artifacts/resources-full-tests.log`, `artifacts/resources-typecheck.log` and `artifacts/resources-build.log`.

Final regression: **740/740 tests pass**, zero failures/skips/cancellations, in 240.56 seconds. Typecheck passes. The build reports 472 KiB Brotli for all client assets. The original movement and physics SHA-256 hashes match `artifacts/resources-movement-baseline.json`.

The consistent pre-upgrade save backup is `artifacts/universe-before-resources-1789219339795.sqlite`. Earlier source is retained under `artifacts/resources-before-source/`.

The final preview runs at http://127.0.0.1:8081 with all three planets available. `artifacts/resources-save-migration.json` confirms SQLite integrity and retention of all 39 pre-upgrade character identities. The final ordinary gameplay check passes running, jumping, firing, reloading, faction persistence, simultaneous touch movement/fire and portrait sizing without browser errors (`artifacts/resources-game-browser.json`). Preview output is `artifacts/resources-final-preview.log`.

This completes a renewable gathering loop. Crafting, trading, richer survival/logistics, distinct resource types and distant resource markers remain future work. Broader art, regional orchestration and measured distributed capacity are still unfinished. Touch tests are workstation emulation, not physical-phone profiling.
