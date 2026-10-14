import { messageChannelsFor } from './message-channels.js';

export function clanVoiceChannels(config = {}) {
  return [...new Set([config.voiceChannelId, config.secondVoiceChannelId, config.thirdVoiceChannelId].filter(Boolean))];
}

// The configured clan rooms share one counter, including assignments already
// saved today. Other voice channels retain their own channel-specific rules.
export function voiceChannelsFor(channelId, config = {}) {
  const clan = clanVoiceChannels(config);
  return clan.includes(channelId) ? clan : [channelId].filter(Boolean);
}

export function taskChannels(task, config = {}) {
  if (task.type === 'voice' && task.categoryIds?.length) return [];
  if (task.type === 'games') return [task.channelId];
  return task.type === 'voice' ? voiceChannelsFor(task.channelId, config) : messageChannelsFor(task, config);
}

export function trackedVoiceChannels(config, attendance, templates) {
  return new Set([...clanVoiceChannels(config),
    ...templates.filter(t => t.type === 'voice').flatMap(t => taskChannels(t, config))]);
}

export function trackedVoiceCategories(templates) {
  return new Set(templates.filter(task => task.type === 'voice').flatMap(task => task.categoryIds || []));
}

export function readVoiceSnapshot(guild, source, membership, trackedChannels, trackedCategories = new Set()) {
  if (!guild) return [];
  for (const state of guild.voiceStates.cache.values()) {
    if (state.member && !state.member.partial) membership.updateArena(state.member);
  }
  // Read received Gateway state only. View Channel is required; Connect is not
  // requested or used. There is no voice join or REST voice-state lookup here.
  return [...guild.voiceStates.cache.values()]
    .filter(state => state.channelId && (trackedChannels.has(state.channelId)
      || trackedCategories.has(guild.channels.cache.get(state.channelId)?.parentId))
      && guild.channels.cache.get(state.channelId)?.permissionsFor(source.user)?.has(1024n))
    .map(state => ({
      userId: state.id, channelId: state.channelId,
      ...(guild.channels.cache.get(state.channelId)?.parentId ? { categoryId: guild.channels.cache.get(state.channelId).parentId } : {}),
      bot: state.member?.user?.bot ?? guild.members?.cache?.get(state.id)?.user?.bot
        ?? source.users.cache.get(state.id)?.bot ?? (membership.has?.(state.id) ? false : true),
      muted: !!(state.selfMute || state.serverMute), deafened: !!(state.selfDeaf || state.serverDeaf),
      suppressed: !!state.suppress, afk: state.channelId === guild.afkChannelId
    }));
}
