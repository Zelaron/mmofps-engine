import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShaderCommandQueue } from '../src/render/shader-command-queue.js';
import { ShaderPreparation } from '../src/render/shader-preparation.js';

const program = () => ({}) as WebGLProgram;
function fixture() {
  let time = 0;
  const state = { lost: false, nullFence: false, status: 0x911b,
    onCreate: undefined as (() => void) | undefined, onWait: undefined as (() => void) | undefined };
  const created: WebGLSync[] = [], deleted: WebGLSync[] = [];
  const waits: [WebGLSync, number, number][] = [];
  let flushes = 0;
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911a,
    TIMEOUT_EXPIRED: 0x911b, CONDITION_SATISFIED: 0x911c, WAIT_FAILED: 0x911d,
    isContextLost: () => state.lost,
    fenceSync: (condition: number, flags: number) => {
      assert.equal(condition, gl.SYNC_GPU_COMMANDS_COMPLETE); assert.equal(flags, 0);
      state.onCreate?.();
      if (state.nullFence) return null;
      const fence = {} as WebGLSync; created.push(fence); return fence;
    },
    flush: () => { flushes++; },
    clientWaitSync: (fence: WebGLSync, flags: number, timeout: number) => {
      waits.push([fence, flags, timeout]); state.onWait?.(); return state.status;
    },
    deleteSync: (fence: WebGLSync) => {
      assert.equal(state.lost, false, 'lost-context handles must never be deleted');
      assert(!deleted.includes(fence), 'a sync must be deleted at most once');
      deleted.push(fence);
    },
  };
  const queue = new ShaderCommandQueue(gl as unknown as WebGL2RenderingContext, () => time);
  return { queue, gl, state, created, deleted, waits, setTime: (value: number) => { time = value; },
    get flushes() { return flushes; } };
}

test('command submission yields and polls only with zero timeout until signaled', () => {
  const f = fixture(), a = program();
  assert.equal(f.queue.poll([]), true);
  assert.equal(f.queue.poll([a]), false);
  assert.equal(f.created.length, 1); assert.equal(f.flushes, 1); assert.equal(f.waits.length, 0);
  for (let i = 0; i < 3; i++) assert.equal(f.queue.poll([a]), false);
  assert.equal(f.created.length, 1);
  assert(f.waits.every(([sync, flags, timeout]) => sync === f.created[0] && flags === 0 && timeout === 0));
  f.state.status = f.gl.ALREADY_SIGNALED;
  assert.equal(f.queue.poll([a]), true);
  assert.deepEqual(f.deleted, f.created);
  assert.equal(f.queue.poll([a]), true); assert.equal(f.queue.fallbackCount, 0);
});

test('ShaderPreparation verification only rearms for newly appeared native programs', () => {
  const f = fixture(), visible = [program()];
  let submissions = 0;
  const preparation = new ShaderPreparation(() => {
    if (++submissions === 2) visible.push(program());
  }, () => f.queue.poll(visible));
  assert.equal(preparation.poll(), false);
  assert.equal(preparation.poll(), false); assert.equal(submissions, 1);
  f.state.status = f.gl.CONDITION_SATISFIED;
  assert.equal(preparation.poll(), false, 'verification discovered a second variant');
  assert.equal(f.created.length, 2);
  assert.equal(preparation.poll(), true, 'unchanged verification does not create an endless fence loop');
  assert.equal(preparation.pending, false); assert.equal(submissions, 3);
  assert.deepEqual(f.deleted, f.created);
  assert.equal(preparation.poll(), true); assert.equal(submissions, 3);
});

test('same-count replacements supersede a pending fence and removed handles are forgotten', () => {
  const f = fixture(), a = program(), b = program();
  assert.equal(f.queue.poll([a]), false);
  assert.equal(f.queue.poll([b]), false);
  assert.equal(f.created.length, 2); assert.deepEqual(f.deleted, [f.created[0]]);
  assert.equal(f.waits.length, 0, 'superseded work is never polled');
  f.state.status = f.gl.ALREADY_SIGNALED;
  assert.equal(f.queue.poll([b]), true);
  assert.equal(f.queue.poll([a]), false, 'pruned handles do not remain permanently retained');
  assert.equal(f.created.length, 3);
  assert.equal(f.queue.poll([]), true);
  assert.deepEqual(f.deleted, f.created);
});

test('null fences and failed polls yield once then preserve ordinary first-use error checks', () => {
  for (const mode of ['null', 'wait'] as const) {
    const f = fixture(), visible = [program()];
    f.state.nullFence = mode === 'null';
    const preparation = new ShaderPreparation(() => {}, () => f.queue.poll(visible));
    assert.equal(preparation.poll(), false);
    if (mode === 'wait') {
      f.state.status = f.gl.WAIT_FAILED;
      assert.equal(preparation.poll(), false, 'a wait failure also yields its discovery frame');
    }
    assert.equal(f.queue.fallbackCount, 1);
    assert.equal(preparation.poll(), true);
    const firstUse = () => { if (preparation.poll()) throw new Error('ordinary shader link failure'); };
    assert.throws(firstUse, /ordinary shader link failure/);
    assert.equal(f.queue.fallbackCount, 1, 'verification does not retry the failed batch');
    assert.equal(f.created.length, mode === 'null' ? 0 : 1);
    assert.deepEqual(f.deleted, f.created);
    f.queue.reset();
    assert.equal(f.queue.fallbackCount, 1, 'telemetry survives world resets');
    f.state.nullFence = false; f.state.status = f.gl.ALREADY_SIGNALED;
    assert.equal(f.queue.poll(visible), false); assert.equal(f.queue.poll(visible), true);
    assert.equal(f.queue.fallbackCount, 1);
  }
});

test('a never-signaling batch falls back after ten seconds but signaled work wins at the deadline', () => {
  const f = fixture(), a = program();
  assert.equal(f.queue.poll([a]), false);
  f.setTime(9999); assert.equal(f.queue.poll([a]), false); assert.equal(f.queue.fallbackCount, 0);
  f.setTime(10_000); assert.equal(f.queue.poll([a]), false); assert.equal(f.queue.fallbackCount, 1);
  assert.equal(f.queue.poll([a]), true); assert.equal(f.created.length, 1);
  const g = fixture(), b = program();
  assert.equal(g.queue.poll([b]), false);
  g.setTime(10_001); g.state.status = g.gl.ALREADY_SIGNALED;
  assert.equal(g.queue.poll([b]), true); assert.equal(g.queue.fallbackCount, 0);
});

test('live reset deletes once and context loss discards handles until fresh restored preparation', () => {
  const f = fixture(), a = program();
  assert.equal(f.queue.poll([a]), false);
  f.queue.reset(); f.queue.reset(); assert.deepEqual(f.deleted, f.created);
  assert.equal(f.queue.poll([a]), false);
  f.state.lost = true;
  f.queue.reset(); assert.equal(f.deleted.length, 1);
  assert.equal(f.queue.poll([a]), false); assert.equal(f.queue.poll([]), false);
  assert.equal(f.waits.length, 0); assert.equal(f.created.length, 2);
  f.state.lost = false;
  assert.equal(f.queue.poll([a]), false, 'restoration needs a new fence even for an identical test handle');
  f.state.status = f.gl.ALREADY_SIGNALED;
  assert.equal(f.queue.poll([a]), true);
  assert.deepEqual(f.deleted, [f.created[0], f.created[2]]);
  assert.equal(f.queue.fallbackCount, 0);
});

test('context loss during fence creation or polling never becomes a counted fallback or readiness', () => {
  for (const mode of ['create', 'wait'] as const) {
    const f = fixture(), a = program();
    if (mode === 'create') {
      f.state.nullFence = true; f.state.onCreate = () => { f.state.lost = true; };
    }
    assert.equal(f.queue.poll([a]), false);
    if (mode === 'wait') {
      f.state.status = f.gl.WAIT_FAILED; f.state.onWait = () => { f.state.lost = true; };
      assert.equal(f.queue.poll([a]), false);
    }
    assert.equal(f.queue.poll([a]), false); assert.equal(f.queue.fallbackCount, 0);
    assert.equal(f.deleted.length, 0);
    f.state.onCreate = f.state.onWait = undefined; f.state.nullFence = false; f.state.lost = false;
    assert.equal(f.queue.poll([a]), false);
    f.state.status = f.gl.ALREADY_SIGNALED;
    assert.equal(f.queue.poll([a]), true); assert.equal(f.queue.fallbackCount, 0);
  }
});
