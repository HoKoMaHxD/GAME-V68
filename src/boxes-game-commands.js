import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { boxesBoard } from './boxes-board.js';
import { BOXES_EDGES, boxesScore } from './boxes-game.js';
import { bankMember } from './bank.js';
import { gameDisplays, playGameAction, STALE_GAME_NOTICE } from './game-display.js';
import { XO_MAX } from './xo.js';
import { XoManager } from './xo-commands.js';

export function buildBoxesCommand() {
  return new SlashCommandBuilder().setName('مربعات').setDescription('وصّل النقاط واستحوذ على مربعات أكثر من خصمك')
    .addUserOption(o => o.setName('العضو').setDescription('العضو المتحدّى').setRequired(true))
    .addIntegerOption(o => o.setName('المبلغ').setDescription('المبلغ المحجوز من كل طرف').setMinValue(1).setMaxValue(XO_MAX).setRequired(true));
}
export function boxesPayload(g) {
  const name = id => escapeMarkdown((g.names?.[id] || 'لاعب').slice(0, 60));
  const amount = g.amount.toLocaleString('en-US'), score = boxesScore(g.boxes);
  const status = g.status === 'pending'
    ? `<@${g.o}>، تحدّاك <@${g.x}> في مربعات!\nلوحة من **٩ مربعات**؛ اضغط زر رقم الخط لتوصيل نقطتين متجاورتين. من يرسم الضلع الرابع يملك المربع ويأخذ دورًا إضافيًا. تنتهي اللعبة عند رسم كل الخطوط، وصاحب أكثر مربعات يفوز.\nعند القبول يُحجز **${amount} $** من كل طرف. الفائز يأخذ مبلغ خصمه كاملًا بدون ضريبة.\nالقبول خلال 30 ثانية؛ لكل دور 30 ثانية، وعدم اللعب خسارة. انتظار إرسال تحدٍّ جديد: 20 دقيقة؛ استقبال التحديات متاح أثناء الانتظار.\nتنتهي الدعوة <t:${Math.ceil(g.expiresAt / 1000)}:R>.`
    : g.status === 'active'
      ? `الدور على <@${g.turn}> ${g.turn === g.x ? '🔵' : '🔴'}\n${g.captured.length ? `اكتمل ${g.captured.length === 1 ? 'مربع' : 'مربعان'}؛ لك دور إضافي!\n` : ''}اضغط زر **رقم الخط** الظاهر بين نقطتين في الصورة. إكمال مربع يمنحك دورًا إضافيًا.\nلديك **30 ثانية**؛ تنتهي <t:${Math.ceil(g.expiresAt / 1000)}:R>.\nمبلغ التحدّي: **${amount} $** لكل طرف.`
      : g.status === 'won'
        ? `${g.reason === 'timeout' ? '⏰ انتهت مهلة صاحب الدور؛ تُحسب عليه خسارة.\n' : ''}🏆 فاز <@${g.winner}>!\nربح **${amount} $** من خصمه واسترجع مبلغه المحجوز، بدون ضريبة.`
        : g.status === 'tie' ? '🤝 تعادل في عدد المربعات؛ رجع لكل طرف مبلغه.'
          : g.status === 'rejected' ? 'رُفض التحدّي؛ لم يُخصم أي مبلغ.'
            : g.reason === 'balance' ? 'أُلغي التحدّي؛ رصيد أحد الطرفين لا يكفي. لم يُحجز أي مبلغ.'
              : 'أُلغي التحدّي؛ أُعيدت أي مبالغ محجوزة للطرفين.';
  const color = g.status === 'won' ? (g.winner === g.x ? 0x168ec4 : 0xe64e68)
    : g.status === 'active' ? (g.turn === g.x ? 0x168ec4 : 0xe64e68) : 0x5865f2;
  const embed = new EmbedBuilder().setColor(color).setTitle(`مربعات • ${name(g.x)} ضد ${name(g.o)}`)
    .setDescription(`🔵 <@${g.x}>: **${score.B}**   |   🔴 <@${g.o}>: **${score.R}**\n\n${status}`)
    .setFooter({ text: `مربعات • ${g.edges.filter(Boolean).length}/24 خطًا • رقم اللعبة: ${g.id}` });
  const button = (move, label, style) => new ButtonBuilder().setCustomId(`boxes:v1:${g.id}:${g.revision}:${move}`).setLabel(label).setStyle(style);
  let components = [], files = [];
  if (g.status === 'pending') components = [new ActionRowBuilder().addComponents(
    button('accept', 'قبول', ButtonStyle.Success), button('reject', 'رفض', ButtonStyle.Danger))];
  if (g.status === 'active' || g.acceptedAt != null) {
    const filename = `boxes-${g.id}-${g.revision}.png`;
    embed.setImage(`attachment://${filename}`); files = [{ attachment: boxesBoard(g), name: filename }];
    const buttons = BOXES_EDGES.map((edge, i) => button(String(i + 1), `${i + 1} ${edge.horizontal ? '━' : '┃'}`,
      g.edges[i] === 'B' ? ButtonStyle.Primary : g.edges[i] === 'R' ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(g.status !== 'active' || !!g.edges[i]));
    components = Array.from({ length: 5 }, (_, i) => new ActionRowBuilder().addComponents(...buttons.slice(i * 5, i * 5 + 5)));
  }
  return { content: '', embeds: [embed], components, files, attachments: [], allowedMentions: { parse: [] } };
}

export function createBoxesHandler({ config, service, isBankMember, boxesManager, onError = () => {} }) {
  let displays = boxesManager?.displays;
  return async i => {
    const action = i.isButton?.() ? /^boxes:v1:(\d{17,20}):(\d+):(accept|reject|[1-9]|1\d|2[0-4])$/.exec(i.customId || '') : null;
    if (!action && i.commandName !== 'مربعات' && i.customId !== 'boxes:help') return false;
    if (i.guildId !== config.clanGuildId || i.user.bot) {
      await i.reply({ content: 'اللعبة لأعضاء سيرفر الكلان فقط.', flags: MessageFlags.Ephemeral }); return true;
    }
    if (i.customId === 'boxes:help') {
      await i.reply({ content: 'لبدء التحدّي اكتب: مربعات @العضو المبلغ، مثال: مربعات @العضو 1000. بعد قبول خصمك اضغط زر رقم الخط بين نقطتين في الصورة؛ من يكمل مربعًا يملكه ويلعب مرة أخرى، وصاحب أكثر مربعات يفوز.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); return true;
    }
    if (action) await i.deferUpdate(); else await i.deferReply({});
    displays ||= gameDisplays(service.boxesGame);
    await displays.runSerial(action?.[1] || i.id, async () => {
      try {
        const eligible = id => isBankMember ? isBankMember(id) : bankMember(i, config, id);
        let g, stale = false;
        if (action) ({ round: g, stale } = await playGameAction(service.boxesGame, {
          id: action[1], revision: Number(action[2]), move: action[3], userId: i.user.id, channelId: i.channelId, messageId: i.message?.id
        }, eligible));
        else {
          const target = i.options.getUser('العضو');
          const targetMember = target?.id ? await i.guild?.members?.fetch?.(target.id) : null;
          const names = { [i.user.id]: i.member?.displayName || i.user.username || 'اللاعب الأزرق',
            [target?.id]: targetMember?.displayName || target?.globalName || target?.username || 'اللاعب الأحمر' };
          g = await service.boxesGame.open({ id: i.id, x: i.user.id, o: target?.id, bot: !!target?.bot,
            channelId: i.channelId, amount: i.options.getInteger('المبلغ'), requireDelivery: true, names }, eligible);
        }
        const msg = await i.editReply(boxesPayload(g));
        if (msg?.id && !g.messageId) await service.boxesGame.bind(g.id, msg.id);
        await service.boxesGame.displayed(g);
        if (stale) await i.followUp({ content: STALE_GAME_NOTICE, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch (e) {
        onError(e);
        const p = { content: /[\u0600-\u06ff]/.test(e.message) ? e.message : 'تعذر إكمال الطلب؛ حاول مجددًا.', allowedMentions: { parse: [] } };
        if (action) await i.followUp({ ...p, flags: MessageFlags.Ephemeral });
        else await i.editReply({ ...p, embeds: [], components: [], attachments: [] });
      }
    });
    return true;
  };
}
export class BoxesManager extends XoManager {
  constructor(ctx) { super({ ...ctx, game: ctx.service.boxesGame, payload: boxesPayload }); }
}
