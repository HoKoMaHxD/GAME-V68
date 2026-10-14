const ACCOUNTS = Object.freeze({
  bot: { variable: 'DISCORD_BOT_TOKEN', label: 'البوت الرسمي', apiVersion: 10 },
  observer: { variable: 'ARENA_USER_TOKEN', label: 'حساب القارئ', apiVersion: 9 }
});

// Tokens are opaque. Do not decode them or enforce historical token lengths.
function readToken(env, variable, warnings) {
  const raw = env[variable];
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`المتغير ${variable} مطلوب.`);
  let token = raw.trim();
  if (/^(["']).*\1$/s.test(token)) {
    token = token.slice(1, -1).trim();
    warnings.push(`${variable}: أزيلت علامتا الاقتباس المحيطتان بالقيمة.`);
  }
  if (/^(Bot|Bearer)\s+/i.test(token)) {
    token = token.replace(/^(Bot|Bearer)\s+/i, '').trim();
    warnings.push(`${variable}: أزيلت بادئة Authorization؛ يكفي وضع التوكن وحده في Environment.`);
  }
  if (!token || /[\s\p{C}]/u.test(token) || /[^\x21-\x7e]|["'`]/.test(token)
    || /^(DISCORD_BOT_TOKEN|ARENA_USER_TOKEN)\s*=/.test(token)) {
    throw new Error(`${variable}: تنسيق القيمة غير صالح؛ ضع التوكن وحده دون اسم المتغير أو أسطر أو محارف خفية داخله.`);
  }
  return token;
}

export function normalizeReaderToken(value) {
  return readToken({ ARENA_USER_TOKEN: value }, 'ARENA_USER_TOKEN', []);
}

export function readAuthConfig(env = process.env) {
  const mode = env.OBSERVER_MODE?.trim() || 'selfbot';
  if (!['selfbot', 'official'].includes(mode)) throw new Error('OBSERVER_MODE: official أو selfbot فقط.');
  if (mode === 'selfbot' && env.ACKNOWLEDGE_SELFBOT_RISK?.trim() !== 'true') {
    throw new Error('الـself-bot مخالف لشروط Discord وقد يغلق الحساب. راجع README ثم ACKNOWLEDGE_SELFBOT_RISK.');
  }
  const authWarnings = [];
  const botToken = readToken(env, ACCOUNTS.bot.variable, authWarnings);
  const userToken = mode === 'selfbot' ? readToken(env, ACCOUNTS.observer.variable, authWarnings) : null;
  if (userToken === botToken) throw new Error('DISCORD_BOT_TOKEN وARENA_USER_TOKEN متطابقان؛ يلزم توكن مستقل لكل حساب.');
  return { mode, botToken, userToken, authWarnings };
}

function gatewayFailure(role, error, closeCode) {
  const { variable, label } = ACCOUNTS[role];
  const sourceCode = error?.code;
  let code = 'GATEWAY_LOGIN_FAILED';
  let detail = `تعذر اتصال ${label}. شغّل npm run diagnose لفحص المصادقة من نفس البيئة.`;
  if (closeCode === 4004 || (['TOKEN_INVALID', 'TokenInvalid'].includes(sourceCode) || error?.message === 'TOKEN_INVALID')) {
    code = 'AUTHENTICATION_FAILED';
    detail = `رُفض تسجيل دخول ${label} باستخدام ${variable}. شغّل npm run diagnose؛ هذا السجل وحده لا يحدد سبب رفض القيمة.`;
  } else if (closeCode === 4014 || ['DISALLOWED_INTENTS', 'DisallowedIntents'].includes(sourceCode)
    || error?.message === 'Used disallowed intents') {
    code = 'DISALLOWED_INTENTS';
    detail = role === 'bot'
      ? 'فعّل Server Members Intent وMessage Content Intent للبوت الرسمي في Developer Portal.'
      : 'رُفضت intents لاتصال القارئ. هذا رفض اتصال، وليس نتيجة فحص صلاحية التوكن.';
  } else if (sourceCode === 'LOGIN_TIMEOUT') {
    code = 'LOGIN_TIMEOUT';
    detail = `انتهت مهلة اتصال ${label}؛ لا تثبت المهلة أن التوكن غير صالح.`;
  }
  // Never forward SDK debug output, arbitrary error messages, tokens or response bodies.
  const suffix = Number.isInteger(closeCode) ? ` Gateway close=${closeCode}.` : '';
  return Object.assign(new Error(`${code}: ${detail}${suffix}`), { code, scope: `auth:${role}` });
}

export function loginReady(client, token, readyEvent, role, { log = console.log, timeoutMs = 90000 } = {}) {
  const { variable, label } = ACCOUNTS[role];
  log(`[auth:${role}] بدء اتصال ${label} باستخدام ${variable}.`);
  return new Promise((resolve, reject) => {
    let closeCode;
    let settled = false;
    const disconnected = event => {
      if (Number.isInteger(event?.code) && event.code >= 1000 && event.code <= 4999) closeCode = event.code;
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off(readyEvent, ready);
      client.off('shardDisconnect', disconnected);
    };
    const ready = () => {
      if (settled) return;
      settled = true; cleanup();
      log(`[auth:${role}] GATEWAY_READY: اتصل ${label} بنجاح.`);
      resolve();
    };
    const failed = error => {
      if (settled) return;
      settled = true; cleanup();
      reject(gatewayFailure(role, error, closeCode));
    };
    const timer = setTimeout(() => failed({ code: 'LOGIN_TIMEOUT' }), timeoutMs);
    client.once(readyEvent, ready);
    client.on('shardDisconnect', disconnected);
    // Handle both a synchronous throw and a rejected login promise.
    Promise.resolve().then(() => client.login(token)).catch(failed);
  });
}

export async function probeIdentity(token, role, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const { apiVersion } = ACCOUNTS[role];
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    // One read-only request to Discord itself. No retries, redirects or gateway login.
    response = await fetchImpl(`https://discord.com/api/v${apiVersion}/users/@me`, {
      method: 'GET', redirect: 'error', signal,
      headers: { Authorization: role === 'bot' ? `Bot ${token}` : token, Accept: 'application/json' }
    });
    const http = response.status;
    if (http === 200) {
      const identity = await response.json();
      if (typeof identity?.id !== 'string' || !/^\d{17,20}$/.test(identity.id)
        || (identity.bot !== undefined && typeof identity.bot !== 'boolean')) {
        return { code: 'UNEXPECTED_RESPONSE', http };
      }
      const isBot = identity.bot === true;
      return { code: isBot === (role === 'bot') ? 'REST_OK' : 'ACCOUNT_TYPE_MISMATCH', http };
    }
    const code = ({ 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 429: 'RATE_LIMITED' })[http]
      || (http >= 500 ? 'SERVER_ERROR' : 'UNEXPECTED_RESPONSE');
    return { code, http };
  } catch (error) {
    if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) return { code: 'TIMEOUT' };
    return { code: response?.status === 200 ? 'UNEXPECTED_RESPONSE' : 'NETWORK_ERROR' };
  } finally {
    if (response?.body && !response.bodyUsed) {
      try { await response.body.cancel(); } catch { /* Nothing from the response is logged. */ }
    }
  }
}

const DIAGNOSTIC_DETAILS = Object.freeze({
  REST_OK: 'قُبل التوكن لهذا الطلب ونوع الحساب مطابق. لا يثبت ذلك نجاح Gateway أو الوصول إلى السيرفر.',
  ACCOUNT_TYPE_MISMATCH: 'رد Discord بنوع حساب لا يطابق المتغير؛ تحقق من توزيع التوكنين.',
  UNAUTHORIZED: 'رفض Discord مصادقة هذا الطلب بالقيمة التي قرأتها العملية؛ لا تحدد النتيجة سبب الرفض.',
  FORBIDDEN: 'منع Discord الطلب. لم نصنف التوكن خطأ، ولن نعيد المحاولة أو نتجاوز المنع.',
  RATE_LIMITED: 'حد طلبات من Discord؛ أوقفنا الفحص دون إعادة محاولة.',
  SERVER_ERROR: 'خطأ خادم؛ لا يمكن الحكم على التوكن من هذه النتيجة.',
  NETWORK_ERROR: 'تعذر إكمال طلب الشبكة؛ لا يمكن الحكم على التوكن من هذه النتيجة.',
  TIMEOUT: 'انتهت مهلة الطلب؛ لا يمكن الحكم على التوكن من هذه النتيجة.',
  UNEXPECTED_RESPONSE: 'رد غير متوقع؛ لم تُطبع بيانات الرد ولا يمكن الجزم بصلاحية التوكن.'
});

export async function runAuthDiagnostics(env = process.env, { log = console.log, fetchImpl = globalThis.fetch } = {}) {
  let config;
  try { config = readAuthConfig(env); }
  catch (error) { log(`[auth:config] ${error.message}`); return 1; }
  log('[diagnose] فحص مصادقة فقط: بلا MongoDB أو رسائل أو اتصال Gateway، وبلا طباعة توكنات أو بيانات حساب.');
  for (const warning of config.authWarnings) log(`[auth:config] ${warning}`);
  let exitCode = 0;
  const accounts = [['bot', config.botToken]];
  if (config.mode === 'selfbot') accounts.push(['observer', config.userToken]);
  for (const [role, token] of accounts) {
    const result = await probeIdentity(token, role, { fetchImpl });
    log(`[auth:${role}] ${ACCOUNTS[role].variable} ${result.code}${result.http ? ` HTTP ${result.http}` : ''}`);
    log(`[auth:${role}] ${DIAGNOSTIC_DETAILS[result.code]}`);
    if (result.code !== 'REST_OK') exitCode = 1;
    // A server/network block or rate limit is not a reason to send another request.
    if (['FORBIDDEN', 'RATE_LIMITED', 'SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(result.code)) break;
  }
  log('[diagnose] انتهى الفحص. REST_OK مع فشل Gateway يعني قبول طلب REST ورفض اتصال Gateway؛ لا يثبت وحده عطل المكتبة.');
  return exitCode;
}
