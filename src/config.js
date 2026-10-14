import { readAuthConfig } from './auth.js';

export const isId = value => typeof value === 'string' && /^\d{17,20}$/.test(value);

export function readConfig(env = process.env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`المتغير ${name} مطلوب.`);
    return value;
  };
  const id = name => {
    const value = required(name);
    if (!isId(value)) throw new Error(`${name} يجب أن يكون ID ديسكورد صحيحًا.`);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name]?.trim() || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`قيمة ${name} غير صالحة.`);
    return value;
  };
  const boolean = (name, fallback) => {
    const value = env[name]?.trim() || String(fallback);
    if (!['true', 'false'].includes(value)) throw new Error(`${name}: استخدم true أو false.`);
    return value === 'true';
  };
  const auth = readAuthConfig(env);
  const mongoUri = required('MONGODB_URI');
  if (!/^mongodb(?:\+srv)?:\/\//.test(mongoUri)) throw new Error('MONGODB_URI يجب أن يبدأ بـ mongodb:// أو mongodb+srv://');
  const memberRole = id('CLAN_MEMBER_ROLE_ID');
  const gamesBotId = env.ARENA_GAMES_BOT_ID?.trim() ? id('ARENA_GAMES_BOT_ID') : '995439183650889888';
  const gamesChannelId = env.ARENA_GAMES_CHANNEL_ID?.trim() ? id('ARENA_GAMES_CHANNEL_ID') : '1142961202004234330';
  const generalChannelId = id('GENERAL_CHANNEL_ID');
  const clanChatChannelId = id('CLAN_CHAT_CHANNEL_ID');
  if (generalChannelId === clanChatChannelId) throw new Error('CLAN_CHAT_CHANNEL_ID يجب أن يختلف عن GENERAL_CHANNEL_ID.');
  return {
    ...auth,
    gamesBotId, gamesChannelId,
    mongoUri, dbName: env.MONGODB_DB?.trim() || 'clan_quests',
    clanGuildId: id('CLAN_GUILD_ID'), arenaGuildId: id('ARENA_GUILD_ID'),
    generalChannelId, clanChatChannelId, voiceChannelId: id('CLAN_VOICE_CHANNEL_ID'), memberRole,
    secondVoiceChannelId: env.CLAN_VOICE_CHANNEL_ID_2?.trim() ? id('CLAN_VOICE_CHANNEL_ID_2') : null,
    thirdVoiceChannelId: env.CLAN_VOICE_CHANNEL_ID_3?.trim() ? id('CLAN_VOICE_CHANNEL_ID_3') : null,
    feelingChannelId: id('FEELING_CHANNEL_ID'), lookChannelId: id('LOOK_CHANNEL_ID'),
    weekStart: integer('WEEK_START_DAY', 0, 0, 6),
    attendance: {
      channelId: id('CLAN_VOICE_CHANNEL_ID'), enabled: true, version: 1,
      points: integer('VOICE_POINTS', 200, 1, 100000),
      intervalMs: integer('VOICE_INTERVAL_MINUTES', 21, 1, 1440) * 60000,
      dailyCap: integer('VOICE_DAILY_CAP', 4000, 1, 100000),
      minPeople: integer('VOICE_MIN_PEOPLE', 1, 1, 100),
      ignoreMuted: boolean('VOICE_IGNORE_MUTED', false), ignoreDeafened: boolean('VOICE_IGNORE_DEAFENED', false)
    },
    port: env.PORT ? integer('PORT', 10000, 1024, 65535) : null
  };
}
