import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { themedEmbed } from './appearance.js';
import { number, safe } from './presentation.js';
import { auctionTerminal } from './auction.js';

export const auctionKey = (id, action) => `clan-auction:v1:${id}:${action}`;
export const auctionFooter = (id, stage) => `مزاد #${id} • ${stage}`;
const stamp = (at, format = 'F') => `<t:${Math.floor(at / 1000)}:${format}>`;
const riyadh = at => new Date(at + 10800000).toISOString().slice(0, 16).replace('T', ' ');
const money = amount => `${number(amount)} $ 💵`;

export function auctionPayload(a, stage, appearance, { ping = false } = {}) {
  const terminal = auctionTerminal(a);
  const upcoming = stage === 'upcoming' && !terminal;
  const result = stage === 'result';
  const title = upcoming ? '📅 مزاد قادم' : a.status === 'cancelled' ? '🚫 مزاد ملغى' : terminal ? '🏆 المزاد منتهي' : '🔨 بدأ المزاد';
  const embed = themedEmbed(title, appearance).setImage(a.imageUrl)
    .setDescription(`**${safe(a.name)}**\n${safe(a.description)}`)
    .addFields(
      { name: 'العدد', value: `${number(a.quantity)} • كامل الكمية للفائز بصفقة واحدة`, inline: true },
      { name: 'سعر البداية', value: money(a.startPrice), inline: true }
    ).setFooter({ text: auctionFooter(a.id, stage) });
  if (upcoming) {
    embed.setColor(0xf2b84b).addFields(
      { name: 'موعد البداية', value: `${stamp(a.startsAt)} • ${stamp(a.startsAt, 'R')}\n${riyadh(a.startsAt)} بتوقيت السعودية` },
      { name: 'مدة المزاد', value: '5 دقائق من نشر إعلان البداية.' },
      { name: 'نظام المزايدة', value: 'يُحجز مبلغ أعلى سوم فورًا، ويُرد لصاحبه إذا تجاوزه عضو آخر.\nأي مزايدة مقبولة في آخر 15 ثانية تضيف 30 ثانية إلى موعد النهاية.' }
    );
  } else {
    embed.setColor(a.status === 'cancelled' ? 0xc96565 : terminal ? 0x4fb687 : 0x8fd6ff)
      .addFields(
        { name: terminal ? 'السوم النهائي' : 'السوم الحالي', value: money(a.amount), inline: true },
        { name: terminal && a.status === 'ended' ? 'الفائز' : 'أعلى مزايد', value: a.highestBidderId ? `<@${a.highestBidderId}>` : 'لا توجد مزايدات بعد', inline: true },
        { name: 'عدد المزايدات', value: number(a.bidCount), inline: true }
      );
    if (terminal) {
      const note = a.status === 'cancelled'
        ? `أُلغي المزاد. ${a.settlement.refundedAmount ? `أُعيد ${money(a.settlement.refundedAmount)} لصاحب أعلى سوم.` : 'لا توجد مبالغ محجوزة.'}\n${safe(a.settlement.reason || '')}`
        : a.settlement.winnerId ? `🎉 مبروك <@${a.settlement.winnerId}>!\nثُبت سداد ${money(a.settlement.amount)} من الحجز السابق، وحُفظ الفوز بكامل الكمية. يرجى متابعة الإدارة لتسليم المنتج.`
          : 'انتهى المزاد بدون مزايدات؛ لم يُخصم أي مبلغ.';
      embed.addFields({ name: 'النتيجة', value: note }, { name: 'وقت الإغلاق', value: stamp(a.endedAt) });
    } else {
      embed.addFields(
        { name: 'ينتهي', value: `${stamp(a.endsAt, 'R')} • ${stamp(a.endsAt, 'T')}` },
        { name: 'الحجز والتمديد', value: 'الزيادة تُضاف إلى السوم الحالي. زر سعر البداية متاح لأول مزايد.\nيُحجز أعلى سوم ويُرد للسابق فور تجاوزه. آخر 15 ثانية: تمديد +30 ثانية.' }
      );
      if (a.extensions) embed.addFields({ name: 'تمديدات المزاد', value: `${number(a.extensions)} • +${number(a.extensions * 30)} ثانية` });
    }
  }
  const components = upcoming || result ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(auctionKey(a.id, 'opening')).setLabel('سعر البداية').setStyle(ButtonStyle.Success).setDisabled(terminal || !!a.highestBidderId),
    new ButtonBuilder().setCustomId(auctionKey(a.id, '500')).setLabel('+500').setStyle(ButtonStyle.Primary).setDisabled(terminal),
    new ButtonBuilder().setCustomId(auctionKey(a.id, '1000')).setLabel('+1000').setStyle(ButtonStyle.Primary).setDisabled(terminal),
    new ButtonBuilder().setCustomId(auctionKey(a.id, 'custom')).setLabel('مزايدة').setStyle(ButtonStyle.Secondary).setDisabled(terminal)
  )];
  const rolePing = ping && !result && !terminal;
  const winnerPing = ping && result && a.status === 'ended' && a.settlement.winnerId;
  const content = !result && !terminal ? `<@&${a.roleId}> ${upcoming ? 'مزاد قادم' : 'بدأ المزاد الآن'}: **${safe(a.name)}**`
    : winnerPing ? `🎉 الفائز بالمزاد: <@${winnerPing}>` : '';
  return { content, embeds: [embed], components,
    allowedMentions: { parse: [], roles: rolePing ? [a.roleId] : [], users: winnerPing ? [winnerPing] : [] } };
}
