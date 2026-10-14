import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readAuthConfig, loginReady, probeIdentity, runAuthDiagnostics } from '../src/auth.js';
import { readConfig } from '../src/config.js';

// Deliberately fake credentials. Tests never access process.env or the network.
const authEnv = {
  OBSERVER_MODE: 'selfbot', ACKNOWLEDGE_SELFBOT_RISK: 'true',
  DISCORD_BOT_TOKEN: 'fake-bot-credential', ARENA_USER_TOKEN: 'fake-observer-credential'
};
const response = (status, body = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});
const identity = bot => ({ id: '100000000000000001', bot, username: 'private-name', email: 'private@example.invalid' });

test('normalization preserves opaque tokens and removes only surrounding copy syntax', () => {
  const unchanged = readAuthConfig(authEnv);
  assert.equal(unchanged.botToken, authEnv.DISCORD_BOT_TOKEN);
  assert.equal(unchanged.userToken, authEnv.ARENA_USER_TOKEN);
  assert.deepEqual(unchanged.authWarnings, []);
  const normalized = readAuthConfig({ ...authEnv,
    DISCORD_BOT_TOKEN: '  "Bot fake-bot-credential"  ',
    ARENA_USER_TOKEN: "'fake-observer-credential'"
  });
  assert.equal(normalized.botToken, unchanged.botToken);
  assert.equal(normalized.userToken, unchanged.userToken);
  assert.equal(normalized.authWarnings.length, 3);
  assert.doesNotMatch(normalized.authWarnings.join(' '), /fake-bot-credential|fake-observer-credential/);
});

test('invalid copy formatting and duplicated credentials fail without exposing their values', () => {
  for (const token of ['fake\nsecret', 'fake\u200bsecret', 'fake secret', '"fake-secret',
    'ARENA_USER_TOKEN=fake-secret', '`fake-secret`', '']) {
    assert.throws(() => readAuthConfig({ ...authEnv, ARENA_USER_TOKEN: token }), error => {
      assert.match(error.message, /ARENA_USER_TOKEN/);
      assert.doesNotMatch(error.message, /fake/);
      return true;
    });
  }
  assert.throws(() => readAuthConfig({ ...authEnv, ARENA_USER_TOKEN: '"fake-bot-credential"' }), /متطابقان/);
});

test('official mode does not require a reader token and selfbot mode retains acknowledgement', () => {
  assert.equal(readAuthConfig({ OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'opaque' }).userToken, null);
  assert.throws(() => readAuthConfig({ ...authEnv, ACKNOWLEDGE_SELFBOT_RISK: 'false' }), /ACKNOWLEDGE_SELFBOT_RISK/);
});

test('runtime configuration and diagnostics use the same normalized credentials', () => {
  const config = readConfig({ ...authEnv, ARENA_USER_TOKEN: '"fake-observer-credential"',
    MONGODB_URI: 'mongodb://example.invalid/test', CLAN_GUILD_ID: '100000000000000001',
    ARENA_GUILD_ID: '100000000000000002', GENERAL_CHANNEL_ID: '100000000000000003', CLAN_CHAT_CHANNEL_ID: '100000000000000005',
    CLAN_VOICE_CHANNEL_ID: '100000000000000004', FEELING_CHANNEL_ID: '100000000000000006',
    LOOK_CHANNEL_ID: '100000000000000007', CLAN_MEMBER_ROLE_ID: '100000000000000008'
  });
  assert.equal(config.userToken, authEnv.ARENA_USER_TOKEN);
  assert.equal(config.authWarnings.length, 1);
});

test('successful login identifies the client and removes temporary listeners', async () => {
  const lines = [];
  const client = new EventEmitter();
  let calls = 0;
  client.login = async token => {
    calls++;
    assert.equal(token, authEnv.DISCORD_BOT_TOKEN);
    client.emit('clientReady');
  };
  await loginReady(client, authEnv.DISCORD_BOT_TOKEN, 'clientReady', 'bot', { log: x => lines.push(x) });
  assert.equal(calls, 1);
  assert.match(lines.join('\n'), /\[auth:bot\].*GATEWAY_READY/);
  assert.doesNotMatch(lines.join('\n'), /fake-bot-credential/);
  assert.equal(client.listenerCount('clientReady'), 0);
  assert.equal(client.listenerCount('shardDisconnect'), 0);
});

test('gateway rejection names observer and records an observed 4004 without leaking SDK details', async () => {
  const client = new EventEmitter();
  client.login = async () => {
    client.emit('shardDisconnect', { code: 4004, reason: authEnv.ARENA_USER_TOKEN });
    throw Object.assign(new Error(authEnv.ARENA_USER_TOKEN), { code: 'TOKEN_INVALID' });
  };
  await assert.rejects(loginReady(client, authEnv.ARENA_USER_TOKEN, 'ready', 'observer', { log: () => {} }), error => {
    assert.equal(error.scope, 'auth:observer');
    assert.equal(error.code, 'AUTHENTICATION_FAILED');
    assert.match(error.message, /ARENA_USER_TOKEN/);
    assert.match(error.message, /Gateway close=4004/);
    assert.doesNotMatch(error.message, /fake-observer-credential/);
    return true;
  });
  assert.equal(client.listenerCount('ready'), 0);
  assert.equal(client.listenerCount('shardDisconnect'), 0);
});

test('disallowed intents, synchronous failures and timeouts remain distinct from token rejection', async () => {
  for (const [login, expected] of [
    [() => { throw new Error('Used disallowed intents'); }, 'DISALLOWED_INTENTS'],
    [() => { throw new Error('private-request-body'); }, 'GATEWAY_LOGIN_FAILED'],
    [() => new Promise(() => {}), 'LOGIN_TIMEOUT']
  ]) {
    const client = new EventEmitter();
    client.login = login;
    await assert.rejects(loginReady(client, 'fake', 'ready', 'bot', { log: () => {}, timeoutMs: 5 }), error => {
      assert.equal(error.code, expected);
      assert.doesNotMatch(error.message, /private-request-body/);
      return true;
    });
    assert.equal(client.listenerCount('ready'), 0);
    assert.equal(client.listenerCount('shardDisconnect'), 0);
  }
});

test('identity probes send credentials only to the fixed Discord endpoint with redirects disabled', async () => {
  for (const role of ['bot', 'observer']) {
    const result = await probeIdentity('fake-credential', role, { fetchImpl: async (url, options) => {
      assert.equal(url, `https://discord.com/api/v${role === 'bot' ? 10 : 9}/users/@me`);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, role === 'bot' ? 'Bot fake-credential' : 'fake-credential');
      assert.ok(options.signal instanceof AbortSignal);
      return response(200, identity(role === 'bot'));
    } });
    assert.deepEqual(result, { code: 'REST_OK', http: 200 });
  }
});

test('HTTP 401, 403, 429 and server failures are classified separately with one request and no body logs', async () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [503, 'SERVER_ERROR']]) {
    let calls = 0;
    const result = await probeIdentity('fake', 'observer', { fetchImpl: async () => {
      calls++; return response(status, { private: 'fake-secret' });
    } });
    assert.equal(calls, 1);
    assert.deepEqual(result, { code, http: status });
  }
});

test('successful HTTP with wrong account type or malformed response does not report success', async () => {
  assert.deepEqual(await probeIdentity('fake', 'observer', { fetchImpl: async () => response(200, identity(true)) }),
    { code: 'ACCOUNT_TYPE_MISMATCH', http: 200 });
  assert.deepEqual(await probeIdentity('fake', 'bot', { fetchImpl: async () => response(200, { token: 'private' }) }),
    { code: 'UNEXPECTED_RESPONSE', http: 200 });
});

test('network and timeout errors never echo thrown request details', async () => {
  for (const [name, code] of [['TypeError', 'NETWORK_ERROR'], ['TimeoutError', 'TIMEOUT']]) {
    assert.deepEqual(await probeIdentity('fake', 'observer', { fetchImpl: async () => {
      throw Object.assign(new Error('Authorization: fake-private-value'), { name });
    } }), { code });
  }
});

test('diagnosis runs without database config and reveals no credentials or identity fields', async () => {
  const lines = [];
  let calls = 0;
  const result = await runAuthDiagnostics(authEnv, { log: line => lines.push(line), fetchImpl: async () => {
    calls++; return response(200, identity(calls === 1));
  } });
  assert.equal(result, 0);
  assert.equal(calls, 2);
  assert.match(lines.join('\n'), /DISCORD_BOT_TOKEN REST_OK HTTP 200/);
  assert.match(lines.join('\n'), /ARENA_USER_TOKEN REST_OK HTTP 200/);
  assert.doesNotMatch(lines.join('\n'), /fake-bot-credential|fake-observer-credential|private-name|private@example|100000000000000001/);
});

test('diagnosis aborts before requests on invalid config and does not continue past a block or rate limit', async () => {
  let calls = 0;
  assert.equal(await runAuthDiagnostics({ ...authEnv, ARENA_USER_TOKEN: '' }, {
    log: () => {}, fetchImpl: async () => { calls++; return response(200); }
  }), 1);
  assert.equal(calls, 0);
  for (const status of [403, 429]) {
    calls = 0;
    assert.equal(await runAuthDiagnostics(authEnv, { log: () => {}, fetchImpl: async () => {
      calls++; return response(status);
    } }), 1);
    assert.equal(calls, 1);
  }
});
