import { boostedReward } from './task-boost.js';
import { createHash } from 'node:crypto';
import { isId } from './config.js';
import { taskChannels, voiceChannelsFor } from './voice-channels.js';
import { MESSAGE_MAX_AGE_MS } from './message-channels.js';
import { isSplitChatTask, splitChatTasks } from './split-chat-tasks.js';
import { PUBLIC_VOICE_TASK_ID, appendPublicVoiceTask } from './public-voice-task.js';

export const DAILY_QUEST_VERSION = 1;
export const DAILY_TASK_COUNT = 5;
export const TASK_SET_VERSION = 2;
export const DEFAULT_GAME_TASK_ID = 'daily-games-5';
export const DEFAULT_GAME_TASK_VERSION = 1;
export const hash = value => createHash('sha256').update(value).digest('hex');

export function validateTemplate(task) {
  if (!task.title || typeof task.title !== 'string' || task.title.length > 100) throw new Error('اسم المهمة مطلوب (حتى 100 حرف).');
  if (!['messages', 'voice', 'games'].includes(task.type)) throw new Error('نوع المهمة غير مدعوم.');
  if (task.categoryIds !== undefined) {
    if (task.type !== 'voice' || !Array.isArray(task.categoryIds) || !task.categoryIds.length
      || task.categoryIds.length > 25 || task.categoryIds.some(id => !isId(id)) || task.channelId != null) {
      throw new Error('مهمة الكاتقوريات تتطلب قائمة كاتقوريات صوتية صحيحة دون روم منفرد.');
    }
  } else if (!isId(task.channelId)) throw new Error('ID الروم غير صحيح.');
  for (const [name, value, max] of [['target', task.target, 100000], ['reward', task.reward, 100000], ['repeat', task.repeat, 20]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`قيمة ${name} يجب أن تكون بين 1 و${max}.`);
  }
  if (task.type === 'voice' && task.target > 1440) throw new Error('الحد الأعلى للمهمة الصوتية 1440 دقيقة.');
  if (task.id === PUBLIC_VOICE_TASK_ID && task.repeat !== 1) throw new Error('مهمة الرومات العامة مرة واحدة يوميًا.');
  if (task.type === 'games' && (task.repeat !== 1 || task.target > 1000)) throw new Error('مهمة الألعاب مرة واحدة يوميًا، والهدف بين 1 و1000 قيم.');
  if (task.requiredRoleId && !isId(task.requiredRoleId)) throw new Error('ID رتبة المنشن غير صالح.');
  if (task.requiresMedia !== undefined && typeof task.requiresMedia !== 'boolean') throw new Error('شرط الصور والفيديو يجب أن يكون true أو false.');
  if (task.type !== 'messages' && (task.requiredRoleId || task.requiresMedia)) throw new Error('شروط المنشن والصور والفيديو تخص مهام الرسائل فقط.');
  if (task.forUser && !isId(task.forUser)) throw new Error('عضو المهمة غير صالح.');
  return task;
}

export function seedTemplates(config) {
  // Historical v2 base installation. The separate chat migration at startup
  // replaces only daily-general-100, preserving all other catalog edits/data.
  return [
    { id: 'daily-general-100', title: 'أرسل 100 رسالة في الشات العام', type: 'messages',
      channelId: config.generalChannelId, target: 100, reward: 100 },
    { id: 'daily-feeling-mention', title: 'أرسل رسالة مع منشن لرتبة الكلان في شات الفيلنق', type: 'messages',
      channelId: config.feelingChannelId, target: 1, reward: 150, requiredRoleId: config.memberRole },
    { id: 'daily-look-media', title: 'أرسل صورة أو فيديو مع منشن لرتبة الكلان في روم اللوكت', type: 'messages',
      channelId: config.lookChannelId, target: 1, reward: 200, requiredRoleId: config.memberRole, requiresMedia: true },
    { id: 'daily-voice-180', title: 'تواجد 3 ساعات في روم الكلان', type: 'voice',
      channelId: config.voiceChannelId, target: 180, reward: 180 }
  ].map((t, order) => ({ requiredRoleId: null, requiresMedia: false, ...t, order, repeat: 1, enabled: true, forUser: null }));
}

export function defaultGameTemplate(config, installedAt) {
  return { id: DEFAULT_GAME_TASK_ID, title: 'العب 5 ألعاب في روم الألعاب', type: 'games',
    channelId: config.gamesChannelId, target: 5, reward: 500, repeat: 1, enabled: true,
    order: DAILY_TASK_COUNT, forUser: null, requiredRoleId: null, requiresMedia: false,
    createdAt: installedAt, defaultInstalledAt: installedAt };
}

export function createDay(clanId, userId, day, templates, at) {
  // Keep the split chat pair, then targeted templates and a stable daily shuffle.
  const rank = t => hash(`${clanId}:${userId}:${day}:${t.id}`);
  const tasks = templates.filter(t => t.type !== 'games' && t.id !== PUBLIC_VOICE_TASK_ID && t.enabled && (!t.forUser || t.forUser === userId))
    .filter(t => !isSplitChatTask(t) || (t.createdAt || 0) <= at)
    .sort((a, b) => Number(isSplitChatTask(b)) - Number(isSplitChatTask(a))
      || Number(!!b.forUser) - Number(!!a.forUser) || rank(a).localeCompare(rank(b)))
    .slice(0, DAILY_TASK_COUNT)
    .sort((a, b) => Number(!!b.forUser) - Number(!!a.forUser)
      || (a.order ?? 1000) - (b.order ?? 1000) || rank(a).localeCompare(rank(b)))
    .map(t => ({
      id: t.id, title: t.title, type: t.type, channelId: t.channelId,
      target: t.target, reward: t.reward, repeat: t.repeat, enabled: t.enabled,
      forUser: t.forUser || null, requiredRoleId: t.requiredRoleId || null,
      requiresMedia: !!t.requiresMedia, progress: 0, completed: 0, lastMessageId: null,
      ...(t.categoryIds ? { categoryIds: [...t.categoryIds] } : {}),
      ...(isSplitChatTask(t) ? { availableFrom: t.createdAt || 0 } : {})
    }));
  const state = {
    _id: `${clanId}:${day}:${userId}`, clanId, userId, day, revision: 0, createdAt: at,
    tasks, taskSetVersion: TASK_SET_VERSION, dailyQuestVersion: DAILY_QUEST_VERSION, dailyQuestStartedAt: at, points: { tasks: 0, attendance: 0 }, completionLog: [],
    lastMessage: null, messageChannels: {}, voiceUntil: 0,
    attendance: { milliseconds: 0, ruleVersion: null, carryMs: 0 }
  };
  splitChatTasks(state, templates, at);
  appendGameTask(state, templates, at);
  appendPublicVoiceTask(state, templates, at);
  return state;
}

// The extra games slot never displaces the message/voice tasks. The installed
// default takes priority while enabled; other game templates remain available.
export function appendGameTask(state, templates, at) {
  const rank = t => hash(`${state.clanId}:${state.userId}:${state.day}:${t.id}`);
  const task = templates.filter(t => t.type === 'games' && t.enabled && (!t.forUser || t.forUser === state.userId)
    && (t.createdAt || 0) <= at)
    .sort((a, b) => Number(b.id === DEFAULT_GAME_TASK_ID) - Number(a.id === DEFAULT_GAME_TASK_ID)
      || Number(!!b.forUser) - Number(!!a.forUser) || rank(a).localeCompare(rank(b)))[0];
  if (!task) return false;
  const previous = state.tasks.find(t => t.type === 'games');
  if (previous && (task.id !== DEFAULT_GAME_TASK_ID || previous.id === task.id || previous.completed > 0
    || !task.defaultInstalledAt || state.createdAt >= task.defaultInstalledAt
    || previous.channelId !== task.channelId)) return false;
  const snapshot = { id: task.id, title: task.title, type: 'games', channelId: task.channelId,
    target: task.target, reward: task.reward, repeat: 1, enabled: true, forUser: task.forUser || null,
    requiredRoleId: null, requiresMedia: false, progress: 0, completed: 0, availableFrom: task.createdAt || 0 };
  if (previous) {
    // One-time adoption for an unfinished pre-installation game quest. Preserve
    // verified progress/receipts. A quest already paid today waits until tomorrow.
    (state.previousGameTasks ||= []).push({ task: previous, replacedAt: at });
    snapshot.progress = Math.min(previous.progress, snapshot.target);
    snapshot.availableFrom = previous.availableFrom || 0;
    state.tasks[state.tasks.indexOf(previous)] = snapshot;
    // If five games were already verified under a larger target, credit exactly
    // once in the same atomic day write as this migration and its completion log.
    advanceTasks(state, 'games', task.channelId, 0, at, t => t.id === task.id);
  } else state.tasks.push(snapshot);
  return true;
}

export function applyGame(state, event, config) {
  if (!isId(event.gameId) || !isId(event.id) || event.botId !== config.gamesBotId
    || event.channelId !== config.gamesChannelId || state.gameReceipts?.some(r => r.gameId === event.gameId)) return false;
  const accepted = state.tasks.filter(t => t.type === 'games' && t.channelId === event.channelId
    && t.completed < t.repeat && event.at >= (t.availableFrom || 0));
  if (!accepted.length) return false;
  const ids = new Set(accepted.map(t => t.id));
  advanceTasks(state, 'games', event.channelId, 1, event.at, t => ids.has(t.id), config);
  (state.gameReceipts ||= []).push({ gameId: event.gameId, messageId: event.id, kind: event.kind, at: event.at });
  return true;
}

export function replaceLegacyTasks(state, templates, at) {
  if (state.taskSetVersion === TASK_SET_VERSION) return false;
  state.previousTaskSets = [...(state.previousTaskSets || []), {
    version: state.taskSetVersion || 1, tasks: state.tasks, replacedAt: at
  }];
  state.tasks = createDay(state.clanId, state.userId, state.day, templates, at).tasks;
  state.taskSetVersion = TASK_SET_VERSION;
  state.lastMessage = null;
  state.messageChannels = {};
  delete state.recentHashes;
  state.voiceUntil = Math.max(state.voiceUntil || 0, at);
  return true;
}

export function advanceTasks(state, type, channelId, amount, at, matches = () => true, config = {}, categoryId = null) {
  for (const task of state.tasks) {
    const locationMatches = task.type === 'voice' && task.categoryIds?.length
      ? !!categoryId && task.categoryIds.includes(categoryId) : taskChannels(task, config).includes(channelId);
    if (task.type !== type || !locationMatches || !matches(task)) continue;
    const targetUnits = task.target * (type === 'voice' ? 60000 : 1);
    const credit = type === 'voice' ? Math.min(amount, Math.max(0, at - (task.availableFrom || 0))) : amount;
    task.progress = Math.min(targetUnits * task.repeat, task.progress + credit);
    const earnedCycles = Math.min(task.repeat, Math.floor(task.progress / targetUnits));
    for (let cycle = task.completed + 1; cycle <= earnedCycles; cycle++) {
      const payout = boostedReward(task.reward, at, config.taskBoost);
      const total = state.points.tasks + payout.points;
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('مكافأة المهمة تتجاوز الحد الرقمي للرصيد.');
      state.points.tasks = total;
      state.completionLog.push({ taskId: task.id, cycle, points: payout.points, at, ...(payout.multiplier > 1 ? { basePoints: task.reward, multiplier: payout.multiplier, boostId: payout.boostId } : {}) });
    }
    task.completed = earnedCycles;
  }
}

export function applyMessage(state, event, config, receivedAt = event.at) {
  if (!isId(event.id) || event.bot || event.system || event.webhook) return false;
  const floor = Math.max(state.messageReceiptFloor || 0, receivedAt - MESSAGE_MAX_AGE_MS);
  if (event.at < floor) return false;
  const receipts = (state.messageReceipts || []).filter(item => item.at >= floor);
  const receipt = receipts.find(item => item.id === event.id);
  const accepted = state.tasks.filter(t => t.type === 'messages' && taskChannels(t, config).includes(event.channelId) && t.completed < t.repeat
    && !t.retiredAfterChatSplit && event.at >= (t.availableFrom || 0)
    && (!t.requiredRoleId || event.mentionedRoleIds?.includes(t.requiredRoleId))
    && (!t.requiresMedia || event.hasMedia === true)
    && (!event.mediaOnly || t.requiresMedia)
    && !receipt?.taskIds.includes(t.id)
    && (() => {
      // Freeze only the legacy boundary. New receipts allow messages to arrive
      // out of ID order without dropping them or replaying pre-upgrade credits.
      const legacy = Object.hasOwn(t, 'messageIdFloor') ? t.messageIdFloor : t.lastMessageId;
      return !legacy || BigInt(event.id) > BigInt(legacy);
    })());
  if (!accepted.length) return false;
  if (!state.lastMessage || BigInt(event.id) > BigInt(state.lastMessage.id)) state.lastMessage = { id: event.id, at: event.at };
  const ids = new Set(accepted.map(t => t.id));
  advanceTasks(state, 'messages', event.channelId, 1, event.at, task => ids.has(task.id), config);
  for (const task of accepted) {
    if (!Object.hasOwn(task, 'messageIdFloor')) task.messageIdFloor = task.lastMessageId || null;
    if (!task.lastMessageId || BigInt(event.id) > BigInt(task.lastMessageId)) task.lastMessageId = event.id;
  }
  if (receipt) receipt.taskIds.push(...ids);
  else receipts.push({ id: event.id, at: event.at, taskIds: [...ids] });
  state.messageReceipts = receipts;
  state.messageReceiptFloor = floor;
  return true;
}

export function applyVoice(state, event, rule, config = {}) {
  const from = Math.max(event.from, state.voiceUntil || 0);
  if (event.to <= from) return false;
  const amount = event.to - from;
  state.voiceUntil = event.to;
  advanceTasks(state, 'voice', event.channelId, amount, event.to, undefined, config, event.categoryId);
  if (rule.enabled && voiceChannelsFor(rule.channelId, config).includes(event.channelId)) {
    const attendance = state.attendance;
    attendance.milliseconds += amount;
    if (attendance.ruleVersion !== rule.version) {
      attendance.ruleVersion = rule.version;
      attendance.carryMs = 0;
    }
    attendance.carryMs += amount;
    const cycles = Math.floor(attendance.carryMs / rule.intervalMs);
    attendance.carryMs %= rule.intervalMs;
    state.points.attendance += Math.max(0, Math.min(cycles * rule.points, rule.dailyCap - state.points.attendance));
  }
  return true;
}

export function eligibleVoice(snapshot, rule, memberIds) {
  const humanCount = new Map();
  for (const entry of snapshot) {
    if (entry.channelId && !entry.bot) humanCount.set(entry.channelId, (humanCount.get(entry.channelId) || 0) + 1);
  }
  return snapshot.filter(entry => entry.channelId && !entry.bot && memberIds.has(entry.userId)
    && !entry.afk && !entry.suppressed
    && (!rule.ignoreMuted || !entry.muted)
    && (!rule.ignoreDeafened || !entry.deafened)
    && humanCount.get(entry.channelId) >= rule.minPeople);
}

// Upgrade only the task snapshot. Wallet, receipts, cooldowns, activity and audit
// logs remain intact. Historical timed quests cannot resume after this marker.
export function activateDailyTasks(state, templates, at) {
  if (state.dailyQuestVersion === DAILY_QUEST_VERSION) return false;
  (state.previousTaskSets ||= []).push({ version: state.taskSetVersion || 1,
    tasks: state.tasks || [], timedQuest: state.timedQuest || null, replacedAt: at });
  state.tasks = createDay(state.clanId, state.userId, state.day, templates, at).tasks;
  state.taskSetVersion = TASK_SET_VERSION;
  state.dailyQuestVersion = DAILY_QUEST_VERSION;
  state.dailyQuestStartedAt = at;
  delete state.timedQuest;
  // Old message/game receipts remain proof against replay; only task IDs in
  // new snapshots can earn new rewards after the activation boundary.
  state.voiceUntil = Math.max(state.voiceUntil || 0, at);
  return true;
}
