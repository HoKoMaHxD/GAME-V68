import test from 'node:test';
import assert from 'node:assert/strict';
import { GameTracker, newGameRoom } from '../src/games.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const networkError = () => Object.assign(new Error('write ECONNABORTED'), { code: 'ECONNABORTED' });
function fixture() {
  let state = newGameRoom('room'), changes = 0;
  state.current = { id: '1', participants: [] };
  const credits = [];
  const store = {
    getGameRoom: async () => structuredClone(state),
    ensureGameRoom: async initial => { state ||= initial; },
    pendingGameEvents: async () => [],
    finishGameEvent: async () => {},
    changeGameRoom: async (_, change) => {
      changes++;
      const draft = structuredClone(state);
      if (change(draft)) { draft.revision++; state = draft; }
      return structuredClone(state);
    }
  };
  const tracker = new GameTracker({ config: { clanGuildId: 'clan', gamesChannelId: 'games', gamesBotId: 'bot' }, store,
    service: { game: async entry => credits.push(structuredClone(entry)) }, memberIds: () => new Set() });
  return { tracker, store, credits, state: () => state, changes: () => changes };
}

test('a disconnect during game startup cannot re-enable input when the old write returns', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const change = f.store.changeGameRoom;
  f.store.changeGameRoom = async (...args) => { entered.resolve(); await release.promise; return change(...args); };
  const starting = f.tracker.start();
  await entered.promise;
  const gap = f.tracker.gap();
  release.resolve();
  assert.equal(await starting, false);
  await gap;
  assert.equal(f.tracker.ready, false);
  assert.equal(await f.tracker.start(), true);
  assert.equal(f.tracker.ready, true);
  assert.equal(f.state().needsBoundary, true);
});

test('duplicate resume and gap events share database work', async () => {
  const f = fixture();
  const a = f.tracker.start(), b = f.tracker.start();
  assert.equal(a, b);
  await a;
  const before = f.changes();
  const c = f.tracker.gap(), d = f.tracker.gap();
  assert.equal(c, d);
  await c;
  assert.equal(f.changes(), before + 1);
  assert.equal(f.tracker.ready, false);
});

test('a failed gap write recovers through startup and preserves the unfinished-game boundary', async () => {
  const f = fixture();
  await f.tracker.start();
  f.state().needsBoundary = false;
  const change = f.store.changeGameRoom;
  f.store.changeGameRoom = async () => { throw networkError(); };
  await assert.rejects(f.tracker.gap(), { code: 'ECONNABORTED' });
  assert.equal(f.tracker.ready, false);
  f.store.changeGameRoom = change;
  await f.tracker.start();
  assert.equal(f.tracker.ready, true);
  assert.equal(f.state().needsBoundary, true);
});

test('a lost gap acknowledgement can be retried without repeatedly changing the saved boundary', async () => {
  const f = fixture();
  await f.tracker.start();
  f.state().needsBoundary = false;
  const change = f.store.changeGameRoom;
  f.store.changeGameRoom = async (...args) => { await change(...args); throw networkError(); };
  await assert.rejects(f.tracker.gap(), { code: 'ECONNABORTED' });
  const revision = f.state().revision;
  f.store.changeGameRoom = change;
  await f.tracker.start();
  assert.equal(f.state().revision, revision);
  assert.equal(f.tracker.waiting, true);
});

test('failed recovery retains the credit outbox and retries the same receipt', async () => {
  const f = fixture();
  f.state().outbox = [{ gameId: '1', userId: 'alice' }];
  const change = f.store.changeGameRoom;
  f.store.changeGameRoom = async () => { throw networkError(); };
  await assert.rejects(f.tracker.start(), { code: 'ECONNABORTED' });
  assert.equal(f.tracker.ready, false);
  assert.equal(f.state().outbox.length, 1);
  f.store.changeGameRoom = change;
  await f.tracker.start();
  assert.equal(f.state().outbox.length, 0);
  assert.deepEqual(f.credits, [{ gameId: '1', userId: 'alice' }, { gameId: '1', userId: 'alice' }]);
  assert.equal(f.tracker.ready, true);
});

test('resuming an already ready tracker does not fence an active game again', async () => {
  const f = fixture();
  await f.tracker.start();
  f.state().needsBoundary = false;
  const before = f.changes();
  await f.tracker.start();
  assert.equal(f.changes(), before);
  assert.equal(f.state().needsBoundary, false);
});
