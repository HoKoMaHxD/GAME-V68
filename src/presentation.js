import { escapeMarkdown } from 'discord.js';
import { themedEmbed } from './appearance.js';
import { DAILY_TASK_COUNT } from './domain.js';
import { nextReset } from './time.js';
import { taskChannels } from './voice-channels.js';
import { netPoints } from './point-adjustments.js';
import { messageTaskTitle } from './message-channels.js';
import { specialTaskPage } from './special-tasks.js';
import { ACTIVITY_CATEGORIES } from './activity.js';

export const PERIODS = [
  { name: 'يومي', value: 'daily' }, { name: 'أسبوعي', value: 'weekly' },
  { name: 'شهري', value: 'monthly' }, { name: 'كلي', value: 'all' }
];
export const CATEGORIES = ACTIVITY_CATEGORIES;
export const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const safe = value => escapeMarkdown(String(value)).replace(/@/g, '@\u200b');
export const number = value => Number(value || 0).toLocaleString('en-US');
const roomLinks = ids => ids.map(id => `<#${id}>`).join('، ');
const clamp = ratio => Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));

export function progressMeter(value, total) {
  const ratio = total > 0 ? clamp(value / total) : 0;
  const percent = Math.floor(ratio * 100);
  const filled = Math.floor(ratio * 12);
  return { ratio, percent, text: `\`${'█'.repeat(filled)}${'░'.repeat(12 - filled)}\` **${percent}%**` };
}

export function taskSummary(tasks) {
  const ratios = tasks.map(t => clamp(t.progress / (t.target * t.repeat * (t.type === 'voice' ? 60000 : 1))));
  return {
    completed: tasks.filter(t => t.completed >= t.repeat).length,
    total: tasks.length,
    // Give each task equal weight. Message counts and voice milliseconds are not interchangeable.
    ratio: ratios.length ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length : 0
  };
}

export function duration(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${number(hours)} س ${minutes % 60} د` : `${minutes} د`;
}

export function specialTasksEmbed(tasks, requestedPage = 1, appearance = {}) {
  const { page, pages, offset, tasks: visible } = specialTaskPage(tasks, requestedPage);
  const embed = themedEmbed('مهمات خاصة', appearance, `صفحة ${page} / ${pages} • مكافآت تعتمدها الإدارة`)
    .setDescription('**مشاركتك تصنع الفرق في الكلان.**\nتمنحك الإدارة عملة هذه المهمات يدويًا بعد التحقق من إنجازها.\n'
      + 'عرض القائمة لا يمنح عملة، والمهمات الخاصة مستقلة عن المهام اليومية وتجديدها.');
  for (const [index, task] of visible.entries()) embed.addFields({
    name: `⭐ ${String(offset + index + 1).padStart(2, '0')}  ${safe(task.title)}`,
    value: `المكافأة **${number(task.reward)} $ 💵**`, inline: false
  });
  if (!visible.length) embed.addFields({ name: 'قائمة المهمات', value: 'لا توجد مهمات خاصة مضافة حاليًا.' });
  return embed;
}

export function tasksEmbed(state, at, connected, config = {}, appearance = {}, rule = config.attendance) {
  const balance = netPoints(state);
  const summary = taskSummary(state.tasks);
  const overall = progressMeter(summary.ratio, 1);
  const embed = themedEmbed('مهامك اليومية', appearance, 'تجديد يومي 12 ليلًا • تحديث تلقائي كل 15 ثانية')
    .setDescription(`<@${state.userId}> • **${state.day}**\n\n`
      + `**${summary.completed} / ${summary.total} مهام مكتملة**\n${overall.text}\n\n`
      + `${connected ? '🟢 الاحتساب يعمل' : '🔴 الاحتساب متوقف حاليًا'} • التجديد <t:${Math.floor(nextReset(at) / 1000)}:R>\n`
      + 'كل المهام متاحة معًا بدون قبول أو رفض. تتجدد الساعة **12 ليلًا بتوقيت السعودية**.');
  for (const [index, task] of state.tasks.entries()) {
    const unit = task.type === 'voice' ? 'دقيقة' : task.type === 'games' ? 'قيم' : 'رسالة';
    const divisor = task.type === 'voice' ? 60000 : 1;
    const total = task.target * task.repeat;
    const progress = Math.max(0, Math.min(total, task.progress / divisor));
    const meter = progressMeter(progress, total);
    const done = task.completed >= task.repeat;
    const channels = taskChannels(task, config);
    const categories = task.type === 'voice' ? task.categoryIds || [] : [];
    const remaining = Math.max(0, Math.ceil(total - progress));
    embed.addFields({
      name: `${done ? '✅' : progress > 0 ? '🔹' : '▫️'} ${String(index + 1).padStart(2, '0')}  ${safe(messageTaskTitle(task, config))}`,
      value: `${meter.text} • **${number(Math.floor(progress))} / ${number(total)}** ${unit}\n`
        + (task.retiredAfterChatSplit ? `صُرفت مكافأة الكتابة اليوم • **${number(task.reward * task.completed)} $ 💵**` : done ? `اكتملت • **${number(task.reward * task.completed)} $ 💵 مكتسبة**`
          : `المتبقي **${number(remaining)} ${unit}** • المكافأة **${number(task.reward)} $ 💵**`)
        + (task.repeat > 1 ? `\nالإنجازات: **${task.completed} / ${task.repeat}** • المكافأة لكل إنجاز` : '')
        + (categories.length ? `\nالرومات الصوتية داخل الكاتقوريات: ${roomLinks(categories)}\nالوقت يتجمع بين روماتها؛ المكافأة مرة واحدة يوميًا.` : `\n${roomLinks(channels)}`)
        + (task.type === 'voice' && channels.length > 1 ? '\nالوقت في هذه الرومات يتجمع لنفس المهمة.' : '')
        + (task.retiredAfterChatSplit ? '\nتبدأ مهمتا 50 رسالة في العام و50 في شات الكلان بعد التجديد اليومي.' : '')
        + (task.type === 'games' ? '\nكل الألعاب مشتركة؛ تُثبت مشاركتك بالطرد أو التفجير أو القتل أو الإعدام أو «تم العثور على» أو الانسحاب أثناء اللعب أو إعلان الفوز، مرة واحدة لكل قيم.' : '')
        + (task.requiredRoleId ? `\nمنشن <@&${task.requiredRoleId}> في الرسالة نفسها` : '')
        + (task.requiresMedia ? (task.requiredRoleId ? ' + صورة أو فيديو' : '\nصورة أو فيديو في الرسالة نفسها') : ''),
      inline: false
    });
  }
  if (state.tasks.length < DAILY_TASK_COUNT) embed.addFields({ name: 'المهام المتاحة', value: `المتاح اليوم ${state.tasks.length} مهام. يمكن للإدارة إضافة قوالب أخرى.` });
  embed.addFields(
    { name: '💵 صافي اليوم', value: `**${number(balance.total)}** $ 💵`, inline: true },
    { name: '🎯 عملة المهام', value: `**${number(state.points.tasks)}** $ 💵`, inline: true }
  );
  addAdjustmentNotice(embed, state);
  if (rule?.enabled) embed.addFields({ name: '🎙️ مكافأة الحضور اليوم', value: `**${number(state.points.attendance)} / ${number(rule.dailyCap)} $** • ${rule.points} $ لكل ${rule.intervalMs / 60000} دقائق مؤهلة` });
  return embed;
}

export function pointsEmbed(totals, state, rule, appearance = {}, at = Date.now()) {
  const all = totals.all || { tasks: 0, attendance: 0, total: 0 };
  const embed = themedEmbed('رصيدك من العملة', appearance, '💵 عملة للمتجر • مستقلة عن ترتيب النشاط')
    .setDescription(`<@${state.userId}>\n\n**${number(all.total)} $ 💵 إجمالية**\nرصيدك محفوظ عبر الأيام والأسابيع والشهور.`)
    .addFields(
      { name: '🎯 من المهام', value: `**${number(all.tasks)}** $ 💵`, inline: true },
      { name: 'مكافآت الحضور', value: `**${number(all.attendance)}** $ 💵`, inline: true },
      { name: '🏅 ترتيبك', value: 'بالرسائل والساعات فقط\nاستخدم زر ترتيبي الشخصي', inline: true }
    );
  for (const p of PERIODS.filter(p => p.value !== 'all')) {
    const t = p.value === 'daily' ? netPoints(state) : totals[p.value] || {};
    embed.addFields({ name: p.name, value: `**${number(t.total)}** $ 💵\nمهام ${number(t.tasks)} • فويس ${number(t.attendance)}`, inline: true });
  }
  addAdjustmentNotice(embed, state);
  return embed;
}

function addAdjustmentNotice(embed, state) {
  if (state.salaryCredits) embed.addFields({ name: '💵 رواتب اليوم', value: `**${number(state.salaryCredits)} $** أضيفت إلى محفظتك. الراتب مستقل عن ترتيب النشاط وتقدم المهام.` });
  if (state.prizeCredits) embed.addFields({ name: '🎁 جوائز اليوم', value: `**${number(state.prizeCredits)} $** أضيفت إلى محفظتك من الجوائز النقدية.` });
  if (state.robberyReceipts?.length) {
    const change = (state.robberyAdjustments?.tasks || 0) + (state.robberyAdjustments?.attendance || 0);
    embed.addFields({ name: '🎲 صافي النهب اليوم', value:
      `**${change >= 0 ? '+' : ''}${number(change)} $ 💵**\nمشمولة في رصيدك؛ لا تغيّر ترتيب النشاط أو تقدم المهام.` });
  }
  const spent = -(state.shopAdjustments?.tasks || 0) - (state.shopAdjustments?.attendance || 0);
  if (spent > 0) embed.addFields({ name: '🛍️ مشتريات المتجر اليوم', value:
    `خُصمت **${number(spent)} $ 💵** مقابل مشترياتك. رصيد العملة يعرض الصافي بعد الخصم؛ الترتيب مستقل عنه.\nالشراء لا يغيّر ترتيب الشات والفويس أو إنجاز المهام؛ قد يصبح صافي اليوم سالبًا عند استخدام رصيد سابق.` });
  if (!state.adjustmentLog?.length) return;
  const signed = value => `${value >= 0 ? '+' : ''}${number(value)}`;
  const balance = netPoints(state);
  embed.addFields({ name: 'تعديلات الإدارة اليوم', value:
    `مهام **${signed(state.pointAdjustments?.tasks || 0)}** • فويس **${signed(state.pointAdjustments?.attendance || 0)}**\nمشمولة في رصيد العملة فقط؛ تقدم المهام ووقت الحضور مستقلان عنها.`
    + (balance.tasks < 0 || balance.attendance < 0 ? '\nالرصيد السالب للفترة ناتج عن خصم عملة مكتسبة في أيام سابقة.' : '') });
}

export function rulesEmbed(config, rule, appearance = {}) {
  const embed = themedEmbed('آلية الاحتساب', appearance, 'نشاطك للترتيب • مكافآتك عملة 💵')
    .setDescription('**توب الشات:** عدد الرسائل في شات الكلان فقط.\n**توب الفويس:** وقت التواجد الفعلي في رومات الكلان المفعلة.\n**العملة 💵:** مكافآت مستقلة تستخدمها في المتجر؛ لا تدخل في ترتيب النشاط.')
    .addFields(
      { name: '01  العضوية', value: `أعضاء سيرفر الكلان الحاصلون على رتبة <@&${config.memberRole}> في أرينا. يُحسب النشاط المرصود أثناء الاتصال فقط.` },
      { name: '02  توب الشات', value: `<#${config.clanChatChannelId}> فقط. كل رسالة جديدة تُحسب مرة واحدة، حتى بعد اكتمال مهمة الكتابة. الرسائل القصيرة والإيموجي والمرفقات تُحسب. التعديل والتكرار في تسليم الحدث ورسائل البوتات والويبهوك والنظام لا تزيد العداد. الرسائل في العام وبقية الرومات لا تدخل توب الشات.` },
      { name: '03  مهامي', value: `جميع المهام تتقدم تلقائيًا معًا. اكتب مهامي لعرض تقدم كل مهمة والمطلوب المتبقي. تتحدث البطاقة كل 15 ثانية وأيضًا من زر تحديث المهام.\n<#${config.generalChannelId}> و<#${config.clanChatChannelId}>: لكل شات مهمة مستقلة من 50 رسالة.` },
      { name: '04  تجديد المهام ومكافأتها', value: 'تتجدد يوميًا الساعة 12 منتصف الليل بتوقيت السعودية؛ لا يوجد قبول أو رفض أو انتظار بين المهام. تُصرف المكافأة مرة واحدة لكل إنجاز كامل، ولا يُرحّل التقدم الناقص لليوم التالي. أرصدتك المكتسبة محفوظة. اللوكت والفيلنق يحتاجان منشن رتبة الكلان في المنشور نفسه. مهمة الألعاب تحتسب المشاركة المثبتة مرة واحدة لكل قيم.' }

    );
  if (rule) embed.addFields({ name: 'شروط الصوت', value: `أقل عدد بشر في الروم: **${rule.minPeople}**\nالميوت: **${rule.ignoreMuted ? 'لا يُحتسب' : 'يُحتسب'}** • الديفن: **${rule.ignoreDeafened ? 'لا يُحتسب' : 'يُحتسب'}**\nتنطبق الشروط على المهام الصوتية والتوب. AFK وحالات Stage المقموعة لا تُحسب. الانتقال بين الرومات لا يضاعف الوقت.` });
  if (rule?.enabled) embed.addFields({ name: 'الحضور المتكرر', value: `${number(rule.points)} $ لكل ${rule.intervalMs / 60000} دقائق مؤهلة؛ الحد اليومي ${number(rule.dailyCap)} $. مستقل عن مكافأة مهمة الصوت.` });
  return embed.addFields(
    { name: '05  عرض الترتيب', value: `توب الشات والفويس منفصلان، 5 أعضاء لكل ترتيب مع السابق والتالي. اليومي والأسبوعي والشهري والشامل يستخدمون توقيت السعودية؛ بداية الأسبوع **${WEEKDAYS[config.weekStart ?? 0]}**. التساوي يفصل بمعرف العضو لترتيب ثابت.` },
    { name: '💵 الرصيد والمتجر', value: 'الأرصدة السابقة محفوظة بنفس قيمتها كعملة، وكذلك المشتريات والمنتجات. المهمة والمكافأة والتعديل اليدوي والشراء تؤثر في العملة وحدها. صرف العملة لا يخفض الرسائل أو ساعات التوب أو يعيد إنجاز مهمة مكتملة.' },
    { name: 'الأوامر', value: 'اكتب اوامر في شات البنك لعرض توب البنك، راتب، نهب، مهامي، وقت، رصيدي وشرحها.' },
    { name: 'أثناء توقف الاحتساب', value: 'لا تُحسب رسائل أو دقائق لم تصل إلى القارئ، ولا تتحول نقاط الماضي إلى نشاط تقديري. يبدأ التوب الجديد من وقت تفعيل التحديث. تستخدم الأزرار آخر حالة محفوظة.' }
  );
}

export function leaderboardEmbed(rows, period, category, page, config, appearance = {}) {
  const voice = category === 'voice';
  const label = voice ? 'توب الفويس' : 'توب الشات';
  return themedEmbed(label, appearance, `صفحة ${page} • 5 أعضاء • توقيت السعودية`)
    .setDescription(`**${PERIODS.find(p => p.value === period)?.name || period}**\n\n` +
      (rows.slice(0, 5).map((row, i) => `**#${(page - 1) * 5 + i + 1}** <@${row._id}> — ${voice ? duration(row.voice) : number(row.chat) + ' رسالة'}`).join('\n')
      || 'لا يوجد نشاط مسجل في هذه الصفحة.'));
}
