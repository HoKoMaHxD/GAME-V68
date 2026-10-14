import { isUserMessage } from './message-channels.js';

const MEDIA_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|bmp|apng|mp4|mov|webm|m4v|mkv|avi|ogv)$/i;
const values = collection => collection?.values ? [...collection.values()] : [];

export function hasImageOrVideo(message) {
  if (values(message.attachments).some(file => {
    const type = file.contentType || file.content_type;
    // An explicit non-media MIME type must not pass just because of a renamed file.
    if (type && type !== 'application/octet-stream') return /^(image|video)\//i.test(type);
    return MEDIA_EXTENSION.test(file.name || file.filename || '');
  })) return true;
  return (message.embeds || []).some(embed =>
    !!embed.image?.url || !!embed.video?.url
    || (['image', 'video', 'gifv'].includes(embed.type) && !!embed.url));
}

export class MessageFacts {
  constructor(clock = Date.now) { this.clock = clock; this.pending = new Map(); }
  clear() { this.pending.clear(); }
  forget(id) { this.pending.delete(id); }
  prune() {
    for (const [id, event] of this.pending) if (this.clock() - event.at > 120000) this.pending.delete(id);
  }
  created(message, waitForMedia = false) {
    this.prune();
    const event = {
      guildId: message.guildId, channelId: message.channelId, userId: message.author.id,
      id: message.id, at: message.createdTimestamp, content: message.content,
      mentionedRoleIds: message.mentions?.roles ? [...message.mentions.roles.keys()] : [],
      hasMedia: hasImageOrVideo(message), bot: !!message.author.bot,
      webhook: !!message.webhookId, system: !isUserMessage(message), eligible: true
    };
    if (waitForMedia && !event.hasMedia && this.clock() - event.at <= 120000) {
      // Store only original identity/mention facts for delayed image/video previews.
      // User edits cannot add a qualifying mention or attachment after sending.
      this.pending.set(event.id, { ...event, content: '', mediaOnly: true });
      while (this.pending.size > 2000) this.pending.delete(this.pending.keys().next().value);
    }
    return event;
  }
  updated(message) {
    this.prune();
    const original = this.pending.get(message.id);
    if (!original) return null;
    if (message.editedTimestamp != null || message.edited_timestamp != null) {
      this.forget(message.id); return null;
    }
    if ((message.guildId && message.guildId !== original.guildId)
      || (message.channelId && message.channelId !== original.channelId) || !hasImageOrVideo(message)) return null;
    this.forget(message.id);
    return { ...original, hasMedia: true };
  }
}
