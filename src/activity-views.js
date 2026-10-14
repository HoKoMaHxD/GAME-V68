import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { readAppearance, themedEmbed } from './appearance.js';
import { PERIODS, number } from './presentation.js';
import { ACTIVITY_CATEGORIES, ACTIVITY_PAGE_SIZE } from './activity.js';
import { NOTIFICATION_BUTTON } from './notification-events.js';

export function voiceTime(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${number(Math.floor(seconds / 3600))}س ${Math.floor(seconds / 60) % 60}د ${seconds % 60}ث`;
}
export const activityValue = (value, metric) => metric === 'voice' ? voiceTime(value) : `${number(value)} رسالة`;

// Discord resolves mixed Arabic, numbers and display names in the client. Start
// each rank line in RTL and isolate its inline parts so names cannot move the
// rank or its value. Keep controls outside mention IDs and inside code spans.
const rtlLine = text => `\u200f${text}\u200f`;
const ltr = text => `\u2066${text}\u2069`;
const rankMention = id => `\u2068<@${id}>\u2069`;
const rankValue = (value, metric) => metric === 'voice'
  ? `\`\u2067${voiceTime(value)}\u2069\`` : `\`${ltr(number(value))}\``;

function rankEmbed(title, appearance, footer = '') {
  const name = readAppearance(appearance).name;
  return themedEmbed(title, appearance).setAuthor(null).setColor(0xffffff)
    .setFooter({ text: footer ? `${name} • ${footer}` : name }).setTimestamp();
}

export function rankPanel(appearance = {}) {
  return { allowedMentions: { parse: [] }, embeds: [rankEmbed('ترتيبك الشخصي', appearance)
    .setDescription('اضغط ترتيبي الشخصي لمعرفة ترتيبك في توب الشات وتوب الفويس.\nزر تنبيه يوقف أو يفعّل تنبيهاتك بالخاص؛ مفعّلة افتراضيًا.\nتوب البنك يعرض جميع المشاركين مع السابق والتالي والتحديث.')],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('clan-rank:open')
    .setLabel('ترتيبي الشخصي').setEmoji('🏅').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(NOTIFICATION_BUTTON).setLabel('تنبيه').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('clan-bank:open').setLabel('توب البنك').setEmoji('💵').setStyle(ButtonStyle.Secondary))] };
}

export function parseRankAction(id) {
  if (id === 'clan-rank:open') return { personal: true, category: 'both', period: 'all', page: 1, update: false };
  const match = /^clan-rank:v2:(\d{17,20}):(personal|board):(both|chat|voice):(all|daily|weekly|monthly):([1-9]\d{0,8}):(previous|next|period|category|refresh)$/.exec(id || '');
  // Older board controls were on public messages: open a private result instead
  // of inserting the member's personal ranks into the shared message.
  return match ? { ownerId: match[1], personal: true, category: 'both', period: match[4], page: Number(match[5]), update: match[2] === 'personal' } : null;
}

export async function activityView({ store, config, ownerId, appearance = {}, personal = false,
  category = 'both', period = 'all', page = 1, at = Date.now() }) {
  if (!ACTIVITY_CATEGORIES.some(c => c.value === category) || !PERIODS.some(p => p.value === period)
    || !Number.isSafeInteger(page) || page < 1 || page > 999999999) throw new Error('طلب الترتيب غير صالح.');
  if (personal) category = 'both';
  const metrics = category === 'both' ? ['voice', 'chat'] : [category];
  const boards = await Promise.all(metrics.map(metric => store.activityRanking(period, metric, at,
    { skip: (page - 1) * ACTIVITY_PAGE_SIZE, limit: ACTIVITY_PAGE_SIZE + 1 })));
  let description = `**${PERIODS.find(p => p.value === period).name}** • الترتيب بالنشاط الفعلي\nالعملة والمكافآت والشراء لا تغير ترتيبك.`;
  if (personal) {
    const [chat, voice] = await Promise.all(['chat', 'voice'].map(metric => store.activityPosition(ownerId, period, metric, at)));
    const position = result => result.position ? ltr(`#${number(result.position)}`) : 'غير مصنف';
    description = [
      rtlLine(`**مركزك في توب الشات: ${position(chat)}** - ${rankValue(chat.value, 'chat')} رسالة`),
      rtlLine(`**مركزك في توب الفويس: ${position(voice)}** - ${rankValue(voice.value, 'voice')} صوت`)
    ].join('\n');
  }
  const embed = rankEmbed(personal ? 'ترتيبك الشخصي' : 'ترتيب نشاط الكلان', appearance,
    `${PERIODS.find(p => p.value === period).name} • صفحة ${number(page)}`).setDescription(description).setTimestamp(at);
  for (const [i, metric] of metrics.entries()) embed.addFields({
    name: metric === 'voice' ? 'توب الفويس' : 'توب الشات',
    value: boards[i].slice(0, ACTIVITY_PAGE_SIZE).map((row, index) =>
      rtlLine(`**${ltr(`#${number((page - 1) * ACTIVITY_PAGE_SIZE + index + 1)}`)}** ${rankMention(row._id)} - ${rankValue(row[metric], metric)}${metric === 'chat' ? ' رسالة' : ''}`)
    ).join('\n') || 'لا يوجد نشاط مسجل في هذه الصفحة.'
  });
  if (!personal && config.activityStartedAt) embed.addFields({ name: 'بداية رصد الترتيب الجديد',
    value: `<t:${Math.floor(config.activityStartedAt / 1000)}:f> • إجمالي النشاط منذ التحديث، دون تحويل مكافآت قديمة إلى رسائل أو ساعات.` });
  const key = (cat, per, pg, action) => `clan-rank:v2:${ownerId}:${personal ? 'personal' : 'board'}:${cat}:${per}:${pg}:${action}`;
  const button = (id, label, active = false) => new ButtonBuilder().setCustomId(id).setLabel(label)
    .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return { content: '', allowedMentions: { parse: [] }, embeds: [embed], components: [
    ...(!personal ? [new ActionRowBuilder().addComponents(...ACTIVITY_CATEGORIES.map(c => button(key(c.value, period, 1, 'category'), c.name, c.value === category)))] : []),
    new ActionRowBuilder().addComponents(...PERIODS.map(p => button(key(category, p.value, 1, 'period'), p.value === 'all' ? 'الشامل' : p.name, p.value === period))),
    new ActionRowBuilder().addComponents(
      button(key(category, period, Math.max(1, page - 1), 'previous'), 'السابق').setDisabled(page === 1),
      button(key(category, period, page, 'refresh'), 'تحديث').setEmoji('🔄'),
      button(key(category, period, Math.min(999999999, page + 1), 'next'), 'التالي')
        .setDisabled(!boards.some(rows => rows.length > ACTIVITY_PAGE_SIZE) || page === 999999999)
    )
  ] };
}
