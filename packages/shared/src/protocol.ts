import { NO_ENTITY_ID } from './entity-id.js';
import { quantYaw, unquantYaw, quantPitch, unquantPitch, clamp } from './math.js';
import type { InputCmd } from './movement.js';
import type { AirliftFlight } from './airlift.js';
import type { TeleporterPad } from './teleporters.js';
import { PROTOCOL_VERSION } from './constants.js';
import { WEAPONS, type WeaponAmmo } from './weapons.js';
import { MAX_VISIBLE_CREATURES, type CreatureState } from './wildlife.js';
import { VEHICLE, validVehicleVariant } from './vehicles.js';
import { normalizeRotation, vehicleQuaternion, type Rotation } from './rotation.js';

// Hand-rolled little-endian binary protocol. One WebSocket message = one
// game message, first byte is the type. Everything is quantized to keep
// snapshots small. Entity references use canonical 1–8 byte varints, preserving
// safe-integer IDs across worker restarts without bloating small character IDs.

export const Msg = {
  CHello: 1,
  CInput: 2,
  CPing: 3,
  CChat: 4,
  CTravel: 5,
  CFaction: 6,
  CPlanet: 7,
  COutpost: 8,
  CHarvest: 9,
  CRespawn: 29,
  /** Out of combat: move to a reinforcement point now (payload: option id). */
  CDeploy: 31,

  SWelcome: 10,
  SSnapshot: 11,
  SPong: 12,
  SJoin: 13,
  SLeave: 14,
  SFire: 15,
  SExplosion: 16,
  SDeath: 17,
  SSpawn: 18,
  SHit: 19,
  SScores: 20,
  SMessage: 21,
  SPickupResult: 22,
  STeleport: 23,
  SChat: 24,
  SFrontier: 25,
  SJourney: 26,
  SOutposts: 27,
  SResources: 28,
  SXp: 30,
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private off = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.off + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.off + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this { this.ensure(1); this.view.setUint8(this.off, v); this.off += 1; return this; }
  i8(v: number): this { this.ensure(1); this.view.setInt8(this.off, v); this.off += 1; return this; }
  u16(v: number): this { this.ensure(2); this.view.setUint16(this.off, v, true); this.off += 2; return this; }
  i16(v: number): this { this.ensure(2); this.view.setInt16(this.off, v, true); this.off += 2; return this; }
  u32(v: number): this { this.ensure(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; return this; }
  f32(v: number): this { this.ensure(4); this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  f64(v: number): this { this.ensure(8); this.view.setFloat64(this.off, v, true); this.off += 8; return this; }

  tick(v: number): this {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('Invalid simulation tick');
    return this.f64(v);
  }

  /** Canonical base-128 integer, preserving all 53 safe JS integer bits.
   * Small persistent character IDs stay compact; issued dynamic IDs grow. */
  entity(v: number): this {
    if (v === -1) v = NO_ENTITY_ID;
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('Invalid entity reference');
    while (v >= 128) { this.u8((v % 128) | 128); v = Math.floor(v / 128); }
    return this.u8(v);
  }

  str(s: string, maxChars = 60): this {
    let end = Math.min(s.length, Math.max(0, Math.min(255, Math.floor(maxChars))));
    // Do not split a surrogate pair or wrap the one-byte UTF-8 length.
    if (end > 0 && end < s.length && s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff &&
        s.charCodeAt(end) >= 0xdc00 && s.charCodeAt(end) <= 0xdfff) end--;
    const encoded = textEncoder.encode(s.slice(0, end));
    let length = Math.min(255, encoded.length);
    while (length > 0 && length < encoded.length && (encoded[length] & 0xc0) === 0x80) length--;
    const bytes = encoded.subarray(0, length);
    this.u8(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.off);
    this.off += bytes.length;
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.off);
  }
}

export class ByteReader {
  private view: DataView;
  private bytes: Uint8Array;
  off = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
      this.view = new DataView(data);
    }
  }

  get length(): number { return this.bytes.length; }
  get remaining(): number { return this.bytes.length - this.off; }

  u8(): number { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i8(): number { const v = this.view.getInt8(this.off); this.off += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.off, true); this.off += 8; return v; }

  tick(): number {
    const v = this.f64();
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('Invalid simulation tick');
    return v;
  }

  entity(): number {
    let value = 0, scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8(), digit = byte & 127;
      if (i === 7 && digit > 15) throw new RangeError('Entity reference exceeds integer precision');
      value += digit * scale;
      if (!(byte & 128)) {
        if (i > 0 && digit === 0) throw new RangeError('Noncanonical entity reference');
        return value;
      }
      scale *= 128;
    }
    throw new RangeError('Entity reference is too long');
  }

  str(): string {
    const n = this.u8();
    const s = textDecoder.decode(this.bytes.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
}

// ---- Entity + snapshot shapes -------------------------------------------

export const ENT_PLAYER = 0;
export const ENT_PROJECTILE = 1;

/** Homing lock progress reported to the local player. */
export const LOCK_NONE = 0;
export const LOCK_ACQUIRING = 1;
export const LOCK_LOCKED = 2;

/** A parked (unoccupied) vehicle. Occupied hulls ride their driver entity. */
export interface SnapshotVehicle {
  transportRoute?: number;
  id: number;
  type: number;
  variant?: number;
  x: number; y: number; z: number;
  heading: number;
  health: number;
}
/** @deprecated Use ENT_PROJECTILE. Kept as a source-compatible alias. */
export const ENT_ROCKET = ENT_PROJECTILE;

export const PICKUP_HEALTH = 0;
export const PICKUP_AMMO = 1;
/** Cave loot: grants a full magazine of the spawnEmpty weapon it carries. */
export const PICKUP_WEAPON = 2;
export const PICKUP_RESULT_COLLECTED = 0;
export const PICKUP_RESULT_FULL = 1;

export type PickupKind =
  typeof PICKUP_HEALTH | typeof PICKUP_AMMO | typeof PICKUP_WEAPON;

/**
 * Stationary server-authoritative resource drop. Health pickups use
 * `weapon = -1`; ammo/weapon pickups identify the weapon they restore.
 */
export interface SnapshotPickup {
  id: number;
  kind: PickupKind;
  weapon: number;
  x: number; y: number; z: number;
}

export interface EntPlayer {
  transportRoute?: number;
  seat?: number;
  vehicleId?: number;
  kind: typeof ENT_PLAYER;
  id: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  grounded: boolean;
  dead: boolean;
  weapon: number;
  /** VEHICLE.NONE on foot; remote clients render the hull instead. */
  vehicle: number;
  vehicleVariant?: number;
  /** Hull yaw while driving (aim yaw is still `yaw`). */
  heading: number;
  /** Aircraft attitude is independent from the occupant view. */
  vehiclePitch?: number;
  vehicleRoll?: number;
  vehicleRotation?: Rotation;
}

export interface EntProjectile {
  kind: typeof ENT_PROJECTILE;
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  owner: number;
  weapon: number;
}

/** @deprecated Use EntProjectile. */
export type EntRocket = EntProjectile;

export type SnapshotEntity = EntPlayer | EntProjectile;

export interface AircraftThreat {
  /** 1: a launcher is tracking us, 2: full lock, 3: a guided missile is inbound. */
  stage: 1 | 2 | 3;
  /** Absolute world yaw toward the threatening launcher or nearest missile. */
  bearing: number;
  /** Approximate closing time in seconds; zero for launcher-only warnings. */
  eta: number;
}

export interface YourState {
  jumpAscent?: boolean;
  airlift?: AirliftFlight;
  transportRoute?: number;
  seat?: number;
  vehicleId?: number;
  airSeconds?: number;
  swimming?: boolean;
  submerged?: boolean;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  grounded: boolean;
  alive: boolean;
  dodgeCd: number;   // seconds
  health: number;
  weapon: number;
  cooldown: number;  // seconds until next shot
  ammo: WeaponAmmo[];
  /** Weapon being reloaded, or -1. */
  reloadWeapon: number;
  reloadCooldown: number;
  reloadHeld: boolean;
  /** VEHICLE.NONE on foot; otherwise the possessed vehicle type. */
  vehicle: number;
  vehicleVariant?: number;
  /** Hull yaw for prediction reconciliation. */
  heading: number;
  /** Jeep boost fuel 0..1. */
  boostFuel: number;
  vehiclePitch?: number;
  vehicleRoll?: number;
  vehicleRotation?: Rotation;
  boosting?: boolean;
  /** Current hull health while driving (display only, never predicted). */
  vehicleHealth: number;
  /** Seconds until this seat's primary and alternate weapons are ready
   * (display only; the reloads belong to the hull). */
  vehicleFireCd?: number;
  vehicleAltCd?: number;
  /** LOCK_NONE / LOCK_ACQUIRING / LOCK_LOCKED for the homing HUD. */
  lockState: number;
  /** Target-side radar warning, sent to every occupied aircraft seat. */
  aircraftThreat?: AircraftThreat;
}

export interface Snapshot {
  tick: number;
  lastSeq: number;
  you: YourState;
  ents: SnapshotEntity[];
  /**
   * Kept optional for source-compatible test/fixture construction. Decoded
   * network snapshots always contain an array.
   */
  pickups?: readonly SnapshotPickup[];
  /** Parked vehicles in interest range; optional like pickups. */
  vehicles?: readonly SnapshotVehicle[];
  creatures?: readonly CreatureState[];
}

const F_GROUNDED = 1;
const F_ALIVE = 2;
const F_DEAD = 2; // for remote entities: dead flag
const F_RELOAD_HELD = 4;
const F_BOOSTING = 8;

// ---- Client -> server ----------------------------------------------------

export function encodeHello(name: string): Uint8Array {
  return new ByteWriter(80).u8(Msg.CHello).u8(PROTOCOL_VERSION).str(name).finish();
}

export function encodeInput(cmd: InputCmd): Uint8Array {
  const w = new ByteWriter(24);
  w.u8(Msg.CInput);
  w.u32(cmd.seq);
  w.u16(cmd.buttons & 0xffff);
  w.u8(cmd.weapon & 0xff);
  w.u16(quantYaw(cmd.yaw));
  w.i16(quantPitch(cmd.pitch));
  w.tick(cmd.renderTick);
  w.u8(clamp(Math.round(cmd.renderFrac * 255), 0, 255));
  return w.finish();
}

export function decodeInput(r: ByteReader): InputCmd {
  return {
    seq: r.u32(),
    buttons: r.u16(),
    weapon: r.u8(),
    yaw: unquantYaw(r.u16()),
    pitch: unquantPitch(r.i16()),
    renderTick: r.tick(),
    renderFrac: r.u8() / 255,
  };
}

export function encodePing(sentAtMs: number, rttMs: number): Uint8Array {
  return new ByteWriter(16).u8(Msg.CPing).f64(sentAtMs).u16(clamp(Math.round(rttMs), 0, 65535)).finish();
}

// ---- Server -> client ----------------------------------------------------

function validateWelcomePads(pads: readonly TeleporterPad[]): void {
  if (pads.length > 255) throw new RangeError('Too many base teleporters');
  for (const pad of pads) {
    if (![pad.x, pad.y, pad.z].every(Number.isFinite) || typeof pad.cave !== 'boolean' ||
        !Number.isInteger(pad.partner) || pad.partner < 0 || pad.partner >= pads.length)
      throw new RangeError('Invalid base teleporter');
  }
}

/** Sent to a client built for another protocol before refusing it. Every
 * client version reads a welcome's version byte before anything else. */
export function encodeVersionNotice(): Uint8Array {
  return Uint8Array.of(Msg.SWelcome, PROTOCOL_VERSION);
}

export function encodeWelcome(yourId: number, seed: number, tick: number, teleporters: readonly TeleporterPad[] = []): Uint8Array {
  validateWelcomePads(teleporters);
  const w = new ByteWriter(24 + teleporters.length * 27).u8(Msg.SWelcome).u8(PROTOCOL_VERSION)
    .entity(yourId).u32(seed).tick(tick).u8(teleporters.length);
  // Preserve the server's placement doubles exactly. This small static list
  // is sent once on admission, rather than searched for on the render thread.
  for (const pad of teleporters) w.f64(pad.x).f64(pad.y).f64(pad.z).u8(pad.cave ? 1 : 0).u16(pad.partner);
  return w.finish();
}

export interface WelcomeMsg { version: number; yourId: number; seed: number; tick: number; teleporters: TeleporterPad[] }

export function decodeWelcome(r: ByteReader): WelcomeMsg {
  const welcome: WelcomeMsg = { version: r.u8(), yourId: r.entity(), seed: r.u32(), tick: r.tick(), teleporters: [] };
  const count = r.u8();
  if (r.remaining !== count * 27) throw new RangeError('Invalid base teleporter payload length');
  for (let i = 0; i < count; i++) {
    const x = r.f64(), y = r.f64(), z = r.f64(), cave = r.u8(), partner = r.u16();
    if (cave > 1) throw new RangeError('Invalid base teleporter cave flag');
    welcome.teleporters.push({ x, y, z, cave: cave === 1, partner });
  }
  validateWelcomePads(welcome.teleporters);
  return welcome;
}

export function encodePong(sentAtMs: number, serverTick: number): Uint8Array {
  return new ByteWriter(24).u8(Msg.SPong).f64(sentAtMs).tick(serverTick).finish();
}

export function encodeSnapshot(w: ByteWriter, snap: Snapshot): void {
  w.u8(Msg.SSnapshot);
  w.tick(snap.tick);
  w.u32(snap.lastSeq);
  const you = snap.you;
  w.f32(you.px).f32(you.py).f32(you.pz);
  w.f32(you.vx).f32(you.vy).f32(you.vz);
  w.u8(
    (you.grounded ? F_GROUNDED : 0) |
    (you.alive ? F_ALIVE : 0) |
    (you.reloadHeld ? F_RELOAD_HELD : 0) |
    (you.boosting ? F_BOOSTING : 0),
  );
  w.u16(clamp(Math.round(you.dodgeCd * 1000), 0, 65535));
  w.u8(clamp(Math.ceil(you.health), 0, 255));
  w.u8(you.weapon);
  // Weapon timers stay exact: prediction replays from them, and a rounded
  // value can move a shot or reload whose timer ends on a tick boundary.
  w.f64(you.cooldown);
  for (let i = 0; i < WEAPONS.length; i++) {
    const ammo = you.ammo[i];
    w.u16(clamp(Math.round(ammo?.magazine ?? 0), 0, 65535));
    w.u16(clamp(Math.round(ammo?.reserve ?? 0), 0, 65535));
  }
  w.u8(you.reloadWeapon < 0 ? 255 : clamp(you.reloadWeapon, 0, 254));
  w.f64(you.reloadCooldown);
  const yourVariant = validVehicleVariant(you.vehicle, you.vehicleVariant);
  w.u8(you.vehicle | (yourVariant ? 128 : 0));
  if (yourVariant) w.u8(yourVariant);
  if (you.vehicle) w.u8(you.seat ?? 0).entity(you.vehicleId ?? NO_ENTITY_ID)
    .u16(clamp(Math.ceil((you.vehicleFireCd ?? 0) * 100), 0, 65535)).u16(clamp(Math.ceil((you.vehicleAltCd ?? 0) * 100), 0, 65535));
  if (you.seat === 2) w.u8(you.transportRoute ?? 0);
  w.u16(quantYaw(you.heading));
  w.f32(you.vehiclePitch ?? 0).f32(you.vehicleRoll ?? 0);
  if (you.vehicle === VEHICLE.JET) {
    const q = vehicleQuaternion(you);
    w.f32(q.x).f32(q.y).f32(q.z).f32(q.w);
  }
  w.u8(clamp(Math.round(you.boostFuel * 255), 0, 255));
  w.u16(clamp(Math.round(you.vehicleHealth), 0, 65535));
  w.u8(clamp(you.lockState, 0, 255));
  if (you.vehicle === VEHICLE.JET) {
    const threat = you.aircraftThreat;
    w.u8(threat?.stage ?? 0);
    if (threat) w.u16(quantYaw(threat.bearing)).u16(clamp(Math.round(threat.eta * 100), 0, 65535));
  }
  w.u8(clamp(Math.round((you.airSeconds ?? 18) * 10), 0, 180));
  w.u8((you.swimming ? 1 : 0) | (you.submerged ? 2 : 0) | (you.airlift ? 4 : 0) | (you.jumpAscent ? 8 : 0));
  if (you.airlift) w.u8(you.airlift.source).u8(you.airlift.destination).tick(you.airlift.startTick).u16(you.airlift.durationTicks);

  w.u8(snap.ents.length);
  for (const e of snap.ents) {
    w.u8(e.kind);
    w.entity(e.id);
    w.f32(e.x).f32(e.y).f32(e.z);
    if (e.kind === ENT_PLAYER) {
      w.u16(quantYaw(e.yaw));
      w.i8(clamp(Math.round((e.pitch / (Math.PI / 2)) * 127), -127, 127));
      w.u8((e.grounded ? F_GROUNDED : 0) | (e.dead ? F_DEAD : 0));
      w.u8(e.weapon);
      const variant = validVehicleVariant(e.vehicle, e.vehicleVariant);
      w.u8(e.vehicle | (variant ? 128 : 0));
      if (variant) w.u8(variant);
      if (e.vehicle) w.u8(e.seat ?? 0).entity(e.vehicleId ?? NO_ENTITY_ID);
      if (e.seat === 2) w.u8(e.transportRoute ?? 0);
      w.u16(quantYaw(e.heading));
      w.i16(quantPitch(e.vehiclePitch ?? 0));
      w.u16(quantYaw(e.vehicleRoll ?? 0));
      if (e.vehicle === VEHICLE.JET) {
        const q = vehicleQuaternion(e);
        w.i16(Math.round(clamp(q.x, -1, 1) * 32767)).i16(Math.round(clamp(q.y, -1, 1) * 32767))
          .i16(Math.round(clamp(q.z, -1, 1) * 32767)).i16(Math.round(clamp(q.w, -1, 1) * 32767));
      }
    } else {
      w.i16(clamp(Math.round(e.vx * 64), -32767, 32767));
      w.i16(clamp(Math.round(e.vy * 64), -32767, 32767));
      w.i16(clamp(Math.round(e.vz * 64), -32767, 32767));
      w.entity(e.owner);
      w.u8(e.weapon);
    }
  }

  const pickups = snap.pickups ?? [];
  w.u8(clamp(pickups.length, 0, 255));
  for (let i = 0; i < pickups.length && i < 255; i++) {
    const p = pickups[i];
    w.entity(p.id)
      .u8(p.kind)
      .u8(p.weapon < 0 ? 255 : clamp(p.weapon, 0, 254))
      .f32(p.x).f32(p.y).f32(p.z);
  }

  const vehicles = snap.vehicles ?? [];
  w.u8(clamp(vehicles.length, 0, 255));
  for (let i = 0; i < vehicles.length && i < 255; i++) {
    const v = vehicles[i];
    const variant = validVehicleVariant(v.type, v.variant);
    w.entity(v.id).u8(v.type | (variant ? 128 : 0));
    if (variant) w.u8(variant);
    if (variant === 3) w.u8(v.transportRoute ?? 0);
    w.f32(v.x).f32(v.y).f32(v.z)
      .u16(quantYaw(v.heading))
      .u16(clamp(Math.round(v.health), 0, 65535));
  }
  const creatures = (snap.creatures ?? []).slice(0, MAX_VISIBLE_CREATURES);
  w.u8(creatures.length);
  for (const c of creatures) {
    w.entity(c.id).u8(c.species).f32(c.x).f32(c.y).f32(c.z)
      .u16(quantYaw(c.yaw)).u8(clamp(Math.round(c.speed * 20), 0, 255))
      .u8((c.alert ? 1 : 0) | (c.dead ? 2 : 0) | (c.windingUp ? 4 : 0) | (c.health !== undefined ? 8 : 0) | (c.rangedAttack ? 16 : 0));
    if (c.health !== undefined) w.u8(clamp(Math.round(c.health * 255), 0, 255));
    if (c.rangedAttack) {
      const a = c.rangedAttack;
      w.f32(a.originX).f32(a.originY).f32(a.originZ).f32(a.x).f32(a.y).f32(a.z)
        .f32(a.radius).tick(a.fireTick).tick(a.impactTick);
    }
  }
}

export function decodeSnapshot(r: ByteReader): Snapshot {
  const tick = r.tick();
  const lastSeq = r.u32();
  const you: YourState = {
    px: r.f32(), py: r.f32(), pz: r.f32(),
    vx: r.f32(), vy: r.f32(), vz: r.f32(),
    grounded: false, alive: false, dodgeCd: 0, health: 0, weapon: 0, cooldown: 0,
    ammo: [], reloadWeapon: -1, reloadCooldown: 0, reloadHeld: false,
    vehicle: 0, heading: 0, boostFuel: 1, vehicleHealth: 0, lockState: 0,
  };
  const flags = r.u8();
  you.grounded = (flags & F_GROUNDED) !== 0;
  you.alive = (flags & F_ALIVE) !== 0;
  you.reloadHeld = (flags & F_RELOAD_HELD) !== 0;
  you.boosting = (flags & F_BOOSTING) !== 0;
  you.dodgeCd = r.u16() / 1000;
  you.health = r.u8();
  you.weapon = r.u8();
  you.cooldown = r.f64();
  for (let i = 0; i < WEAPONS.length; i++) {
    you.ammo.push({ magazine: r.u16(), reserve: r.u16() });
  }
  const reloadWeapon = r.u8();
  you.reloadWeapon = reloadWeapon === 255 ? -1 : reloadWeapon;
  you.reloadCooldown = r.f64();
  const yourType = r.u8();
  you.vehicle = yourType & 127;
  if (yourType & 128) you.vehicleVariant = validVehicleVariant(you.vehicle, r.u8());
  if (you.vehicle) {
    const seat = r.u8(), vehicleId = r.entity(); if (seat) you.seat = seat; if (vehicleId !== NO_ENTITY_ID) you.vehicleId = vehicleId;
    you.vehicleFireCd = r.u16() / 100; you.vehicleAltCd = r.u16() / 100;
  }
  if (you.seat === 2) you.transportRoute = r.u8();
  you.heading = unquantYaw(r.u16());
  you.vehiclePitch = r.f32(); you.vehicleRoll = r.f32();
  if (you.vehicle === VEHICLE.JET) {
    you.vehicleRotation = normalizeRotation({ x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() });
  }
  you.boostFuel = r.u8() / 255;
  you.vehicleHealth = r.u16();
  you.lockState = r.u8();
  if (you.vehicle === VEHICLE.JET) {
    const stage = r.u8();
    if (stage) {
      const bearing = unquantYaw(r.u16()), eta = r.u16() / 100;
      if (stage <= 3) you.aircraftThreat = { stage: stage as 1 | 2 | 3, bearing, eta };
    }
  }
  const air = r.u8() / 10, liquidFlags = r.u8();
  if (air < 18) you.airSeconds = air;
  if (liquidFlags & 1) you.swimming = true;
  if (liquidFlags & 2) you.submerged = true;
  if (liquidFlags & 8) you.jumpAscent = true;
  if (liquidFlags & 4) you.airlift = { source:r.u8(), destination:r.u8(), startTick:r.tick(), durationTicks:r.u16() };

  const n = r.u8();
  const ents: SnapshotEntity[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    const id = r.entity();
    const x = r.f32(), y = r.f32(), z = r.f32();
    if (kind === ENT_PLAYER) {
      const yaw = unquantYaw(r.u16());
      const pitch = (r.i8() / 127) * (Math.PI / 2);
      const f = r.u8();
      const weapon = r.u8();
      const encodedVehicle = r.u8();
      const vehicle = encodedVehicle & 127;
      const vehicleVariant = encodedVehicle & 128 ? validVehicleVariant(vehicle, r.u8()) : 0;
      const seat = vehicle ? r.u8() : 0, vehicleId = vehicle ? r.entity() : NO_ENTITY_ID;
      const transportRoute = seat === 2 ? r.u8() : 0;
      const heading = unquantYaw(r.u16());
      const vehiclePitch = unquantPitch(r.i16());
      const vehicleRoll = unquantYaw(r.u16());
      const vehicleRotation = vehicle === VEHICLE.JET ? normalizeRotation({
        x: r.i16() / 32767, y: r.i16() / 32767, z: r.i16() / 32767, w: r.i16() / 32767,
      }) : undefined;
      ents.push({
        kind: ENT_PLAYER, id, x, y, z, yaw, pitch,
        grounded: (f & F_GROUNDED) !== 0,
        dead: (f & F_DEAD) !== 0,
        weapon,
        vehicle,
        ...(vehicleVariant ? { vehicleVariant } : {}),
        ...(seat ? { seat } : {}), ...(vehicleId !== NO_ENTITY_ID ? { vehicleId } : {}),
        ...(transportRoute ? { transportRoute } : {}),
        heading, vehiclePitch, vehicleRoll,
        ...(vehicleRotation ? { vehicleRotation } : {}),
      });
    } else {
      ents.push({
        kind: ENT_PROJECTILE, id, x, y, z,
        vx: r.i16() / 64, vy: r.i16() / 64, vz: r.i16() / 64,
        owner: r.entity(),
        weapon: r.u8(),
      });
    }
  }
  const pickupCount = r.u8();
  const pickups: SnapshotPickup[] = [];
  for (let i = 0; i < pickupCount; i++) {
    const id = r.entity();
    const kind = r.u8() as SnapshotPickup['kind'];
    const encodedWeapon = r.u8();
    pickups.push({
      id,
      kind,
      weapon: encodedWeapon === 255 ? -1 : encodedWeapon,
      x: r.f32(), y: r.f32(), z: r.f32(),
    });
  }
  const vehicleCount = r.u8();
  const vehicles: SnapshotVehicle[] = [];
  for (let i = 0; i < vehicleCount; i++) {
    const id = r.entity(), encodedType = r.u8(), type = encodedType & 127;
    const variant = encodedType & 128 ? validVehicleVariant(type, r.u8()) : 0;
    const transportRoute = variant === 3 ? r.u8() : 0;
    vehicles.push({
      id, type, ...(variant ? { variant } : {}),
      ...(transportRoute ? { transportRoute } : {}),
      x: r.f32(), y: r.f32(), z: r.f32(),
      heading: unquantYaw(r.u16()),
      health: r.u16(),
    });
  }
  const creatures: CreatureState[] = [];
  const creatureCount = r.u8();
  for (let i = 0; i < creatureCount; i++) {
    const id = r.entity(), species = r.u8(), x = r.f32(), y = r.f32(), z = r.f32();
    const yaw = unquantYaw(r.u16()), speed = r.u8() / 20, flags = r.u8();
    creatures.push({ id, species, x, y, z, yaw, speed, alert: (flags & 1) !== 0, dead: (flags & 2) !== 0,
      ...(flags & 4 ? { windingUp: true } : {}), ...(flags & 8 ? { health: r.u8() / 255 } : {}),
      ...(flags & 16 ? { rangedAttack: { originX: r.f32(), originY: r.f32(), originZ: r.f32(),
        x: r.f32(), y: r.f32(), z: r.f32(), radius: r.f32(), fireTick: r.tick(), impactTick: r.tick() } } : {}) });
  }
  return { tick, lastSeq, you, ents, pickups, vehicles, creatures };
}

// ---- Events --------------------------------------------------------------

export interface FireEnd { x: number; y: number; z: number; hitKind: number /* 0 world, 1 player, 2 air */ }
export interface FireEvent { shooter: number; weapon: number; seq: number; ox: number; oy: number; oz: number; ends: FireEnd[] }

export function encodeFire(ev: FireEvent): Uint8Array {
  const w = new ByteWriter(32 + ev.ends.length * 13);
  w.u8(Msg.SFire).entity(ev.shooter).u8(ev.weapon).u32(ev.seq);
  w.f32(ev.ox).f32(ev.oy).f32(ev.oz);
  w.u8(ev.ends.length);
  for (const e of ev.ends) {
    w.f32(e.x).f32(e.y).f32(e.z).u8(e.hitKind);
  }
  return w.finish();
}

export function decodeFire(r: ByteReader): FireEvent {
  const shooter = r.entity(), weapon = r.u8(), seq = r.u32();
  const ox = r.f32(), oy = r.f32(), oz = r.f32();
  const n = r.u8();
  const ends: FireEnd[] = [];
  for (let i = 0; i < n; i++) ends.push({ x: r.f32(), y: r.f32(), z: r.f32(), hitKind: r.u8() });
  return { shooter, weapon, seq, ox, oy, oz, ends };
}

export interface ExplosionEvent {
  x: number;
  y: number;
  z: number;
  weapon: number;
  projectileId: number;
}
export function encodeExplosion(
  x: number, y: number, z: number, weapon: number, projectileId: number,
): Uint8Array {
  return new ByteWriter(20)
    .u8(Msg.SExplosion)
    .f32(x).f32(y).f32(z)
    .u8(weapon)
    .entity(projectileId)
    .finish();
}
export function decodeExplosion(r: ByteReader): ExplosionEvent {
  return {
    x: r.f32(), y: r.f32(), z: r.f32(),
    weapon: r.u8(),
    projectileId: r.entity(),
  };
}

export interface DeathMotion { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number }
export interface DeathEvent { victim: number; killer: number; weapon: number; motion?: DeathMotion }
export function encodeDeath(victim: number, killer: number, weapon: number, motion?: DeathMotion): Uint8Array {
  const w = new ByteWriter(48).u8(Msg.SDeath).entity(victim).entity(killer).u8(weapon);
  if (motion) for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw'] as const) {
    if (!Number.isFinite(motion[key])) throw new Error('Invalid death motion');
    w.f32(motion[key]);
  }
  return w.finish();
}
export function decodeDeath(r: ByteReader): DeathEvent {
  const event: DeathEvent = { victim: r.entity(), killer: r.entity(), weapon: r.u8() };
  if (r.remaining) {
    if (r.remaining !== 28) throw new Error('Invalid death motion length');
    const motion = { x: r.f32(), y: r.f32(), z: r.f32(), vx: r.f32(), vy: r.f32(), vz: r.f32(), yaw: r.f32() };
    if (!Object.values(motion).every(Number.isFinite)) throw new Error('Invalid death motion');
    event.motion = motion;
  }
  return event;
}

export interface SpawnEvent { id: number; x: number; y: number; z: number }
export function encodeSpawn(id: number, x: number, y: number, z: number): Uint8Array {
  return new ByteWriter(17).u8(Msg.SSpawn).entity(id).f32(x).f32(y).f32(z).finish();
}
export function decodeSpawn(r: ByteReader): SpawnEvent {
  return { id: r.entity(), x: r.f32(), y: r.f32(), z: r.f32() };
}

export interface HitEvent { damage: number; kill: boolean }
export function encodeHit(damage: number, kill: boolean): Uint8Array {
  return new ByteWriter(4).u8(Msg.SHit).u8(clamp(Math.round(damage), 0, 255)).u8(kill ? 1 : 0).finish();
}
export function decodeHit(r: ByteReader): HitEvent {
  return { damage: r.u8(), kill: r.u8() !== 0 };
}

export interface PickupResultEvent {
  pickupId: number;
  kind: PickupKind;
  /** Finite-ammo weapon index, or -1 for health. */
  weapon: number;
  result: typeof PICKUP_RESULT_COLLECTED | typeof PICKUP_RESULT_FULL;
  /** Exact server-authoritative gain; zero when the represented resource is full. */
  amount: number;
}

export function encodePickupResult(ev: PickupResultEvent): Uint8Array {
  return new ByteWriter(12)
    .u8(Msg.SPickupResult)
    .entity(ev.pickupId)
    .u8(ev.kind)
    .u8(ev.weapon < 0 ? 255 : clamp(ev.weapon, 0, 254))
    .u8(ev.result)
    .f32(ev.amount)
    .finish();
}

export function decodePickupResult(r: ByteReader): PickupResultEvent {
  const pickupId = r.entity();
  const kind = r.u8() as PickupResultEvent['kind'];
  const encodedWeapon = r.u8();
  const result = r.u8() as PickupResultEvent['result'];
  const amount = r.f32();
  return {
    pickupId,
    kind,
    weapon: encodedWeapon === 255 ? -1 : encodedWeapon,
    result,
    amount,
  };
}

/** A player stepped on a teleporter pad and was moved to its partner. */
export interface TeleportEvent {
  id: number;
  fromX: number; fromY: number; fromZ: number;
  toX: number; toY: number; toZ: number;
}
export function encodeTeleport(ev: TeleportEvent): Uint8Array {
  return new ByteWriter(29)
    .u8(Msg.STeleport)
    .entity(ev.id)
    .f32(ev.fromX).f32(ev.fromY).f32(ev.fromZ)
    .f32(ev.toX).f32(ev.toY).f32(ev.toZ)
    .finish();
}
export function decodeTeleport(r: ByteReader): TeleportEvent {
  return {
    id: r.entity(),
    fromX: r.f32(), fromY: r.f32(), fromZ: r.f32(),
    toX: r.f32(), toY: r.f32(), toZ: r.f32(),
  };
}

export interface JoinEvent { id: number; name: string; bot?: boolean }
/** Roster entry. A trailing flag byte marks bots so clients can keep the
 * kill feed free of reinforcement churn. */
export function encodeJoin(id: number, name: string, bot = false): Uint8Array {
  return new ByteWriter(33).u8(Msg.SJoin).entity(id).str(name).u8(bot ? 1 : 0).finish();
}
export function decodeJoin(r: ByteReader): JoinEvent {
  const event: JoinEvent = { id: r.entity(), name: r.str() };
  if (r.remaining) event.bot = (r.u8() & 1) === 1;
  return event;
}

export function encodeLeave(id: number): Uint8Array {
  return new ByteWriter(5).u8(Msg.SLeave).entity(id).finish();
}

export interface ScoreRow { id: number; frags: number; deaths: number; ping: number }
export function encodeScores(rows: ScoreRow[]): Uint8Array {
  const w = new ByteWriter(4 + rows.length * 9);
  w.u8(Msg.SScores).u8(rows.length);
  for (const s of rows) {
    w.entity(s.id).i16(clamp(s.frags, -32768, 32767)).u16(clamp(s.deaths, 0, 65535)).u8(clamp(Math.round(s.ping / 4), 0, 255));
  }
  return w.finish();
}
export function decodeScores(r: ByteReader): ScoreRow[] {
  const n = r.u8();
  const rows: ScoreRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ id: r.entity(), frags: r.i16(), deaths: r.u16(), ping: r.u8() * 4 });
  }
  return rows;
}

export function encodeServerMessage(text: string): Uint8Array {
  return new ByteWriter(80).u8(Msg.SMessage).str(text, 255).finish();
}
