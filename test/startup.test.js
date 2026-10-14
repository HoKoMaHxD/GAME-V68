import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRuntimeReporter, runApplication, runtimeSupported } from '../src/startup.js';

const project = new URL('../', import.meta.url);
const privateEnv = { DISCORD_BOT_TOKEN: ' "Bot fake-bot-private-token" ', ARENA_USER_TOKEN: 'fake-reader-private-token',
  MONGODB_URI: 'mongodb://privateuser:private%40password@private.invalid/database' };
function capture(env = {}) {
  const lines = [];
  const reporter = createRuntimeReporter({ env, log: value => lines.push(value), errorLog: value => lines.push(value) });
  return { lines, reporter, output: () => lines.join('\n') };
}
function runEntry(env) {
  // The child never inherits account credentials or NODE_OPTIONS from this environment.
  const result = spawnSync(process.execPath, ['src/index.js'], { cwd: project,
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return { ...result, output: result.stdout + result.stderr };
}

test('boot banner precedes module loading and unsupported Node fails without loading the application', async () => {
  const c = capture(); let loaded = false;
  assert.equal(await runApplication(async () => { loaded = true; }, { reporter: c.reporter, version: 'v24.19.0', packageVersion: '2.2.2' }), 0);
  assert.equal(loaded, true); assert.match(c.lines[0], /\[boot\] clan-quests-bot@2.2.2 node=v24.19.0/);
  for (const version of ['v18.20.0', 'v22.11.0', 'v25.0.0', 'invalid']) {
    assert.equal(runtimeSupported(version), false);
    const failed = capture();
    assert.equal(await runApplication(() => { throw new Error('must not load'); }, { reporter: failed.reporter, version, packageVersion: '2.2.2' }), 1);
    assert.match(failed.output(), /startup:runtime.*UNSUPPORTED_NODE_VERSION/);
    assert.doesNotMatch(failed.output(), /must not load/);
  }
  for (const version of ['v22.12.0', 'v22.22.0', 'v23.0.0', 'v24.20.0']) assert.equal(runtimeSupported(version), true);
});

test('an early missing module and a synchronous constructor error retain their stage and code', async () => {
  const missing = capture();
  assert.equal(await runApplication(() => import('../src/__missing_startup_test__.js'),
    { reporter: missing.reporter, packageVersion: '2.2.2' }), 1);
  assert.match(missing.output(), /startup:modules.*ERR_MODULE_NOT_FOUND/);
  assert.match(missing.output(), /__missing_startup_test__/);
  const failed = capture();
  assert.equal(await runApplication(() => {
    failed.reporter.stage('database-client');
    throw Object.assign(new Error('Invalid connection string'), { name: 'MongoParseError' });
  }, { reporter: failed.reporter, packageVersion: '2.2.2' }), 1);
  assert.match(failed.output(), /startup:database-client.*MongoParseError: Invalid connection string/);
});

test('error details redact normalized tokens, database credentials, headers and stack locations before truncation', () => {
  const c = capture(privateEnv);
  const error = Object.assign(new Error(`fake-bot-private-token fake-reader-private-token ${privateEnv.MONGODB_URI} privateuser private%40password private@password`),
    { code: 'AUTH_FAILED', request: { secret: 'NEVER_DUMP_REQUEST' }, response: { secret: 'NEVER_DUMP_RESPONSE' } });
  error.stack = 'Error: hidden header\n at login (fake-reader-private-token:1:1)\n at fail (src/app.js:1:2)';
  error.cause = Object.assign(new Error('Authorization: Bot unknown-header-secret'), { code: 18 });
  c.reporter.error('startup:database-connect', error);
  c.reporter.error('headers', new Error('"Authorization": "Bearer other-header-secret"'));
  c.reporter.error('long', new Error('x'.repeat(650) + privateEnv.DISCORD_BOT_TOKEN));
  for (const secret of ['fake-bot-private-token', 'fake-reader-private-token', 'privateuser', 'private%40password', 'private@password',
    'private.invalid', 'unknown-header-secret', 'other-header-secret', 'NEVER_DUMP_REQUEST', 'NEVER_DUMP_RESPONSE']) assert.ok(!c.output().includes(secret));
  assert.match(c.output(), /code=AUTH_FAILED/); assert.match(c.output(), /:cause.*code=18/);
  assert.match(c.output(), /app.js:1:2/); assert.match(c.output(), /REDACTED/);
});

test('logger also redacts unknown database URLs and token-shaped strings and bounds circular causes', () => {
  const c = capture();
  const token = 'A'.repeat(24) + '.BBBBBB.' + 'C'.repeat(30);
  const error = new Error(`mongodb+srv://hidden:password@example.invalid/test ${token}\nnot a new log line`);
  error.cause = error; c.reporter.error('startup', error);
  c.reporter.error('unhandled', null); c.reporter.error('unhandled', 'text failure');
  assert.doesNotMatch(c.output(), /hidden:password|example.invalid|AAAAAA|BBBBBB|CCCCCC/);
  assert.ok(c.lines.every(line => !line.includes('\n')));
  assert.equal(c.lines.filter(line => line.includes(':cause]')).length, 0);
  assert.match(c.output(), /Unknown error/); assert.match(c.output(), /text failure/);
});

test('real node src/index.js reports a missing configuration variable and exits nonzero without connecting', () => {
  const result = runEntry({ OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'fake-private-entry-token' });
  assert.equal(result.status, 1);
  assert.match(result.output, /\[boot\] clan-quests-bot@/);
  assert.match(result.output, /\[startup:config\] Error: المتغير MONGODB_URI مطلوب/);
  assert.doesNotMatch(result.output, /fake-private-entry-token|database-connect|auth:bot/);
});

test('real entry catches MongoClient constructor failures that occur before the main startup try block', () => {
  const result = runEntry({ OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'fake-private-entry-token',
    MONGODB_URI: 'mongodb://', CLAN_GUILD_ID: '100000000000000001', ARENA_GUILD_ID: '100000000000000002',
    CLAN_MEMBER_ROLE_ID: '100000000000000003', GENERAL_CHANNEL_ID: '100000000000000004',
    CLAN_CHAT_CHANNEL_ID: '100000000000000005', CLAN_VOICE_CHANNEL_ID: '100000000000000006',
    FEELING_CHANNEL_ID: '100000000000000007', LOOK_CHANNEL_ID: '100000000000000008' });
  assert.equal(result.status, 1);
  assert.match(result.output, /\[startup:database-client\] MongoParseError/);
  assert.doesNotMatch(result.output, /fake-private-entry-token|\[startup:database-connect\]|auth:bot/);
});
