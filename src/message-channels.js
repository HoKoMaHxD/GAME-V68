export const MESSAGE_MAX_AGE_MS = 120000;

export function clanMessageChannels(config = {}) {
  return [...new Set([config.generalChannelId, config.clanChatChannelId].filter(Boolean))];
}

export function messageChannelsFor(task) {
  return [task.channelId].filter(Boolean);
}

export function messageTaskTitle(task) {
  return task.retiredAfterChatSplit ? 'مهمة الكتابة السابقة — صُرفت مكافأتها اليوم' : task.title;
}

export function isUserMessage(message) {
  return !!message.author && !message.author.bot && !message.webhookId && !message.system
    && (message.type == null || [0, 19, 'DEFAULT', 'REPLY'].includes(message.type));
}
