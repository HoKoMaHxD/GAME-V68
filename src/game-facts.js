import { isId } from './config.js';

export const GAME_MAX_AGE_MS = 120000;
const clean = text => String(text || '').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u064b-\u065f\u0670\u0640]/g, '')
  .replace(/[*_~\x60]/g, '');
const mention = '<@!?(\\d{17,20})>';
const blockedContext = /(?:التسجيل|اللوبي|قبل\s+(?:بدء|بداية)|لم\s+تبدأ|الغاء|إلغاء)/u;

function componentItems(components = []) {
  return components.flatMap(c => [c, ...componentItems(c.components || []), ...(c.accessory ? componentItems([c.accessory]) : [])]);
}

function registrationMessage(message) {
  const items = componentItems(message.components);
  const joinButton = items.some(c => c.type === 2 && c.style !== 5 && !c.url && !c.disabled
    && /(?:دخول|[اإ]نضمام|[اإ]نضم|\bjoin\b)/iu.test(clean(c.label)));
  if (!joinButton) return false;
  const text = [message.content, ...(message.embeds || []).flatMap(e =>
    [e.title, e.description, ...(e.fields || []).map(f => (f.name || '') + '\n' + (f.value || ''))]),
    ...items.flatMap(c => [c.label, c.type === 10 ? c.content : ''])]
    .map(clean).join('\n').replace(/<a?:[A-Za-z0-9_]+:\d+>/g, '')
    .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0));
  // Count is a registration marker only. It never identifies members or proves
  // participation. No number in a role/user/custom-emoji ID can match this field.
  return !/(?:إلغاء|الغاء|ألغيت|انتهت)/u.test(text)
    && /المشارك(?:ين|ون)[\s:：()[\]{}|#\-–—]*(\d{1,5})(?=\D|$)/u.test(text);
}

function interactive(components = []) {
  return components.some(c => [2, 3, 5, 6, 7, 8].includes(c.type)
    || interactive(c.components || []) || (c.accessory && interactive([c.accessory])));
}
function hasImage(message) {
  return (message.attachments || []).some(file => {
    if (file.content_type && file.content_type !== 'application/octet-stream') return /^image\//i.test(file.content_type);
    return /\.(png|jpe?g|gif|webp|avif|apng|bmp)$/i.test(file.filename || '');
  }) || (message.embeds || []).some(e => !!e.image?.url || (e.type === 'image' && !!e.url));
}

function namedWinners(texts) {
  const userIds = [];
  let hasHeading = false;
  for (const text of texts) {
    let inList = false;
    for (const original of text.split('\n')) {
      const line = original.replace(/<a?:[A-Za-z0-9_]+:\d+>/g, '').trim();
      const heading = line.match(/^[\s\p{P}\p{S}\uFE0F]*قائمة\s+الفائزين(?=$|[\s\p{P}\p{S}])(.*)$/u);
      if (heading) { hasHeading = true; inList = true; }
      if (!inList) continue;
      let entry = heading ? heading[1] : line;
      const ids = [];
      const leadingMention = new RegExp('^[\\s\\p{P}\\p{S}\\p{N}\\uFE0Fو]*?' + mention, 'u');
      let match;
      while ((match = entry.match(leadingMention))) {
        ids.push(match[1]); entry = entry.slice(match[0].length);
      }
      // Only explicit list entries belong to this section. A later host/loser
      // heading or sentence ends it, so unrelated mentions cannot earn a game.
      // A trailing role/score label is fine, but mentions after prose (such as
      // "by <@host>") are not additional list members.
      if (!ids.length && !/^[\s\p{P}\p{S}\p{N}\uFE0Fو]*$/u.test(entry)) { inList = false; continue; }
      userIds.push(...ids);
    }
  }
  return { hasHeading, userIds: [...new Set(userIds)] };
}

function terminalMembers(texts, phrase) {
  const ids = new Set();
  const first = new RegExp(phrase + '\\s*[:：\\-–—]?\\s*' + mention, 'gmu');
  const next = new RegExp('^[\\s,،]*(?:(?:و|and|&)\\s*)?' + mention, 'iu');
  for (const text of texts) {
    for (const match of text.matchAll(first)) {
      ids.add(match[1]);
      let tail = text.slice(match.index + match[0].length);
      let member;
      // A single terminal notice can name several victims. Continue through
      // the adjacent mention list only; prose such as "by" or "remaining"
      // ends that list, so a host/actor/survivor mention is never included.
      while ((member = tail.match(next))) {
        ids.add(member[1]); tail = tail.slice(member[0].length);
      }
    }
  }
  return [...ids];
}

// Only these user-supplied terminal formats count. Names on wheel images and
// arbitrary mentions, button labels, roles, hosts and notifications never do.
export function parseGameMessage(message, config) {
  if (!isId(message.id) || message.guild_id !== config.arenaGuildId || message.channel_id !== config.gamesChannelId
    || message.author?.id !== config.gamesBotId || message.author.bot !== true
    || (message.type != null && ![0, 19].includes(message.type))) return null;
  const texts = [message.content, ...(message.embeds || []).flatMap(e =>
    [[e.title, e.description, ...(e.fields || []).flatMap(f => [f.name, f.value])].filter(Boolean).join('\n')])].map(clean);
  const text = texts.join('\n');
  const elimination = '(?:تم\\s+طرد|لقد\\s+تم\\s+تفجير|المافيا\\s+قامت\\s+بقتل\\s+(?:المواطن|المحقق)|تم\\s+[إا]عدام|(?<![\\p{L}\\p{N}])تم\\s+العثور\\s+على)';
  const losers = terminalMembers(texts, elimination);
  const withdrawn = terminalMembers(texts, 'لقد\\s+انسحب\\s*[:：\\-–—]?\\s*(?:(?:العضو|اللاعب)\\s+)?');
  const named = namedWinners(texts);
  const winners = named.hasHeading ? named.userIds : terminalMembers(texts, '^\\s*>\\s*-');
  if (registrationMessage(message)) return { kind: 'lobby', userIds: [] };
  if (blockedContext.test(text)) return null;
  if (winners.length && !losers.length && !withdrawn.length && (named.hasHeading || hasImage(message)) && !interactive(message.components)) {
    return { kind: 'win', userIds: [...new Set(winners)] };
  }
  if (losers.length && !winners.length && !withdrawn.length) return { kind: 'elimination', userIds: [...new Set(losers)] };
  if (withdrawn.length && !winners.length && !losers.length) return { kind: 'withdrawal', userIds: [...new Set(withdrawn)] };
  return null;
}

export function rawGameMessage(message) {
  return {
    id: message.id, guild_id: message.guildId, channel_id: message.channelId,
    author: message.author && { id: message.author.id, bot: message.author.bot },
    content: message.content, type: message.type === 'DEFAULT' ? 0 : message.type === 'REPLY' ? 19 : message.type,
    timestamp: new Date(message.createdTimestamp).toISOString(),
    edited_timestamp: message.editedTimestamp ? new Date(message.editedTimestamp).toISOString() : null,
    attachments: [...(message.attachments?.values() || [])].map(a => ({
      filename: a.name, content_type: a.contentType, url: a.url
    })),
    embeds: (message.embeds || []).map(e => e.toJSON?.() || e),
    components: (message.components || []).map(c => c.toJSON?.() || c)
  };
}

// The observer disables the SDK message cache. Raw updates plus a small cache
// scoped to the games room preserve explicit [] (buttons removed) versus omitted
// fields (buttons unchanged). A cache miss uses one authorized read of that
// exact message; it never crawls old channel history.
export class GameFacts {
  constructor(config, fetchMessage) { this.config = config; this.fetchMessage = fetchMessage; this.cache = new Map(); }
  clear() { this.cache.clear(); }
  accepts(packet) {
    return ['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(packet.t)
      && isId(packet.d?.id)
      && packet.d?.channel_id === this.config.gamesChannelId
      && (!packet.d.guild_id || packet.d.guild_id === this.config.arenaGuildId)
      && (!packet.d.author || packet.d.author.id === this.config.gamesBotId);
  }
  async read(packet, receivedAt) {
    if (!this.accepts(packet)) return null;
    const update = packet.t === 'MESSAGE_UPDATE';
    const data = packet.d;
    let previous = this.cache.get(data.id);
    if (update && !previous) {
      if (!this.fetchMessage) throw new Error('تعذر قراءة تعديل رسالة الألعاب غير المحفوظة؛ يلزم الوصول إلى الرسالة الأصلية.');
      previous = await this.fetchMessage(data.id);
      // A read can race a later edit. Never overwrite a newer fetched snapshot
      // with an older update and mistake a live wheel for the winner image.
      if (Date.parse(previous.edited_timestamp) > Date.parse(data.edited_timestamp)) return null;
    }
    const message = update ? { ...previous, ...data } : { components: [], attachments: [], embeds: [], ...data };
    if (message.author?.id !== this.config.gamesBotId || message.author.bot !== true
      || message.guild_id !== this.config.arenaGuildId) return null;
    this.cache.delete(data.id);
    this.cache.set(data.id, message);
    while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    const at = update ? (Date.parse(data.edited_timestamp) || receivedAt) : Date.parse(data.timestamp);
    if (!Number.isFinite(at) || receivedAt - at > GAME_MAX_AGE_MS || at > receivedAt + 5000) return null;
    const parsed = parseGameMessage(message, this.config);
    // Every edit of a participant counter refers to the original registration
    // message, never the edit time. Old counter edits cannot start a new game.
    const proofAt = parsed?.kind === 'lobby' ? Date.parse(message.timestamp) : at;
    if (!Number.isFinite(proofAt) || receivedAt - proofAt > GAME_MAX_AGE_MS || proofAt > receivedAt + 5000) return null;
    return parsed ? { ...parsed, id: data.id, at: proofAt, receivedAt, guildId: message.guild_id,
      channelId: message.channel_id, botId: message.author.id } : null;
  }
}
