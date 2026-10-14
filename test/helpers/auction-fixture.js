import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { AuctionManager } from '../../src/auction-manager.js';
import { AUCTION_ROLE_ID, AUCTION_DURATION_MS } from '../../src/auction.js';
import { fixture, at, user, other, actor, config, destination, snowflake } from './shop-fixture.js';

export const auctionId = snowflake(at, 80);
export const liveId = snowflake(at + 60000, 81);
export const auctionInput = (overrides = {}) => ({ id: auctionId, createdBy: actor, channelId: destination.channelId,
  name: 'بطاقة هدية', description: 'بطاقة رقمية للتسليم عبر الإدارة', quantity: 3,
  imageUrl: 'https://cdn.discordapp.com/attachments/100000000000000001/100000000000000002/item.png',
  startPrice: 1000, startsAt: at + 60000, ...overrides });

export async function auctionFixture({ active = true, tasks = 10000, attendance = 0, startPrice = 1000 } = {}) {
  const f = await fixture(); let time = at, seq = 100;
  f.service.clock = () => time;
  await f.store.auctions.initialize(at);
  await f.seed(user, tasks, attendance); await f.seed(other, tasks, attendance);
  await f.service.createAuction(auctionInput({ startPrice }));
  const set = now => { time = now; };
  if (active) {
    time = at + 60000;
    await f.service.auctionChange(auctionId, a => {
      a.status = 'active'; a.startedAt = time; a.endsAt = time + AUCTION_DURATION_MS;
      a.delivery.live.messageId = liveId; return true;
    });
  }
  const bid = (overrides = {}) => ({ auctionId, userId: user, operationId: snowflake(time, seq++),
    at: time, channelId: destination.channelId, messageId: liveId, increment: 500, ...overrides });
  return { ...f, set, bid, now: () => time, get: () => f.store.auctions.get(auctionId),
    balance: id => f.store.totals(id, 'all', time),
    restart: () => { const reopened = f.open(time); reopened.service.clock = () => time; return reopened; } };
}

export async function managerFixture() {
  const f = await auctionFixture({ active: false });
  const messages = new Map(), sent = [], edits = [], deleted = [], errors = [];
  const state = { failSend: false, loseSendAck: false, permission: true, mentionable: true, canMention: false, live: true };
  const bot = { user: { id: actor }, channels: { fetch: async () => channel } };
  let sequence = 200;
  const channel = { id: destination.channelId, guildId: config.clanGuildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: p => p === PermissionFlagsBits.MentionEveryone ? state.canMention : state.permission }),
    guild: { roles: { fetch: async id => ({ id, mentionable: state.mentionable }) } },
    messages: { fetch: async query => {
      if (typeof query === 'object') return messages;
      if (!messages.has(query)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return messages.get(query);
    } },
    send: async payload => {
      if (state.failSend) throw new Error('Discord offline');
      const json = p => ({ ...p, embeds: p.embeds.map(e => e.toJSON()), components: p.components.map(c => c.toJSON()) });
      const message = { id: snowflake(f.now(), sequence++), createdTimestamp: f.now(), author: bot.user,
        ...json(payload),
        edit: async p => { edits.push(p); Object.assign(message, json(p)); return message; },
        delete: async () => { deleted.push(message.id); messages.delete(message.id); } };
      messages.set(message.id, message); sent.push(payload);
      if (state.loseSendAck) { state.loseSendAck = false; throw new Error('Discord send acknowledgement lost'); }
      return message;
    }
  };
  const openManager = (service = f.service, store = f.store) => new AuctionManager({ bot, store, service, clock: f.now,
    canRun: () => state.live && !service.blocked, onError: e => errors.push(e) });
  const manager = openManager();
  return { ...f, bot, channel, messages, sent, edits, deleted, state, errors, openManager, manager, roleId: AUCTION_ROLE_ID };
}
