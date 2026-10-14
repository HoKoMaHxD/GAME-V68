export function membershipFailureText(failure) {
  const code = failure?.code;
  if (code === 'MEMBERSHIP_ROLE_MISSING') return 'رتبة الكلان المحددة غير موجودة في أرينا؛ راجع CLAN_MEMBER_ROLE_ID وARENA_GUILD_ID.';
  if (code === 'CLAN_GUILD_MISSING') return 'البوت الرسمي لا يرى سيرفر الكلان المحدد؛ راجع CLAN_GUILD_ID.';
  if (code === 'ARENA_GUILD_MISSING') return 'القارئ لا يرى سيرفر أرينا المحدد؛ راجع ARENA_GUILD_ID وحساب القارئ.';
  if ([50001, 50013].includes(Number(code))) return 'رُفض الوصول إلى بيانات الأعضاء؛ راجع وصول الحساب وصلاحيات قراءة الأعضاء.';
  if (code === 401) return 'رُفض توثيق طلب الأعضاء؛ راجع سجل اتصال الحساب في الاستضافة.';
  if (code === 403) return 'رُفض الوصول إلى بيانات الأعضاء؛ راجع وصول الحساب وصلاحيات قراءة الأعضاء.';
  if (code === 429) return 'بلغت الطلبات الحد المسموح؛ ستتم إعادة المحاولة بعد الانتظار.';
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'انقطع اتصال تحميل الأعضاء؛ ستتم إعادة المحاولة تلقائيًا.';
  if (['ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) return 'تعذر الاتصال بخدمة الأعضاء؛ ستتم إعادة المحاولة تلقائيًا.';
  if (Number.isInteger(code) && code >= 500 && code < 600) return 'خدمة الأعضاء غير متاحة مؤقتًا؛ ستتم إعادة المحاولة تلقائيًا.';
  if (['GuildMembersTimeout', 'GUILD_MEMBERS_TIMEOUT', 'MEMBERSHIP_REQUEST_TIMEOUT'].includes(code)) return 'انتهت مهلة تحميل الأعضاء؛ ستتم إعادة المحاولة تلقائيًا.';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'TimeoutError', 'AbortError'].includes(code)) return 'انتهت مهلة اتصال تحميل الأعضاء؛ ستتم إعادة المحاولة تلقائيًا.';
  if (code === 'MEMBER_RESPONSE_INCOMPLETE') return 'وصلت بيانات أعضاء غير مكتملة؛ لم تُعتمد الأهلية منها.';
  return 'تعذر إكمال التحقق من الأعضاء؛ راجع سجل membership في الاستضافة.';
}

export function membershipUnavailable(status = {}) {
  if (status.membership?.ready !== false) return null;
  return 'التحقق من أعضاء الكلان غير جاهز حاليًا؛ تعذر التأكد من العضوية والرتبة. ستتم إعادة المحاولة تلقائيًا. يمكن للإدارة مراجعة /حالة_البوت لمعرفة السبب.';
}

export function membershipStatusText(state = {}) {
  const progress = `تم فحص ${state.checked || 0} من ${state.total || 0} عضو`;
  if (state.ready) return `✅ اكتمل التحقق • ${progress} • المؤهلون ${state.eligible || 0}`
    + (state.total > 0 && !state.eligible ? '\nلم يطابق أي عضو شروط الرتبة؛ راجع رتبة الكلان المحددة في أرينا.' : '');
  const stages = { configuration: 'التحقق من السيرفر والرتبة', clan: 'تحميل أعضاء سيرفر الكلان', arena: 'التحقق من رتب الأعضاء في أرينا' };
  const loading = state.loading && state.stage !== 'failed';
  const stageKey = state.stage === 'failed' ? state.failure?.stage : state.stage;
  const stage = stages[stageKey];
  const count = stageKey === 'clan' ? `تم تحميل ${state.clanLoaded || 0} عضو من الكلان`
    : (stageKey === 'arena' || state.total > 0 ? progress : null);
  const current = [loading ? `⏳ ${stage || 'جارٍ تحميل الأعضاء'}` : `🔴 التحقق غير مكتمل${stage ? `: ${stage}` : ''}`, count].filter(Boolean).join(' • ');
  return [current, state.failure && `${loading ? 'آخر تعذر: ' : ''}${membershipFailureText(state.failure)}`,
    state.retryAt > Date.now() && `المحاولة التالية <t:${Math.ceil(state.retryAt / 1000)}:R>`].filter(Boolean).join('\n');
}

export function trackingBlocker({ stopping, paused, current, blocked, leaseHeld, taskSetReady, bot, observer, membershipReady, arenaAvailable }) {
  if (stopping) return 'جارٍ إيقاف البوت.';
  if (paused) return 'الاحتساب موقوف من تحكم البنك؛ يمكن للإدارة تشغيله من /البنك.';
  if (!current) return 'جارٍ تنفيذ عملية إدارة للبيانات.';
  if (blocked) return 'توقف الاحتساب بعد تعذر تأكيد حفظ عملية؛ يجري استكمال العمليات المحفوظة تلقائيًا قبل استئناف الاحتساب.';
  if (!leaseHeld) return 'قفل تشغيل هذه النسخة غير متاح.';
  if (!taskSetReady) return 'لم تكتمل تهيئة المهام بعد.';
  if (!bot || !observer) return 'بانتظار استعادة اتصال البوت والقارئ.';
  if (!arenaAvailable) return 'سيرفر أرينا غير متاح للقارئ حاليًا.';
  if (!membershipReady) return 'لم يكتمل التحقق من أعضاء الكلان ورتبهم في أرينا.';
  return null;
}
