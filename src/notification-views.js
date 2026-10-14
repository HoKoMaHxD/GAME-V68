import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { readAppearance } from './appearance.js';
import { number, safe } from './presentation.js';
import { MEMBER_JOB } from './bank.js';

export const notificationFooter = id => `تنبيه #${id}`;
const time = at => `<t:${Math.ceil(at / 1000)}:R> • <t:${Math.ceil(at / 1000)}:f>`;
const money = value => `**${number(value)} $**`;
export function memberNotification(event, settings, guildId) {
  const { kind, data: d, userId } = event;
  let title, text, channelId = settings?.bank?.channelId, messageId;
  const task = d.title ? `**${safe(d.title)}**\n` : '';
  switch (kind) {
    case 'salary_paid': title = '💵 تم صرف راتبك'; text = `الوظيفة: **${safe(d.job || MEMBER_JOB)}**\nأُضيف ${money(d.amount)} إلى رصيدك.\nالرصيد بعد الصرف: ${money(d.after)}.\nتقدر تستلم الراتب التالي ${time(d.nextAt)}.`; break;
    case 'salary_ready': title = '💵 راتبك جاهز'; text = 'انتهت مهلة الراتب. اكتب **راتب** في شات البنك لاستلامه.'; break;
    case 'prize_ready': title = '🎁 جائزتك جاهزة'; text = 'انتهت مهلة الجائزة. اكتب **جائزة** في شات البنك للسحب من جديد.'; break;
    case 'prize_claimed': title = '🎁 حصلت على جائزة'; text = d.type === 'money' ? `أُضيف ${money(d.amount)} إلى رصيدك.`
      : ['salary', 'quest_wait'].includes(d.type) ? `حصلت على زيادة **${d.percent}%** لراتبك القادم، تُستخدم مرة واحدة.`
        : `حصلت على جائزة محفوظة في رصيدك.`; break;
    case 'daily_completed': title = '✅ اكتملت مهمة يومية'; text = `${task}أُضيفت المكافأة ${money(d.reward)} إلى رصيدك.\nباقي مهامك متاحة تلقائيًا. اكتب **مهامي** لمتابعتها.`; break;
    case 'daily_all_completed': title = '🏆 أنجزت جميع مهام اليوم'; text = `أكملت المهام الـ **${d.total}** وصُرفت مكافآتها.\nتتجدد المهام الساعة 12 ليلًا بتوقيت السعودية ${time(d.resetsAt)}.`; break;
    case 'daily_warning': title = '⏳ اقترب تجديد مهامك'; text = `بقي أقل من 10 دقائق على نهاية اليوم السعودي. لديك مهام غير مكتملة.\nراجع **مهامي**؛ التقدم غير المكتمل لا ينتقل لليوم التالي.`; break;
    case 'daily_reset': title = '🌙 تجددت مهامك اليومية'; text = `بدأ يوم جديد الساعة **12 منتصف الليل بتوقيت السعودية**.\nإنجاز أمس: **${d.completed} / ${d.total}** • مكافآت المهام: ${money(d.earned)}.\n`
      + (d.remaining ? `انتهى وقت **${d.remaining}** مهام غير مكتملة دون مكافأتها.\n` : '')
      + 'مهام اليوم الجديد متاحة تلقائيًا بدون قبول أو رفض. اكتب **مهامي** لعرضها. أرصدتك المكتسبة محفوظة.'; break;
    case 'robbery_result': {
      title = userId === d.targetId ? '⚔️ نتيجة محاولة نهبك' : '⚔️ نتيجة محاولة النهب';
      const r = d.result, other = userId === d.targetId ? d.initiatorId : d.targetId;
      const outcome = { win: 'فوز المبادر بالنهب', loss: 'خسارة المبادر بالنهب', tie: 'تعادل' }[r.outcome];
      const change = !r.amount ? 'لم ينتقل أي مبلغ.' : r.fromId === userId ? `خُصم منك ${money(r.amount)} وحُوّل إلى <@${other}>.` : `أُضيف لك ${money(r.amount)} من رصيد <@${other}>.`;
      text = `الطرف الآخر: <@${other}>\nالنتيجة: **${outcome}** • النسبة: **${r.percent}%**\n${change}\nرصيدك بعد النتيجة: ${money(r.after[userId === d.initiatorId ? 'user' : 'target'])}.`;
      if (d.endReason === 'timeout') text = `⏰ خسر المبادر تحدي ${d.game === 'mine' ? 'اللغم' : 'حجر ورقة مقص'} بسبب انتهاء الوقت دون إكمال اللعب.\n` + text;
      else if (d.game === 'mine') text = `💣 لعبة اللغم: ${d.mineLoser === 'bot' ? 'البوت' : 'المبادر بالنهب'} اختار اللغم رقم **${d.mineCell}**.\n` + text;
      text += d.protection?.userId === userId ? `\n🛡️ مُنحت حماية تلقائية من النهب حتى ${time(d.protection.expiresAt)}.`
        : '\nهذه النتيجة لم تمنحك حماية تلقائية جديدة؛ أي حماية سابقة تبقى حتى موعدها.';
      break;
    }
    case 'protection_bought': title = d.extended ? '🛡️ تم تمديد حمايتك' : '🛡️ تم شراء الحماية';
      text = `أُضيفت **${(d.addedDurationMs || 10800000) / 60000} دقيقة** مقابل ${money(d.price)}.\nتنتهي حمايتك ${time(d.expiresAt)}.\nرصيدك بعد الشراء: ${money(d.after)}.`; break;
    case 'protection_expired': title = '🛡️ انتهت حمايتك من النهب'; text = 'لم تعد لديك حماية سارية. تقدر تشتري حماية جديدة بكتابة **حماية** لعرض السعر والمدة وشروط التجديد الحالية.'; break;
    case 'shop_bought': title = '🛍️ تأكد طلبك من المتجر'; text = `المنتج: **${safe(d.product.name)}**\nخُصم ${money(d.product.price)} وحُجزت قطعة لك.\nرقم الطلب: \`${d.orderId}\`\nتواصل مع الإدارة لتسليم المنتج.`; break;
    case 'spam_penalty': title = d.amount ? '⚠️ تم الخصم بسبب السبام' : '⚠️ تنبيه بسبب السبام';
      text = (d.amount ? `تم خصم **${d.amount} نقطة** من رصيدك.` : 'رصيدك صفر؛ لم يُخصم أي مبلغ إضافي.')
        + `\nالسبب: ${safe(d.reason)}\nرصيدك بعد الخصم: **${d.totalAfter.toLocaleString('en-US')}**.`; break;
    case 'balance_changed': title = d.mode === 'add' ? '💵 أُضيفت عملة إلى رصيدك' : '💵 عُدّل رصيدك';
      text = `${d.mode === 'add' ? 'أضافت' : 'خصمت'} الإدارة ${money(d.amount)} ${d.mode === 'add' ? 'إلى رصيدك' : 'من رصيدك'}.\nالسبب: ${d.reason ? safe(d.reason) : 'لم يُذكر سبب إضافي.'}`; break;
    case 'progress_reset': title = '🔄 تم تنفيذ ريست'; text = `نفّذت الإدارة تصفير **${{ all: 'رصيدك وتقدمك ونشاطك', bank: 'رصيد البنك', activity: 'نشاط الشات والفويس' }[d.target]}**.\nإعداد التنبيهات الخاص بك لم يتغير.`; break;
    case 'auction_started': title = '🔨 بدأ مزادك'; text = `بدأ مزاد **${safe(d.name)}**. ينتهي ${time(d.endsAt)}.`; break;
    case 'auction_outbid': title = '🔨 تمت المزايدة فوق سومك'; text = `في مزاد **${safe(d.name)}** وصل السوم إلى ${money(d.amount)}.\nأُعيد المبلغ المحجوز ${money(d.refundedAmount)} إلى رصيدك.\nافتح المزاد لمراجعة السوم وحالته الحالية.`; break;
    case 'auction_ended': title = d.winnerId === userId ? '🏆 فزت بالمزاد' : '🔨 انتهى مزادك';
      text = `المنتج: **${safe(d.name)}** • العدد: **${d.quantity}**\n` + (d.winnerId ? `الفائز: <@${d.winnerId}>\nالمبلغ النهائي: ${money(d.amount)}.` : 'انتهى المزاد بدون مزايدات.');
      if (d.winnerId === userId) text += '\nثُبّت خصم المبلغ المحجوز. تواصل مع الإدارة لاستلام المنتج.';
      break;
    case 'auction_cancelled': title = '🔨 أُلغي المزاد'; text = `أُلغي مزاد **${safe(d.name)}**.\nالسبب: ${d.reason ? safe(d.reason) : 'إلغاء من الإدارة.'}`;
      if (userId === d.refundedUserId && d.refundedAmount) text += `\nأُعيد المبلغ المحجوز ${money(d.refundedAmount)} إلى رصيدك.`;
      break;
    default: throw new Error('نوع التنبيه غير معروف.');
  }
  if (kind.startsWith('auction_')) { channelId = d.channelId; messageId = d.messageId; }
  const embed = new EmbedBuilder().setColor(0xffffff).setAuthor({ name: readAppearance(settings?.appearance).name })
    .setTitle(title).setDescription(text.slice(0, 3800) + '\n\nلإيقاف التنبيهات أو تفعيلها، اضغط **تنبيه** بجانب **ترتيبي الشخصي** في السيرفر.')
    .setFooter({ text: notificationFooter(event.id) }).setTimestamp(event.dueAt);
  return { content: '', embeds: [embed], allowedMentions: { parse: [] }, nonce: event.id, enforceNonce: true,
    components: channelId ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link)
      .setLabel(kind.startsWith('auction_') ? 'افتح المزاد' : 'افتح شات البنك')
      .setURL(`https://discord.com/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ''}`))] : [] };
}
