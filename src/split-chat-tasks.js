import { isId } from './config.js';

export const CHAT_SPLIT_VERSION = 1;
export const LEGACY_CHAT_TASK_ID = 'daily-general-100';
export const CHAT_TASK_IDS = ['daily-general-50', 'daily-clan-chat-50'];
export const isSplitChatTask = task => CHAT_TASK_IDS.includes(task.id);

export function splitChatTemplates(config, installedAt) {
  if (!isId(config.generalChannelId) || !isId(config.clanChatChannelId)) {
    throw new Error('GENERAL_CHANNEL_ID وCLAN_CHAT_CHANNEL_ID مطلوبان لمهمتي الكتابة المنفصلتين.');
  }
  if (config.generalChannelId === config.clanChatChannelId) {
    throw new Error('CLAN_CHAT_CHANNEL_ID يجب أن يختلف عن GENERAL_CHANNEL_ID؛ لكل شات مهمة مستقلة.');
  }
  return [
    { id: CHAT_TASK_IDS[0], title: 'أرسل 50 رسالة في الشات العام', channelId: config.generalChannelId, order: -2 },
    { id: CHAT_TASK_IDS[1], title: 'أرسل 50 رسالة في شات الكلان', channelId: config.clanChatChannelId, order: -1 }
  ].map(task => ({ ...task, type: 'messages', target: 50, reward: 50, repeat: 1,
    enabled: true, forUser: null, requiredRoleId: null, requiresMedia: false,
    createdAt: installedAt, chatSplitVersion: CHAT_SPLIT_VERSION }));
}

export function splitChatTasks(state, templates, at) {
  if (state.chatSplitVersion === CHAT_SPLIT_VERSION) return false;
  const pair = CHAT_TASK_IDS.map(id => templates.find(t => t.id === id && t.enabled
    && (!t.forUser || t.forUser === state.userId) && (t.createdAt || 0) <= at));
  if (pair.some(t => !t)) return false;
  const previous = state.tasks.filter(t => t.id === LEGACY_CHAT_TASK_ID);
  if (previous.length) state.previousCombinedChat = { tasks: structuredClone(previous), replacedAt: at };
  state.chatSplitVersion = CHAT_SPLIT_VERSION;
  if (previous.some(t => t.completed > 0)) {
    // Today's writing reward was already paid. Keep its truthful saved progress
    // and balance; the new pair starts next Saudi day, without another reward.
    state.chatSplitDeferred = true;
    for (const task of previous) task.retiredAfterChatSplit = true;
    return true;
  }
  // Historical combined progress has no reliable per-channel attribution.
  // Archive it, start two fresh counters and retain every unrelated task/receipt.
  const fresh = pair.map(t => state.tasks.find(old => old.id === t.id) || {
    id: t.id, title: t.title, type: t.type, channelId: t.channelId,
    target: t.target, reward: t.reward, repeat: t.repeat, enabled: t.enabled,
    forUser: t.forUser || null, requiredRoleId: t.requiredRoleId || null,
    requiresMedia: !!t.requiresMedia, progress: 0, completed: 0, lastMessageId: null,
    availableFrom: t.createdAt || 0
  });
  state.tasks = [...fresh, ...state.tasks.filter(t => t.id !== LEGACY_CHAT_TASK_ID && !isSplitChatTask(t))];
  return true;
}
