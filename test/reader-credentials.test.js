import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderCredentials } from '../src/reader-credentials.js';
import { createRuntimeReporter, protectSecret } from '../src/startup.js';
import { fixture, config, at, actor, user, snowflake } from './helpers/shop-fixture.js';

const auth = { ...config, userToken: 'environment-token', botToken: 'bot-encryption-secret' };
const metadata = { actorId: actor, operationId: snowflake(at), accountId: user };
test('token survives reopening but is absent from plaintext stored records', async () => {
  const f = await fixture(), credentials = new ReaderCredentials({ store: f.store, config: auth });
  await credentials.save('saved-reader-secret', metadata, at);
  assert.ok(!JSON.stringify(f.documents.reader_credentials).includes('saved-reader-secret'));
  const reopened = new ReaderCredentials({ store: f.open().store, config: auth });
  assert.equal(await reopened.load(auth.userToken), 'saved-reader-secret');
});
test('explicit Render environment replacement overrides the stored token', async () => {
  const f = await fixture(), credentials = new ReaderCredentials({ store: f.store, config: auth });
  await credentials.save('saved-reader-secret', metadata, at);
  const newer = new ReaderCredentials({ store: f.store, config: { ...auth, userToken: 'render-new-token' } });
  assert.equal(await newer.load('render-new-token'), 'render-new-token');
});
test('ciphertext tampering and wrong key fail closed', async () => {
  const f = await fixture(), credentials = new ReaderCredentials({ store: f.store, config: auth });
  await credentials.save('saved-reader-secret', metadata, at);
  const wrong = new ReaderCredentials({ store: f.store, config: auth, encryptionKey: 'wrong-key' });
  await assert.rejects(wrong.load(auth.userToken));
  f.documents.reader_credentials[0].secret.tag = Buffer.alloc(16).toString('base64');
  await assert.rejects(credentials.load(auth.userToken));
});
test('lost save acknowledgement is verified and a failed pre-write is not reported as saved', async () => {
  for (const phase of ['before', 'after']) {
    const f = await fixture(), credentials = new ReaderCredentials({ store: f.store, config: auth });
    f.intercept(e => { if (e.name === 'reader_credentials' && e.method === 'replaceOne' && e.phase === phase) throw new Error('write timeout'); });
    if (phase === 'before') await assert.rejects(credentials.save('new-token', metadata, at));
    else { await credentials.save('new-token', metadata, at); assert.equal(await credentials.load(auth.userToken), 'new-token'); }
  }
});
test('dynamic token values are redacted from logs including nested errors', () => {
  const lines = [], secret = 'new-opaque-reader-secret'; protectSecret(secret);
  const reporter = createRuntimeReporter({ env: {}, errorLog: line => lines.push(line) });
  reporter.error('reader', new Error(`failed ${secret}`, { cause: new Error(secret) }));
  assert.ok(!lines.join('\n').includes(secret)); assert.match(lines.join('\n'), /REDACTED/);
});
