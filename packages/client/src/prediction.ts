import {
  World, TICK_DT, PLAYER, BTN,
  createMoveState, stepMove,
  createFullAmmoLoadout, stepWeaponState, idleWeaponStep,
  type MoveState, type InputCmd, type Snapshot, type StepResult,
  type WeaponState, type WeaponStepResult,
} from '@shared/index';
import { transitSupport, transitLocal, transitWorld } from '@shared/transit-motion';
import { transportPose } from '@shared/transport';
import { airliftPose } from '@shared/airlift';
import { carryCityLift } from '@shared/lifts';

// Client-side prediction + server reconciliation.
//
// Every predicted tick we run the SAME stepMove() the server runs and send
// the input. When a snapshot arrives we rewind to the authoritative state,
// replay all unacknowledged inputs, and smooth away whatever tiny error
// remains (usually zero, because the simulation is shared).

export interface PredictionStepResult extends StepResult {
  weapon: WeaponStepResult;
}

export class Prediction {
  /** Recovery is visible to the frame clock without replaying seconds of
   * obsolete movement and weapon commands after a stalled connection. */
  resyncVersion = 0;
  readonly state: MoveState = createMoveState(0, 100, 0);
  readonly weaponState: WeaponState = {
    weapon: 0,
    fireCd: 0,
    reloadWeapon: -1,
    reloadCd: 0,
    reloadHeld: false,
    ammo: createFullAmmoLoadout(),
  };
  initialized = false;
  /** Continuous presentation clock, shared by the camera and moving scenery. */
  renderSeconds = 0;
  private clockReady = false;
  private clockRate = 1;

  /** HUD mirrors (server-authoritative, locally predicted between snapshots). */
  health: number = PLAYER.MAX_HEALTH;
  alive = true;

  private pending: InputCmd[] = [];
  private errX = 0;
  private errY = 0;
  private errZ = 0;

  constructor(private readonly world: World) {}

  get cooldown(): number {
    return this.weaponState.fireCd;
  }

  /** Advance movement and combat by one tick and remember the input. */
  applyLocal(cmd: InputCmd): PredictionStepResult {
    const res = stepMove(this.world, this.state, cmd, TICK_DT);
    // Handheld weapons are holstered while driving - the server fires the
    // vehicle's armament instead, so predicting the held weapon here would
    // spray phantom shots that no snapshot ever confirms.
    const weapon = this.state.alive && this.state.vehicle === 0 && !this.state.airlift
      ? stepWeaponState(this.weaponState, cmd.weapon, cmd.buttons, TICK_DT)
      : idleWeaponStep();
    this.pending.push(cmd);
    if (this.pending.length > 240) this.pending.shift();
    return { ...res, weapon };
  }

  onSnapshot(snap: Snapshot): void {
    const you = snap.you;
    const wasAlive = this.alive;
    let oldX = this.state.px, oldY = this.state.py, oldZ = this.state.pz;
    const oldSeconds = (this.state.simulationTick ?? snap.tick) * TICK_DT;
    const oldSupport = this.initialized ? transitSupport(this.world, this.state, oldSeconds) : null;
    const oldVelocity = { x: this.state.vx, y: this.state.vy, z: this.state.vz };
    const oldAirborne = !this.state.grounded;

    // Adopt authoritative state.
    this.state.simulationTick = snap.tick;
    this.state.px = you.px; this.state.py = you.py; this.state.pz = you.pz;
    this.state.vx = you.vx; this.state.vy = you.vy; this.state.vz = you.vz;
    this.state.grounded = you.grounded;
    this.state.jumpAscent = you.jumpAscent;
    this.state.alive = you.alive;
    const flightChanged = this.state.airlift?.startTick !== you.airlift?.startTick;
    this.state.airlift = you.airlift ? { ...you.airlift } : undefined;
    this.state.dodgeCd = you.dodgeCd;
    const nextVariant = you.vehicle === 0 ? 0 : you.vehicleVariant ?? 0;
    const vehicleChanged = this.state.vehicle !== you.vehicle || this.state.vehicleVariant !== nextVariant || (this.state.seat ?? 0) !== (you.seat ?? 0) || this.state.vehicleId !== you.vehicleId;
    this.state.vehicle = you.vehicle;
    this.state.vehicleVariant = nextVariant;
    this.state.seat = you.seat; this.state.vehicleId = you.vehicleId;
    this.state.transportRoute = you.transportRoute;
    this.state.heading = you.heading;
    this.state.boostFuel = you.boostFuel;
    this.state.vehiclePitch = you.vehiclePitch ?? 0;
    this.state.vehicleRoll = you.vehicleRoll ?? 0;
    this.state.vehicleRotation = you.vehicleRotation ? { ...you.vehicleRotation } : undefined;
    this.state.boosting = you.boosting ?? false;
    this.state.airSeconds = you.airSeconds ?? 18;
    this.state.swimming = you.swimming ?? false; this.state.submerged = you.submerged ?? false;
    if (vehicleChanged) {
      // Entering/exiting happens server-side; the replay below re-simulates
      // pending inputs in the new mode, and the error smoothing would only
      // drag a stale on-foot offset across the possession boundary.
      this.errX = 0; this.errY = 0; this.errZ = 0;
    }

    this.weaponState.weapon = you.weapon;
    this.weaponState.fireCd = you.cooldown;
    this.weaponState.reloadWeapon = you.reloadWeapon;
    this.weaponState.reloadCd = you.reloadCooldown;
    this.weaponState.reloadHeld = you.reloadHeld;
    const full = createFullAmmoLoadout();
    this.weaponState.ammo = full.map((fallback, i) => ({
      magazine: you.ammo[i]?.magazine ?? fallback.magazine,
      reserve: you.ammo[i]?.reserve ?? fallback.reserve,
    }));

    // Drop acknowledged inputs; seed jumpHeld from the acked input so the
    // first replayed tick sees the correct jump edge.
    let acked: InputCmd | null = null;
    while (this.pending.length && this.pending[0].seq <= snap.lastSeq) {
      acked = this.pending.shift()!;
    }
    if (this.pending.length > 60) {
      this.pending.length = 0;
      this.resyncVersion++;
      this.errX = this.errY = this.errZ = 0;
    }
    this.state.jumpHeld = acked ? (acked.buttons & BTN.JUMP) !== 0 : this.state.jumpHeld;

    // Replay unacknowledged inputs on top.
    for (const cmd of this.pending) {
      stepMove(this.world, this.state, cmd, TICK_DT);
      if (this.state.alive && this.state.vehicle === 0 && !this.state.airlift) {
        stepWeaponState(this.weaponState, cmd.weapon, cmd.buttons, TICK_DT);
      }
    }

    // Compare at the same transport time. Replaying a different number of
    // ticks must not turn ordinary deck travel into a positional correction.
    const seconds = this.state.simulationTick! * TICK_DT;
    const support = transitSupport(this.world, this.state, seconds);
    if (oldSupport && support && oldSupport.route.id === support.route.id && oldSupport.car === support.car) {
      const aligned = transitWorld(support.pose, oldSupport.local.x, oldSupport.local.y, oldSupport.local.z);
      oldX = aligned.x; oldY = aligned.y; oldZ = aligned.z;
    } else if (oldAirborne && !this.state.grounded && Math.abs(seconds - oldSeconds) < .25) {
      oldX += oldVelocity.x * (seconds - oldSeconds);
      oldY += oldVelocity.y * (seconds - oldSeconds);
      oldZ += oldVelocity.z * (seconds - oldSeconds);
    }
    // Smooth the correction unless it is a teleport (respawn, hard snap).
    const dx = oldX - this.state.px;
    const dy = oldY - this.state.py;
    const dz = oldZ - this.state.pz;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const respawned = !wasAlive && you.alive;
    if (!this.initialized || respawned || vehicleChanged || flightChanged || you.airlift || err > 3) {
      this.errX = 0; this.errY = 0; this.errZ = 0;
      if (!this.initialized || respawned || (!you.airlift && err > 3)) this.clockReady = false;
    } else {
      this.errX = Math.max(-1.5, Math.min(1.5, this.errX + dx));
      this.errY = Math.max(-1.5, Math.min(1.5, this.errY + dy));
      this.errZ = Math.max(-1.5, Math.min(1.5, this.errZ + dz));
    }

    this.health = you.health;
    this.alive = you.alive;
    this.initialized = true;
  }

  /** Per-frame error decay. */
  frame(dt: number, fraction = 0): void {
    const f = Math.max(0, 1 - 8 * dt);
    this.errX *= f; this.errY *= f; this.errZ *= f;
    const target = ((this.state.simulationTick ?? 0) + fraction) * TICK_DT;
    if (!this.clockReady || Math.abs(target - this.renderSeconds) > .5) {
      this.renderSeconds = target; this.clockReady = true; this.clockRate = 1;
    } else {
      const error = target - (this.renderSeconds + dt);
      const rate = 1 + Math.max(-.12, Math.min(.12, error * 3));
      this.clockRate += (rate - this.clockRate) * Math.min(1, dt * 4);
      this.renderSeconds += dt * this.clockRate;
    }
  }

  /** Where to render the local player (predicted + smoothing offset). */
  renderPos(): { x: number; y: number; z: number } {
    if (this.state.airlift) {
      const pose = airliftPose(this.world.collectTransportPlan(), this.state.airlift,
        this.clockReady ? this.renderSeconds / TICK_DT : this.state.simulationTick ?? 0);
      if (pose) return {x:pose.x,y:pose.y,z:pose.z};
    }
    const p = {
      x: this.state.px + this.errX,
      y: this.state.py + this.errY,
      z: this.state.pz + this.errZ,
    };
    if (!this.clockReady) return p;
    const seconds = (this.state.simulationTick ?? 0) * TICK_DT;
    const support = transitSupport(this.world, this.state, seconds);
    if (support) {
      const local = transitLocal(support.pose, p.x, p.y, p.z);
      const pose = transportPose(support.route, this.renderSeconds, support.route.carOffsets[support.car]);
      return transitWorld(pose, local.x, local.y, local.z);
    }
    if (this.state.grounded) {
      const ghost={...this.state,px:p.x,py:p.y,pz:p.z};
      if(carryCityLift(this.world,ghost,seconds,this.renderSeconds))p.y=ghost.py;
    }
    if (!this.state.grounded) {
      const dt = Math.max(-.15, Math.min(.15, this.renderSeconds - seconds));
      p.x += this.state.vx * dt; p.y += this.state.vy * dt; p.z += this.state.vz * dt;
    }
    return p;
  }

  hardResync(): void {
    this.pending.length = 0;
    this.initialized = false;
    this.clockReady = false;
    this.errX = 0; this.errY = 0; this.errZ = 0;
  }
}
