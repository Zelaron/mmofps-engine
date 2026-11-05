import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { advanceDaily, dailyStatus, progressStatus } from '../src/progression.js';
import { capturePlayer, restorePlayer } from '../src/persistence.js';
import { DAILY_COUNT, DAILY_ORDERS, dailyDay, dailyOrders, XP_REASON } from '@shared/progression';

const DAY = 86_400_000;

test('every day has three distinct orders, one of them a kill order, the same for everyone', () => {
  const seen = new Set<string>();
  for (let day = 20_000; day < 20_060; day++) {
    const orders = dailyOrders(day);
    assert.equal(orders.length, DAILY_COUNT);
    assert.equal(orders[0].metric, 'kills', 'anyone can progress');
    assert.equal(new Set(orders.map(o => o.metric)).size, DAILY_COUNT, 'distinct kinds');
    assert.deepEqual(dailyOrders(day), orders, 'deterministic');
    for (const order of orders) seen.add(order.id);
  }
  assert.ok(seen.size >= DAILY_ORDERS.length - 1, `the catalogue rotates (${seen.size} of ${DAILY_ORDERS.length} used)`);
});

test('orders count up from the reward events, pay once when done and reset at UTC midnight', () => {
  const sent: Uint8Array[] = [];
  const g = new Game(1337, { frontier: true });
  const player = g.addPlayer('Daily', { send: (bytes: Uint8Array) => { sent.push(bytes); } } as unknown as Parameters<Game['addPlayer']>[1], false);
  const now = 20_100 * DAY + 3_600_000, orders = dailyOrders(dailyDay(now));
  const kill = orders[0];
  for (let i = 0; i < kill.goal - 1; i++) advanceDaily(player, 'kills', 1, now);
  assert.equal(dailyStatus(player, now).orders[0].progress, kill.goal - 1);
  assert.equal(player.xp, 0, 'no bonus before the goal');
  advanceDaily(player, 'kills', 1, now);
  assert.equal(player.xp, kill.xp);
  assert.equal(sent.at(-1)![3], XP_REASON.DAILY, 'the client hears which reward it was');
  advanceDaily(player, 'kills', 5, now);
  assert.equal(player.xp, kill.xp, 'a finished order pays once');
  const status = progressStatus(player, now)!;
  assert.equal(status.daily!.orders[0].done, true);
  assert.equal(status.daily!.resetsIn, 23 * 3600, 'one hour into the UTC day');
  const other = orders[1];
  if (other.metric === 'streak') { advanceDaily(player, 'streak', 2, now); advanceDaily(player, 'streak', 1, now);
    assert.equal(dailyStatus(player, now).orders[1].progress, 2, 'a streak order keeps the best streak'); }
  // Saved and restored with the character.
  const saved = JSON.parse(JSON.stringify(capturePlayer(g, player)));
  const again = g.addPlayer('Daily again', null, false); restorePlayer(g, again, saved);
  assert.deepEqual([again.dailyDay, again.dailyProgress, again.dailyDone], [player.dailyDay, player.dailyProgress, player.dailyDone]);
  // A new day brings new orders and fresh progress.
  const tomorrow = now + DAY;
  assert.equal(dailyStatus(player, tomorrow).orders.every(o => o.progress === 0 && !o.done), true);
  const bot = g.addPlayer('Bot', null, true);
  advanceDaily(bot, 'kills', 50, now);
  assert.equal(bot.xp, 0, 'bots have no orders');
});
