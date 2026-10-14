import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { bankMember } from './bank.js';
import { COLORS, COLOR_SIZE, MINI_KINDS } from './mini-games.js';
import { gameDisplays, GameDisplayJobs, STALE_GAME_NOTICE } from './game-display.js';
const names = { 'الوان': 'colors', 'ألوان': 'colors', 'نرد': 'dice' };
const title = kind => kind === 'colors' ? 'ألوان' : 'نرد';
const money = n => `${n.toLocaleString('en-US')} $`;
const colorPresses = new WeakMap();

// Fast color moves can acknowledge AND draw via the component callback. The
// previous deferUpdate + editReply path sent two requests for every move and
// queued all board edits on the webhook route. Slow DB/queue work still gets
// an acknowledgement after one second, well before Discord's 3-second limit.
function colorResponse(interaction) {
  let initial = null, failed = false, timer;
  const respond = operation => {
    clearTimeout(timer);
    initial = Promise.resolve().then(operation);
    void initial.catch(() => { failed = true; });
    return initial;
  };
  const defer = () => initial || respond(() => interaction.deferUpdate());
  timer = setTimeout(defer, 1000);
  timer.unref?.();
  return {
    defer,
    async show(payload) {
      if (!initial) {
        await respond(() => interaction.update(payload));
        return interaction.message;
      }
      await initial;
      return interaction.editReply(payload);
    },
    async notice(payload) {
      if (failed) return; // The saved dirty board will be retried by the manager.
      if (!initial) return respond(() => interaction.reply(payload));
      await initial;
      return interaction.followUp(payload);
    },
    close() { clearTimeout(timer); }
  };
}
export function buildMiniCommands() {
  return ['الوان', 'نرد'].map(name => new SlashCommandBuilder().setName(name)
    .setDescription(`${name === 'نرد' ? 'ارم النرد ضد البوت' : 'وحّد شبكة الألوان بمحاولات تناسب صعوبة الشبكة'}؛ ربح أو خسارة 5–10%، كل 20 دقيقة`));
}
export function parseMiniAction(id) {
  const m = /^mini:v1:(colors|dice):(\d{17,20}):(\d{17,20}):(\d{1,4}):(roll|[0-4])$/.exec(id || '');
  return m ? { kind: m[1], userId: m[2], id: m[3], revision: Number(m[4]), move: m[5] } : null;
}
export function miniPayload(round) {
  const embed = new EmbedBuilder().setColor(0x949cf7).setTitle(title(round.kind));
  if (round.author) embed.setAuthor(round.author);
  if (round.status === 'cooldown') return { content: '', embeds: [embed.setDescription(`⏳ تقدر تلعب ${title(round.kind)} مجددًا <t:${Math.ceil(round.nextAt / 1000)}:R>.\nلكل لعبة انتظار مستقل 20 دقيقة.`)], components: [], allowedMentions: { parse: [] } };
  const lines = [];
  if (round.kind === 'colors') {
    if (round.status === 'open') lines.push('وحّد ألوان الشبكة بدءًا من **أعلى اليسار**، باختيار لون مجاور للمساحة المتصلة.');
    lines.push(Array.from({ length: COLOR_SIZE }, (_, row) => round.board.slice(row * COLOR_SIZE, (row + 1) * COLOR_SIZE).map(n => COLORS[n]).join('')).join('\n'));
    lines.push(`**عدد المحاولات:** ${round.moves}/${round.maxMoves}`);
  } else lines.push(`🎲 رقمي: **${round.botDie || '؟'}**\n🎲 رقمك: **${round.playerDie || '؟'}**`);
  if (round.status === 'open') {
    lines.push(round.kind === 'dice' ? 'قم برمي النرد من الزر بالأسفل. الرقم الأعلى يفوز، والتعادل دون تغيير الرصيد.' : 'اختر اللون من الأزرار بالأسفل.');
    lines.push(`⏰ الوقت: <t:${Math.ceil(round.expiresAt / 1000)}:R>\nربح أو خسارة **5–10%** من رصيدك وقت النتيجة. انتهاء الوقت يُحسب خسارة.`);
  } else if (round.status === 'cancelled') lines.push('أُلغيت اللعبة دون ربح أو خصم.');
  else {
    const r = round.result;
    lines.push(r.outcome === 'win' ? '🥳 مبروك لقد ربحت!' : r.outcome === 'tie' ? '🤝 تعادل — لم يتغير رصيدك.' : '😕 لقد خسرت!');
    if (round.endReason === 'timeout') lines.push('انتهى وقت اللعبة.');
    if (r.outcome !== 'tie') lines.push(`**${r.outcome === 'win' ? 'الربح' : 'الخصم'}:** ${money(r.amount)} (${r.percent}%)`);
    lines.push(`رصيدك السابق: **${money(r.before)}**\nرصيدك الحالي: **${money(r.after)}**`);
  }
  embed.setDescription(lines.join('\n\n')).setFooter({ text: 'SNOW BANK • كل لعبة مرة كل 20 دقيقة' });
  const button = (move, label) => new ButtonBuilder().setCustomId(`mini:v1:${round.kind}:${round.userId}:${round.id}:${round.revision}:${move}`)
    .setLabel(label).setStyle(ButtonStyle.Primary).setDisabled(round.status !== 'open' || (round.kind === 'colors' && Number(move) === round.board[0]));
  const buttons = round.kind === 'dice' ? [button('roll', 'رمي النرد')] : COLORS.map((emoji, i) => button(String(i), emoji));
  return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)], allowedMentions: { parse: [] } };
}
export function createMiniHandler({ config, service, isBankMember, onError = () => {} }) {
  let displays;
  return async interaction => {
    const action = interaction.isButton?.() ? parseMiniAction(interaction.customId) : null;
    const start = interaction.isButton?.() ? /^clan-games:play:(colors|dice)$/.exec(interaction.customId || '')?.[1] : null;
    const kind = start || names[interaction.commandName];
    if (!kind && !action) return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId || interaction.user.bot) { await deny('اللعبة متاحة لأعضاء سيرفر الكلان فقط.'); return true; }
    if (action && action.userId !== interaction.user.id) { await deny('هذه لعبة عضو آخر. اكتب الوان أو نرد لبدء لعبتك.'); return true; }
    const eligible = id => isBankMember ? isBankMember(id) : bankMember(interaction, config, id);
    displays ||= gameDisplays(service.mini);
    let pending, pressKey;
    if (action?.kind === 'colors') {
      if (!colorPresses.has(service.mini)) colorPresses.set(service.mini, new Set());
      pending = colorPresses.get(service.mini);
      pressKey = `${action.id}:${action.userId}:${interaction.channelId}:${interaction.message?.id}:${action.revision}`;
      // Only the first choice from a displayed revision can count. A repeated
      // click must be acknowledged without joining either the DB or edit queue.
      if (pending.has(pressKey)) { await interaction.deferUpdate(); return true; }
      pending.add(pressKey);
    }
    const response = action?.kind === 'colors' && typeof interaction.update === 'function' ? colorResponse(interaction) : null;
    let notice;
    try {
      if (!response) {
        if (action) await interaction.deferUpdate(); else await interaction.deferReply({});
      }
      await displays.runSerial(`${action?.kind || kind}:${interaction.user.id}`, async () => {
        try {
          const previous = action ? (await service.mini.latest(action.userId, action.kind))?.miniGames?.[action.kind] : null;
          const stale = !!action && previous?.id === action.id && previous?.revision !== action?.revision;
          const iconURL = interaction.user.displayAvatarURL?.({ extension: 'png', size: 128 });
          const author = { name: (interaction.member?.displayName || interaction.user.globalName || interaction.user.username || 'عضو الكلان').slice(0, 256), ...(iconURL ? { iconURL } : {}) };
          const round = action ? await service.mini.play({ ...action, channelId: interaction.channelId, messageId: interaction.message?.id }, eligible)
            : await service.mini.open({ kind, id: interaction.id, userId: interaction.user.id, channelId: interaction.channelId,
              at: interaction.createdTimestamp || service.clock(), author }, eligible);
          if (!action && round.status === 'open' && round.id !== interaction.id && round.messageId) {
            await interaction.editReply({ content: `عندك جولة مستمرة؛ أكملها هنا: https://discord.com/channels/${config.clanGuildId}/${round.channelId}/${round.messageId}`, allowedMentions: { parse: [] } });
            return;
          }
          // A stale/no-op press must not resend a revision already shown. A
          // failed edit leaves displayRevision behind, so it is still repaired.
          if (action?.kind === 'colors' && round.messageId && round.displayRevision === round.revision) {
            if (response) await response.defer();
          } else {
            const message = response ? await response.show(miniPayload(round)) : await interaction.editReply(miniPayload(round));
            if (round.status !== 'cooldown' && message?.id) {
              if (!round.messageId) await service.mini.bind(round, message.id);
              await service.mini.markDisplayed(round);
            }
          }
          if (stale && round.status === 'open') notice = { content: STALE_GAME_NOTICE, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
        } catch (error) {
          onError(error);
          const payload = { content: /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر إكمال اللعبة. حاول مجددًا؛ النتيجة المحفوظة لا تُصرف مرتين.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
          if (action) notice = payload;
          else await interaction.editReply({ ...payload, embeds: [], components: [] });
        }
      });
      // Ephemeral followups can be rate-limited too. Never hold the board's
      // display lock while sending one, or the next valid color gets stuck.
      pending?.delete(pressKey);
      pending = null;
      if (notice) {
        if (response) await response.notice(notice);
        else await interaction.followUp(notice);
      }
    } finally {
      pending?.delete(pressKey);
      response?.close();
    }
    return true;
  };
}
export class MiniGameManager {
  constructor({ bot, service, canRun, onError = () => {} }) { Object.assign(this, { bot, service, canRun, onError }); this.running = null; this.displays = gameDisplays(service.mini); this.jobs = new GameDisplayJobs(onError); }
  tick() {
    if (this.running) return this.running;
    this.running = this.update().finally(() => { this.running = null; }); return this.running;
  }
  async update() {
    if (!this.canRun()) return;
    await this.service.mini.expire();
    for (const day of await this.service.mini.pending()) for (const kind of MINI_KINDS) {
      const row = day.miniGames?.[kind];
      if (!this.canRun()) return;
      if (!row?.messageId || row.displayRevision === row.revision) continue;
      const key = `${kind}:${row.userId}`;
      this.jobs.add(key, () => this.displays.runSerial(key, async () => {
        if (!this.canRun()) return;
        let round = (await this.service.mini.latest(row.userId, kind))?.miniGames?.[kind];
        if (round?.id !== row.id || !round.messageId || round.displayRevision === round.revision) return;
        try {
          const channel = await this.bot.channels.fetch(round.channelId);
          if (channel?.guildId !== this.service.config.clanGuildId) return;
          const message = await channel.messages.fetch(round.messageId);
          if (message.author.id !== this.bot.user.id) return;
          if (!this.canRun()) return;
          round = (await this.service.mini.latest(row.userId, kind))?.miniGames?.[kind];
          if (round?.id !== row.id || round.messageId !== row.messageId || round.displayRevision === round.revision) return;
          await message.edit(miniPayload(round));
          await this.service.mini.markDisplayed(round);
        } catch (error) {
          if ([10008, 10003, 50001, 50013].includes(Number(error.code))) await this.service.mini.markDisplayed(round);
          else this.onError(error);
        }
      }));
    }
  }
  async drain() { await this.running; await this.jobs.drain(); }
}
