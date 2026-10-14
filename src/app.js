import { FullResetControl } from './full-reset-control.js';
import { ShipManager } from './ship-game-commands.js';
import { RuntimeControl } from './runtime-control.js';
import { SpamMonitor } from './spam-monitor.js';
import { BankLiveViews } from './bank-live-views.js';
import { bankPagePayload } from './bank-leaderboard.js';
import { FinancialLogger } from './financial-log.js';
import { createServer } from 'node:http';
import { setTimeout as taskDelay } from 'node:timers/promises';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { readConfig } from './config.js';
import { loginReady } from './auth.js';
import { MongoStore } from './store.js';
import { QuestService } from './service.js';
import { VoiceTracker } from './voice.js';
import { clanVoiceChannels, trackedVoiceChannels, trackedVoiceCategories, readVoiceSnapshot } from './voice-channels.js';
import { ClanMembership } from './membership.js';
import { MembershipRecovery } from './membership-recovery.js';
import { trackingBlocker } from './membership-status.js';
import { MessageFacts } from './message-facts.js';
import { isUserMessage } from './message-channels.js';
import { GameTracker } from './games.js';
import { rawGameMessage } from './game-facts.js';
import { DailyQuestViews, QUEST_REFRESH_MS } from './daily-quest-views.js';
import { buildCommands, createHandler, checkSourceChannel } from './commands.js';
import { PanelManager, createSetupMessageHandler } from './panel.js';
import { ShopNotifier } from './shop-notifications.js';
import { MemberNotifier } from './member-notifications.js';
import { AuctionManager } from './auction-manager.js';
import { BoostManager } from './task-boost-commands.js';
import { MemoryManager } from './memory-commands.js';
import { BoxesManager } from './boxes-game-commands.js';
import { DotManager } from './dot-game-commands.js';
import { NumbersManager } from './numbers-game-commands.js';
import { MinesManager } from './mines-game-commands.js';
import { ButtonGameManager } from './button-game-commands.js';
import { XoManager } from './xo-commands.js';
import { MiniGameManager } from './mini-game-commands.js';
import { RobberyManager } from './robbery-manager.js';
import { BotPermissions } from './permissions.js';
import { createTextCommands } from './experience-commands.js';
import { startup, protectSecret } from './startup.js';
import { AccountingRecovery } from './accounting-recovery.js';
import { ReaderCredentials } from './reader-credentials.js';
import { ReaderRuntime, readerConnectionHealthy } from './reader-runtime.js';

startup.stage('config');
const config = readConfig();
for (const warning of config.authWarnings) console.warn(`[auth:config] ${warning}`);

const logError = (scope, error) => startup.error(scope, error);

startup.stage('clients');
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
if (config.mode === 'official') intents.push(GatewayIntentBits.GuildVoiceStates);
const bot = new Client({ intents });
let source = bot;
let createReaderClient;
if (config.mode === 'selfbot') {
  const { default: Selfbot } = await import('discord.js-selfbot-v13');
  // No token extraction, captcha solving, sending, joining, invitations or voice connection.
  // This client is ONLY used as an event source for already-accessible Arena channels.
  createReaderClient = () => new Selfbot.Client({
    makeCache: Selfbot.Options.cacheWithLimits({ MessageManager: 0 }),
    captchaRetryLimit: 0, restRequestTimeout: 15000
  });
  source = createReaderClient();
  console.warn('تحذير: تشغيل حساب عادي آليًا يخالف شروط Discord وقد يؤدي إلى إغلاق الحساب. مكتبة القارئ مؤرشفة وغير مضمونة التوافق.');
}

startup.stage('database-client');
const store = new MongoStore(config);
const service = new QuestService(store, config);
const access = new BotPermissions({ store, config });
const membership = new ClanMembership({ bot, source, config,
  onFallback: error => logError('membership:fallback-to-member-reads', error),
  onReadRetry: ({ operation, code, attempt, maxAttempts, delayMs }) => {
    console.warn(`[membership:read-retry] operation=${operation} code=${code} attempt=${attempt}/${maxAttempts} delayMs=${delayMs}`);
  } });
const members = membership.members;
let leaseHeld = false;
let taskSetReady = false;
let stopping = false;
let settings;
let trackedChannels = new Set();
let trackedCategories = new Set();
let mediaChannels = new Set();
let gamesTimer;
let questTimer;
const messageFacts = new MessageFacts();
let lastMessageAt = null;
let lastVoiceAt = null;
let voiceTimer;
let leaseTimer;
let panelTimer;
let shopTimer;
let auctionTimer;
let robberyTimer;
let miniTimer;
let memoryTimer;
let xoTimer;
let notificationTimer;
let http;
let reconnecting = false;
let recoveryTimer;
let detachReader = () => {};
const inflight = new Set();
const spamMonitor = new SpamMonitor({ store, service, config,
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current(), actorId: () => bot.user.id });

const status = () => {
  const arena = source.guilds.cache.get(config.arenaGuildId), botReady = bot.isReady(), observerReady = source === bot ? source.isReady() : readerConnectionHealthy(source);
  const state = { stopping, paused: service.paused, current: store.fence.current(), blocked: service.blocked,
    leaseHeld, taskSetReady, membershipReady: membership.ready, bot: botReady, observer: observerReady,
    arenaAvailable: !!arena && arena.available !== false };
  const reason = trackingBlocker(state);
  return { bot: botReady, observer: observerReady, tracking: reason === null, trackingReason: reason,
    observingVoice: trackingBlocker({ ...state, blocked: false }) === null,
    membership: { ...membership.diagnostics(), retryAt: memberRecovery.retryAt },
    memberCount: members.size, lastMessageAt, lastVoiceAt,
    recovery: accountingRecovery.diagnostics(), reader: readerRuntime?.diagnostics(),
    games: { ready: games.ready, waiting: games.waiting, lastProofAt: games.lastProofAt } };
};

const createGameTracker = () => new GameTracker({ config, store, service, memberIds: () => members,
  fetchMessage: async id => {
    const channel = await checkSourceChannel(source, config.arenaGuildId, config.gamesChannelId, 'games');
    return rawGameMessage(await channel.messages.fetch(id));
  }
});
let games = createGameTracker();
const questViews = new DailyQuestViews({ bot, store, service, config, status, isMember: id => membership.has(id),
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current() && !service.blocked && bot.isReady(),
  onError: error => logError('quest-view', error) });
const createVoiceTracker = () => new VoiceTracker({ service, guildId: config.arenaGuildId,
  onError: error => logError('voice', error),
  onGap: ({ from, to, memberCount }) => console.warn(`[voice:observation-gap] from=${new Date(from).toISOString()} to=${new Date(to).toISOString()} seconds=${(to - from) / 1000} members=${memberCount}; لم تُحسب فترة لم يصل خلالها رصد منتظم.`)
});
let tracker = createVoiceTracker();
const panel = new PanelManager({ bot, store, guildId: config.clanGuildId,
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current() && bot.isReady(), onError: error => logError('panel', error),
  getAppearance: async () => (await store.settings()).appearance });
const setupMessage = createSetupMessageHandler({ config, panel, access, onError: error => logError('setup', error) });
const shopNotifier = new ShopNotifier({ bot, store,
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current() && bot.isReady(),
  onError: error => logError('shop-notification', error) });
const auctions = new AuctionManager({ bot, store, service,
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current() && !service.blocked && bot.isReady(),
  onError: error => logError('auction', error) });
const bankViews = new BankLiveViews({ store, service, payload: bankPagePayload, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('bank-live', error) });
const financialLogger = new FinancialLogger({ bot, store, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('financial-log', error) });
const boostManager = new BoostManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('task-boost', error) });
const memoryManager = new MemoryManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('memory-game', error) });
const dotManager = new DotManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('dot-game', error) });
const shipManager = new ShipManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('ship-game', error) });
const boxesManager = new BoxesManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('boxes-game', error) });
const numbersManager = new NumbersManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('numbers-game', error) });
const minesManager = new MinesManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('mines-game', error) });
const buttonGameManager = new ButtonGameManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('button-game', error) });
const xoManager = new XoManager({ bot, service, canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && !service.blocked && bot.isReady(), onError: error => logError('xo', error) });
const miniGames = new MiniGameManager({ bot, service,
  canRun: () => leaseHeld && !stopping && taskSetReady && !service.paused && store.fence.current() && bot.isReady(), onError: error => logError('mini-games', error) });
const robberies = new RobberyManager({ bot, store, service,
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current() && !service.blocked,
  onError: error => logError('robbery-timeout', error) });
const memberNotifier = new MemberNotifier({ bot, store, service, isMember: id => membership.has(id),
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current() && !service.blocked && bot.isReady(),
  onError: error => logError('member-notification', error) });

function run(scope, operation) {
  // Capture the generation at event receipt, before any asynchronous wait.
  const work = new Promise(resolve => resolve(scope === 'lease' ? store.fence.control(operation) : store.fence.run(operation)));
  const tracked = work.catch(error => { if (error.code !== 'RESET_INTERRUPTED') logError(scope, error); }).finally(() => inflight.delete(tracked));
  inflight.add(tracked);
  return tracked;
}

function voiceSnapshot() {
  return readVoiceSnapshot(source.guilds.cache.get(config.arenaGuildId), source, membership, trackedChannels, trackedCategories);
}

function transitionVoice(at = Date.now(), { persist = true, userId = null } = {}) {
  if (!store.fence.current()) return Promise.resolve();
  const state = status();
  if (!state.observingVoice || !settings) { tracker.drop(); return Promise.resolve(); }
  const snapshot = voiceSnapshot(), eligible = new Set(members);
  if (!state.tracking) {
    // A financial journal lock does not erase known connected presence.
    // Capture only; writers resume AFTER journal recovery releases the gate.
    tracker.observe(snapshot, settings.attendance, eligible, at);
    return Promise.resolve();
  }
  if (!persist || userId) {
    tracker.observe(snapshot, settings.attendance, eligible, at, { onlyChanges: !persist && !userId });
    return userId ? tracker.flushUser(userId) : Promise.resolve();
  }
  return tracker.transition(snapshot, settings.attendance, eligible, at);
}

function startVoiceSampling() {
  voiceTimer = setInterval(() => {
    if (stopping) return;
    if (!membership.ready && bot.isReady() && source.isReady()) {
      run('voice-membership', async () => {
        if (await loadMembers()) await transitionVoice();
      });
    }
    // Always sample on time, even if an earlier MongoDB write is still waiting.
    // VoiceTracker captures synchronously and orders persistence separately.
    run('voice-tick', () => {
      const at = Date.now();
      const saving = transitionVoice(at);
      if (status().tracking) lastVoiceAt = at;
      return saving;
    });
  }, 15000);
}

async function refreshSettings() {
  // Flush under the previous rules before applying the new rules to future samples.
  if (status().tracking) await tracker.tick(Date.now());
  settings = await store.settings();
  const templates = await store.templates();
  service.templateCache = templates;
  const observed = [...templates, ...await store.activeTaskSnapshots()];
  trackedChannels = trackedVoiceChannels(config, settings.attendance, observed);
  trackedCategories = trackedVoiceCategories(observed);
  mediaChannels = new Set(observed.filter(t => t.requiresMedia).map(t => t.channelId));
  await transitionVoice();
}

const memberRecovery = new MembershipRecovery({ membership,
  canRun: () => leaseHeld && !stopping && store.fence.current() && bot.isReady() && source.isReady(),
  beforeLoad: () => tracker.drop(),
  onReady: () => {
    const state = membership.diagnostics();
    console.log(`[membership:ready] checked=${state.checked} total=${state.total} eligible=${state.eligible}`);
  },
  onError: (error, delayMs) => {
    logError('membership', error);
    const state = membership.diagnostics();
    console.warn(`[membership:progress] stage=${state.failure?.stage || state.stage} checked=${state.checked} total=${state.total} clanLoaded=${state.clanLoaded}`);
    console.warn(`[membership:retry] تعذر تحديث العضوية؛ المحاولة التالية بعد ${delayMs / 1000} ثانية.`);
  }
});
const loadMembers = options => memberRecovery.run(options);

const runtimeControl = new RuntimeControl({ store, service,
  onChanged: () => {
    tracker.drop(); tracker.pending.clear(); messageFacts.clear();
    // Disable raw game input immediately. gap/start share the game's serial queue.
    games.ready = false; games.facts.clear();
    run('runtime-games-gap', () => games.gap());
  },
  onResumed: () => {
    run('runtime-games-resume', () => games.start());
    run('runtime-voice-resume', () => transitionVoice());
  },
  onError: error => logError('runtime-control', error)
});
const fullReset = new FullResetControl({ store, service, runtimeControl,
  onStopped: () => {
    tracker.drop(); tracker.pending.clear(); games.ready = false; games.facts.clear(); messageFacts.clear();
    // New trackers do not share queues or unsaved event arrays with interrupted work.
    tracker = createVoiceTracker(); games = createGameTracker();
    questViews.privateViews.clear(); bankViews.views.clear();
    lastMessageAt = null; lastVoiceAt = null;
  },
  onResumed: () => {
    run('reset-games-resume', () => games.start());
    run('reset-voice-resume', () => transitionVoice());
  },
  onError: error => logError('full-reset', error)
});
const accountingRecovery = new AccountingRecovery({ store, service,
  canRun: () => leaseHeld && taskSetReady && !stopping && !service.paused && !service.resetting && store.fence.current(),
  onReady: () => {
    console.log('[accounting:recovered] اكتمل التحقق من العمليات المحفوظة؛ استؤنف الاحتساب.');
    run('accounting-voice-resume', () => transitionVoice());
  },
  onError: (error, delay) => {
    logError('accounting:recovery', error);
    console.warn(`[accounting:retry] nextMs=${delay}`);
  }
});
const readerCredentials = source !== bot ? new ReaderCredentials({ store, config }) : null;
const readerRuntime = source !== bot ? new ReaderRuntime({
  token: config.userToken, botToken: config.botToken, getClient: () => source,
  createClient: createReaderClient,
  connect: (client, token) => loginReady(client, token, 'ready', 'observer', { timeoutMs: 45000 }),
  validate: validateReader,
  credentials: readerCredentials, protect: protectSecret,
  canRun: () => leaseHeld && !stopping && !service.resetting,
  onGap: () => connectionGap(),
  activate: client => {
    const previous = source;
    detachReader(); connectionGap();
    source = client; membership.source = client;
    membership.preferRest = false; memberRecovery.retryAt = 0; memberRecovery.failures = 0;
    detachReader = attachSource(client);
    // Old callbacks are detached/guarded before destroying the retired client.
    previous.on('error', () => {});
    void Promise.resolve(previous.destroy()).catch(() => {});
  },
  onReady: () => {
    config.userToken = readerRuntime.token;
    console.log('[reader:connected] تم توصيل القارئ؛ جارٍ التحقق من الأعضاء.');
    resumeTracking();
  },
  onError: (error, delay) => {
    logError('reader:recovery', error);
    console.warn(`[reader:retry] nextMs=${delay}`);
  }
}) : null;

async function validateReader(client) {
  if (!client.guilds.cache.has(config.arenaGuildId)) throw new Error('حساب القارئ غير موجود في أرينا المحدد.');
  for (const [id, type] of [...[...new Set([config.generalChannelId, config.clanChatChannelId, config.feelingChannelId, config.lookChannelId, config.gamesChannelId])].map(id => [id, 'messages']),
    ...clanVoiceChannels(config).map(id => [id, 'voice'])]) await checkSourceChannel(client, config.arenaGuildId, id, type);
}

function connectionGap() {
  tracker.drop(); messageFacts.clear();
  if (games.ready || games.starting) run('games-gap', () => games.gap());
  membership.invalidate();
}
function resumeTracking() {
  if (!leaseHeld || !taskSetReady || stopping || !settings || reconnecting || !bot.isReady() || !source.isReady()) return;
  reconnecting = true;
  run('reconnect', async () => {
    try {
      if (!await loadMembers()) return;
      await transitionVoice();
      if (status().tracking && !games.ready) await games.start();
    } finally { reconnecting = false; }
  });
}

const handler = createHandler({
  config, service, store, runtimeControl, fullReset, readerRuntime, isMember: id => membership.has(id),
  validateChannel: (id, type) => checkSourceChannel(source, config.arenaGuildId, id, type),
  refreshSettings, refreshVoice: userId => transitionVoice(Date.now(), { userId }), status, panel, bot, access, auctions, robberies, xoManager, buttonGameManager, minesManager, numbersManager, dotManager, boxesManager, shipManager, memoryManager, boostManager, bankViews, questViews, notifyPurchase: () => run('shop-notification', () => shopNotifier.tick()),
  onError: error => logError('command', error)
});

const textCommands = createTextCommands(handler, config);
bot.on(Events.InteractionCreate, interaction => {
  if (!leaseHeld || !taskSetReady || stopping) return;
  run('interaction', () => handler(interaction));
});
bot.on(Events.MessageCreate, message => {
  if (message.guildId === config.clanGuildId || source === bot) run('spam', () => spamMonitor.receive(message));
  if (leaseHeld && taskSetReady && !stopping && !service.paused && store.fence.current()) {
    run('setup', () => setupMessage(message));
    run('text-command', () => textCommands(message));
  }
});
for (const event of [Events.GuildMemberAdd, Events.GuildMemberUpdate, Events.GuildMemberRemove]) {
  bot.on(event, (old, updated) => {
    const member = updated || old;
    if (member.guild.id !== config.clanGuildId) return;
    if (membership.updateClan(member, event === Events.GuildMemberRemove)) run('member-voice', () => transitionVoice());
    if (event === Events.GuildMemberAdd && config.memberRole && membership.ready && leaseHeld && !stopping) {
      run('member-refresh', () => membership.loadArenaMember(member.id).then(changed => {
        if (changed) return transitionVoice();
      }));
    }
  });
}
function attachSource(client) {
  const listeners = [];
  const on = (event, callback) => {
    const guarded = (...args) => { if (source === client && !stopping) callback(...args); };
    client.on(event, guarded); listeners.push([event, guarded]);
  };
  for (const event of ['guildMemberAdd', 'guildMemberUpdate', 'guildMemberRemove']) {
    on(event, (old, updated) => {
      if (membership.updateArena(updated || old, event === 'guildMemberRemove')) run('arena-member-voice', () => transitionVoice());
    });
  }
  on('roleDelete', role => {
    if (membership.roleDeleted(role)) {
      tracker.drop();
      console.error('توقف الرصد: حذفت رتبة أعضاء الكلان المحددة من سيرفر أرينا.');
    }
  });

  on('messageCreate', message => {
    if (source !== bot && message.guildId === config.arenaGuildId) run('spam', () => spamMonitor.receive(message));
    if (!status().tracking || message.guildId !== config.arenaGuildId || !isUserMessage(message)) return;
    if (message.member && !message.member.partial && membership.updateArena(message.member)) {
      run('message-member-voice', () => transitionVoice());
    }
    if (!membership.has(message.author?.id)) return;
    const waitForMedia = mediaChannels.has(message.channelId);
    run('message', () => service.message(messageFacts.created(message, waitForMedia)).then(state => {
      if (state?.lastMessage?.id === message.id) lastMessageAt = message.createdTimestamp;
    }));
  });
  on('raw', packet => {
    if (status().tracking && games.ready && games.facts.accepts(packet)) run('games', () => games.receive(packet));
  });
  on('messageUpdate', (old, updated) => {
    if (!status().tracking) return;
    const event = messageFacts.updated(updated || old);
    if (!event || event.guildId !== config.arenaGuildId || !membership.has(event.userId)) return;
    run('message-media', () => service.message(event));
  });
  on('messageDelete', message => messageFacts.forget(message.id));
  on('voiceStateUpdate', (old, next) => {
    if (next.guild.id !== config.arenaGuildId) return;
    const tracked = state => state.channelId && (trackedChannels.has(state.channelId)
      || trackedCategories.has(state.guild.channels.cache.get(state.channelId)?.parentId));
    if (!tracked(old) && !tracked(next)) return;
    // Capture exact boundaries now; the independent 15-second sampler persists
    // them. Unrelated/rapid Gateway events no longer start global write batches.
    run('voice-transition', () => transitionVoice(Date.now(), { persist: false }));
  });
  on('channelUpdate', (old, next) => {
    if (next.guild?.id === config.arenaGuildId) run('channel-voice', () => transitionVoice());
  });
  on('channelDelete', channel => {
    if (channel.guild?.id === config.arenaGuildId) run('channel-voice', () => transitionVoice());
  });

  for (const event of ['guildUnavailable', 'guildDelete']) on(event, guild => {
    if (guild.id === config.arenaGuildId) connectionGap();
  });
  for (const event of ['guildAvailable', 'guildCreate']) on(event, guild => {
    if (guild.id === config.arenaGuildId) { connectionGap(); resumeTracking(); }
  });
  if (client !== bot) attachLifecycle(client, on);
  return () => { for (const [event, callback] of listeners) client.off(event, callback); };
}
function attachLifecycle(client, on) {
  on('error', error => logError(client === bot ? 'bot' : 'observer', error));
  on('shardError', error => { tracker.drop(); logError(client === bot ? 'gateway:bot' : 'gateway:observer', error); });
  for (const event of ['shardDisconnect', 'shardReconnecting']) on(event, info => {
    if (client !== bot) readerRuntime.disconnected(info?.code);
    else connectionGap();
  });
  // shardReady may fire before the SDK reports client.isReady(). Also listen
  // for the final ready event; the independent timer is the fallback.
  for (const event of new Set(['shardResume', 'shardReady', 'ready', Events.ClientReady])) on(event, resumeTracking);
  on('invalidated', () => {
    if (client !== bot) readerRuntime.disconnected();
    else void shutdown(1, false);
  });
}
attachLifecycle(bot, (event, callback) => bot.on(event, callback));
detachReader = attachSource(source);

async function shutdown(code = 0, flush = true) {
  if (stopping) return;
  // Stop accepting events but allow the bounded final observed interval to commit.
  stopping = true; fullReset.close(); readerRuntime?.close();
  clearInterval(recoveryTimer);
  clearInterval(voiceTimer); clearInterval(leaseTimer); clearInterval(panelTimer);
  clearInterval(shopTimer);
  clearInterval(auctionTimer);
  clearInterval(robberyTimer); clearInterval(miniTimer); clearInterval(memoryTimer); clearInterval(xoTimer);
  clearInterval(notificationTimer); clearInterval(gamesTimer); clearInterval(questTimer);
  const deadline = setTimeout(() => process.exit(code || 1), 12000);
  deadline.unref();
  try {
    if (flush && !service.paused && store.fence.current() && leaseHeld && bot.isReady() && source.isReady() && membership.ready) await tracker.tick(Date.now());
    else tracker.drop();
    await tracker.drain();
    await games.drain();
    await questViews.drain();
    await panel.drain();
    await shopNotifier.drain();
    await auctions.drain();
    await robberies.drain();
    await miniGames.drain();
    await xoManager.drain();
    await buttonGameManager.drain();
    await minesManager.drain();
    await numbersManager.drain();
    await dotManager.drain();
    await shipManager.drain();
    await boxesManager.drain();
    await memoryManager.drain();
    await boostManager.drain();
    await bankViews.drain();
    await financialLogger.drain();
    await memberNotifier.drain();
    for (const client of new Set([bot, source])) await client.destroy();
    await Promise.allSettled([...inflight]);
    if (leaseHeld) await store.fence.control(() => store.releaseLease());
    await store.close();
    http?.close();
  } catch (error) { logError('shutdown', error); }
  clearTimeout(deadline);
  process.exit(code);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('unhandledRejection', error => { logError('unhandled', error); void shutdown(1, false); });
process.on('uncaughtException', error => { logError('uncaught', error); void shutdown(1, false); });

try {
  startup.stage('database-connect');
  await store.connect();
  startup.stage('worker-lease');
  leaseHeld = await store.acquireLease();
  // A Render worker rolling deployment may briefly overlap with the previous process.
  for (let attempt = 0; !leaseHeld && attempt < 24 && !stopping; attempt++) {
    if (attempt === 0) console.log('بانتظار إغلاق النسخة السابقة وتحرير قفل التشغيل...');
    await taskDelay(5000);
    leaseHeld = await store.acquireLease();
  }
  if (!leaseHeld) throw new Error('هناك نسخة أخرى تعمل لنفس الكلان. أوقفها وانتظر 45 ثانية ثم أعد النشر.');
  let leaseBusy = false;
  leaseTimer = setInterval(() => {
    if (leaseBusy || stopping) return;
    leaseBusy = true;
    run('lease', () => (async () => {
      try {
        if (!await store.acquireLease()) throw new Error('فقدت النسخة قفل التشغيل.');
      } catch (error) {
        leaseHeld = false; tracker.drop(); logError('lease', error);
        // Do not await shutdown inside inflight, which shutdown itself drains.
        void shutdown(1, false);
      } finally { leaseBusy = false; }
    })());
  }, 10000);
  startup.stage('saved-operations');
  if (await fullReset.recover()) console.log('اكتمل الريست الشامل المحفوظ قبل استرجاع أي معاملة قديمة.');
  await store.notifications.initialize();
  await store.db.collection('task_boosts').createIndex({ clanId: 1, startsAt: 1, endsAt: 1 });
  await store.shop.initialize();
  if (await store.shop.recover()) console.log('تم استكمال طلب الشراء المحفوظ قبل استئناف الاحتساب.');
  await store.robbery.initialize();
  if (await store.robbery.recover()) console.log('تم استكمال عملية النهب أو شراء الحماية المحفوظة قبل استئناف الاحتساب.');
  await service.shipGame.initialize();
  await service.shipGame.recover();
  await service.boxesGame.initialize();
  await service.boxesGame.recover();
  await service.dotGame.initialize();
  await service.dotGame.recover();
  await service.numbersGame.initialize();
  await service.numbersGame.recover();
  await service.minesGame.initialize();
  await service.minesGame.recover();
  await service.buttonGame.initialize();
  await service.buttonGame.recover();
  await service.xo.initialize();
  await service.xo.recover();
  await store.auctions.initialize();
  if (await store.auctions.recover()) console.log('تم استكمال حجز/استرجاع المزاد المحفوظ قبل استئناف الاحتساب.');
  if (await store.initializeResets()) console.log('تم استكمال الريست المحفوظ قبل استئناف الاحتساب.');
  if (await store.repairNegativeBalances()) console.log('تم تصحيح الأرصدة السالبة القديمة؛ الحد الأدنى للرصيد الآن صفر.');
  settings = await store.settings();
  runtimeControl.load(settings);
  access.load(settings);
  startup.stage('bot-login');
  await loginReady(bot, config.botToken, Events.ClientReady, 'bot');
  startup.stage('observer-login');
  if (readerRuntime) {
    try { readerRuntime.token = await readerCredentials.load(config.userToken); }
    catch { console.warn('[reader:credentials] تعذر فتح التوكن المحفوظ؛ سيُستخدم ARENA_USER_TOKEN من Environment.'); }
    protectSecret(readerRuntime.token);
    config.userToken = readerRuntime.token;
    try { await loginReady(source, readerRuntime.token, 'ready', 'observer', { timeoutMs: 45000 }); }
    catch (error) {
      logError('observer-login', error);
      readerRuntime.disconnected(error.code === 'AUTHENTICATION_FAILED' ? 4004 : undefined);
      // Keep the official bot and recovery command available for a bad reader token.
      console.warn('[reader:offline] ستبقى الأوامر متاحة؛ يمكن إصلاح التوكن من /تحديث التوكن.');
    }
  }
  startup.stage('membership');
  if (source.isReady()) await loadMembers({ required: source === bot });
  startup.stage('source-channels');
  for (const [id, type] of [...[...new Set([config.generalChannelId, config.clanChatChannelId, config.feelingChannelId, config.lookChannelId, config.gamesChannelId])].map(id => [id, 'messages']), ...clanVoiceChannels(config).map(id => [id, 'voice'])]) {
    if (source.isReady()) {
      try { await checkSourceChannel(source, config.arenaGuildId, id, type); }
      catch (error) { if (source === bot) throw error; logError('channel-configuration', error); }
    }
  }
  startup.stage('tasks-and-activity');
  if (await store.initializeDailyQuests()) console.log('تم تفعيل المهام اليومية التلقائية مع حفظ الأرصدة وإعدادات التنبيهات.');
  if (await store.initializeDailyRewards()) console.log('تم تحديث مكافآت المهام وحد الحضور اليومي مع حفظ التقدم والأرصدة.');
  if (await store.initializePublicVoiceTask()) console.log('تمت إضافة مهمة التواجد 40 دقيقة في الرومات العامة بمكافأة 12000 مرة يوميًا.');
  if (await store.initializeVoiceAttendance()) console.log('تم ضبط مكافأة الحضور: 200 كل 21 دقيقة، بسقف 4000، مع حفظ شروط احتساب الصوت.');
  if (await store.initializeSpecialTasks()) console.log('تمت إضافة المهمات الخاصة الثلاث. تمنح الإدارة نقاطها يدويًا.');
  await store.initializeActivity();
  await refreshSettings();
  if (!service.paused && store.fence.current() && source.isReady() && membership.ready) await games.start();
  taskSetReady = true;
  startup.stage('tracking');
  await transitionVoice();
  // Panel/command restoration can be slow; voice observation starts now.
  startVoiceSampling();
  recoveryTimer = setInterval(() => {
    if (stopping) return;
    run('accounting-recovery', () => accountingRecovery.run());
    // Reader credential changes are control operations, available while the
    // economy is paused; full resets and shutdown still prevent replacement.
    if (readerRuntime) run('reader-watchdog', () => readerRuntime.tick());
  }, 10000);
  for (const [id, type] of [...[...new Set([config.generalChannelId, config.clanChatChannelId, config.feelingChannelId, config.lookChannelId, config.gamesChannelId])].map(id => [id, 'messages']), ...clanVoiceChannels(config).map(id => [id, 'voice'])]) {
    try { await checkSourceChannel(source, config.arenaGuildId, id, type); }
    catch (error) { logError('channel-configuration', error); }
  }
  // Only replaces this new application's clan-guild commands, never global/other-guild commands.
  startup.stage('register-commands');
  await bot.application.commands.set(buildCommands(), config.clanGuildId);
  // Persistent custom IDs are handled above; no expiring collectors are used.
  // Recover a due or missing saved panel once, rather than replaying every missed interval.
  startup.stage('restore-panels');
  await run('quest-restore', () => questViews.tick());
  questTimer = setInterval(() => { run('quest-refresh', () => questViews.tick()); }, QUEST_REFRESH_MS);
  let gamesBusy = false;
  gamesTimer = setInterval(() => {
    if (gamesBusy || !status().tracking) return;
    gamesBusy = true;
    run('games-retry', () => (async () => {
      try { if (!games.ready) await games.start(); else await games.retry(); }
      finally { gamesBusy = false; }
    })());
  }, 15000);
  await run('panel-restore', () => panel.tick({ checkMessage: true }));
  await run('shop-notification', () => shopNotifier.tick());
  await run('auction-restore', () => auctions.tick());
  await run('robbery-restore', () => robberies.tick());
  await run('mini-restore', () => miniGames.tick());
  await run('xo-restore', () => xoManager.tick());
  await run('button-restore', () => buttonGameManager.tick());
  await run('mines-restore', () => minesManager.tick());
  await run('numbers-restore', () => numbersManager.tick());
  await run('dot-restore', () => dotManager.tick());
  await run('ship-restore', () => shipManager.tick());
  await run('boxes-restore', () => boxesManager.tick());
  await run('memory-restore', () => memoryManager.tick());
  await run('boost-restore', () => boostManager.tick());
  xoTimer = setInterval(() => { run('xo-games', () => xoManager.tick()); run('button-game', () => buttonGameManager.tick()); run('mines-game', () => minesManager.tick()); run('numbers-game', () => numbersManager.tick()); run('dot-game', () => dotManager.tick()); run('boxes-game', () => boxesManager.tick()); run('ship-game', () => shipManager.tick()); run('task-boost', () => boostManager.tick()); run('bank-live', () => bankViews.tick()); }, 1000);
  memoryTimer = setInterval(() => { run('memory-game', () => memoryManager.tick()); }, 500);
  miniTimer = setInterval(() => { run('mini-games', () => miniGames.tick()); }, 5000);
  await run('member-notification', () => memberNotifier.tick()); run('financial-log', () => financialLogger.tick());
  await spamMonitor.initialize();
  run('spam-recovery', () => spamMonitor.tick());
  notificationTimer = setInterval(() => { run('member-notification', () => memberNotifier.tick()); run('financial-log', () => financialLogger.tick()); run('spam-recovery', () => spamMonitor.tick()); }, 15000);
  auctionTimer = setInterval(() => { run('auction', () => auctions.tick()); }, 1000);
  robberyTimer = setInterval(() => { run('robbery-timeout', () => robberies.tick()); }, 1000);
  shopTimer = setInterval(() => { run('shop-notification', () => shopNotifier.tick()); }, 15000);
  panelTimer = setInterval(() => {
    run('panel-refresh', () => panel.tick({ checkMessage: true }));
  }, 30000);
  startup.stage('health-server');
  if (config.port) {
    http = createServer((request, response) => {
      const healthy = status().tracking || (service.paused && leaseHeld && taskSetReady && !stopping && bot.isReady() && source.isReady());
      response.writeHead(request.url === '/health' || request.url === '/' ? (healthy ? 200 : 503) : 404,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: healthy }));
    });
    http.listen(config.port, '0.0.0.0');
  }
  startup.info('[startup:ready] اكتمل تشغيل البوت.');
  console.log(`جاهز: ${members.size} عضو مؤهل. الأوامر مسجلة في سيرفر الكلان. راجع /حالة_البوت ثم اكتب مهامي لعرض المهام التلقائية.`);
} catch (error) { logError(error.scope || `startup:${startup.currentStage()}`, error); await shutdown(1, false); }
