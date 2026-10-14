import { readFileSync } from 'node:fs';

const privateVariables = ['DISCORD_BOT_TOKEN', 'ARENA_USER_TOKEN', 'MONGODB_URI', 'READER_TOKEN_KEY'];
const runtimeSecrets = new Set();
export function protectSecret(value) { if (typeof value === 'string' && value) runtimeSecrets.add(value); }

export function runtimeSupported(version) {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return (major === 22 && minor >= 12) || major === 23 || major === 24;
}

function secretValues(env) {
  const values = new Set();
  for (const name of privateVariables) {
    const raw = env[name];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    values.add(raw); values.add(raw.trim());
    let plain = raw.trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
    plain = plain.replace(/^(Bot|Bearer)\s+/i, '').trim();
    if (plain) values.add(plain);
    if (name === 'MONGODB_URI') {
      // Driver errors may contain just a credential, without the full URI.
      const credentials = /^mongodb(?:\+srv)?:\/\/([^/@]+)@/.exec(plain)?.[1];
      if (credentials) for (const part of credentials.split(':')) {
        if (part) values.add(part);
        try { if (part) values.add(decodeURIComponent(part)); } catch { /* Keep encoded form. */ }
      }
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function createRuntimeReporter({ env = process.env, log = console.log, errorLog = console.error } = {}) {
  let stage = 'modules';
  const redact = value => {
    let text = String(value ?? '');
    for (const secret of [...secretValues(env), ...runtimeSecrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[REDACTED_DB_URI]')
      .replace(/(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:Bot|Bearer)\s+)?[^\s,;"'}]+/gi, '$1[REDACTED]')
      .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TOKEN]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ');
  };
  const label = value => redact(value).replace(/[^a-zA-Z0-9_:\[\]. -]/g, '').slice(0, 80) || 'Error';
  return {
    currentStage: () => stage,
    stage(name) { stage = name; log(`[startup:${label(name)}] بدء الخطوة.`); },
    info(message) { log(redact(message)); },
    error(scope, error) {
      const prefix = label(scope);
      const seen = new Set(); let current = error;
      for (let depth = 0; current != null && depth < 3 && !seen.has(current); depth++) {
        seen.add(current);
        const message = redact(typeof current === 'string' ? current : current.message || 'Unknown error').slice(0, 700);
        const code = typeof current.code === 'string' || Number.isInteger(current.code) ? ` code=${label(current.code)}` : '';
        errorLog(`[${prefix}${depth ? ':cause' : ''}] ${label(current.name || 'Error')}${code}: ${message}`);
        // Only call locations, never request/response objects or the raw stack header.
        if (depth === 0 && typeof current.stack === 'string') {
          for (const frame of current.stack.split('\n').filter(line => /^\s*at\s/.test(line)).slice(0, 3)) {
            errorLog(`[${prefix}:trace] ${redact(frame.trim()).slice(0, 220)}`);
          }
        }
        current = current.cause;
      }
      if (error == null) errorLog(`[${prefix}] Error: Unknown error`);
    }
  };
}

export const startup = createRuntimeReporter();

export async function runApplication(load, { reporter = startup, version = process.version, packageVersion } = {}) {
  try {
    packageVersion ??= JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    const release = /^\d+\.\d+\.\d+$/.test(packageVersion) ? packageVersion : 'unknown';
    reporter.info(`[boot] clan-quests-bot@${release} node=${version} entry=src/index.js bootstrap=1`);
    reporter.stage('runtime');
    if (!runtimeSupported(version)) {
      const error = new Error('إصدار Node غير مدعوم. المشروع يحتاج Node >=22.12.0 وأقل من 25.');
      error.code = 'UNSUPPORTED_NODE_VERSION'; throw error;
    }
    reporter.stage('modules');
    await load();
    return 0;
  } catch (error) {
    reporter.error(`startup:${reporter.currentStage()}`, error);
    return 1;
  }
}
