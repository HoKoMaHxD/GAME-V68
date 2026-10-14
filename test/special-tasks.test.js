import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { seedSpecialTasks, validateSpecialTask, specialTaskPage, MAX_SPECIAL_TASKS } from '../src/special-tasks.js';
import { specialTasksEmbed } from '../src/presentation.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { MongoStore } from '../src/store.js';
import { parsePanelAction } from '../src/panel.js';

const clan = '100000000000000001';
const user = '100000000000000002';
const operation = '200000000000000001';
const at = Date.parse('2026-09-09T12:00:00Z');
const copy = value => structuredClone(value);
const entry = (id = operation) => ({ id, title: 'تنظيم فعالية للكلان', reward: 200, createdBy: user });

// Exercise the real store methods against atomic in-memory collection operations;
// no Discord connection or production database is used.
function fixture() {
  const store = Object.create(MongoStore.prototype);
  Object.assign(store, { config: { clanGuildId: clan }, settingsId: `settings:${clan}`, leaseId: `worker:${clan}`, owner: 'worker' });
  const documents = { task_boosts: [],
    settings: [{ _id: store.settingsId, attendance: { points: 10, dailyCap: 500 }, appearance: { name: 'SNOW' } },
      { _id: 'settings:other', specialTasks: [{ id: 'other', title: 'Other clan', reward: 99 }] }],
    leases: [{ _id: store.leaseId, owner: store.owner, expiresAt: Number.MAX_SAFE_INTEGER }],
    days: [{ _id: 'member-day', points: { tasks: 700, attendance: 300 }, tasks: [{ progress: 3 }] }],
    templates: [{ clanId: clan, id: 'daily-games-5', target: 5, reward: 500 }]
  };
  const controls = { lostAcknowledgement: false, failBeforeWrite: false };
  const writes = [];
  const matches = (doc, filter) => Object.entries(filter).every(([key, wanted]) => {
    const actual = key.split('.').reduce((value, part) => value?.[part], doc);
    if (wanted && typeof wanted === 'object') {
      if ('$exists' in wanted) return (actual !== undefined) === wanted.$exists;
      if ('$type' in wanted) return wanted.$type === 'array' && Array.isArray(actual);
      if ('$ne' in wanted) return key === 'specialTasks.id'
        ? !doc.specialTasks?.some(t => t.id === wanted.$ne) : actual !== wanted.$ne;
      if ('$gt' in wanted) return actual > wanted.$gt;
      throw new Error('Unsupported fixture query');
    }
    return actual === wanted;
  });
  const mutate = (name, filter, changes) => {
    if (controls.failBeforeWrite) { controls.failBeforeWrite = false; throw new Error('write failed'); }
    const doc = documents[name].find(d => matches(d, filter));
    if (!doc) return null;
    writes.push({ name, filter: copy(filter), changes: copy(changes) });
    Object.assign(doc, copy(changes.$set || {}));
    for (const [key, value] of Object.entries(changes.$push || {})) doc[key].push(copy(value));
    if (controls.lostAcknowledgement) { controls.lostAcknowledgement = false; throw new Error('acknowledgement lost'); }
    return copy(doc);
  };
  store.db = { collection: name => ({
    findOne: async filter => copy(documents[name].find(d => matches(d, filter)) || null),
    updateOne: async (filter, changes) => ({ modifiedCount: mutate(name, filter, changes) ? 1 : 0 }),
    findOneAndUpdate: async (filter, changes) => mutate(name, filter, changes)
  }) };
  return { store, documents, controls, writes };
}

test('special defaults match all three manual rewards and input validation rejects invalid titles and amounts', () => {
  assert.deepEqual(seedSpecialTasks(at).map(t => [t.title, t.reward]), [
    ['إدخال عضو للكلان عن طريقك', 250], ['الفوز في فعاليات الكلان', 150], ['حضور فعاليات الكلان', 50]
  ]);
  assert.deepEqual(validateSpecialTask({ title: '  مهمة خاصة  ', reward: 250 }), { title: 'مهمة خاصة', reward: 250 });
  for (const input of [{ title: '', reward: 50 }, { title: ' \n ', reward: 50 }, { title: 'a\nb', reward: 50 },
    { title: 'ا'.repeat(101), reward: 50 }, { title: 'valid', reward: 0 }, { title: 'valid', reward: 1.5 },
    { title: 'valid', reward: 100001 }, { title: 'valid', reward: '50' }]) assert.throws(() => validateSpecialTask(input));
});

test('initializing special tasks is atomic, clan scoped and preserves existing or empty catalogs on restart', async () => {
  const f = fixture(); const before = copy(f.documents);
  const results = await Promise.all(Array.from({ length: 10 }, () => f.store.initializeSpecialTasks(at)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(f.documents.settings[0], { ...before.settings[0], specialTasks: seedSpecialTasks(at) });
  assert.deepEqual(f.documents.settings[1], before.settings[1]);
  assert.deepEqual(f.documents.days, before.days); assert.deepEqual(f.documents.templates, before.templates);
  f.documents.settings[0].specialTasks[0].reward = 300;
  assert.equal(await f.store.initializeSpecialTasks(at + 86400000), false);
  assert.equal(f.documents.settings[0].specialTasks[0].reward, 300);
  f.documents.settings[0].specialTasks = [];
  assert.equal(await f.store.initializeSpecialTasks(at + 86400000), false);
  assert.deepEqual(f.documents.settings[0].specialTasks, []);
});

test('special task writes require a lease and initialization resumes after an uncertain acknowledgement', async () => {
  const f = fixture(); f.documents.leases = [];
  await assert.rejects(f.store.initializeSpecialTasks(at), /قفل تشغيل/);
  await assert.rejects(f.store.addSpecialTask(entry(), at), /قفل تشغيل/);
  assert.equal(f.writes.length, 0);
  const g = fixture(); g.controls.lostAcknowledgement = true;
  await assert.rejects(g.store.initializeSpecialTasks(at), /acknowledgement lost/);
  assert.equal(await g.store.initializeSpecialTasks(at + 1), false);
  assert.deepEqual(g.documents.settings[0].specialTasks, seedSpecialTasks(at));
});

test('concurrent special task additions and interaction replays preserve all entries without granting points', async () => {
  const f = fixture(); await f.store.initializeSpecialTasks(at);
  const before = copy(f.documents);
  const additions = Array.from({ length: 12 }, (_, i) => entry(String(BigInt(operation) + BigInt(i))));
  await Promise.all([...additions, ...additions].map(task => f.store.addSpecialTask(task, at + 1)));
  const saved = await f.store.settings();
  assert.equal(saved.specialTasks.length, 15);
  assert.equal(new Set(saved.specialTasks.map(t => t.id)).size, 15);
  assert.deepEqual(saved.specialTasks.slice(0, 3), before.settings[0].specialTasks);
  assert.deepEqual(f.documents.days, before.days); assert.deepEqual(f.documents.templates, before.templates);
  assert.deepEqual(saved.attendance, before.settings[0].attendance); assert.deepEqual(saved.appearance, before.settings[0].appearance);
  assert.deepEqual(f.documents.settings[1], before.settings[1]);
  const reopened = Object.assign(Object.create(MongoStore.prototype), f.store);
  assert.equal(await reopened.initializeSpecialTasks(at + 86400000), false);
  assert.equal((await reopened.addSpecialTask(additions[0], at + 2)).duplicate, true);
  assert.deepEqual((await reopened.settings()).specialTasks, saved.specialTasks);
});

test('catalog capacity stays atomic and failed or uncertain writes are reported without duplicating entries', async () => {
  const f = fixture(); await f.store.initializeSpecialTasks(at);
  f.documents.settings[0].specialTasks = Array.from({ length: MAX_SPECIAL_TASKS - 1 }, (_, i) => ({ ...entry(`old-${i}`), createdAt: at }));
  const results = await Promise.allSettled([f.store.addSpecialTask(entry(), at), f.store.addSpecialTask(entry('200000000000000002'), at)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.documents.settings[0].specialTasks.length, MAX_SPECIAL_TASKS);
  const g = fixture(); await g.store.initializeSpecialTasks(at);
  g.controls.failBeforeWrite = true;
  await assert.rejects(g.store.addSpecialTask(entry(), at), /write failed/);
  assert.equal((await g.store.settings()).specialTasks.length, 3);
  g.controls.lostAcknowledgement = true;
  const saved = await g.store.addSpecialTask(entry(), at);
  assert.equal(saved.task.title, entry().title);
  assert.equal((await g.store.settings()).specialTasks.length, 4);
  assert.equal((await g.store.addSpecialTask(entry(), at)).duplicate, true);
  await assert.rejects(g.store.addSpecialTask({ ...entry(), id: 'invalid' }, at), /معرف/);
});

function interaction({ name = 'مهمات_خاصة', customId, guildId = clan, owner = user, admin = false, title = 'تنظيم فعالية', reward = 200, page } = {}) {
  const calls = { replies: [], deferred: [], updates: 0, edits: [] };
  return { id: operation, commandName: name, customId, guildId, user: { id: owner }, calls,
    isButton: () => !!customId, isChatInputCommand: () => !customId,
    memberPermissions: { has: bit => admin && bit === PermissionFlagsBits.ManageGuild },
    options: { getSubcommand: () => 'اضافة_مهمة_خاصة', getString: () => title,
      getInteger: key => key === 'الصفحة' ? page ?? null : reward },
    reply: async p => calls.replies.push(p), deferReply: async p => calls.deferred.push(p),
    deferUpdate: async () => { calls.updates++; }, editReply: async p => calls.edits.push(p) };
}

function handlerContext(store) {
  const forbidden = () => { throw new Error('special catalog must not call scoring or automatic templates'); };
  const errors = [];
  store.templates = forbidden;
  return { config: { clanGuildId: clan }, store, errors, isMember: forbidden,
    service: { day: forbidden, adjustPoints: forbidden, reset: forbidden }, status: forbidden,
    validateChannel: forbidden, refreshSettings: forbidden, onError: error => { errors.push(error); } };
}

test('special slash command and all buttons privately display the saved catalog without activity or point writes', async () => {
  const f = fixture(); await f.store.initializeSpecialTasks(at);
  const before = copy(f.documents);
  for (const options of [{}, { customId: 'clan-panel:v1:special' }, { customId: `clan-view:v1:${user}:special` }]) {
    const i = interaction(options); await createHandler(handlerContext(f.store))(i);
    const payload = i.calls.edits[0]; const embed = payload.embeds[0].toJSON();
    assert.ok(embed.title.includes('مهمات خاصة'));
    assert.deepEqual(embed.fields.map(field => Number(field.value.match(/\d+/)[0])), [250, 150, 50]);
    assert.match(embed.description, /يدويًا/);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    if (options.customId?.startsWith('clan-view:')) assert.equal(i.calls.updates, 1);
    else assert.equal(i.calls.deferred[0].flags, MessageFlags.Ephemeral);
    assert.ok(payload.components.flatMap(row => row.toJSON().components).every(button => parsePanelAction(button.custom_id)));
  }
  assert.deepEqual(f.documents, before);
});

test('admin special-task command needs only a name and reward, enforces permissions and appears immediately on the list', async () => {
  const commands = buildCommands();
  assert.ok(commands.some(c => c.name === 'مهمات_خاصة'));
  const add = commands.find(c => c.name === 'ادارة_المهام').options.find(c => c.name === 'اضافة_مهمة_خاصة');
  assert.deepEqual(add.options.map(option => [option.name, option.required]), [['الاسم', true], ['النقاط', true]]);
  const f = fixture(); await f.store.initializeSpecialTasks(at);
  const before = copy(f.documents);
  const handle = createHandler(handlerContext(f.store));
  const denied = interaction({ name: 'ادارة_المهام' }); await handle(denied);
  assert.match(denied.calls.replies[0].content, /صلاحية إدارة/);
  const foreign = interaction({ name: 'ادارة_المهام', admin: true, guildId: 'other' }); await handle(foreign);
  assert.match(foreign.calls.replies[0].content, /سيرفر الكلان/);
  const invalid = interaction({ name: 'ادارة_المهام', admin: true, reward: 0 }); await handle(invalid);
  assert.ok(invalid.calls.edits[0].content.startsWith('❌'));
  assert.deepEqual(f.documents, before);
  const addRequest = interaction({ name: 'ادارة_المهام', admin: true }); await handle(addRequest);
  assert.match(addRequest.calls.edits[0].content, /تمت إضافة المهمة الخاصة/);
  assert.match(addRequest.calls.edits[0].content, /اضافة_نقاط/);
  assert.equal(addRequest.calls.deferred[0].flags, MessageFlags.Ephemeral);
  await handle(interaction({ name: 'ادارة_المهام', admin: true }));
  const list = interaction(); await createHandler(handlerContext(f.store))(list);
  assert.equal(list.calls.edits[0].embeds[0].toJSON().fields.length, 4);
  assert.match(list.calls.edits[0].embeds[0].toJSON().fields[3].name, /تنظيم فعالية/);
  assert.deepEqual(f.documents.days, before.days);
});

test('special catalog pagination retains all tasks, honors owner checks and stays within embed limits with images', async () => {
  const f = fixture(); await f.store.initializeSpecialTasks(at);
  const tasks = Array.from({ length: 23 }, (_, i) => ({ id: String(i), title: `${'*'.repeat(90)} @everyone ${i}`, reward: 100000 }));
  f.documents.settings[0].specialTasks = tasks;
  const collected = [];
  for (let page = 1; page <= 3; page++) {
    const slice = specialTaskPage(tasks, page); collected.push(...slice.tasks.map(t => t.id));
    const embed = specialTasksEmbed(tasks, page, { name: 'SNOW', imageUrl: 'https://example.com/banner.png', thumbnailUrl: 'https://example.com/icon.png' });
    assert.ok(embed.length <= 6000);
    const data = embed.toJSON();
    assert.equal(data.image.url, 'https://example.com/banner.png'); assert.equal(data.thumbnail.url, 'https://example.com/icon.png');
    assert.ok(data.fields.every(field => field.name.length <= 256 && field.value.length <= 1024 && !field.name.includes('@everyone')));
  }
  assert.deepEqual(collected, tasks.map(t => t.id));
  assert.equal(specialTaskPage(tasks, 99).page, 3);
  assert.match(specialTasksEmbed([]).toJSON().fields[0].value, /لا توجد/);
  const handle = createHandler(handlerContext(f.store));
  const first = interaction(); await handle(first);
  const next = first.calls.edits[0].components[1].toJSON().components[1];
  assert.equal(parsePanelAction(next.custom_id).page, 2);
  const stranger = interaction({ customId: next.custom_id, owner: '100000000000000099' }); await handle(stranger);
  assert.equal(stranger.calls.edits.length, 0); assert.equal(stranger.calls.updates, 0);
  const second = interaction({ customId: next.custom_id }); await createHandler(handlerContext(f.store))(second);
  assert.equal(second.calls.updates, 1);
  assert.ok(second.calls.edits[0].embeds[0].toJSON().fields[0].name.startsWith('⭐ 11'));
  for (const id of [`clan-special:v1:${user}:0:next`, `clan-special:v1:${user}:101:next`, `clan-special:v1:${user}:2:claim`]) {
    assert.equal(parsePanelAction(id), null);
  }
});
