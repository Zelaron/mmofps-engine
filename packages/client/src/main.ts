import * as THREE from 'three';
import { CampsUI } from './camps.js';
import { OutpostRenderer } from './render/outposts.js';
import { encodeOutpostAction } from '@shared/outpost-wire';
import { encodeHarvest } from '@shared/resource-wire';
import type { ResourceSnapshot } from '@shared/resources';
import { ResourceModels } from './render/resources.js';
import { ResourcesUI } from './resources.js';
import { FrontierUI } from './frontier.js';
import { OrbitalUI } from './orbital.js';
import { planetById } from '@shared/universe';
import { FrontierMarkers } from './render/frontier.js';
import {
  World, WEAPONS, PLAYER, NET, TICK_RATE, pelletDir, viewDir, clamp,
  VEHICLE, vehicleDefinition, vehicleArmament, vehicleWeaponColor, isJetBombWeapon, vehicleEyeHeight, weaponDefById, VEHICLE_WEAPON_ID_BASE,
  NUKE_BOMB,
  LOCK_ACQUIRING, LOCK_LOCKED, HOMING_SPEED_FACTOR,
  type VehicleType,
  PICKUP_AMMO, PICKUP_HEALTH, PICKUP_WEAPON, PICKUP_RESULT_COLLECTED,
  caveBiomeAt, isWeaponSelectable,
  vehicleQuaternion,
  aircraftCrewMuzzle, vehicleEyeOffset as sharedVehicleEyeOffset,
  encodeInput, encodeClientChat, ByteWriter, Msg,
  type Snapshot, type WelcomeMsg, type FireEvent, type ScoreRow,
  type TeleportEvent,
} from '@shared/index';
import { NetClient } from './net.js';
import { InputTracker } from './input.js';
import { ChatPanel } from './chat.js';
import { AirliftMap } from './airlift.js';
import { NavigationMap } from './world-map.js';
import { AirliftPodView } from './render/airlift-pod.js';
import { airliftPose } from '@shared/airlift';
import { TouchControls } from './touch-controls.js';
import { SceneryScheduler } from './render/scenery-scheduler.js';
import { SceneryStream } from './render/scenery-stream.js';
import { isTouchDevice } from './render/device-profile.js';
import { Prediction } from './prediction.js';
import { Interp } from './interp.js';
import { SceneMgr } from './render/scene.js';
import { ChunkManager } from './render/chunks.js';
import { PlayerModels } from './render/players.js';
import { Effects } from './render/effects.js';
import { PickupModels } from './render/pickups.js';
import { VehicleModels, buildVehicleHull, buildCrewWeapon, trainArtilleryModel, aimVehicleWeapon, vehicleMuzzlePosition, flashVehicleWeapon, vehicleAttitude, updateVehicleHull, disposeVehicleHull } from './render/vehicles.js';
import { VegetationRenderer } from './render/vegetation.js';
import { StructureRenderer } from './render/structures.js';
import { GroundCoverRenderer } from './render/ground-cover.js';
import { RockRenderer } from './render/rocks.js';
import { CaveDetails } from './render/cave-details.js';
import { TeleporterRenderer } from './render/teleporters.js';
import { EncounterStream } from './render/encounter-stream.js';
import { WildlifeModels } from './render/wildlife.js';
import { CaveLandmarkRenderer } from './render/cave-landmarks.js';
import { CityLiftRenderer } from './render/city-lifts.js';
import { VesperCity } from './render/vesper-city.js';
import { AureliaCity } from './render/aurelia-city.js';
import { CityLife } from './render/city-life.js';
import { JungleTempleRenderer } from './render/jungle-temples.js';
import { LiquidRenderer } from './render/liquids.js';
import { TransportRenderer } from './render/transport.js';
import { ViewModel } from './render/viewmodel.js';
import { Hud, escapeHtml } from './hud.js';
import { AudioFX } from './audio.js';
import { VehicleShotQueue } from './vehicle-shot-queue.js';
import { ArtilleryFeedback } from './artillery-feedback.js';
import { nearestMovingLift } from './city-lift-audio.js';

// Drop-in play: connect immediately, no menus. Everything spins up once the
// server's Welcome (world seed + player id) arrives.

const canvas = document.getElementById('c') as HTMLCanvasElement;
// Establish the session while CPU/GPU resources initialize. Keep a handled
// result so a slow or unavailable gateway cannot cause an unhandled rejection.
const requestSession = () => fetch('/api/session', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) })
  .then(response => response.ok, () => false);
let initialSession: Promise<boolean> | null = requestSession();
const hud = new Hud();
const audio = new AudioFX();
const input = new InputTracker(canvas);
input.weapon = 1;
document.addEventListener('pointerdown', () => audio.unlock(), { once: true });
let frontier: FrontierUI | null = null;
let camps: CampsUI | null = null;
let resourcesUI: ResourcesUI | null = null;
let resourceState: ResourceSnapshot | null = null;
let orbital: OrbitalUI | null = null;
let chat: ChatPanel | null = null;
let airlift: AirliftMap | null = null;
let airliftTouchWasActive = false;
let chatTouchWasActive = false;
const sceneMgr = new SceneMgr(canvas);
const navigationMap = new NavigationMap();
const frontierMarkers = new FrontierMarkers();
sceneMgr.scene.add(frontierMarkers.group);
const campModels = new OutpostRenderer(); sceneMgr.scene.add(campModels.group);
const resourceModels = new ResourceModels(); sceneMgr.scene.add(resourceModels.group);
const airliftPod = new AirliftPodView(sceneMgr.camera);
input.onToggleMap = () => navigationMap.toggle();
const effects = new Effects();
const pickupModels = new PickupModels();
const vehicleModels = new VehicleModels();
const playerModels = new PlayerModels();
const wildlifeModels = new WildlifeModels();
const viewModel = new ViewModel(sceneMgr.camera);
sceneMgr.scene.add(effects.group);
sceneMgr.scene.add(pickupModels.group);
sceneMgr.scene.add(vehicleModels.group);
sceneMgr.scene.add(playerModels.group);
sceneMgr.scene.add(wildlifeModels.group);

// -- identity ---------------------------------------------------------------
let lockState = 0;
let vehicleHealth = 0;
let localHull: THREE.Group | null = null;
let localHullType = 0;
let localHullVariant = 0;
let localHullSeat = 0;
let localCrew: THREE.Group | null = null;
let localCrewKey = '';
let localSeat = 0;

/** One-shot control hint per vehicle entry (steering differs per type). */
const CONTROL_HINTS: Record<number, string> = {
  [VEHICLE.JEEP]: 'Jeep: W/S drive | A/D steer | mouse aims MG | RMB boost',
  [VEHICLE.TANK]: 'Tank: W/S drive | A/D steer | mouse aims turret',
  [VEHICLE.JET]: 'Jet: W/S pitch | A/D roll | Space throttle | C brake | mouse look',
  [VEHICLE.GUNBOAT]: 'Gunboat: W/S throttle | A/D steer | mouse aims cannon | RMB rockets',
};
/** Smoothed cosmetic attitude of the driven hull (radians). */
let localAttPitch = 0;
let localAttRoll = 0;
const vehicleEyeOffset = new THREE.Vector3();
const vehicleEyeRotation = new THREE.Quaternion();
const jetAimPoint = new THREE.Vector3();
const localWeaponMuzzle = new THREE.Vector3();
const pendingVehicleShots = new VehicleShotQueue();
const artilleryFeedback = new ArtilleryFeedback();
const artilleryMarkerPoint = new THREE.Vector3(), artilleryViewDirection = new THREE.Vector3();
let creatureAlerts = new Set<number>();
/** Previous-frame vehicle/boost state for audio cues (enter/exit, engine). */
let lastVehicle: number = VEHICLE.NONE;
let lastVehicleVariant = 0;

/** Previous-frame reload progress, to fire the mid-reload seating cue once. */
let lastReloadProgress = 0;

const params = new URLSearchParams(location.search);
const queryNumber = (name: string, fallback: number): number => {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const cleanCapture = params.get('clean') === '1';
if (cleanCapture) document.getElementById('hud')?.style.setProperty('display', 'none');
const touch = isTouchDevice() && !cleanCapture ? new TouchControls(input, () => {
  if (touch?.active) audio.unlock();
  updateOverlay();
}) : null;

// Debug fly-camera: ?spectate=x,z parks above a spot; ?spectate=x,y,z
// places it at an exact height for inspecting caves. Camera angles are
// radians; spin=0 makes them stable for repeatable screenshots.
const spectateParam = params.get('spectate');
let spectate: {
  x: number;
  z: number;
  y: number;
  yaw: number;
  pitch: number;
  spin: boolean;
  flight?: boolean;
} | null = null;
if (spectateParam) {
  const coords = spectateParam.split(',').map(Number);
  const [sx, syOrZ, sz] = coords;
  const camera = {
    yaw: queryNumber('yaw', 0),
    pitch: clamp(
      queryNumber('pitch', -0.28),
      -Math.PI * 0.5 + 0.01,
      Math.PI * 0.5 - 0.01,
    ),
    spin: params.get('spin') !== '0',
    flight: params.get('flight') === '1',
  };
  if (coords.length === 2 && Number.isFinite(sx) && Number.isFinite(syOrZ)) {
    spectate = { x: sx, z: syOrZ, y: NaN, ...camera };
  } else if (coords.length === 3 &&
             Number.isFinite(sx) && Number.isFinite(syOrZ) && Number.isFinite(sz)) {
    spectate = { x: sx, y: syOrZ, z: sz, ...camera };
  }
}
let myName = params.get('name') ?? localStorage.getItem('mmofps-name') ?? '';
myName = myName.replace(/[^\x20-\x7e]/g, '').trim().slice(0, NET.MAX_NAME_LEN);
if (!myName) myName = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
localStorage.setItem('mmofps-name', myName);

// -- state ------------------------------------------------------------------
let myId = -1;
let world: World | null = null;
let pred: Prediction | null = null;
let chunks: ChunkManager | null = null;
let vegetation: VegetationRenderer | null = null;
let structures: StructureRenderer | null = null;
let groundCover: GroundCoverRenderer | null = null;
let rocks: RockRenderer | null = null;
let caveDetails: CaveDetails | null = null;
let teleporters: TeleporterRenderer | null = null;
let caveLandmarks: CaveLandmarkRenderer | null = null;
let cityLifts: CityLiftRenderer | null = null;
let vesperCity: VesperCity | null = null;
let aureliaCity: AureliaCity | null = null;
let cityLife: CityLife | null = null;
let jungleTemples: JungleTempleRenderer | null = null;
let liquids: LiquidRenderer | null = null;
let transport: TransportRenderer | null = null;
let recallHeldSeconds = 0, recallLastHealth = 100;
const scenery = new SceneryScheduler([
  (x, z) => vegetation?.update(x, z),
  (x, z) => structures?.update(x, z),
  (x, z) => rocks?.update(x, z),
  (x, z) => groundCover?.update(x, z),
]);
let lastStreamX = NaN, lastStreamZ = NaN;
let sceneryStream: SceneryStream | null = null;
const interp = new Interp();
const names = new Map<number, string>();
let scores: ScoreRow[] = [];

let seq = 1;
let predTick = -1;
let tickAccum = 0;
let prevWeapon = 0;
let lastHealth: number = PLAYER.MAX_HEALTH;
let deadSince = -1;
let killerName = '';
let disconnected = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectStopped = false;
let transferring = false;
let fps = 60;
let statTimer = 0;

canvas.addEventListener('click', () => audio.unlock());

function presentWeapon(weapon: number, playSound = true): void {
  if (weapon === prevWeapon) return;
  prevWeapon = weapon;
  viewModel.setWeapon(weapon);
  if (playSound) audio.weaponSwitch();
}

// -- overlay state machine --------------------------------------------------
function updateOverlay(): void {
  if (disconnected) {
    hud.showCenter(reconnectStopped ? 'SESSION CLOSED' : 'RECONNECTING', reconnectStopped ? 'Refresh to rejoin from this tab.' : 'Restoring your place in the world…');
    return;
  }
  if (transferring) { hud.showCenter('IN TRANSIT', 'Your next frontier is waiting…'); return; }
  if (!pred || !pred.initialized) {
    hud.showCenter('THE MMOFPS', 'Entering world…');
    return;
  }
  if (pred && !pred.alive) {
    const t = Math.max(0, PLAYER.RESPAWN_SECONDS - (performance.now() - deadSince) / 1000);
    hud.showCenter(killerName ? `Fragged by ${killerName}` : 'You died', `Respawning in ${t.toFixed(1)}…`);
    return;
  }
  if (chat?.open || airlift?.open) { hud.hideCenter(); return; }
  hud.hideCenter();
}

input.onPointerLockChange = () => updateOverlay();
input.onToggleScores = (show) => {
  hud.setScores(scores, names, myId);
  hud.showScores(show);
};
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') hud.showScores(false);
});
input.onToggleDebug = () => hud.toggleDebug();
input.onHyperToggle = (on) => hud.showAnnounce(on ? 'HYPERSPEED ON (invulnerable)' : 'Hyperspeed off');

// -- weapon name for the kill feed -----------------------------------------
function weaponLabel(w: number): string {
  if (w === 255) return 'world';
  return weaponDefById(w)?.name ?? WEAPONS[w]?.name ?? '?';
}

function nameOf(id: number): string {
  return names.get(id) ?? `#${id}`;
}

// -- fire visuals -----------------------------------------------------------
function muzzleWorldPos(): THREE.Vector3 {
  const cam = sceneMgr.camera;
  const v = new THREE.Vector3(0.25, -0.2, -0.6);
  return cam.localToWorld(v);
}

function showOwnShot(weapon: number, shotSeq: number, yaw: number, pitch: number): void {
  const w = weaponDefById(weapon);
  if (!w) return;
  // The flash itself is camera-attached (inside ViewModel.onFire): a
  // world-space flash outlives the frame and visibly detaches from the
  // barrel whenever the player is moving. Tracers still start from the
  // world-space muzzle - they sweep away instantly, so no artifact.
  viewModel.onFire();
  audio.fire(weapon);
  const m = muzzleWorldPos();
  if (!world || !pred) return;
  const eye = pred.renderPos();
  const ex = eye.x, ey = eye.y + PLAYER.EYE_HEIGHT, ez = eye.z;

  if (w.kind === 'projectile') {
    const d = viewDir(yaw, pitch);
    const speed = (w.speed ?? 48) * (weapon === 3 && lockState === LOCK_LOCKED ? HOMING_SPEED_FACTOR : 1);
    effects.spawnPredictedProjectile(
      weapon,
      ex + d.x * 0.5, ey + d.y * 0.5, ez + d.z * 0.5,
      d.x * speed, d.y * speed, d.z * speed,
    );
    return;
  }
  const color = weapon === 2 ? 0xffc27a : 0xffe0a8;
  for (let i = 0; i < w.pellets; i++) {
    const d = pelletDir(world.seed, myId, shotSeq, i, yaw, pitch, w.spread);
    const th = world.trace(ex, ey, ez, d.x, d.y, d.z, Math.min(w.range, 300));
    const t = th.hit ? th.dist : Math.min(w.range, 300);
    effects.addTracer(m.x, m.y, m.z, ex + d.x * t, ey + d.y * t, ez + d.z * t, color);
    if (th.hit) effects.addImpact(th.x, th.y, th.z);
  }
}

function showRemoteShot(ev: FireEvent): void {
  const cam = sceneMgr.camera;
  const muzzle = playerModels.muzzlePos(ev.shooter) ?? new THREE.Vector3(ev.ox, ev.oy, ev.oz);
  const pos = audio.positional(muzzle.x, muzzle.y, muzzle.z, cam.position.x, cam.position.y, cam.position.z, cam.rotation.y,ev.weapon===213?150:undefined);
  audio.fire(ev.weapon, pos.pan, pos.gain);
  if (isJetBombWeapon(ev.weapon)) return;
  if (!playerModels.flashVehicle(ev.shooter)) effects.addMuzzle(muzzle.x, muzzle.y, muzzle.z);
  if(ev.weapon===213)effects.addArtilleryMuzzle(muzzle.x,muzzle.y,muzzle.z,cam.position);
  const color = ev.weapon >= VEHICLE_WEAPON_ID_BASE ? vehicleWeaponColor(ev.weapon) : ev.weapon === 2 ? 0xffc27a : 0xffd9a0;
  for (const end of ev.ends) {
    if(ev.weapon===207||ev.weapon===209)effects.addBeam(muzzle.x,muzzle.y,muzzle.z,end.x,end.y,end.z,color,ev.weapon===209?1.1:.055);
    else effects.addTracer(muzzle.x, muzzle.y, muzzle.z, end.x, end.y, end.z, color);
    if (end.hitKind === 1) effects.addBlood(end.x, end.y, end.z);
    else if (end.hitKind === 0) effects.addImpact(end.x, end.y, end.z);
  }
}

// -- net --------------------------------------------------------------------
const net = new NetClient({
  onJourney(state) {
    orbital?.receive(state);
    const destination = planetById(state.destination)?.name ?? 'the next world';
    if (state.phase === 'charging' && state.remaining === 5) hud.showAnnounce(`Launching to ${destination} · Hold position`);
    if (state.phase === 'cancelled') { transferring = false; input.setSuspended(!!orbital?.open); hud.showAnnounce(state.message ?? 'Launch cancelled'); updateOverlay(); }
    if (state.phase === 'departing') { transferring = true; input.setSuspended(true); updateOverlay(); }
    if (state.phase === 'committed') { transferring = true; location.reload(); }
  },
  onOutposts(state) { world?.outposts.replace(state.sites); campModels.receive(state.sites); camps?.receive(state); },
  onResources(state) { resourceState = state; resourceModels.receive(state); resourcesUI?.receive(state); },
  onFrontier(state) { camps?.receiveInventory(state); frontier?.receive(state); frontierMarkers.receive(state); playerModels.setFactions(state.nearby); },
  onWelcome(msg: WelcomeMsg): void {
    pendingVehicleShots.clear();
    artilleryFeedback.clear();
    pickupModels.clear();
    interp.clearAll(); names.clear(); scores = []; predTick = -1; tickAccum = 0; seq = 1;
    lastStreamX = NaN; lastStreamZ = NaN; creatureAlerts.clear();
    reconnectAttempt = 0; reconnectStopped = false; transferring = false;
    input.setSuspended(!!frontier?.open || !!orbital?.open || !!camps?.open);
    if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null;
    myId = msg.yourId;
    world = new World(msg.seed);
    sceneryStream?.dispose();
    sceneryStream = new SceneryStream(msg.seed);
    campModels.receive([]); camps?.setWorld(world);
    resourceState = null; resourceModels.clear(); resourcesUI?.clear();
    navigationMap.setWorld(world);
    frontier?.setWorld(world);
    orbital?.setWorld(world);
    disconnected = false;
    sceneMgr.setCities(world.collectCities());
    sceneMgr.setWorldSeed(msg.seed);
    if (cityLifts) { sceneMgr.scene.remove(cityLifts.group); cityLifts.dispose(); }
    cityLifts = new CityLiftRenderer(world);
    sceneMgr.scene.add(cityLifts.group);
    for (const city of [vesperCity, aureliaCity]) if (city) { sceneMgr.scene.remove(city.group); city.dispose(); }
    vesperCity = new VesperCity(world);
    aureliaCity = new AureliaCity(world);
    sceneMgr.scene.add(vesperCity.group, aureliaCity.group);
    for (const detail of [cityLife, jungleTemples]) if (detail) { sceneMgr.scene.remove(detail.group); detail.dispose(); }
    cityLife = new CityLife(world); jungleTemples = new JungleTempleRenderer(world);
    sceneMgr.scene.add(cityLife.group, jungleTemples.group);
    if(liquids){sceneMgr.scene.remove(liquids.group);liquids.dispose();}
    liquids=new LiquidRenderer(world);sceneMgr.scene.add(liquids.group);
    if (transport) { sceneMgr.scene.remove(transport.group); transport.dispose(); }
    transport = new TransportRenderer(world); sceneMgr.scene.add(transport.group);
    vehicleModels.setTransportRoutes(world.collectTransportPlan().routes);
    pred = new Prediction(world);
    if (chunks) {
      sceneMgr.scene.remove(chunks.group);
      chunks.dispose();
    }
    chunks = new ChunkManager(msg.seed);
    sceneMgr.scene.add(chunks.group);
    if (vegetation) {
      sceneMgr.scene.remove(vegetation.group);
      vegetation.dispose();
    }
    vegetation = new VegetationRenderer(world, {}, sceneryStream);
    sceneMgr.scene.add(vegetation.group);
    if (structures) {
      sceneMgr.scene.remove(structures.group);
      structures.dispose();
    }
    structures = new StructureRenderer(world, {}, sceneryStream);
    sceneMgr.scene.add(structures.group);
    if (groundCover) {
      sceneMgr.scene.remove(groundCover.group);
      groundCover.dispose();
    }
    groundCover = new GroundCoverRenderer(world);
    sceneMgr.scene.add(groundCover.group);
    if (rocks) {
      sceneMgr.scene.remove(rocks.group);
      rocks.dispose();
    }
    rocks = new RockRenderer(world, sceneryStream);
    sceneMgr.scene.add(rocks.group);
    if (caveDetails) {
      sceneMgr.scene.remove(caveDetails.group);
      caveDetails.dispose();
    }
    caveDetails = new CaveDetails(world);
    sceneMgr.scene.add(caveDetails.group);
    // The authoritative base network arrives with the welcome. It remains
    // available even if the regional encounter worker cannot start.
    if (caveLandmarks) { sceneMgr.scene.remove(caveLandmarks.group); caveLandmarks.dispose(); }
    if (teleporters) { sceneMgr.scene.remove(teleporters.group); teleporters.dispose(); }
    teleporters = new TeleporterRenderer(new EncounterStream(world.seed, msg.teleporters));
    sceneMgr.scene.add(teleporters.group);
    caveLandmarks = new CaveLandmarkRenderer(teleporters.field);
    sceneMgr.scene.add(caveLandmarks.group);
    names.set(myId, myName);
    updateOverlay();
  },

  onSnapshot(snap: Snapshot): void {
    wildlifeModels.sync(snap.creatures ?? []);
    const nextAlerts = new Set<number>();
    for (const c of snap.creatures ?? []) {
      if (!c.alert || c.dead) continue;
      nextAlerts.add(c.id);
      const dx = c.x - snap.you.px, dz = c.z - snap.you.pz;
      const distance = Math.hypot(dx, dz, c.y - snap.you.py);
      if (!creatureAlerts.has(c.id) && distance < 26) {
        const pan = clamp((dx * Math.cos(input.yaw) - dz * Math.sin(input.yaw)) / Math.max(1, distance), -1, 1);
        audio.creatureAlert(c.species, pan, Math.max(.15, 1 - distance / 30));
      }
    }
    creatureAlerts = nextAlerts;
    if (!pred) return;
    pickupModels.sync(snap.pickups ?? []);
    vehicleModels.update(snap.vehicles);
    lockState = snap.you.lockState;
    vehicleHealth = snap.you.vehicleHealth;
    const wasInit = pred.initialized;
    const wasAlive = pred.alive;
    const resyncVersion = pred.resyncVersion;
    const oldVehicle = pred.state.vehicle, oldVariant = pred.state.vehicleVariant, oldSeat=pred.state.seat??0,oldVehicleId=pred.state.vehicleId;
    const oldFlight = pred.state.airlift;
    pred.onSnapshot(snap);
    if (pred.state.airlift && !oldFlight) {
      const pose=airliftPose(world!.collectTransportPlan(),pred.state.airlift,snap.tick);
      if(pose){input.yaw=pose.heading;input.pitch=-.2;}
    }
    if (oldVehicle !== pred.state.vehicle || oldVariant !== pred.state.vehicleVariant || oldSeat!==(pred.state.seat??0) || oldVehicleId!==pred.state.vehicleId) {
      pendingVehicleShots.clear();
      if (oldVehicle === pred.state.vehicle) input.setVehicleMode(VEHICLE.NONE, 0);
    }
    input.setVehicleMode(pred.state.vehicle, pred.state.heading, pred.state.vehiclePitch,
      pred.state.vehicleRoll, pred.state.vehicleRotation,pred.state.seat??0);
    presentWeapon(pred.weaponState.weapon, wasInit);
    interp.push(snap);
    if ((!wasInit && pred.initialized) || resyncVersion !== pred.resyncVersion) {
      predTick = Math.floor(net.estServerTick() + leadTicks());
      tickAccum = 0;
      updateOverlay();
    }
    // Death/respawn overlay follows the authoritative alive flag.
    if (wasAlive !== pred.alive) updateOverlay();
    if (pred.health < lastHealth - 0.5 && pred.alive) {
      hud.damageFlash();
      audio.hurt();
    }
    lastHealth = pred.health;
  },

  onFire(ev: FireEvent): void {
    if (ev.shooter === myId) {
      if (ev.weapon >= VEHICLE_WEAPON_ID_BASE) {
        // Vehicle armament is fired server-side. Its effects originate at
        // the actual articulated barrel, including when the pilot looks away.
        if (document.hidden || disconnected) return;
        if(ev.weapon!==213)audio.fire(ev.weapon);
        else artilleryFeedback.fired(performance.now()*.001);
        if (isJetBombWeapon(ev.weapon)) return;
        pendingVehicleShots.enqueue(ev);
        return;
      }
      // Already predicted the tracer+audio; just add authoritative impact FX.
      for (const end of ev.ends) {
        if (end.hitKind === 1) effects.addBlood(end.x, end.y, end.z);
      }
      return;
    }
    showRemoteShot(ev);
  },

  onExplosion(ev): void {
    const cam = sceneMgr.camera;
    const ownArtilleryImpact=ev.weapon===213&&artilleryFeedback.impact(ev.projectileId,ev,performance.now()*.001);
    // The event beats projectile retirement in the next snapshot. Remove both
    // interpolation history and rendered/predicted copies in the same frame.
    interp.removeProjectile(ev.projectileId);
    effects.removeProjectile(
      ev.projectileId, ev.weapon,
      ev.x, ev.y, ev.z,
    );
    const radius = weaponDefById(ev.weapon)?.splashRadius ?? 6;
    if (ev.weapon === 207) {
      effects.addLanceExplosion(ev.x,ev.y,ev.z,radius);
    } else if (ev.weapon === 208) {
      effects.addVoidExplosion(ev.x,ev.y,ev.z,cam.position,radius);
      hud.nukeFlash(.65-Math.hypot(ev.x-cam.position.x,ev.y-cam.position.y,ev.z-cam.position.z)/450);
    } else if(ev.weapon===213) {
      effects.addArtilleryExplosion(ev.x,ev.y,ev.z,cam.position,radius);
      const distance=Math.hypot(ev.x-cam.position.x,ev.y-cam.position.y,ev.z-cam.position.z);
      hud.nukeFlash(1.05-distance/650);
      if(ownArtilleryImpact)hud.showAnnounce(`Artillery impact confirmed · ${(distance/1000).toFixed(2)} km`);
    } else if (ev.weapon === NUKE_BOMB.id || ev.weapon === 210) {
      effects.addNukeExplosion(ev.x, ev.y, ev.z, cam.position, radius);
      // Whiteout scales with proximity; beyond ~600m it is just a glow.
      const dist = Math.hypot(ev.x - cam.position.x, ev.y - cam.position.y, ev.z - cam.position.z);
      hud.nukeFlash(1.05 - dist / 600);
    } else {
      effects.addExplosion(ev.x, ev.y, ev.z, cam.position, radius, ev.weapon >= 207 ? vehicleWeaponColor(ev.weapon) : undefined);
    }
    // Bigger blasts are audible from proportionally farther away.
    const p = audio.positional(
      ev.x, ev.y, ev.z,
      cam.position.x, cam.position.y, cam.position.z, cam.rotation.y,
      ev.weapon===213?1000:14 + radius * 2,
    );
    if(ev.weapon===207)audio.lanceImpact(p.pan,p.gain);
    else audio.explosion(p.pan,ownArtilleryImpact?Math.max(.14,p.gain):p.gain,radius,ev.weapon===208);
  },

  onDeath(ev): void {
    const killer = escapeHtml(nameOf(ev.killer));
    const victim = escapeHtml(nameOf(ev.victim));
    if (ev.killer === ev.victim) {
      hud.addFeed(`<span class="v">${victim}</span> <span class="w">died (${weaponLabel(ev.weapon)})</span>`);
    } else {
      hud.addFeed(`<span class="k">${killer}</span> <span class="w">[${weaponLabel(ev.weapon)}]</span> <span class="v">${victim}</span>`);
    }
    if (ev.victim === myId) {
      pendingVehicleShots.clear();
      deadSince = performance.now();
      killerName = ev.killer === myId ? '' : nameOf(ev.killer);
      audio.death();
      updateOverlay();
    } else if (ev.killer === myId) {
      hud.showAnnounce(`You fragged ${nameOf(ev.victim)}`);
    }
  },

  onSpawn(ev): void {
    interp.reset(ev.id);
    if (ev.id === myId) {
      pendingVehicleShots.clear();
      audio.spawn();
      updateOverlay();
    }
  },

  onHit(ev): void {
    hud.hitmarker(ev.kill);
    audio.hit(ev.kill);
  },

  onPickupResult(ev): void {
    hud.showPickupResult(ev);
    if (ev.result !== PICKUP_RESULT_COLLECTED) return;
    if (ev.kind === PICKUP_HEALTH) audio.pickupHealth();
    else if (ev.kind === PICKUP_WEAPON) audio.pickupWeapon();
    else if (ev.kind === PICKUP_AMMO) audio.pickupAmmo();
  },

  onTeleport(ev: TeleportEvent): void {
    const cam = sceneMgr.camera;
    effects.addTeleportBurst(ev.fromX, ev.fromY, ev.fromZ);
    effects.addTeleportBurst(ev.toX, ev.toY, ev.toZ);
    if (ev.id === myId) {
      pendingVehicleShots.clear();
      // The server moved us; snap prediction rather than rubber-banding
      // across the map, and let the next frame's camera drive fog/LOD.
      pred?.hardResync();
      predTick = -1;
      audio.teleport();
      effects.shake = Math.min(0.85, effects.shake + 0.25);
    } else {
      const p = audio.positional(
        ev.toX, ev.toY, ev.toZ,
        cam.position.x, cam.position.y, cam.position.z, cam.rotation.y,
      );
      audio.teleport(p.pan, p.gain);
      interp.reset(ev.id);
    }
  },

  onJoin(ev): void {
    const isNew = !names.has(ev.id);
    names.set(ev.id, ev.name);
    if (isNew && ev.id !== myId) {
      hud.addFeed(`<span class="k">${escapeHtml(ev.name)}</span> <span class="w">joined</span>`);
    }
  },

  onLeave(id): void {
    if (names.has(id) && id !== myId) {
      hud.addFeed(`<span class="w">${escapeHtml(nameOf(id))} left</span>`);
    }
    names.delete(id);
    interp.reset(id);
  },

  onScores(rows): void {
    scores = rows;
    hud.setScores(scores, names, myId);
  },

  onMessage(text): void {
    camps?.message(text);
    hud.showAnnounce(text);
  },
  onChat(message): void { chat?.add(message); },

  onClose(code): void {
    resourceState = null; resourceModels.clear(); resourcesUI?.clear();
    chat?.close(false);
    airlift?.close(false);
    pendingVehicleShots.clear();
    artilleryFeedback.clear();
    audio.stopLift();
    disconnected = true;
    if (camps) camps.receive({ enabled: false, sites: camps.state.sites });
    reconnectStopped = [4001, 1002, 1008].includes(code);
    pickupModels.clear();
    updateOverlay();
    if (!reconnectStopped) scheduleReconnect();
  },
});

resourcesUI = new ResourcesUI(held => net.send(encodeHarvest(held)), () => net.connected && !!pred?.alive &&
  !pred.state.vehicle && !pred.state.airlift && !frontier?.open && !orbital?.open && !camps?.open && !chat?.open && !airlift?.open &&
  (input.isLocked || !!touch?.active), !!touch);

chat = new ChatPanel(text => net.send(encodeClientChat(text)), (open, resume) => {
  input.setSuspended(open);
  if (open) {
    chatTouchWasActive = touch?.active ?? false;
    touch?.setActive(false);
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (resume) {
    if (chatTouchWasActive) touch?.setActive(true);
    else input.resumePlay();
  }
  updateOverlay();
}, () => net.connected && !airlift?.open && !frontier?.open && !orbital?.open && !camps?.open);
airlift = new AirliftMap(destination => net.send(new ByteWriter(2).u8(Msg.CTravel).u8(destination).finish()), (open, resume) => {
  input.setSuspended(open);
  if (open) {
    airliftTouchWasActive = touch?.active ?? false; touch?.setActive(false);
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (resume) {
    if (airliftTouchWasActive) touch?.setActive(true); else input.resumePlay();
  }
  updateOverlay();
}, () => orbital?.toggle(true));
input.onUse = () => {
  if (!world || !pred?.alive || pred.state.vehicle || pred.state.airlift || chat?.open || airlift?.open || frontier?.open || orbital?.open || camps?.open) return false;
  const s = pred.state, plan = world.collectTransportPlan();
  const pod = plan.pods.find(p => Math.hypot(p.x - s.px, p.y - s.py, p.z - s.pz) < 3.2);
  if (!pod) return false;
  airlift!.show(plan, pod.id, world); return true;
};
frontier = new FrontierUI(faction => net.send(new ByteWriter(2).u8(Msg.CFaction).u8(faction).finish()), (open, resume) => {
  if (open) {
    camps?.toggle(false, false); chat?.close(false); airlift?.close(false); orbital?.toggle(false, false);
    touch?.setActive(false);
    input.setSuspended(true);
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    input.setSuspended(false);
    if (resume) { if (touch) touch.setActive(true); else input.resumePlay(); }
  }
  updateOverlay();
}, () => orbital?.toggle(true));
orbital = new OrbitalUI(destination => net.send(new ByteWriter(2).u8(Msg.CPlanet).u8(destination).finish()), (open, resume) => {
  if (open) {
    camps?.toggle(false, false); chat?.close(false); airlift?.close(false); frontier?.toggle(false, false);
    touch?.setActive(false); input.setSuspended(true);
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    input.setSuspended(transferring);
    if (resume) { if (touch) touch.setActive(true); else if (!transferring) input.resumePlay(); }
  }
  updateOverlay();
}, () => frontier?.toggle(true));
camps = new CampsUI(action => net.send(encodeOutpostAction(action)), (open, resume) => {
  if (open) {
    chat?.close(false); airlift?.close(false); frontier?.toggle(false, false); orbital?.toggle(false, false);
    touch?.setActive(false); input.setSuspended(true);
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    input.setSuspended(transferring);
    if (resume) { if (touch) touch.setActive(true); else if (!transferring) input.resumePlay(); }
  }
  updateOverlay();
}, (site, valid) => campModels.preview(site, valid));
frontier.bar.append(camps.button);
if (cleanCapture) frontier.bar.hidden = true;
touch?.setActive(true);
async function connect(): Promise<void> {
  try {
    const session = initialSession ?? requestSession(); initialSession = null;
    if (!await session) throw new Error('World unavailable');
    net.connect(myName);
  } catch { disconnected = true; updateOverlay(); scheduleReconnect(); }
}
function scheduleReconnect(): void {
  if (reconnectTimer || reconnectStopped) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, Math.min(5000, 750 * 1.6 ** reconnectAttempt++));
}
void connect();
updateOverlay();
window.addEventListener('beforeunload', () => {
  chat?.dispose();
  airlift?.dispose(); liquids?.dispose(); transport?.dispose();
  navigationMap.dispose();airliftPod.dispose();
  orbital?.dispose(); campModels.dispose();
  resourcesUI?.dispose(); resourceModels.dispose();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  cityLifts?.dispose();
  vesperCity?.dispose(); aureliaCity?.dispose();
  cityLife?.dispose(); jungleTemples?.dispose();
  caveLandmarks?.dispose();
  wildlifeModels.dispose();
  teleporters?.dispose();
  touch?.dispose();
  chunks?.dispose();
  vegetation?.dispose();
  sceneryStream?.dispose();
  structures?.dispose();
  groundCover?.dispose();
  rocks?.dispose();
  caveDetails?.dispose();
  vehicleModels.dispose();
  if (localHull) disposeVehicleHull(localHull);
  audio.engine(VEHICLE.NONE, 0);
  audio.stopLift();
  pickupModels.dispose();
}, { once: true });

// -- fixed-tick prediction --------------------------------------------------
function leadTicks(): number {
  return clamp(net.rttMs / (1000 / TICK_RATE) + 2, 2, 30);
}

function doPredictedTick(): void {
  if (!pred || !world) return;
  const rt = net.estServerTick() - NET.INTERP_TICKS;
  const cmd = input.sample(seq++, Math.floor(rt), rt - Math.floor(rt));

  const res = pred.applyLocal(cmd);
  net.send(encodeInput(cmd));

  if (res.weapon.switched) presentWeapon(pred.weaponState.weapon);
  if (res.weapon.firedWeapon >= 0) {
    showOwnShot(res.weapon.firedWeapon, cmd.seq, cmd.yaw, cmd.pitch);
  }
  if (res.weapon.reloadStartedWeapon >= 0) {
    audio.reloadStart(res.weapon.reloadStartedWeapon);
  }
  if (res.weapon.reloadCompletedWeapon >= 0) {
    audio.reloadComplete(res.weapon.reloadCompletedWeapon);
  }
  if (res.weapon.dryFireWeapon >= 0) {
    audio.dryFire();
    viewModel.onDryFire();
  }
  if (res.jumped && !res.dodged) audio.jump();
  if (res.dodged) {
    audio.dodge();
    const p = pred.renderPos();
    effects.addDodgePuff(p.x, p.y + 0.2, p.z);
  }
  if (res.impact > 6) audio.land();
}

// -- resync on tab switch ---------------------------------------------------
document.addEventListener('visibilitychange', () => {
  pendingVehicleShots.clear();
  if (document.hidden) { audio.engine(VEHICLE.NONE, 0); audio.stopLift(); }
  if (!document.hidden) {
    net.resync();
    pred?.hardResync();
    interp.clearAll();
    effects.clearProjectiles();
    pickupModels.clear();
    predTick = -1;
    tickAccum = 0;
    updateOverlay();
  }
});

// -- main loop --------------------------------------------------------------
let lastFrame = performance.now();

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  chat?.update(now);
  resourcesUI?.update();
  const frameSeconds = (now - lastFrame) / 1000;
  const dt = Math.min(0.1, frameSeconds);
  sceneMgr.updateFrame(frameSeconds, now / 1000);
  lastFrame = now;
  fps = fps * 0.95 + (1 / Math.max(1e-3, frameSeconds)) * 0.05;

  if (pred && pred.initialized) {
    // Keep the predicted tick leading the server by rtt + margin, nudging
    // the accumulator rate instead of jumping.
    const target = net.estServerTick() + leadTicks();
    if (predTick < 0 || Math.abs(target - predTick) > 30) {
      predTick = Math.floor(target);
      pendingVehicleShots.clear();
      pred.hardResync();
      tickAccum = 0;
    }
    const rate = 1 + clamp((target - predTick) * 0.08, -0.25, 0.5);
    // Match the server's bounded input catch-up. A slow frame must not
    // create an ever-growing debt of simulation work on the next frame.
    tickAccum = Math.min(3, tickAccum + dt * TICK_RATE * rate);
    let guard = 0;
    while (tickAccum >= 1 && guard < 3 && net.snapshotAgeMs < 500) {
      tickAccum -= 1;
      doPredictedTick();
      predTick++;
      guard++;
    }

    pred.frame(dt, tickAccum);

    // Camera.
    const rp = pred.renderPos();
    const cam = sceneMgr.camera;
    const shake = effects.shake;
    const driving = pred.state.vehicle !== VEHICLE.NONE;
    const gunner = driving && pred.state.seat===1;
    const artillery = driving && pred.state.seat===2;
    const rt = net.estServerTick() - NET.INTERP_TICKS;
    const views = interp.samplePlayers(rt);
    const driverView=gunner?views.find(v=>v.vehicleId!==undefined&&v.vehicleId===pred!.state.vehicleId&&(v.seat??0)===0&&!v.dead):undefined;
    sharedVehicleEyeOffset(pred.state,vehicleEyeOffset);
    if (pred.state.vehicle === VEHICLE.JET) {
      const q=vehicleQuaternion(pred.state);vehicleEyeRotation.set(q.x,q.y,q.z,q.w);
    }
    cam.position.set(
      rp.x + vehicleEyeOffset.x + (Math.random() - 0.5) * shake * 0.25,
      rp.y + vehicleEyeOffset.y + (Math.random() - 0.5) * shake * 0.25,
      rp.z + vehicleEyeOffset.z + (Math.random() - 0.5) * shake * 0.25,
    );
    input.setVehicleMode(pred.state.vehicle, pred.state.heading, pred.state.vehiclePitch,
      pred.state.vehicleRoll, pred.state.vehicleRotation,pred.state.seat??0);
    input.followJet(pred.state.heading, pred.state.vehiclePitch, pred.state.vehicleRoll, pred.state.vehicleRotation);
    if (pred.state.vehicle === VEHICLE.JET) {
      const q = input.viewRotation;
      cam.quaternion.set(q.x, q.y, q.z, q.w);
    } else cam.rotation.set(input.pitch, input.yaw, 0, 'YXZ');

    // First-person hull: the driver sees their own vehicle under the camera.
    if (driving) {
      if (localHullType !== pred.state.vehicle || localHullVariant !== pred.state.vehicleVariant || localHullSeat!==(pred.state.seat??0)) {
        if (localHull) disposeVehicleHull(localHull);
        localHull = artillery?trainArtilleryModel():buildVehicleHull(pred.state.vehicle as VehicleType, pred.state.vehicleVariant);
        localHullType = pred.state.vehicle; localHullVariant = pred.state.vehicleVariant;
        localHullSeat=pred.state.seat??0;
        sceneMgr.scene.add(localHull);
        const hint = artillery?'Leviathan siege cannon: aim and FIRE a nuclear shell | E dismount':gunner ? (pred.state.vehicle===VEHICLE.JET?'Ventral gunner: look within the downward cone | FIRE rockets | E exit':'Gunner: mouse aims the crew MG | FIRE to shoot | E exit') : touch ? (pred.state.vehicle === VEHICLE.JET
          ? 'Stick: pitch / roll · THRUST and BRAKE control speed · drag to look'
          : 'Stick to drive · drag to aim · hold FIRE to shoot') : CONTROL_HINTS[pred.state.vehicle];
        if (hint) hud.showAnnounce(hint);
      }
      if (localHull) {
        localHull.visible = true;
        localHull.position.set(rp.x, rp.y, rp.z);
        // Nose follows the velocity slope (dips off cliff edges, rises up
        // hills) and the body rolls with lateral slide. Jet orientation
        // comes directly from the shared flight simulation.
        const att = vehicleAttitude(
          pred.state.vehicle as VehicleType,
          pred.state.vx, pred.state.vy, pred.state.vz,
          pred.state.heading,
        );
        const targetPitch = pred.state.vehicle === VEHICLE.JET
          ? pred.state.vehiclePitch
          : att.pitch;
        const ak = Math.min(1, dt * 10);
        localAttPitch = pred.state.vehicle === VEHICLE.JET ? targetPitch : localAttPitch + (targetPitch - localAttPitch) * ak;
        localAttRoll = pred.state.vehicle === VEHICLE.JET ? pred.state.vehicleRoll : localAttRoll + (att.roll - localAttRoll) * ak;
        if(artillery)localAttPitch=localAttRoll=0;
        if (pred.state.vehicle === VEHICLE.JET) localHull.quaternion.copy(vehicleEyeRotation);
        else localHull.rotation.set(localAttPitch, pred.state.heading, localAttRoll, 'YXZ');
        // The tank turret tracks the mouse (where the cannon fires); the
        // tracks steer with A/D.
        aimVehicleWeapon(localHull, gunner?(driverView?.yaw??pred.state.heading):input.yaw, gunner?(driverView?.pitch??0):input.pitch);
        updateVehicleHull(localHull, {
          dt,
          speed: -pred.state.vx * Math.sin(pred.state.heading) - pred.state.vz * Math.cos(pred.state.heading),
          steering: input.steering,
          throttle: Math.abs(input.throttle),
        });
      }
    } else if (localHull) {
      localHull.visible = false;
      localHullType = 0;
      localAttPitch = 0;
      localAttRoll = 0;
    }
    const crewKey=gunner&&pred.state.vehicle!==VEHICLE.JET?`${pred.state.vehicle}:${pred.state.vehicleVariant}`:'';
    if(localCrewKey!==crewKey) {
      if(localCrew)disposeVehicleHull(localCrew);localCrew=null;localCrewKey=crewKey;
      if(crewKey){localCrew=buildCrewWeapon(pred.state.vehicle as VehicleType,pred.state.vehicleVariant);sceneMgr.scene.add(localCrew);}
    }
    if(localCrew&&localHull){localCrew.position.copy(localHull.position);localCrew.quaternion.copy(localHull.quaternion);
      aimVehicleWeapon(localCrew,input.yaw,input.pitch);updateVehicleHull(localCrew,{dt,speed:0});}
    if(localSeat!==(pred.state.seat??0)&&gunner)hud.showAnnounce(pred.state.vehicle===VEHICLE.JET?'Ventral gunner: aim below the aircraft | FIRE rockets':'Gunner: independent crew machine gun | FIRE to shoot');
    localSeat=pred.state.seat??0;

    // Remote entities at interpolated time.
    playerModels.update(views, names, dt,driving&&localHull&&pred.state.vehicleId!==undefined?
      {vehicleId:pred.state.vehicleId,x:localHull.position.x,y:localHull.position.y,z:localHull.position.z,rotation:localHull.quaternion}:undefined);

    let projectiles = interp.sampleProjectiles(rt);
    artilleryFeedback.sync(projectiles,myId,now*.001);
    const predictedIds = new Set<number>();
    for (const p of projectiles) {
      if (p.owner === myId && p.ageTicks < 8 &&
          effects.reconcilePredictedProjectile(p)) {
        predictedIds.add(p.id);
      }
    }
    if (predictedIds.size > 0) projectiles = projectiles.filter((p) => !predictedIds.has(p.id));
    effects.updateProjectiles(projectiles);
    interp.gc(rt);

    // Terrain streaming around the player (or the spectate point).
    if (spectate && world) {
      if (!Number.isFinite(spectate.y)) spectate.y = world.groundY(spectate.x, spectate.z) + 26;
      cam.position.set(spectate.x, spectate.y, spectate.z);
      cam.rotation.y = spectate.yaw + (spectate.spin ? now * 0.00012 : 0);
      cam.rotation.x = spectate.pitch;
    }
    const streamX = cam.position.x, streamZ = cam.position.z;
    const cameraDt = Math.max(0.001, frameSeconds);
    chunks?.update(streamX, cam.position.y, streamZ, {
      vx: spectate ? (Number.isFinite(lastStreamX) ? (streamX - lastStreamX) / cameraDt : 0) : pred.state.vx,
      vz: spectate ? (Number.isFinite(lastStreamZ) ? (streamZ - lastStreamZ) / cameraDt : 0) : pred.state.vz,
      flight: spectate ? spectate.flight === true : pred.state.vehicle === VEHICLE.JET || !!pred.state.airlift,
    });
    lastStreamX = streamX; lastStreamZ = streamZ;
    scenery.update(streamX, streamZ);
    sceneMgr.setCaveView(chunks?.isBelowSurfaceEnvelope ?? false);
    caveDetails?.update(cam.position.x, cam.position.z, cam.position.y);
    touch?.setVehicle(pred.state.vehicle,pred.state.seat??0);
    touch?.setSwimming(pred.state.swimming ?? false);

    // HUD.
    if (pred.alive && pred.state.vehicle === VEHICLE.JET && !gunner) {
      jetAimPoint.set(0, 0, -1).applyQuaternion(vehicleEyeRotation).multiplyScalar(400).add(cam.position);
      cam.updateMatrixWorld();
      jetAimPoint.applyMatrix4(cam.matrixWorldInverse);
      const behind = jetAimPoint.z >= 0;
      if (Math.abs(jetAimPoint.z) < 0.001) jetAimPoint.z = behind ? 0.001 : -0.001;
      jetAimPoint.applyMatrix4(cam.projectionMatrix);
      hud.setJetAim(behind ? -jetAimPoint.x : jetAimPoint.x, behind ? -jetAimPoint.y : jetAimPoint.y, behind);
    } else hud.setJetAim(null);
    hud.setHealth(pred.health, pred.alive);
    const activeWeapon = pred.weaponState.weapon;
    hud.setWeapon(activeWeapon);
    const ammo = pred.weaponState.ammo[activeWeapon];
    const wdef = WEAPONS[activeWeapon];
    hud.setAmmo(
      ammo?.magazine ?? 0,
      ammo?.reserve ?? 0,
      pred.alive,
      wdef?.infiniteReserve === true,
    );
    hud.setCooldown(wdef ? pred.cooldown / wdef.interval : 0);
    const reloading = pred.alive && pred.weaponState.reloadWeapon === activeWeapon;
    const reloadProgress = reloading && wdef
      ? 1 - pred.weaponState.reloadCd / Math.max(1e-6, wdef.reloadTime)
      : 0;
    hud.setReload(reloading, reloadProgress);
    // Cave weapons only exist in the selection while actually carried.
    const availability = WEAPONS.map((_, i) => isWeaponSelectable(pred!.weaponState.ammo, i));
    input.setWeaponAvailability(availability);
    hud.setWeaponAvailability(availability);
    if (pred.state.vehicle !== VEHICLE.NONE) {
      const mounted = artillery ? weaponDefById(213) : gunner
        ? weaponDefById(pred.state.vehicle === VEHICLE.JET ? 215 : 214)
        : vehicleArmament(pred.state.vehicle, pred.state.vehicleVariant).primary;
      hud.setMountedWeapon(mounted?.name ?? 'Mounted weapon', pred.alive);
    }
    // The round/mag seats home around the midpoint of the choreography.
    if (reloading) {
      if (lastReloadProgress < 0.55 && reloadProgress >= 0.55) {
        audio.reloadMid(activeWeapon);
      }
      lastReloadProgress = reloadProgress;
    } else {
      lastReloadProgress = 0;
    }
    if (pred.state.vehicle !== VEHICLE.NONE) {
      const vdef = vehicleDefinition(pred.state.vehicle, pred.state.vehicleVariant)!;
      hud.setVehicle(
        artillery?'LEVIATHAN RAIL ARTILLERY: Nuclear Cannon':gunner?`${vdef.name} GUNNER: ${pred.state.vehicle===VEHICLE.JET?'Ventral Rockets':'Crew Machine Gun'}`:
        pred.state.vehicleVariant ? `${vdef.name}: ${vehicleArmament(pred.state.vehicle, pred.state.vehicleVariant).primary.name} / ${vehicleArmament(pred.state.vehicle, pred.state.vehicleVariant).alt?.name}` : vdef.name,
        vdef ? vehicleHealth / vdef.maxHealth : 0,
        pred.state.vehicle === VEHICLE.JEEP ? pred.state.boostFuel : null,
      );
    } else {
      hud.setVehicle(null, 0, null);
      const prompt = pred.alive
        ? vehicleModels.nearestPrompt(rp.x, rp.y, rp.z)
        : null;
      const crewPrompt=pred.alive?views.filter(v=>v.vehicle!==VEHICLE.NONE&&!v.dead&&(v.seat??0)===0&&v.vehicleId!==undefined&&
        !views.some(o=>o.vehicleId===v.vehicleId&&o.seat===1&&!o.dead)).map(v=>({v,d:Math.hypot(v.x-rp.x,v.y-rp.y,v.z-rp.z)}))
        .filter(({v,d})=>d<=(vehicleDefinition(v.vehicle,v.vehicleVariant)?.enterRange??0)).sort((a,b)=>a.d-b.d)[0]:undefined;
      hud.setPrompt(crewPrompt&&(!prompt||crewPrompt.d<prompt.dist)?`${touch?'ENTER':'[E] Join'} ${vehicleDefinition(crewPrompt.v.vehicle,crewPrompt.v.vehicleVariant)?.name??'vehicle'} gunner`:
        prompt ? `${touch ? 'ENTER' : '[E] Enter'} ${vehicleDefinition(prompt.type, prompt.variant)?.name ?? 'vehicle'}` : null);
    }
    if (pred.state.vehicle !== VEHICLE.NONE) hud.setPrompt(touch ? 'Tap EXIT to dismount' : '[E] Exit');
    hud.setLock(
      lockState === LOCK_LOCKED ? 'LOCKED' :
      lockState === LOCK_ACQUIRING ? 'LOCKING…' : null,
    );
    viewModel.setReloadProgress(reloading ? reloadProgress : null);
    if (!pred.alive) updateOverlay();

    const gspeed = Math.hypot(pred.state.vx, pred.state.vz);
    viewModel.group.visible = pred.alive && !cleanCapture && pred.state.vehicle === VEHICLE.NONE && !pred.state.airlift;
    viewModel.update(dt, gspeed, pred.state.grounded, input.takeSway());

    // Vehicle audio: enter/exit stingers plus the continuous engine bed.
    const vt = pred.alive ? pred.state.vehicle : VEHICLE.NONE;
    if (vt !== lastVehicle || pred.state.vehicleVariant !== lastVehicleVariant) {
      if (vt !== VEHICLE.NONE) audio.vehicleEnter(vt, pred.state.vehicleVariant);
      else if (pred.alive) audio.vehicleExit(lastVehicle);
      lastVehicle = vt; lastVehicleVariant = pred.state.vehicleVariant;
    }
    const boosting = vt === VEHICLE.JEEP && pred.state.boosting && input.throttle > 0;
    const vdefSnd = vt !== VEHICLE.NONE ? vehicleDefinition(vt, pred.state.vehicleVariant)! : null;
    const airspeed = Math.hypot(pred.state.vx, pred.state.vy, pred.state.vz);
    audio.engine(document.hidden || disconnected || artillery ? VEHICLE.NONE : vt,
      vdefSnd ? (vt === VEHICLE.JET ? airspeed : gspeed) / vdefSnd.maxSpeed : 0, boosting, {
      throttle: input.throttle, grounded: pred.state.grounded, turning: input.steering,
    });

    if (hud.debugVisible) {
      const s = pred.state;
      hud.setDebug(
        `pos ${s.px.toFixed(1)} ${s.py.toFixed(1)} ${s.pz.toFixed(1)}  vel ${gspeed.toFixed(1)}\n` +
        `predTick ${predTick}  est ${net.estServerTick().toFixed(1)}  rtt ${net.rttMs.toFixed(0)}ms\n` +
        `ents ${views.length}  projectiles ${projectiles.length}  pickups ${pickupModels.count}  plants ${vegetation?.count ?? 0}  structure boxes ${structures?.count ?? 0}  ammo ${ammo?.magazine ?? 0}/${wdef?.infiniteReserve ? '\u221e' : (ammo?.reserve ?? 0)}\n` +
        `chunks ready ${chunks?.stats.columnsReady ?? 0} pending ${chunks?.stats.columnsPending ?? 0} tris ${chunks?.stats.triangles ?? 0}\n` +
        `draws ${sceneMgr.renderStats.calls} visible tris ${sceneMgr.renderStats.triangles} pixel ratio ${sceneMgr.renderStats.pixelRatio.toFixed(2)}`,
      );
    }
  } else {
    audio.engine(VEHICLE.NONE, 0);
  }

  statTimer += dt;
  if (statTimer > 0.25) {
    statTimer = 0;
    hud.setStats(net.rttMs, fps);
  }

  // Network callbacks can precede the new predicted hull transform. Resolve
  // tracer origins only after this frame's driving/aim pose is installed.
  for (const ev of pendingVehicleShots.take()) {
    localWeaponMuzzle.set(ev.ox, ev.oy, ev.oz);
    const shotHull=ev.weapon===214?localCrew:ev.weapon===215?null:localHull;
    if (shotHull?.visible) {
      vehicleMuzzlePosition(shotHull, localWeaponMuzzle); flashVehicleWeapon(shotHull);
    } else if(ev.weapon===215&&pred?.state.vehicle===VEHICLE.JET) {
      const offset=aircraftCrewMuzzle(pred.state),rp=pred.renderPos();localWeaponMuzzle.set(rp.x+offset.x,rp.y+offset.y,rp.z+offset.z);
      effects.addMuzzle(localWeaponMuzzle.x,localWeaponMuzzle.y,localWeaponMuzzle.z);
    } else effects.addMuzzle(ev.ox, ev.oy, ev.oz);
    if(ev.weapon===213) {
      const cam=sceneMgr.camera,pos=audio.positional(localWeaponMuzzle.x,localWeaponMuzzle.y,localWeaponMuzzle.z,
        cam.position.x,cam.position.y,cam.position.z,cam.rotation.y,150);
      audio.fire(213,pos.pan,pos.gain);
      effects.addArtilleryMuzzle(localWeaponMuzzle.x,localWeaponMuzzle.y,localWeaponMuzzle.z,cam.position);
    }
    for (const end of ev.ends) {
      if(ev.weapon===207||ev.weapon===209)effects.addBeam(localWeaponMuzzle.x,localWeaponMuzzle.y,localWeaponMuzzle.z,end.x,end.y,end.z,vehicleWeaponColor(ev.weapon),ev.weapon===209?1.1:.055);
      else effects.addTracer(localWeaponMuzzle.x, localWeaponMuzzle.y, localWeaponMuzzle.z,
        end.x, end.y, end.z, vehicleWeaponColor(ev.weapon));
      if (end.hitKind === 1) effects.addBlood(end.x, end.y, end.z);
      else if (end.hitKind === 0) effects.addImpact(end.x, end.y, end.z);
    }
  }
  effects.update(dt);
  wildlifeModels.update(dt);
  const cameraPos = sceneMgr.camera.position;
  const artilleryMarker=cleanCapture?null:artilleryFeedback.marker(now*.001);
  let artilleryTarget=null;
  if(artilleryMarker) {
    const point=artilleryMarker.point,distance=Math.hypot(point.x-cameraPos.x,point.y-cameraPos.y,point.z-cameraPos.z);
    sceneMgr.camera.getWorldDirection(artilleryViewDirection);
    const behind=artilleryMarkerPoint.set(point.x,point.y,point.z).sub(cameraPos).dot(artilleryViewDirection)<0;
    artilleryMarkerPoint.set(point.x,point.y,point.z).project(sceneMgr.camera);
    artilleryTarget={x:artilleryMarkerPoint.x,y:artilleryMarkerPoint.y,behind,impact:artilleryMarker.impact,
      label:`${artilleryMarker.impact?'IMPACT':'SHELL'} · ${(distance/1000).toFixed(2)} km`};
  }
  hud.setArtillery(!cleanCapture&&pred?.alive&&pred.state.seat===2?artilleryFeedback.reloadSeconds(now*.001):null,
    artilleryFeedback.count,artilleryTarget);
  liquids?.update(cameraPos,now*.001);
  sceneMgr.liquidKind = liquids?.currentLiquid?.kind ?? null;
  const airMeter = document.getElementById('air-meter')!;
  const breath = pred?.state.airSeconds ?? 18;
  airMeter.hidden = cleanCapture || !pred?.alive || !(pred.state.submerged || breath < 17.9);
  airMeter.textContent = `${breath <= 0 ? 'OUT OF AIR' : `AIR ${Math.ceil(breath)}s`} · ${touch ? 'UP / DIVE' : 'Space up · C dive'}`;
  airMeter.classList.toggle('critical', breath < 5);
  document.getElementById('liquid-tint')!.dataset.kind = sceneMgr.liquidKind ?? '';
  pickupModels.update(dt, cameraPos);
  const liftSeconds = !spectate && pred?.initialized ? pred.renderSeconds : net.estServerTick() / TICK_RATE;
  airliftPod.update(world?.collectTransportPlan()??null,pred?.state.airlift,liftSeconds,sceneMgr.camera,cleanCapture||!!spectate||!pred?.alive);
  if (pred) camps?.update(pred.state.px, pred.state.py, pred.state.pz, sceneMgr.camera.rotation.y, myId, pred.alive, !pred.state.vehicle && !pred.state.airlift, now * .001);
  frontier?.update(cameraPos.x, cameraPos.y, cameraPos.z, sceneMgr.camera.rotation.y, now * .001);
  if (pred) orbital?.update(pred.state.px, pred.state.py, pred.state.pz, sceneMgr.camera.rotation.y, pred.alive && !pred.state.vehicle && !pred.state.airlift, now * .001);
  frontierMarkers.update(cameraPos.x, cameraPos.z, now * .001);
  navigationMap.update(cameraPos.x,cameraPos.z,sceneMgr.camera.rotation.y,now*.001,cleanCapture||!pred?.alive||!!airlift?.open);
  audio.lift(world?nearestMovingLift(world.collectCityLifts(),liftSeconds,cameraPos,sceneMgr.camera.rotation.y,
    !document.hidden&&!disconnected&&!!pred?.alive):null);
  vehicleModels.updateTransport(liftSeconds);
  transport?.update(liftSeconds, cameraPos.x, cameraPos.y, cameraPos.z);
  cityLifts?.update(liftSeconds, cameraPos.x, cameraPos.z);
  vesperCity?.update(cameraPos.x, cameraPos.y, cameraPos.z);
  aureliaCity?.update(cameraPos.x, cameraPos.y, cameraPos.z);
  cityLife?.update(cameraPos.x, cameraPos.y, cameraPos.z, liftSeconds);
  jungleTemples?.update(liftSeconds, cameraPos.x, cameraPos.y, cameraPos.z);
  if (world && pred?.alive && !pred.state.vehicle && !cleanCapture) {
    const pod = world.collectTransportPlan().pods.find(p => Math.hypot(p.x - pred!.state.px, p.y - pred!.state.py, p.z - pred!.state.pz) < 3.2);
    if (pod) hud.setPrompt(touch ? 'Tap ENTER · Airlift destination map' : '[E] Airlift destination map');
  }
  teleporters?.update(dt, cameraPos.x, cameraPos.y, cameraPos.z);
  caveLandmarks?.update(cameraPos.x, cameraPos.y, cameraPos.z);
  touch?.setUnderground(chunks?.isUnderground ?? false);
  const recalling = chunks?.isUnderground && pred?.state.grounded && input.using && !input.firing &&
    Math.hypot(pred.state.vx, pred.state.vy, pred.state.vz) < 1.2 && pred.health >= recallLastHealth;
  recallHeldSeconds = recalling ? Math.min(4, recallHeldSeconds + dt) : 0;
  recallLastHealth = pred?.health ?? 100;
  const recallHint = recallHeldSeconds > .1 ? `RECALL ${Math.max(0, 4 - recallHeldSeconds).toFixed(1)}s \u00b7 stay still`
    : touch?.active ? 'Hold RECALL 4s to surface' : 'Hold E 4s for surface recall';
  const returnPad = chunks?.isUnderground && !cleanCapture && pred?.alive
    ? teleporters?.nearestReturn(cameraPos.x, cameraPos.y - PLAYER.EYE_HEIGHT, cameraPos.z) : null;
  const liftHint = !chunks?.isUnderground && !cleanCapture && pred?.alive && pred.state.vehicle === VEHICLE.NONE
    ? cityLifts?.hint(liftSeconds, cameraPos.x, cameraPos.y - PLAYER.EYE_HEIGHT, cameraPos.z, sceneMgr.camera.rotation.y) ?? null : null;
  touch?.setWorldGuide(!!liftHint);
  if (returnPad && world) {
    const dx = returnPad.x - cameraPos.x, dz = returnPad.z - cameraPos.z;
    const dy = Math.round(returnPad.y - (cameraPos.y - PLAYER.EYE_HEIGHT));
    const bearing = Math.atan2(-dx, -dz) - sceneMgr.camera.rotation.y;
    const angle = Math.atan2(Math.sin(bearing), Math.cos(bearing));
    const arrow = Math.abs(angle) < Math.PI / 5 ? '\u2191' : Math.abs(angle) > Math.PI * 4 / 5 ? '\u2193' : angle > 0 ? '\u2190' : '\u2192';
    const biome = ['LIMESTONE', 'COPPER', 'GLACIAL', 'FUNGAL'][caveBiomeAt(world.seed, cameraPos.x, cameraPos.z)];
    const discovery = (teleporters?.field.pois ?? []).map(p => ({ p,
      distance: Math.hypot(p.x - cameraPos.x, p.z - cameraPos.z), floor: Math.abs(p.y - cameraPos.y + PLAYER.EYE_HEIGHT) }))
      .filter(v => v.floor < 5 && v.distance < 260).sort((a, b) => a.distance - b.distance)[0];
    const label = discovery ? `${discovery.p.kind.toUpperCase()} ${Math.round(discovery.distance)}m \u00b7 ${WEAPONS[discovery.p.weapon]?.name}\n` : '';
    hud.setCaveGuide(`${label}${biome} ${arrow} RETURN ${Math.round(Math.hypot(dx, dz))}m` +
      (Math.abs(dy) > 4 ? ` \u00b7 ${Math.abs(dy)}m ${dy > 0 ? 'above' : 'below'}` : '') + `\n${recallHint}`);
  } else hud.setCaveGuide(!cleanCapture && pred?.alive && chunks?.isUnderground ? recallHint : liftHint);
  vegetation?.animate(now / 1000);
  groundCover?.animate(now / 1000);
  sceneMgr.render(!!pred?.initialized);
}

requestAnimationFrame(frame);

// Debug/monitoring handle (also used by automated smoke tests).
(window as unknown as Record<string, unknown>).__mmofps = {
  get state() {
    return {
      connected: net.connected,
      scenery: sceneryStream?.stats ?? null,
      initialized: pred?.initialized ?? false,
      myId,
      predTick,
      simulationTick: pred?.state.simulationTick ?? null,
      seed: world?.seed ?? null,
      rttMs: net.rttMs,
      pos: pred?.renderPos() ?? null,
      camera: {
        x: sceneMgr.camera.position.x,
        y: sceneMgr.camera.position.y,
        z: sceneMgr.camera.position.z,
        yaw: sceneMgr.camera.rotation.y,
        pitch: sceneMgr.camera.rotation.x,
      },
      spectate: spectate ? { ...spectate } : null,
      cleanCapture,
      camps: camps?.state ?? null,
      salvage: frontier?.state?.you.salvage ?? null,
      resources: resourceState,
      touch: touch ? { active: touch.active } : null,
      terrainReady: chunks !== null &&
        chunks.stats.columnsReady > 0 &&
        chunks.stats.columnsPending === 0,
      health: pred?.health ?? -1,
      alive: pred?.alive ?? true,
      weapon: pred?.weaponState.weapon ?? 0,
      ammo: pred?.weaponState.ammo.map((a) => ({ ...a })) ?? [],
      reloadWeapon: pred?.weaponState.reloadWeapon ?? -1,
      reloadCooldown: pred?.weaponState.reloadCd ?? 0,
      viewmodelVisible: viewModel.group.visible,
      vegetation: vegetation ? { ...vegetation.stats } : null,
      groundCover: groundCover?.count ?? 0,
      rocks: rocks?.count ?? 0,
      caveDetails: caveDetails?.stats ?? null,
      teleporters: teleporters?.stats ?? null,
      caveLandmarks: caveLandmarks?.stats ?? null,
      underground: chunks?.isUnderground ?? false,
      vehiclesVisible: vehicleModels.latest.length,
      myVehicle: pred?.state.vehicle ?? 0,
      myVehicleVariant: pred?.state.vehicleVariant ?? 0,
      myVehicleSeat: pred?.state.seat ?? 0,
      liquid: liquids?.currentLiquid ?? null,
      vehicleMotion: pred ? { heading: pred.state.heading, pitch: pred.state.vehiclePitch,
        roll: pred.state.vehicleRoll, boosting: pred.state.boosting, boostFuel: pred.state.boostFuel,
        speed: Math.hypot(pred.state.vx, pred.state.vy, pred.state.vz) } : null,
      structures: structures ? { ...structures.stats } : null,
      cityMood: sceneMgr.cityMood,
      capitalDetails: { vesper: vesperCity?.stats ?? null, aurelia: aureliaCity?.stats ?? null },
      cities: world?.collectCities() ?? [],
      chunks: chunks ? { ...chunks.stats } : null,
      streaming: chunks?.streaming ?? null,
      rendering: sceneMgr.renderStats,
      players: names.size,
      creatures: wildlifeModels.count,
      pickups: pickupModels.count,
    };
  },
};
