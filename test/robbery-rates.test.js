import test from 'node:test';
import assert from 'node:assert/strict';
import { newRobberyRound, resolveRobbery } from '../src/robbery.js';
import { robberyPayload } from '../src/robbery-commands.js';
import { at, user, other, snowflake } from './helpers/shop-fixture.js';
const input = { id: snowflake(at), userId: user, targetId: other, channelId: '100000000000000060', at };
const balances = { user: { tasks: 1000, attendance: 0, total: 1000 }, target: { tasks: 2000, attendance: 0, total: 2000 } };
for (const upper of [false, true]) test(`independent ${upper ? 'upper' : 'lower'} boundaries for wins, losses and timeouts`, () => {
  const round = newRobberyRound(input, at, (min, max) => min === 0 ? 0 : upper ? max - 1 : min);
  assert.equal(round.percent, upper ? 40 : 15); assert.equal(round.lossPercent, upper ? 60 : 40);
  assert.equal(resolveRobbery(round, 'paper', balances).amount, upper ? 800 : 300);
  assert.equal(resolveRobbery(round, 'scissors', balances).amount, upper ? 600 : 400);
  assert.equal(resolveRobbery({ ...round, endReason: 'timeout' }, null, balances).percent, round.lossPercent);
});
test('unequal balances tie at zero with no payer, recipient, debit or misleading equality claim', () => {
  const round = newRobberyRound(input, at, min => min);
  const result = resolveRobbery(round, 'rock', balances);
  assert.deepEqual([result.percent, result.amount, result.fromId, result.toId], [0, 0, null, null]);
  assert.deepEqual(result.after, { user: 1000, target: 2000 }); assert.deepEqual(result.debit, { tasks: 0, attendance: 0 });
  const payload = robberyPayload({ ...round, status: 'settled', playerMove: 'rock', result });
  assert.match(payload.embeds[0].data.description, /0%/);
  assert.doesNotMatch(payload.embeds[0].data.description, /الرصيدان متساويان/);
});
test('unfinished old rounds get bounded deterministic rates and zero ties', () => {
  const legacy = { ...input, percent: 49, tiePercent: 5, botMove: 'rock' };
  assert.equal(resolveRobbery(legacy, 'paper', balances).percent, 40);
  assert.equal(resolveRobbery(legacy, 'scissors', balances).percent, 49);
  assert.equal(resolveRobbery(legacy, 'rock', balances).amount, 0);
  assert.deepEqual(resolveRobbery(legacy, 'scissors', balances), resolveRobbery(legacy, 'scissors', balances));
});


test('pending version 2 rounds use the reduced upper loss bound after upgrade', () => {
  const old = { ...input, botMove: 'rock', percentageVersion: 2, percent: 30, lossPercent: 70 };
  assert.equal(resolveRobbery(old, 'scissors', balances).percent, 60);
});
