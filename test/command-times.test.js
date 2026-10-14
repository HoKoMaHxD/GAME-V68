import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config as base, at, user, other, snowflake } from './helpers/shop-fixture.js';
import { nextReset } from '../src/time.js';
import { commandTimesPayload } from '../src/bank-commands.js';

const channelId = '100000000000000060';
const config = { ...base, clanChatChannelId: '100000000000000041', voiceChannelId: '100000000000000042' };
const visible = text => text.replace(/[\u200e\u200f\u2066-\u2069]/g, '');
async function setup(start = at) {
  const f = await fixture(); let now = start;
  f.store.config = { ...config }; f.service.config = f.store.config; f.service.clock = () => now;
  f.documents.settings[0].bank.salaryAmount = 500;
  await f.store.initializeActivity(start); await f.store.robbery.initialize(start);
  const input = sequence => ({ id: snowflake(now, sequence), userId: user, channelId, at: now });
  return { ...f, input, view: () => f.service.commandTimes(user, channelId, true), time: value => { now = value; } };
}
function disallowWrites(f) {
  f.intercept(({ method }) => assert.ok(['findOne'].includes(method), `وقت attempted ${method}`));
}

test('وقت reads a new member without assigning tasks, creating days or writing anything', async () => {
  const f = await setup(), before = structuredClone(f.documents);
  disallowWrites(f);
  const view = await f.view();
  for (const key of ['salary', 'prize', 'robbery']) assert.equal(view[key].status, 'ready');
  assert.deepEqual(view.quest, { status: 'daily', resetsAt: nextReset(at), completed: 0, total: 6 });
  assert.equal(view.protection.status, 'none');
  assert.deepEqual(await f.view(), view); assert.deepEqual(f.documents, before);
});

test('salary and prize deadlines persist across midnight and restart and become ready at their exact boundaries', async () => {
  const start = nextReset(at) - 1000, f = await setup(start);
  await f.service.claimSalary(f.input(10));
  await f.service.claimPrize(f.input(11), () => true, min => min === 0 ? 2 : 500);
  const before = structuredClone(f.documents); disallowWrites(f);
  for (const elapsed of [2000, 3600000 - 1, 3600000, 7200000 - 1, 7200000]) {
    const view = await f.open(start + elapsed).service.commandTimes(user, channelId);
    for (const [key, interval] of [['salary', 3600000], ['prize', 7200000]]) {
      assert.deepEqual(view[key], elapsed < interval ? { status: 'cooldown', nextAt: start + interval } : { status: 'ready' });
    }
  }
  assert.deepEqual(f.documents, before);
});

test('disabled commands and quest ineligibility are not shown as ready', async () => {
  const f = await setup(); f.documents.settings[0].bank.salaryEnabled = false;
  f.documents.settings[0].bank.robberyEnabled = false;
  const view = await f.service.commandTimes(user, channelId, false);
  assert.equal(view.salary.status, 'disabled'); assert.equal(view.robbery.status, 'disabled');
  assert.equal(view.quest.status, 'ineligible'); assert.equal(view.prize.status, 'ready');
  const fields = commandTimesPayload(view).embeds[0].data.fields;
  assert.match(fields[0].value, /موقوف/); assert.match(fields[2].value, /رتبته في أرينا/);
  f.documents.settings[0].bank.salaryEnabled = true; f.documents.settings[0].bank.salaryAmount = 0;
  assert.equal((await f.view()).salary.status, 'disabled');
});

test('protection reports the full stacked expiration and allows buying more while protected', async () => {
  const f = await setup(); await f.seed(user, 30000);
  await f.service.buyProtection(f.input(10)); f.time(at + 1000);
  const receipt = await f.service.buyProtection(f.input(11));
  const before = structuredClone(f.documents); disallowWrites(f);
  assert.deepEqual((await f.view()).protection, { status: 'active', expiresAt: receipt.protection.expiresAt });
  const card = commandTimesPayload(await f.view()).embeds[0].data;
  assert.match(visible(card.fields.find(f => f.name === 'حماية من النهب').value), /05:59:59/); assert.match(card.fields.find(f => f.name === 'حماية من النهب').value, /سعر ومدة الحماية/);
  f.time(receipt.protection.expiresAt);
  assert.equal((await f.view()).protection.status, 'none'); assert.deepEqual(f.documents, before);
});

test('robbery reports an open challenge and ignores expired or invalidated challenges', async () => {
  const f = await setup();
  const round = await f.service.openRobbery({ ...f.input(10), targetId: other }, () => true, min => min);
  assert.deepEqual((await f.view()).robbery, { status: 'open', expiresAt: round.expiresAt });
  f.documents.settings[0].bank.channelVersion++;
  assert.deepEqual((await f.view()).robbery, { status: 'cooldown', nextAt: at + 60000 });
  f.documents.settings[0].bank.channelVersion--;
  f.time(round.expiresAt); assert.equal((await f.view()).robbery.status, 'ready');
});

test('remaining time rounds up a partial second and public payloads never ping members', async () => {
  const f = await setup(); await f.service.claimSalary(f.input(10)); f.time(at + 3600000 - 1);
  const payload = commandTimesPayload(await f.view());
  assert.match(visible(payload.embeds[0].data.fields[0].value), /00:00:01/);
  assert.match(payload.embeds[0].data.description, /عند إرسال البطاقة/);
  assert.deepEqual(payload.allowedMentions, { parse: [] }); assert.deepEqual(payload.components, []);
  await assert.rejects(f.service.commandTimes(user, other, true), /فقط/);
  f.service.blocked = true; await assert.rejects(f.view(), /الاحتساب متوقف/);
});
