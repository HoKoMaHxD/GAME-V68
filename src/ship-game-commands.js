import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { bankMember } from './bank.js';
import { gameDisplays, playGameAction, STALE_GAME_NOTICE } from './game-display.js';
import { XO_MAX } from './xo.js';
import { XoManager } from './xo-commands.js';
import { shipBoard } from './ship-board.js';
import { opponent, sunkCount, SHIP_ROWS, cellLabel, shipRules } from './ship-game.js';

export function buildShipCommand() {
  return new SlashCommandBuilder().setName('سفينة').setDescription('تحدّي بحري: جهّز سفنك سرًا وأغرق أسطول خصمك')
    .addUserOption(o => o.setName('العضو').setDescription('العضو المتحدّى').setRequired(true))
    .addIntegerOption(o => o.setName('المبلغ').setDescription('المبلغ المحجوز من كل طرف').setMinValue(1).setMaxValue(XO_MAX).setRequired(true));
}
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const base = (g, title, description) => ({ content: '', embeds: [new EmbedBuilder().setTitle(title).setColor(0x169fbd)
  .setDescription(description).setFooter({ text: `سفينة • رقم اللعبة: ${g.id}` })], components: [], files: [], attachments: [], allowedMentions: { parse: [] } });
const addBoard = (payload, g, viewer = null) => {
  // Public and private bytes are always rendered separately. Never reuse a private attachment.
  const filename = `ship-${g.id}-${g.revision}-${viewer ? 'private' : 'public'}.png`;
  payload.embeds[0].setImage(`attachment://${filename}`);
  payload.files = [{ attachment: shipBoard(g, viewer), name: filename }];
};
export function shipPayload(g) {
  const amount = g.amount.toLocaleString('en-US');
  const rules = shipRules(g), total = rules.fleet.length, direct = rules.width === 5;
  const title = `سفينة • ${escapeMarkdown((g.names?.[g.x] || 'لاعب').slice(0, 30))} ضد ${escapeMarkdown((g.names?.[g.o] || 'لاعب').slice(0, 30))}`;
  const make = (move, label, style) => button(`ship:v1:${g.id}:${g.revision}:${move}`, label, style);
  let description;
  if (g.status === 'pending') description = `<@${g.o}>، تحدّاك <@${g.x}>!\nشبكة **${rules.width}×${rules.height}** و**${total} سفن** لكل لاعب. وزّع أسطولك بزر عشوائي ثم اضغط جاهز.\nالإصابة تمنح دورًا إضافيًا، والخطأ ينقل الدور. أغرق أسطول خصمك كاملًا للفوز.\nيُحجز **${amount} $** من كل طرف عند القبول. الفائز يسترجع مبلغه ويربح مبلغ خصمه كاملًا.\nالقبول: **30 ثانية** • التجهيز: **دقيقتان** • كل ضربة: **30 ثانية**. عدم اللعب بعد بدء المعركة خسارة؛ عدم اكتمال التجهيز يعيد المبلغين.\nانتظار إرسال تحدٍّ جديد: **20 دقيقة**؛ استقبال التحديات متاح.\nتنتهي الدعوة <t:${Math.ceil(g.expiresAt / 1000)}:R>.`;
  else if (g.status === 'active' && g.phase === 'setup') description = `🔒 تجهيز الأسطولين\n<@${g.x}>: **${g.ready[g.x] ? '✅ جاهز' : '⏳ يجهّز سفنه'}**\n<@${g.o}>: **${g.ready[g.o] ? '✅ جاهز' : '⏳ يجهّز سفنه'}**\n\nكل لاعب يضغط **تجهيز سفني** لفتح رد مخفي له وحده. اضغط **عشوائي** بأي عدد من المرات ثم **جاهز** لتثبيت الأسطول.\nمبلغ كل طرف محجوز: **${amount} $**.\nتنتهي مهلة التجهيز <t:${Math.ceil(g.expiresAt / 1000)}:R>.`;
  else if (g.status === 'active') description = `🎯 الدور على <@${g.turn}>\n${g.lastShot ? `آخر ضربة: **${cellLabel(g.lastShot.cell, rules.width)}** — ${g.lastShot.sunk !== null ? 'غرقت سفينة! دور إضافي.' : g.lastShot.hit ? 'إصابة! دور إضافي.' : 'خطأ؛ انتقل الدور.'}\n` : ''}${direct ? 'اضغط زر الخانة مباشرة للهجوم؛ مثل **A1**. ترتيب الأزرار يطابق الشبكة.' : `اختر حرف الصف من القائمة، ثم اضغط رقم العمود للهجوم.\n${g.selectedRow == null ? 'لم يُحدّد الصف بعد.' : `الصف المختار: **${SHIP_ROWS[g.selectedRow]}**.`} تغيير الصف لا يمدد المهلة.`}\nلديك **30 ثانية**؛ تنتهي <t:${Math.ceil(g.expiresAt / 1000)}:R>.\n🔵 <@${g.x}> أغرق **${sunkCount(g.fleets[g.o], g.shots[g.x])} من ${total}** • 🔴 <@${g.o}> أغرق **${sunkCount(g.fleets[g.x], g.shots[g.o])} من ${total}**\nالمبلغ: **${amount} $** لكل طرف. ⨯ خطأ • 🎯 إصابة • السفن الغارقة تظهر للجميع.`;
  else if (g.status === 'won') description = `${g.reason === 'timeout' ? '⏰ انتهت مهلة صاحب الدور؛ تُحسب عليه خسارة.\n' : '🚢 اكتمل إغراق أسطول الخصم!\n'}🏆 فاز <@${g.winner}> وربح **${amount} $**، واسترجع مبلغه المحجوز.`;
  else description = g.status === 'rejected' ? 'رُفض التحدّي؛ لم يُحجز أي مبلغ.'
    : `${g.reason === 'setup-timeout' ? 'انتهت مهلة التجهيز قبل جاهزية الطرفين.' : 'أُلغي التحدّي.'} أُعيدت أي مبالغ محجوزة للطرفين.`;
  const p = base(g, title, description);
  if (g.status === 'pending') {
    p.content = `<@${g.o}>`; p.allowedMentions = { parse: [], users: [g.o] };
    p.components = [new ActionRowBuilder().addComponents(make('accept', 'قبول', ButtonStyle.Success), make('reject', 'رفض', ButtonStyle.Danger))];
  } else if (g.status === 'active' && g.phase === 'setup') {
    p.content = `<@${g.x}> <@${g.o}>`; p.allowedMentions = { parse: [], users: [g.x, g.o] };
    p.components = [new ActionRowBuilder().addComponents(make('own', 'تجهيز سفني', ButtonStyle.Primary))];
  } else if (g.status === 'active') {
    p.content = `<@${g.turn}>`; p.allowedMentions = { parse: [], users: [g.turn] };
    addBoard(p, g);
    if (direct) {
      const shots = g.shots[g.turn], fleet = g.fleets[opponent(g, g.turn)];
      for (let row = 0; row < rules.height; row++) p.components.push(new ActionRowBuilder().addComponents(
        ...Array.from({ length: rules.width }, (_, col) => {
          const cell = row * rules.width + col, fired = shots.includes(cell);
          // An untried button must never reveal the ship hidden beneath it.
          const hit = fired && fleet.some(ship => ship.cells.includes(cell));
          const label = `${fired ? (hit ? '● ' : '× ') : ''}${cellLabel(cell, rules.width)}`;
          return make(`fire:${cell}`, label, fired ? (hit ? ButtonStyle.Danger : ButtonStyle.Secondary) : ButtonStyle.Primary).setDisabled(fired);
        })));
    } else {
      // Retain the original controls for 10x10 rounds created before this update.
      const rows = [...SHIP_ROWS].filter((_, r) => Array.from({ length: 10 }, (_, c) => r * 10 + c).some(cell => !g.shots[g.turn].includes(cell)));
      p.components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ship:v1:${g.id}:${g.revision}:row`)
        .setPlaceholder(g.selectedRow == null ? '① اختر حرف الصف A–J' : `الصف ${SHIP_ROWS[g.selectedRow]} — يمكنك تغييره`)
        .addOptions(rows.map(letter => ({ label: `الصف ${letter}`, value: letter, default: SHIP_ROWS[g.selectedRow] === letter })))));
      for (let part = 0; part < 2; part++) p.components.push(new ActionRowBuilder().addComponents(...Array.from({ length: 5 }, (_, i) => {
        const col = part * 5 + i, cell = (g.selectedRow ?? 0) * 10 + col, fired = g.selectedRow != null && g.shots[g.turn].includes(cell);
        return make(`fire:${cell}`, g.selectedRow == null ? String(col + 1) : cellLabel(cell, rules.width), ButtonStyle.Primary).setDisabled(g.selectedRow == null || fired);
      })));
    }
    p.components.push(new ActionRowBuilder().addComponents(make('own', '🚢 سفني')));
  } else if (g.acceptedAt != null) {
    addBoard(p, g); p.components = [new ActionRowBuilder().addComponents(make('own', '🚢 سفني'))];
  }
  return p;
}
export function privateShipPayload(g, userId) {
  if (![g.x, g.o].includes(userId)) throw new Error('هذه اللوحة لصاحب الأسطول فقط.');
  if (!g.fleets[userId]) return base(g, 'سفني', 'لم يبدأ تجهيز الأسطول في هذا التحدّي.');
  const setup = g.status === 'active' && g.phase === 'setup', ready = !!g.ready[userId];
  const rules = shipRules(g);
  const p = base(g, '🚢 أسطولك الخاص', setup
    ? `${ready ? '✅ ثبتّ أسطولك. انتظر جاهزية خصمك.' : 'اضغط عشوائي لتوليد توزيع جديد؛ تقدر تعيده بدون حد حتى تضغط جاهز.'}\n${rules.fleet.length} سفن: **${rules.fleet.map(([h, w]) => `${h}×${w}`).join('، ')}**.\nتنتهي مهلة التجهيز <t:${Math.ceil(g.expiresAt / 1000)}:R>.`
    : `${g.status === 'active' ? 'بدأت المعركة؛ الهجوم من الرسالة الأساسية.' : 'انتهت الجولة.'}\nهذا أسطولك وضربات خصمك؛ اضغط تحديث لرؤية آخر الضربات.`);
  const make = (move, label, style) => button(`ship-private:v1:${g.id}:${userId}:${g.layoutRevision[userId]}:${move}`, label, style);
  p.components = [new ActionRowBuilder().addComponents(...(setup && !ready ? [make('random', '🔀 عشوائي', ButtonStyle.Primary), make('ready', '✅ جاهز', ButtonStyle.Success)] : []), make('own', 'تحديث سفني'))];
  addBoard(p, g, userId);
  return p;
}

export function createShipHandler({ config, service, isBankMember, shipManager, bot, onError = () => {} }) {
  let displays = shipManager?.displays;
  return async i => {
    const publicAction = (i.isButton?.() || i.isStringSelectMenu?.())
      ? /^ship:v1:(\d{17,20}):(\d+):(accept|reject|own|row|fire:(?:[0-9]|[1-9][0-9]))$/.exec(i.customId || '') : null;
    const privateAction = i.isButton?.() ? /^ship-private:v1:(\d{17,20}):(\d{17,20}):(\d+):(random|ready|own)$/.exec(i.customId || '') : null;
    if (!publicAction && !privateAction && i.commandName !== 'سفينة' && i.customId !== 'ship:help') return false;
    if (i.guildId !== config.clanGuildId || i.user.bot) {
      await i.reply({ content: 'اللعبة لأعضاء سيرفر الكلان فقط.', flags: MessageFlags.Ephemeral }); return true;
    }
    if (i.customId === 'ship:help') {
      await i.reply({ content: 'اكتب: سفينة @عضو 1000. بعد القبول افتح تجهيز سفني، وغيّر التوزيع بزر عشوائي ثم اضغط جاهز. عندك 4 سفن بأحجام 3 و2 و1 و1 على شبكة من 5 أعمدة و4 صفوف. اضغط زر الخانة مباشرة من الرسالة الأساسية للهجوم. الإصابة تعطي دورًا إضافيًا. زر سفني يعرض أسطولك لك وحدك.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); return true;
    }
    if (privateAction && (privateAction[2] !== i.user.id || !i.message?.flags?.has(MessageFlags.Ephemeral))) {
      await i.reply({ content: 'افتح لوحة سفنك الخاصة من زر سفني في رسالة اللعبة.', flags: MessageFlags.Ephemeral }); return true;
    }
    const own = publicAction?.[3] === 'own', action = publicAction || privateAction;
    if (own) await i.deferReply({ flags: MessageFlags.Ephemeral });
    else if (action) await i.deferUpdate(); else await i.deferReply({});
    displays ||= gameDisplays(service.shipGame);
    await displays.runSerial(action?.[1] || i.id, async () => {
      try {
        const eligible = id => isBankMember ? isBankMember(id) : bankMember(i, config, id);
        let g, stale = false;
        if (action) {
          let move = privateAction ? privateAction[4] : publicAction[3];
          if (move === 'row') { if (i.values?.length !== 1 || !/^[A-J]$/.test(i.values[0])) throw new Error('اختر صفًا صحيحًا.'); move = `row:${i.values[0]}`; }
          ({ round: g, stale } = await playGameAction(service.shipGame, {
            id: action[1], revision: publicAction ? Number(publicAction[2]) : undefined,
            layoutRevision: privateAction ? Number(privateAction[3]) : undefined,
            move, userId: i.user.id, channelId: i.channelId, messageId: privateAction ? undefined : i.message?.id
          }, eligible));
        } else {
          const target = i.options.getUser('العضو');
          const member = target?.id ? await i.guild?.members?.fetch?.(target.id) : null;
          g = await service.shipGame.open({ id: i.id, x: i.user.id, o: target?.id, bot: !!target?.bot,
            channelId: i.channelId, amount: i.options.getInteger('المبلغ'), requireDelivery: true,
            names: { [i.user.id]: i.member?.displayName || i.user.username || 'اللاعب الأزرق', [target?.id]: member?.displayName || target?.globalName || target?.username || 'اللاعب الأحمر' }
          }, eligible);
        }
        if (own || privateAction) {
          await i.editReply(privateShipPayload(g, i.user.id));
          // Update the public message through a separate destination. Never edit the
          // original public response with a private payload, even after a timeout.
          if (g.dirty && g.messageId) {
            const channel = i.channel?.messages ? i.channel : await (bot || shipManager?.bot)?.channels.fetch(g.channelId);
            if (channel?.guildId === config.clanGuildId) {
              const msg = await channel.messages.fetch(g.messageId);
              if (msg.author?.id === (bot || shipManager?.bot || i.client)?.user?.id) {
                await msg.edit(shipPayload(g)); await service.shipGame.displayed(g);
              }
            }
          }
        } else {
          const msg = await i.editReply(shipPayload(g));
          if (msg?.id && !g.messageId) await service.shipGame.bind(g.id, msg.id);
          await service.shipGame.displayed(g);
          // The accepting player has an interaction token; the challenger opens
          // their own private response via the public setup button (also works for text commands).
          if (publicAction?.[3] === 'accept' && g.status === 'active' && g.phase === 'setup') {
            await i.followUp({ ...privateShipPayload(g, i.user.id), flags: MessageFlags.Ephemeral });
          }
        }
        if (stale) await i.followUp({ content: STALE_GAME_NOTICE, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch (error) {
        onError(error);
        const p = { content: /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر إكمال الطلب؛ حاول مجددًا.', allowedMentions: { parse: [] } };
        if (action && !own) await i.followUp({ ...p, flags: MessageFlags.Ephemeral });
        else await i.editReply({ ...p, embeds: [], components: [], attachments: [] });
      }
    });
    return true;
  };
}
export class ShipManager extends XoManager {
  constructor(ctx) { super({ ...ctx, game: ctx.service.shipGame, payload: shipPayload }); }
}
