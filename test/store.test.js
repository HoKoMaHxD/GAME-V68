import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoStore } from '../src/store.js';
import { createDay, applyMessage } from '../src/domain.js';

// Test OUR optimistic-revision algorithm against a deterministic atomic collection double.
// This is not a substitute for database.integration.js against a real MongoDB server.
function fixture() {
  let document = createDay('clan', 'user', '2026-09-06', [{
    id: 'task', title: 'task', type: 'messages', channelId: '100000000000000001',
    enabled: true, target: 1, repeat: 1, reward: 100
  }], Date.now());
  const store = Object.create(MongoStore.prototype);
  store.db = { collection: () => ({
    findOne: async () => structuredClone(document),
    replaceOne: async (filter, next) => {
      if (document.revision !== filter.revision) return { matchedCount: 0 };
      document = structuredClone(next); return { matchedCount: 1 };
    }
  }) };
  return { store, id: document._id, document: () => document };
}
test('revision retry loop does not lose concurrent independent updates', async () => {
  const { store, id, document } = fixture();
  await Promise.all(Array.from({ length: 15 }, () => store.mutateDay(id, d => { d.points.attendance++; return true; })));
  assert.equal(document().points.attendance, 15);
  assert.equal(document().revision, 15);
});
test('concurrent duplicate task completions credit once through the store API', async () => {
  const { store, id, document } = fixture();
  const event = { id: '200000000000000001', at: Date.now(), channelId: '100000000000000001', content: 'رسالة اختبار' };
  await Promise.all(Array.from({ length: 20 }, () => store.mutateDay(id, d => applyMessage(d, event, { cooldownMs: 10000, minMessageLength: 3 }))));
  assert.equal(document().points.tasks, 100);
  assert.equal(document().completionLog.length, 1);
});
test('mutation exceptions cannot partially change persisted progress or points', async () => {
  const { store, id, document } = fixture();
  await assert.rejects(store.mutateDay(id, d => { d.points.tasks = 100; throw new Error('failure'); }));
  assert.equal(document().points.tasks, 0);
  assert.equal(document().revision, 0);
});
test('ignored events do not cause unnecessary database replacement', async () => {
  const { store, id, document } = fixture();
  await store.mutateDay(id, () => false);
  assert.equal(document().revision, 0);
});
