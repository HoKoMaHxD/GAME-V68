import { clanVoiceChannels } from './voice-channels.js';
import { MESSAGE_MAX_AGE_MS } from './message-channels.js';
import { periodStart, dayKey } from './time.js';

export const ACTIVITY_VERSION = 1;
export const ACTIVITY_PAGE_SIZE = 5;
export const ACTIVITY_CATEGORIES = [
  { name: 'الشات والفويس', value: 'both' },
  { name: 'توب الشات', value: 'chat' }, { name: 'توب الفويس', value: 'voice' }
];

// These observed counters never depend on rewards, wallet debits or quest caps.
// Old capped quest progress cannot reconstruct historical activity accurately.
export function countChat(state, event, config, receivedAt) {
  if (!config.activityStartedAt || event.at < config.activityStartedAt
    || event.channelId !== config.clanChatChannelId || event.mediaOnly) return false;
  const activity = state.activity ||= { clanMessages: 0, voiceMs: 0 };
  const floor = Math.max(activity.messageFloor || 0, receivedAt - MESSAGE_MAX_AGE_MS);
  if (event.at < floor) return false;
  const receipts = (activity.messageReceipts || []).filter(r => r.at >= floor);
  if (receipts.some(r => r.id === event.id)) return false;
  activity.clanMessages++;
  activity.messageReceipts = [...receipts, { id: event.id, at: event.at }];
  activity.messageFloor = floor;
  return true;
}

export function countVoice(state, event, config) {
  if (!config.activityStartedAt || !clanVoiceChannels(config).includes(event.channelId)) return false;
  const from = Math.max(event.from, config.activityStartedAt, state.activity?.voiceUntil || 0);
  if (event.to <= from) return false;
  const activity = state.activity ||= { clanMessages: 0, voiceMs: 0 };
  activity.voiceMs += event.to - from;
  activity.voiceUntil = event.to;
  return true;
}

export function activityPipeline(config, period, at, userId) {
  const match = { clanId: config.clanGuildId,
    day: { $gte: periodStart(period, at, config.weekStart), ...(period === 'all' ? {} : { $lte: dayKey(at) }) } };
  if (userId) match.userId = userId;
  return [{ $match: match }, { $group: { _id: '$userId',
    chat: { $sum: { $ifNull: ['$activity.clanMessages', 0] } },
    voice: { $sum: { $ifNull: ['$activity.voiceMs', 0] } }
  } }];
}

export function activityMetric(metric) {
  if (!['chat', 'voice'].includes(metric)) throw new Error('اختر توب الشات أو توب الفويس.');
  return metric;
}
