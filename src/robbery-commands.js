import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { readAppearance } from './appearance.js';
import { ROBBERY_MOVES, effectiveRobberyProtection } from './robbery.js';
import { bankMember, requireBankChannel } from './bank.js';
import { bankMoney } from './bank-commands.js';
import { MINE_CELLS } from './robbery-mine.js';
import { ActivityGate } from './activity-gate.js';
import { isId } from './config.js';

const PREFIX = 'clan-robbery:v1:';
export function buildRobberyCommand() {
  return new SlashCommandBuilder().setName('نهب').setDescription('تحدَّ البوت عشوائيًا في حجر ورقة مقص أو اللغم لمحاولة نهب عضو')
    .addUserOption(option => option.setName('العضو').setDescription('العضو الذي تريد محاولة نهبه').setRequired(true));
}
export function parseRobberyAction(id) {
  const mine = /^clan-robbery:v1:(\d{17,20}):(\d{17,20}):mine:([0-5]):([1-9])$/.exec(id || '');
  if (mine) return { userId: mine[1], id: mine[2], revision: Number(mine[3]), cell: Number(mine[4]) };
  const match = /^clan-robbery:v1:(\d{17,20}):(\d{17,20}):(rock|paper|scissors)$/.exec(id || '');
  return match ? { userId: match[1], id: match[2], move: match[3] } : null;
}
const rtlLine = text => `\u200f${text}\u200f`;
const mention = id => `\u2068<@${id}>\u2069`;
const codeValue = value => `\`\u2066${value}\u2069\``;
const protectionSecondsLeft = (protection, at) => Math.max(0, Math.ceil((protection.expiresAt - at) / 1000));

function protectionTimeLeft(protection, at) {
  const remaining = protectionSecondsLeft(protection, at);
  return [[Math.floor(remaining / 3600), 'hour'], [Math.floor(remaining % 3600 / 60), 'minute'], [remaining % 60, 'second']]
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value} ${unit}${value === 1 ? '' : 's'}`).join(' ') || '0 seconds';
}

function robberyProtectionPayload(protection, at) {
  const remaining = protectionSecondsLeft(protection, at);
  const duration = `\`\u2067${Math.floor(remaining / 60)} دقائق ${remaining % 60} ثانية\u2069\``;
  return { content: rtlLine(`🛡️ ${mention(protection.userId)} محمي من النهب لمدة ${duration}`),
    embeds: [], components: [], allowedMentions: { parse: [] } };
}

function robberyAuthor({ user, member } = {}, saved = {}) {
  const name = member?.displayName || member?.nick || user?.globalName || user?.username || saved.name || 'عضو الكلان';
  const iconURL = member?.displayAvatarURL?.({ extension: 'png', size: 128 })
    || user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || saved.iconURL;
  return { name: name.slice(0, 256), ...(iconURL ? { iconURL } : {}) };
}

function mineBoard(round) {
  const rows = [];
  for (let row = 0; row < 3; row++) rows.push(new ActionRowBuilder().addComponents(
    ...MINE_CELLS.slice(row * 3, row * 3 + 3).map(cell => {
      const picked = round.mine.picks.some(p => p.cell === cell);
      const hit = picked && cell === round.mine.cell;
      const button = new ButtonBuilder().setCustomId(`${PREFIX}${round.userId}:${round.id}:mine:${round.mine.revision}:${cell}`)
        .setStyle(hit ? ButtonStyle.Danger : picked ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(picked || round.status !== 'open' || !!round.displayBotTurn);
      return picked ? button.setEmoji(hit ? '💣' : '👁️') : button.setLabel(String(cell));
    })
  ));
  return rows;
}

export function robberyPayload(round, appearance = {}, actor = {}, at = Date.now()) {
  const open = round.status === 'open';
  const mine = round.game === 'mine';
  const author = robberyAuthor(actor, round.displayAuthor);
  const timedOut = round.endReason === 'timeout' || round.timedOut === true;
  const embed = new EmbedBuilder().setTitle(open ? 'تحدي النهب' : 'انتهى تحدي النهب')
    .setColor(0xffffff).setAuthor(author)
    .setFooter({ text: `${readAppearance(appearance).name} Pay` })
    .setTimestamp(round.settledAt || round.createdAt);
  if (mine && author.iconURL) embed.setThumbnail(author.iconURL);
  if (open && mine) {
    const last = round.mine.picks.at(-1);
    embed.setTitle('💣 تحدي النهب — اللغم').setDescription([
      rtlLine(`**المواجهة:** ${mention(round.userId)} ضد 🤖 البوت`),
      rtlLine(`**المستهدف بالنهب:** ${mention(round.targetId)}`),
      ...(last ? [rtlLine(`${last.actor === 'bot' ? '🤖 البوت اختار' : '👤 اخترت'} **${last.cell}** — 👁️ آمن`)] : []),
      rtlLine(round.displayBotTurn ? '🤖 **دور البوت…**' : '**دورك:** اختر رقمًا لم يُكشف. من يختار اللغم يخسر!'),
      rtlLine(`**الوقت المتبقي:** <t:${Math.ceil(round.expiresAt / 1000)}:R>`),
      ...(round.timeoutLoss ? [rtlLine('⏳ عدم إكمال التحدي قبل انتهاء الوقت يُحسب خسارة.')] : [])
    ].join('\n'));
  } else if (open) embed.setDescription([
    rtlLine('اختر حجر أو ورقة أو مقص ضد البوت.'),
    rtlLine(`إذا فزت، تنجح عملية نهب ${mention(round.targetId)}.`),
    ...(round.timeoutLoss ? [rtlLine(`**الوقت المتبقي:** <t:${Math.ceil(round.expiresAt / 1000)}:R>`),
      rtlLine('⏳ عدم اختيار حركة قبل انتهاء الوقت يُحسب خسارة.')] : [])
  ].join('\n'));
  else if (round.status !== 'settled') embed.setDescription(round.status === 'cancelled'
    ? round.endReason === 'delivery' ? 'أُلغي التحدي لتعذّر عرض لوحة اللعب أو تحديثها. لم يُخصم أي مبلغ بسبب الإلغاء.'
      : round.endReason === 'protection' ? 'أُلغي التحدي لأن المستهدف حصل على حماية أثناء اللعب. لم يُخصم أي مبلغ بسبب الإلغاء.'
      : round.endReason === 'membership' ? 'أُلغي التحدي لمغادرة أحد الطرفين سيرفر الكلان. لم يُخصم أي مبلغ بسبب الإلغاء.'
        : 'أُلغي التحدي بسبب الريست أو تغيير شات البنك أو إيقاف أمر نهب. لم تُنفذ عملية نهب من هذا الزر.'
    : 'انتهت مهلة الاختيار دون نهب. اكتب `!نهب @عضو` لبدء تحدٍّ جديد.');
  else {
    const result = round.result;
    const protection = effectiveRobberyProtection(round);
    const move = id => { const item = ROBBERY_MOVES.find(m => m.id === id); return `${item.emoji} ${item.label}`; };
    const title = result.amount
      ? { win: 'كفو زرفته', loss: 'للأسف انزرفت', tie: 'تعادل' }[result.outcome]
      : { win: 'فزت على البوت', loss: 'خسرت أمام البوت', tie: 'تعادل' }[result.outcome];
    // Keep the recipient on the left and payer on the right, like the reference,
    // even when one display name is Arabic. Zero transfers must not imply a theft.
    const transfer = result.amount
      ? `\u200e\u2066${mention(result.toId)} 🏃 ${mention(result.fromId)}\u2069\u200e`
      : rtlLine(`${mention(round.userId)} • ${mention(round.targetId)}`) + '\n'
        + rtlLine(result.fromId === null ? 'تعادل بنسبة 0%؛ لم يتم تحويل أو خصم أي عملة.'
          : 'قيمة النسبة بعد التقريب تساوي صفرًا؛ لم يتم تحويل أي عملة.');
    const mineNote = timedOut ? rtlLine('⏰ انتهت مهلة التحدي قبل إكماله؛ حُسبت عليك خسارة وطُبقت نتيجة الخسارة المعتادة.') + '\n\n'
      : mine ? rtlLine(`💣 ${round.mine.loser === 'bot' ? 'البوت وقع في اللغم' : 'وقعت في اللغم'} رقم **${round.mine.cell}**.`) + '\n\n' : '';
    const lastPick = side => {
      const pick = round.mine.picks.findLast(p => p.actor === side);
      return pick ? rtlLine(`${pick.cell === round.mine.cell ? '💣' : '👁️'} رقم ${pick.cell}`) : timedOut ? 'لم يُسجَّل اختيار.' : 'لم يصل دوره.';
    };
    embed.setTitle(timedOut ? '⏰ انتهى الوقت — خسرت التحدي' : mine ? `💣 ${title}` : title).setDescription(mineNote + transfer).addFields(
      { name: 'اختيارك', value: timedOut && !mine ? 'لم تختر حركة في الوقت المحدد.' : mine ? lastPick('player') : rtlLine(move(round.playerMove)) },
      { name: 'اختيار البوت', value: timedOut && !mine ? 'حُسم التحدي بانتهاء الوقت.' : mine ? lastPick('bot') : rtlLine(move(round.botMove)) },
      { name: 'النسبة', value: codeValue(`${result.percent}%`) },
      { name: 'المبلغ', value: codeValue(bankMoney(result.amount)) },
      { name: 'رصيدك', value: codeValue(bankMoney(result.after.user)) },
      { name: 'حماية الضحية', value: protection
        ? codeValue(protectionTimeLeft(protection, at))
        : 'لا توجد حماية تلقائية لهذه النتيجة.' }
    );
  }
  return { content: '', allowedMentions: { parse: [] }, embeds: [embed], components: mine ? mineBoard(round) : [new ActionRowBuilder().addComponents(
    ...ROBBERY_MOVES.map(move => new ButtonBuilder().setCustomId(`${PREFIX}${round.userId}:${round.id}:${move.id}`)
      .setLabel(move.label).setEmoji(move.emoji).setStyle(ButtonStyle.Secondary).setDisabled(!open))
  )] };
}

export function createRobberyHandler({ config, service, store, isBankMember, robberies, onError = () => {} }) {
  const displays = robberies?.displays || new ActivityGate();
  return async interaction => {
    const component = interaction.customId?.startsWith(PREFIX);
    if (!component && interaction.commandName !== 'نهب') return false;
    const action = component ? parseRobberyAction(interaction.customId) : null;
    const deny = content => interaction.reply({ content, ...(component ? { flags: MessageFlags.Ephemeral } : {}), allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId || interaction.user.bot) { await deny('النهب متاح في سيرفر الكلان فقط.'); return true; }
    if (component && !action) { await deny('زر النهب غير صالح. اكتب !نهب @عضو من جديد.'); return true; }
    if (action && action.userId !== interaction.user.id) { await deny('الاختيار لصاحب أمر النهب فقط؛ التحدي ضد البوت.'); return true; }
    let target;
    if (!action) {
      target = interaction.options.getUser?.('العضو');
      if (!target) { await deny('اكتب !نهب @عضو مع منشن عضو واحد، أو استخدم /نهب العضو.'); return true; }
      if (target.bot || target.id === interaction.user.id) { await deny(target.bot ? 'لا يمكن نهب بوت.' : 'ما تقدر تنهب نفسك.'); return true; }
    }
    if (action) await interaction.deferUpdate();
    else await interaction.deferReply({});
    return displays.runSerial(action?.id || interaction.id, async () => {
      let round;
      try {
        const settings = await store.settings(); const appearance = settings?.appearance;
        requireBankChannel(settings?.bank, interaction.channelId);
        const eligible = id => isBankMember ? isBankMember(id) : bankMember(interaction, config, id);
        if (!action) await service.registerRobberyAttempt({ id: interaction.id, userId: interaction.user.id, channelId: interaction.channelId }, eligible);
        round = action
          ? await service.settleRobbery({ ...action, userId: interaction.user.id, channelId: interaction.channelId, resolutionId: interaction.id }, eligible)
          : await service.openRobbery({ id: interaction.id, userId: interaction.user.id, targetId: target.id, targetBot: !!target.bot,
            channelId: interaction.channelId, at: interaction.createdTimestamp, requireDelivery: true }, eligible);
        // Render the committed player/bot pair in one edit. An intermediate
        // disabled board could remain stuck forever if its final edit failed.
        const message = await interaction.editReply(robberyPayload(round, appearance, interaction, service.clock()));
        const messageId = message?.id || interaction.message?.id;
        if (isId(messageId) && !round.delivery?.messageId) {
          await service.bindRobberyMessage(round.id, messageId, robberyAuthor(interaction));
        }
        if (isId(messageId)) await service.confirmRobberyDisplay(round, messageId);
      } catch (error) {
        if (error.code === 'ROBBERY_PROTECTED' && error.protection) {
          const payload = robberyProtectionPayload(error.protection, service.clock());
          if (action) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
          else await interaction.editReply(payload);
          return true;
        }
        if (error.code !== 'ROBBERY_SPAM_BLOCKED') onError(error);
        const content = '❌ ' + (round?.status === 'settled'
          ? `نتيجة التحدي ${round.id} محفوظة. راجع توب؛ إعادة الضغط تعرض النتيجة نفسها دون تحويل إضافي.`
          : /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر إتمام الطلب. راجع توب وحالة البوت قبل بدء تحدٍّ آخر.');
        if (action) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        else await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
      }
      return true;
    });
  };
}
