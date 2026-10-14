// Historical parser/catalog helpers remain covered here. Automatic quest delivery
// has been retired; its replacement is tested in accepted-only.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameFacts, parseGameMessage, rawGameMessage } from '../src/game-facts.js';
import { GameTracker } from '../src/games.js';
import { MongoStore } from '../src/store.js';
import { QuestService } from '../src/service.js';
import { createDay, seedTemplates, defaultGameTemplate, appendGameTask, validateTemplate, TASK_SET_VERSION, DEFAULT_GAME_TASK_ID } from '../src/domain.js';
import { dayStart, dayKey } from '../src/time.js';
import { tasksEmbed, rulesEmbed } from '../src/presentation.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { readConfig } from '../src/config.js';

const config = { clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
  gamesBotId: '995439183650889888', gamesChannelId: '1142961202004234330' };
const user = '100000000000000010', other = '100000000000000011', outsider = '100000000000000099';
const at = dayStart('2026-09-09') + 3600000;
const id = n => String(500000000000000000n + BigInt(n));
const clone = value => structuredClone(value);
const mention = userId => '<@' + userId + '>';
const gameTemplate = { id: 'game-fixture', title: 'شارك في 5 أقيام ألعاب', type: 'games', channelId: config.gamesChannelId,
  target: 5, reward: 230, repeat: 1, enabled: true, forUser: null, createdAt: at - 1000 };
const buttons = [{ type: 1, components: [{ type: 2, label: 'طرد', custom_id: 'fixture', disabled: true }] }];
const image = [{ filename: 'winner.png', content_type: 'image/png', url: 'https://example.invalid/winner.png' }];
function raw(n, text, extra = {}) {
  return { id: id(n), guild_id: config.arenaGuildId, channel_id: config.gamesChannelId,
    author: { id: config.gamesBotId, bot: true }, type: 0, content: text, timestamp: new Date(at).toISOString(),
    attachments: [], embeds: [], components: [], ...extra };
}
const lost = (n, who = user, extra = {}) => ({ t: 'MESSAGE_CREATE', d: raw(n, 'تم طرد ' + mention(who) + ' بالطرد العشوائي، سوف تبدأ الجولة القادمة قريبًا ⏰', extra) });
const won = (n, who = user, extra = {}) => ({ t: 'MESSAGE_CREATE', d: raw(n, '> - ' + mention(who), { attachments: image, ...extra }) });
const withdrawn = (n, who = user, extra = {}) => ({ t: 'MESSAGE_CREATE', d: raw(n, 'لقد انسحب ' + mention(who) + ' من القيم', extra) });
const joinButtons = [{ type: 1, components: [{ type: 2, style: 1, label: 'دخول', custom_id: 'join-fixture' }] }];
const lobby = (n, count = 0, extra = {}) => ({ t: 'MESSAGE_CREATE',
  d: raw(n, 'المشاركين: (' + count + '/20)', { components: joinButtons, ...extra }) });

// Exercise the actual MongoStore state/event/outbox/day APIs against an atomic
// collection double. This does not claim to run a MongoDB server or Discord.
function fixture({ templates = [...seedTemplates(config), gameTemplate], clockAt = at } = {}) {
  const data = new Map();
  const documents = name => { if (!data.has(name)) data.set(name, new Map()); return data.get(name); };
  const matches = (row, query) => Object.entries(query).every(([key, value]) => row[key] === value);
  let clock = clockAt, lease = true;
  const store = Object.create(MongoStore.prototype);
  Object.assign(store, { config, resetAllAt: 0, memberResetAt: new Map(), settingsId: 'settings-fixture', taskSetActivatedAt: 0 });
  store.requireLease = async () => { if (!lease) throw new Error('fixture lease lost'); };
  store.db = { collection: name => {
    const rows = documents(name);
    const find = query => [...rows.values()].filter(row => matches(row, query));
    return {
      findOne: async query => clone(find(query)[0] || null),
      insertOne: async row => { if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); rows.set(row._id, clone(row)); },
      replaceOne: async (query, row, options = {}) => {
        const original = find(query)[0];
        if (!original && !options.upsert) return { matchedCount: 0 };
        rows.set(row._id, clone(row)); return { matchedCount: original ? 1 : 0 };
      },
      updateOne: async (query, change, options = {}) => {
        let row = find(query)[0];
        if (!row && options.upsert) {
          row = { ...clone(query), _id: query._id || query.id }; rows.set(row._id, row);
        }
        if (!row) return { matchedCount: 0 };
        Object.assign(row, clone(change.$set || {}));
        for (const key of Object.keys(change.$unset || {})) delete row[key];
        return { matchedCount: 1 };
      },
      deleteMany: async query => { const selected = find(query); selected.forEach(row => rows.delete(row._id)); return { deletedCount: selected.length }; },
      find: query => {
        let selected = find(query);
        const cursor = {
          sort: fields => { selected.sort((a, b) => { for (const [key, order] of Object.entries(fields)) {
            if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * order;
          } return 0; }); return cursor; },
          limit: count => { selected = selected.slice(0, count); return cursor; },
          toArray: async () => clone(selected)
        }; return cursor;
      }
    };
  }};
  templates.forEach(t => documents('templates').set(t.id, { ...clone(t), _id: t.id, clanId: config.clanGuildId, taskSetVersion: TASK_SET_VERSION }));
  documents('settings').set(store.settingsId, { _id: store.settingsId, taskSetVersion: TASK_SET_VERSION,
    attendance: { channelId: config.voiceChannelId } });
  const service = new QuestService(store, config, () => clock);
  const members = new Set([user, other]);
  const createTracker = () => new GameTracker({ config, store, service, memberIds: () => members, clock: () => clock });
  return { store, service, members, createTracker, data, documents, clock: n => { clock = n; },
    lease: n => { lease = n; }, task: async (who = user, when = clock) => (await service.day(who, when)).tasks.find(t => t.type === 'games') };
}

test('all games use the same trusted elimination proof; an actor mention is not credited', () => {
  const message = raw(1, '✅ **تم طرد** ' + mention(user) + ' بواسطة ' + mention(other));
  assert.deepEqual(parseGameMessage(message, config), { kind: 'elimination', userIds: [user] });
  assert.deepEqual(parseGameMessage(lost(1).d, config)?.userIds, [user]);
  for (const patch of [{ author: { id: outsider, bot: true } }, { author: { id: config.gamesBotId, bot: false } },
    { channel_id: config.generalChannelId }, { guild_id: config.clanGuildId }, { type: 7 }]) {
    assert.equal(parseGameMessage({ ...message, ...patch }, config), null);
  }
});
test('role mentions, ordinary turns, registration expulsions and withdrawals do not qualify', () => {
  for (const text of ['تم طرد <@&' + user + '>', '> - ' + mention(user), 'الدور على ' + mention(user),
    'تم طرد ' + mention(user) + ' من التسجيل', 'تم طرد ' + mention(user) + ' من اللوبي',
    'تم طرد ' + mention(user) + ' قبل بداية اللعبة', 'انسحب ' + mention(user)]) {
    assert.equal(parseGameMessage(raw(1, text), config), null, text);
  }
});
test('winner requires the quoted dash mention, an image and absence of interactive components', () => {
  assert.deepEqual(parseGameMessage(won(1).d, config), { kind: 'win', userIds: [user] });
  for (const extra of [{ components: buttons }, { components: [{ type: 17, components: buttons }] },
    { attachments: [] }, { attachments: [{ filename: 'fake.png', content_type: 'application/pdf' }] },
    { attachments: [{ filename: 'movie.mp4', content_type: 'video/mp4' }] }, { content: 'الفائز ' + mention(user) }]) {
    assert.equal(parseGameMessage(won(1, user, extra).d, config), null);
  }
  assert.equal(parseGameMessage(won(1, user, { attachments: [], embeds: [{ image: { url: 'https://example.invalid/image' } }] }).d, config)?.kind, 'win');
});
test('winner lists and supported embed text preserve exact member IDs without name/OCR matching', () => {
  const message = raw(1, '', { embeds: [{ description: '> - ' + mention(user) + '\n> - ' + mention(other)
    + '\n> - ' + mention(user), image: { url: 'https://example.invalid/image' } }] });
  assert.deepEqual(parseGameMessage(message, config)?.userIds, [user, other]);
  assert.equal(parseGameMessage(raw(1, '> - Sky', { attachments: image }), config), null);
});
test('raw partial updates preserve omitted buttons and recognize their explicit removal', async () => {
  const facts = new GameFacts(config);
  assert.equal(await facts.read({ t: 'MESSAGE_CREATE', d: won(1, user, { components: buttons }).d }, at), null);
  const update = { t: 'MESSAGE_UPDATE', d: { id: id(1), channel_id: config.gamesChannelId, embeds: [] } };
  assert.equal(await facts.read(update, at + 100), null);
  const event = await facts.read({ ...update, d: { ...update.d, components: [] } }, at + 200);
  assert.equal(event.kind, 'win'); assert.equal(event.at, at + 200);
});
test('an uncached update reads only that message and never assumes absent buttons mean empty', async () => {
  const fetched = [];
  const facts = new GameFacts(config, async mid => { fetched.push(mid); return won(1, user, { components: buttons }).d; });
  const update = { t: 'MESSAGE_UPDATE', d: { id: id(1), channel_id: config.gamesChannelId, embeds: [] } };
  assert.equal(await facts.read(update, at), null); assert.deepEqual(fetched, [id(1)]);
  assert.equal((await facts.read({ ...update, d: { ...update.d, components: [] } }, at)).kind, 'win');
  await assert.rejects(new GameFacts(config).read(update, at), /الرسالة الأصلية/);
  const denied = new GameFacts(config, async () => { throw new Error('fixture inaccessible'); });
  await assert.rejects(denied.read(update, at), /inaccessible/);
});
test('old creates, malformed dates and future events cannot become new games', async () => {
  const facts = new GameFacts(config);
  for (const timestamp of [new Date(at - 120001).toISOString(), new Date(at + 5001).toISOString(), 'bad date']) {
    assert.equal(await facts.read(lost(1, user, { timestamp }), at), null);
  }
  assert.equal(await facts.read({ t: 'MESSAGE_UPDATE', d: { channel_id: config.generalChannelId } }, at), null);
});
test('SDK hydration accepts both library message types and maps image/component metadata', () => {
  for (const type of [0, 'DEFAULT', 19, 'REPLY']) {
    const data = rawGameMessage({ id: id(1), guildId: config.arenaGuildId, channelId: config.gamesChannelId,
      author: { id: config.gamesBotId, bot: true }, type, content: '> - ' + mention(user), createdTimestamp: at,
      attachments: new Map([['a', { name: 'x.png', contentType: 'image/png' }]]), components: [], embeds: [] });
    assert.equal(parseGameMessage(data, config)?.kind, 'win');
  }
});

















test('a new games template does not backfill pre-creation proofs and keeps a selected reward immutable', () => {
  const day = createDay(config.clanGuildId, user, dayKey(at), seedTemplates(config), at);
  const future = { ...gameTemplate, createdAt: at + 10 };
  assert.equal(appendGameTask(day, [future], at), false);
  assert.equal(appendGameTask(day, [future], at + 10), true);
  assert.equal(appendGameTask(day, [{ ...future, reward: 999 }], at + 11), false);
  assert.equal(day.tasks[4].reward, 230);
});
test('personal game template wins its own slot without displacing targeted non-game tasks', () => {
  const templates = [...seedTemplates(config), gameTemplate, { ...gameTemplate, id: 'personal', forUser: user }];
  const day = createDay(config.clanGuildId, user, dayKey(at), templates, at);
  assert.equal(day.tasks.length, 5); assert.equal(day.tasks[4].id, 'personal');
  assert.equal(createDay(config.clanGuildId, other, dayKey(at), templates, at).tasks[4].id, 'game-fixture');
});
test('games validation enforces one reward per day and disallows message/voice-only conditions', () => {
  assert.equal(validateTemplate(clone(gameTemplate)).type, 'games');
  for (const patch of [{ repeat: 2 }, { target: 1001 }, { requiredRoleId: config.memberRole }, { requiresMedia: true }]) {
    assert.throws(() => validateTemplate({ ...gameTemplate, ...patch }));
  }
});

test('games bot/channel default to the supplied IDs and overrides require valid IDs', () => {
  const env = { OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'fixture', MONGODB_URI: 'mongodb://example.invalid/test',
    CLAN_GUILD_ID: config.clanGuildId, ARENA_GUILD_ID: config.arenaGuildId, GENERAL_CHANNEL_ID: config.generalChannelId, CLAN_CHAT_CHANNEL_ID: '100000000000000005',
    FEELING_CHANNEL_ID: config.feelingChannelId, LOOK_CHANNEL_ID: config.lookChannelId,
    CLAN_MEMBER_ROLE_ID: config.memberRole, CLAN_VOICE_CHANNEL_ID: config.voiceChannelId };
  assert.equal(readConfig(env).gamesBotId, config.gamesBotId);
  assert.equal(readConfig(env).gamesChannelId, config.gamesChannelId);
  assert.throws(() => readConfig({ ...env, ARENA_GAMES_CHANNEL_ID: 'bad' }), /ARENA_GAMES_CHANNEL_ID/);
});
test('archived game templates retain channel validation and cannot promise automatic participation rewards', async () => {
  const command = buildCommands().find(c => c.name === 'ادارة_المهام');
  assert.ok(command.options[0].options.find(o => o.name === 'النوع').choices.some(c => c.value === 'games'));
  const f = fixture(); let added = null, reply;
  f.store.addTemplate = async task => { added = task; };
  const handler = createHandler({ config, store: f.store, service: f.service, isMember: () => true,
    validateChannel: async () => {}, refreshSettings: async () => {}, onError: () => {} });
  const values = { الاسم: 'شارك في الألعاب', النوع: 'games', الروم: config.generalChannelId, العدد: 5, النقاط: 150 };
  const interaction = { isButton: () => false, isChatInputCommand: () => true, commandName: 'ادارة_المهام',
    guildId: config.clanGuildId, user: { id: user }, memberPermissions: { has: () => true },
    deferReply: async () => {}, editReply: async result => { reply = result; },
    options: { getSubcommand: () => 'اضافة', getString: key => values[key] ?? null, getInteger: key => values[key] ?? null,
      getBoolean: () => null, getUser: () => null } };
  await handler(interaction); assert.equal(added, null); assert.match(reply.content, /ARENA_GAMES_CHANNEL_ID/);
  values.الروم = config.gamesChannelId;
  await handler(interaction); assert.equal(added.type, 'games'); assert.equal(added.target, 5);
  assert.equal(added.reward, 150); assert.equal(added.repeat, 1); assert.match(reply.content, /قوالب المهام اليومية/);
  assert.match(reply.content, /التعيينات الجديدة تلقائيًا/);
});

test('confirmed withdrawal identifies the withdrawing member only, including formatted mentions', () => {
  assert.deepEqual(parseGameMessage(withdrawn(1).d, config), { kind: 'withdrawal', userIds: [user] });
  assert.deepEqual(parseGameMessage(raw(1, '👋 **لقد انسحب** اللاعب <@!' + user + '> — المتبقي ' + mention(other)), config),
    { kind: 'withdrawal', userIds: [user] });
  assert.equal(parseGameMessage(raw(1, 'لقد انسحب <@&' + user + '>'), config), null);
  assert.equal(parseGameMessage(withdrawn(1, user, { author: { id: outsider, bot: true } }).d, config), null);
});
test('explicit registration withdrawal and ambiguous terminal notices do not qualify', () => {
  for (const content of ['لقد انسحب ' + mention(user) + ' من التسجيل',
    'لقد انسحب ' + mention(user) + ' قبل بداية اللعبة',
    'لقد انسحب ' + mention(user) + '\nتم طرد ' + mention(other)]) {
    assert.equal(parseGameMessage(raw(1, content), config), null);
  }
});
test('registration needs a participant counter and an enabled join button from the trusted source', () => {
  assert.deepEqual(parseGameMessage(lobby(1).d, config), { kind: 'lobby', userIds: [] });
  for (const extra of [{ components: [] }, { components: buttons },
    { components: [{ type: 1, components: [{ type: 2, label: 'دخول', disabled: true }] }] },
    { components: [{ type: 1, components: [{ type: 2, label: 'دخول', style: 5, url: 'https://example.invalid' }] }] },
    { content: 'المشاركين: ' + mention(user) },
    { content: 'تم إلغاء اللعبة — المشاركين: 5' }, { content: 'اضغط دخول' },
    { author: { id: outsider, bot: true } }, { channel_id: config.generalChannelId }]) {
    assert.equal(parseGameMessage(lobby(1, 5, extra).d, config), null);
  }
});
test('participant counters in embed fields or button labels support Arabic numerals without awarding the list', () => {
  const fields = lobby(1, 0, { content: '', embeds: [{ title: 'التسجيل في اللعبة', fields: [
    { name: '👥 المشاركين', value: '**١٢/٢٠**\n' + mention(user) + ' ' + mention(other) }
  ] }] }).d;
  assert.deepEqual(parseGameMessage(fields, config), { kind: 'lobby', userIds: [] });
  const labels = lobby(2, 0, { content: '', components: [{ type: 1, components: [
    { type: 2, style: 1, label: 'انضمام', custom_id: 'join' },
    { type: 2, style: 2, label: 'المشاركين: ۴', custom_id: 'count', disabled: true }
  ] }] }).d;
  assert.deepEqual(parseGameMessage(labels, config), { kind: 'lobby', userIds: [] });
});
test('counter updates retain the registration creation time and stale cards cannot create fresh boundaries', async () => {
  const facts = new GameFacts(config);
  assert.equal((await facts.read(lobby(1), at)).at, at);
  const update = { t: 'MESSAGE_UPDATE', d: { id: id(1), channel_id: config.gamesChannelId,
    content: 'المشاركين: 2', edited_timestamp: new Date(at + 1000).toISOString() } };
  assert.equal((await facts.read(update, at + 1000)).at, at);
  update.d.edited_timestamp = new Date(at + 200000).toISOString();
  assert.equal(await facts.read(update, at + 200000), null);
});
test('participant counts and list mentions never increment any member quest', async () => {
  const f = fixture(); const tracker = f.createTracker(); await tracker.start();
  await tracker.receive(lobby(1, 2, { content: 'المشاركين: 2\n' + mention(user) + '\n' + mention(other) }));
  assert.equal(f.documents('days').size, 0);
  assert.equal((await f.store.getGameRoom(tracker.roomId)).current.id, id(1));
  assert.equal(tracker.lastProofAt, null);
});













const terminalPhrases = ['لقد تم تفجير', 'المافيا قامت بقتل المواطن', 'تم إعدام', 'تم العثور على'];
test('terminal game notices credit only the explicitly mentioned victim', () => {
  for (const phrase of terminalPhrases) {
    const text = '💥 **' + phrase + '**: <@!' + user + '> بواسطة ' + mention(other);
    for (const message of [raw(1, text), raw(1, '', { embeds: [{ description: text }] })]) {
      assert.deepEqual(parseGameMessage(message, config), { kind: 'elimination', userIds: [user] });
    }
    for (const patch of [{ author: { id: outsider, bot: true } }, { channel_id: config.generalChannelId },
      { guild_id: config.clanGuildId }, { author: { id: config.gamesBotId, bot: false } }]) {
      assert.equal(parseGameMessage(raw(1, text, patch), config), null);
    }
    assert.equal(parseGameMessage(raw(1, phrase + ' <@&' + user + '>'), config), null);
    assert.equal(parseGameMessage(raw(1, phrase + ' ' + mention(user) + ' قبل بداية اللعبة'), config), null);
  }
  assert.deepEqual(parseGameMessage(raw(1, 'تم اعدام ' + mention(user)), config)?.userIds, [user]);
});
test('explicit winners heading accepts one or several mentions without requiring an image', () => {
  for (const text of [
    'قائمة الفائزين ' + mention(user),
    '🏆 **قائمة الفائزين**:\n> - ' + mention(user) + '\n> - ' + mention(other),
    'قائمة الفائزين: ' + mention(user) + '، ' + mention(other) + ' و ' + mention(user),
    'قائمة الفائزين\n١. ' + mention(user) + '\n2. <@!' + other + '>'
  ]) {
    const result = parseGameMessage(raw(1, text), config);
    assert.equal(result?.kind, 'win');
    assert.deepEqual(result.userIds, text.includes(other) ? [user, other] : [user]);
  }
});
test('winners heading in embed titles, descriptions and field names preserves list boundaries', () => {
  for (const embed of [
    { title: '🏆 قائمة الفائزين', description: mention(user) + '\n' + mention(other) },
    { title: 'قائمة الفائزين', fields: [{ name: '1', value: mention(user) }, { name: '2', value: mention(other) }] },
    { description: 'قائمة الفائزين:\n' + mention(user) + '\n' + mention(other) },
    { fields: [{ name: 'قائمة الفائزين', value: mention(user) + ' ' + mention(other) },
      { name: 'المضيف', value: mention(outsider) }] }
  ]) assert.deepEqual(parseGameMessage(raw(1, '', { embeds: [embed] }), config), { kind: 'win', userIds: [user, other] });
  const text = 'المضيف: ' + mention(outsider) + '\nقائمة الفائزين:\n' + mention(user)
    + '\nالخاسرون:\n> - ' + mention(other);
  assert.deepEqual(parseGameMessage(raw(1, text, { attachments: image }), config)?.userIds, [user]);
  const labeled = 'قائمة الفائزين:\n> - ' + mention(user) + ' — مواطن\n> - ' + mention(other)
    + ' (المافيا) بواسطة ' + mention(outsider);
  assert.deepEqual(parseGameMessage(raw(1, labeled), config)?.userIds, [user, other]);
});
test('winner lists reject roles, instructions, interactive cards and ambiguous mixed outcomes', () => {
  for (const text of [
    'قائمة الفائزين: <@&' + user + '>',
    'سيتم عرض قائمة الفائزين ' + mention(user),
    'قائمة الفائزين:\nالمضيف: ' + mention(user),
    'قائمة الفائزين:\nالخاسرون:\n> - ' + mention(user),
    'قائمة الفائزين ' + mention(user) + '\nتم إعدام ' + mention(other),
    'قائمة الفائزين ' + mention(user) + '\nلقد انسحب ' + mention(other)
  ]) assert.equal(parseGameMessage(raw(1, text, { attachments: image }), config), null, text);
  assert.equal(parseGameMessage(raw(1, 'قائمة الفائزين ' + mention(user), { components: buttons }), config), null);
  assert.equal(parseGameMessage(raw(1, 'قائمة الفائزين ' + mention(user), { author: { id: outsider, bot: true } }), config), null);
});


test('the default wins the games slot without removing custom templates; disabling it restores custom selection', () => {
  const personal = { ...gameTemplate, id: 'personal', forUser: user };
  const template = defaultGameTemplate(config, at - 500);
  const templates = [...seedTemplates(config), gameTemplate, personal, template];
  const today = createDay(config.clanGuildId, user, dayKey(at), templates, at);
  assert.equal(today.tasks.length, 5); assert.equal(today.tasks[4].id, DEFAULT_GAME_TASK_ID);
  template.enabled = false;
  assert.equal(createDay(config.clanGuildId, user, dayKey(at), templates, at).tasks[4].id, 'personal');
  assert.equal(appendGameTask(today, templates, at + 1), false);
});






test('chairs elimination message credits both members joined by Arabic waw', () => {
  const message = raw(1, '> 🪑 | تم طرد ' + mention(user) + ' و' + mention(other) + ' من اللعبة');
  assert.deepEqual(parseGameMessage(message, config), { kind: 'elimination', userIds: [user, other] });
});

const groupLost = (n, members = [user, other], extra = {}) => ({ t: 'MESSAGE_CREATE',
  d: raw(n, '> 🪑 | تم طرد ' + members.map(mention).join(' و') + ' من اللعبة', extra) });

test('group victims support connected waw, Arabic/English commas, whitespace and formatted mentions', () => {
  for (const separator of [' و', ' و ', '، ', ', ', '، و', ', and ', ' & ', ' ', '\n', '']) {
    const text = '> 🪑 | **تم طرد** \u200f<@!' + user + '>\u200f' + separator + '**' + mention(other) + '** من اللعبة';
    for (const message of [raw(1, text), raw(1, '', { embeds: [{ description: text }] }),
      raw(1, '', { embeds: [{ fields: [{ name: 'نتيجة الجولة', value: text }] }] })]) {
      assert.deepEqual(parseGameMessage(message, config), { kind: 'elimination', userIds: [user, other] }, separator);
    }
  }
});
test('group terminal lists stop before an actor or survivor and ignore role/channel mentions', () => {
  for (const phrase of ['تم طرد', ...terminalPhrases, 'لقد انسحب']) {
    const expectedKind = phrase === 'لقد انسحب' ? 'withdrawal' : 'elimination';
    for (const suffix of [' بواسطة ', ' من قبل ', ' — المتبقي ', ' واسم اللاعب ']) {
      assert.deepEqual(parseGameMessage(raw(1, phrase + ' ' + mention(user) + ' و' + mention(other)
        + suffix + mention(outsider)), config), { kind: expectedKind, userIds: [user, other] });
    }
    assert.deepEqual(parseGameMessage(raw(1, phrase + ' ' + mention(user) + ' و<@&' + other + '>'), config)?.userIds, [user]);
    assert.deepEqual(parseGameMessage(raw(1, phrase + ' ' + mention(user) + ' و<#' + other + '>'), config)?.userIds, [user]);
    assert.equal(parseGameMessage(raw(1, phrase + ' <@&' + user + '> و' + mention(other)), config), null);
  }
});
test('several group notices within one message retain all victims but deduplicate repeated member IDs', () => {
  const text = 'تم طرد ' + mention(user) + ' و' + mention(other) + ' من اللعبة\n'
    + 'تم طرد ' + mention(other) + '، ' + mention(outsider) + ' من اللعبة';
  assert.deepEqual(parseGameMessage(raw(1, text), config), { kind: 'elimination', userIds: [user, other, outsider] });
});






test('mafia detective murder is a valid participation proof for every victim in its list', () => {
  const text = 'المافيا قامت بقتل المحقق ' + mention(user) + ' و' + mention(other);
  assert.deepEqual(parseGameMessage(raw(1, text), config), { kind: 'elimination', userIds: [user, other] });
});
test('quoted winner image credits every winner on the same line', () => {
  const text = '> - ' + mention(user) + ' و' + mention(other);
  assert.deepEqual(parseGameMessage(raw(1, text, { attachments: image }), config), { kind: 'win', userIds: [user, other] });
});

const allProofFormats = [
  ...['تم طرد', 'لقد تم تفجير', 'المافيا قامت بقتل المواطن', 'المافيا قامت بقتل المحقق', 'تم إعدام']
    .map(prefix => ({ prefix, kind: 'elimination', suffix: ' من اللعبة' })),
  { prefix: 'لقد انسحب', kind: 'withdrawal', suffix: ' من القيم' },
  { prefix: 'قائمة الفائزين:', kind: 'win', suffix: '' },
  { prefix: '> -', kind: 'win', suffix: '', image: true },
  { prefix: 'تم العثور على', kind: 'elimination', suffix: '' }
];
function proofPacket(n, format, members, separator = ' و', extra = {}) {
  return { t: 'MESSAGE_CREATE', d: raw(n, format.prefix + ' ' + members.map(mention).join(separator) + format.suffix,
    { attachments: format.image ? image : [], ...extra }) };
}
test('every supported outcome extracts one, two, five or twenty exact user IDs from text and embeds', () => {
  const members = Array.from({ length: 20 }, (_, n) => String(BigInt(user) + BigInt(n)));
  for (const format of allProofFormats) for (const count of [1, 2, 5, 20]) {
    for (const separator of [' و', '، ', ', ', '\n', ' & ']) {
      const who = members.slice(0, count);
      const packet = proofPacket(1, format, who, separator);
      for (const message of [packet.d, { ...packet.d, content: '', embeds: [{ description: packet.d.content }] },
        { ...packet.d, content: '', embeds: [{ fields: [{ name: 'نتيجة اللعبة', value: packet.d.content }] }] }]) {
        assert.deepEqual(parseGameMessage(message, config), { kind: format.kind, userIds: who }, format.prefix + ' / ' + count);
      }
    }
  }
});
test('all outcome lists deduplicate members and stop before later actor, survivor or host mentions', () => {
  for (const format of allProofFormats) {
    const packet = proofPacket(1, format, [user, other, user]);
    for (const suffix of [' بواسطة ', ' — المتبقي ', '\nالمضيف: ']) {
      assert.deepEqual(parseGameMessage({ ...packet.d, content: packet.d.content + suffix + mention(outsider) }, config),
        { kind: format.kind, userIds: [user, other] }, format.prefix);
    }
  }
});
test('detective, found-member and group winner proofs require the trusted source and winning image conditions', () => {
  for (const format of [allProofFormats[3], allProofFormats[7], allProofFormats[8]]) {
    const message = proofPacket(1, format, [user, other]).d;
    for (const patch of [{ author: { id: outsider, bot: true } }, { author: { id: config.gamesBotId, bot: false } },
      { guild_id: config.clanGuildId }, { channel_id: config.generalChannelId }]) {
      assert.equal(parseGameMessage({ ...message, ...patch }, config), null);
    }
  }
  const quoted = proofPacket(1, allProofFormats[7], [user, other]).d;
  assert.equal(parseGameMessage({ ...quoted, attachments: [] }, config), null);
  assert.equal(parseGameMessage({ ...quoted, components: buttons }, config), null);
  assert.equal(parseGameMessage(raw(1, 'الدور على ' + mention(user) + ' و' + mention(other)), config), null);
  assert.deepEqual(parseGameMessage(lobby(1, 2, { content: 'المشاركين: 2\n' + mention(user) + ' و' + mention(other) }).d, config),
    { kind: 'lobby', userIds: [] });
});




test('found-member notices accept formatted mention lists and exclude unrelated or negated notices', () => {
  const text = '> 🔍 **تم العثور على**: <@!' + user + '> و' + mention(other) + '، ' + mention(user)
    + '\nبواسطة ' + mention(outsider);
  assert.deepEqual(parseGameMessage(raw(1, text), config), { kind: 'elimination', userIds: [user, other] });
  assert.deepEqual(parseGameMessage(raw(2, 'لقد تم العثور على ' + mention(user)), config)?.userIds, [user]);
  for (const content of ['لم يتم العثور على ' + mention(user), 'يتم العثور على ' + mention(user),
    'تم العثور على <@&' + user + '>', 'تم العثور على <#' + user + '>', 'تم العثور على اسم لاعب',
    'تم العثور على ' + mention(user) + ' قبل بداية اللعبة']) assert.equal(parseGameMessage(raw(1, content), config), null);
});




