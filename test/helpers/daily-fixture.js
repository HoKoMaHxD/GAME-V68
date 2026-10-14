import { fixture, config as base, at, user, snowflake } from './shop-fixture.js';
export const dailyConfig = { ...base, generalChannelId: '100000000000000040', clanChatChannelId: '100000000000000041',
  voiceChannelId: '100000000000000042', secondVoiceChannelId: '100000000000000043', thirdVoiceChannelId: '100000000000000044',
  feelingChannelId: '100000000000000045', lookChannelId: '100000000000000046',
  gamesChannelId: '1142961202004234330', gamesBotId: '995439183650889888',
  attendance: { enabled: true, channelId: '100000000000000042', version: 1, points: 10,
    intervalMs: 600000, dailyCap: 4000, minPeople: 1, ignoreMuted: false, ignoreDeafened: true } };
export async function dailyFixture({ start = at, install = true } = {}) {
  const f = await fixture(); let now = start, sequence = 1000;
  f.store.config = structuredClone(dailyConfig); f.service.config = f.store.config; f.service.clock = () => now;
  await f.store.notifications.initialize(start);
  await f.store.initializeActivity(start);
  f.service.templateCache = null;
  if (install) { await f.store.initializeDailyQuests(start); await f.store.initializeDailyRewards(start); }
  const message = (channelId = dailyConfig.clanChatChannelId, extra = {}) => ({ id: snowflake(now, sequence++), at: now,
    guildId: dailyConfig.arenaGuildId, userId: user, eligible: true, channelId, ...extra });
  const restart = async () => {
    const reopened = f.open(now);
    reopened.store.config = f.store.config; reopened.service.config = f.store.config; reopened.service.clock = () => now;
    await reopened.store.notifications.initialize(now); await reopened.store.initializeResets(now);
    await reopened.store.initializeDailyQuests(now); await reopened.store.initializeDailyRewards(now); reopened.service.templateCache = null; return reopened;
  };
  return { ...f, message, restart, now: () => now, time: value => { now = value; },
    post: (channelId, extra) => f.service.message(message(channelId, extra)) };
}
