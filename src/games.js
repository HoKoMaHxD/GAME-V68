import { GameFacts, GAME_MAX_AGE_MS } from './game-facts.js';

const compare = (a, b) => a.at - b.at || (BigInt(a.id) < BigInt(b.id) ? -1 : a.id === b.id ? 0 : 1);

export function newGameRoom(id) {
  return { _id: id, revision: 0, current: null, closed: [], boundary: null,
    lastEventId: null, outbox: [], needsBoundary: false, lastProofAt: null, lastLobbyId: null };
}

function registerGame(state, event, key) {
  if (state.lastLobbyId && BigInt(event.id) <= BigInt(state.lastLobbyId)) return;
  state.lastLobbyId = event.id;
  if (state.boundary && compare(key, state.boundary) <= 0) return;
  // A delayed lobby packet (or an upgrade from 1.7.0) can identify the already
  // tracked game. Keep its ID and participation set; never clear a gap fence
  // using a registration card older than that game's first terminal message.
  if (state.current && BigInt(event.id) <= BigInt(state.current.id)) {
    if (!state.needsBoundary) state.current.lobbyId = event.id;
    return;
  }
  if (state.current) {
    state.current.end = key;
    state.closed.push(state.current);
  }
  state.current = { id: event.id, lobbyId: event.id, after: key, participants: [] };
  state.boundary = key;
  state.needsBoundary = false;
  state.closed = state.closed.filter(r => r.end.at >= event.receivedAt - GAME_MAX_AGE_MS);
}

// One active game per channel. A new registration message starts a game;
// edits to its participant count do not. Winner images still close games.
export function recordGameEvent(state, event) {
  if (state.lastEventId === event._id) return false;
  if (state.outbox.length) throw new Error('هناك مشاركة ألعاب محفوظة تنتظر استكمال الحفظ.');
  state.lastEventId = event._id;
  const key = { at: event.at, id: event.id };
  if (event.kind === 'lobby') { registerGame(state, event, key); return true; }
  state.lastProofAt = Math.max(state.lastProofAt || 0, event.at);
  // After a gap an unseen winner might have ended the saved game. Wait for a
  // real winner or NEW registration message instead of awarding guesses.
  if (state.needsBoundary) {
    if (event.kind === 'win') {
      state.current = null; state.closed = []; state.boundary = key; state.needsBoundary = false;
    }
    return true;
  }
  const closedCard = state.closed.find(r => r.lobbyId === event.id);
  const currentCard = state.current?.lobbyId === event.id;
  const beforeLatestLobby = state.lastLobbyId && BigInt(event.id) < BigInt(state.lastLobbyId);
  const older = !currentCard && (!!closedCard || beforeLatestLobby || (state.boundary && compare(key, state.boundary) <= 0));
  let round = currentCard ? state.current : closedCard || (older
    ? state.closed.find(r => compare(key, r.end) <= 0 && (!r.after || compare(key, r.after) > 0)) : state.current);
  if (beforeLatestLobby && !round) {
    // An old game card may first acquire its winner image after a NEW card was
    // posted. Its creation ID cannot belong to or close the newer game.
    round = [...state.closed].reverse().find(r => r.lobbyId && BigInt(event.id) >= BigInt(r.lobbyId));
  }
  if (older && !round) return true;
  if (!round) {
    round = { id: event.id, after: state.boundary, participants: [] };
    state.current = round;
  }
  for (const userId of event.userIds) {
    if (round.participants.includes(userId)) continue;
    round.participants.push(userId);
    if (event.eligibleUserIds.includes(userId)) state.outbox.push({
      gameId: round.id, id: event.id, kind: event.kind, at: event.at,
      guildId: event.guildId, channelId: event.channelId, botId: event.botId, userId, eligible: true
    });
  }
  if (event.kind === 'win' && !older) {
    round.end = key;
    state.closed.push(round); state.current = null; state.boundary = key;
  }
  // Retain every recently closed interval for out-of-order terminal messages.
  // Persistent event receipts, not this short interval list, reject old replays.
  state.closed = state.closed.filter(r => r.end.at >= event.receivedAt - GAME_MAX_AGE_MS);
  return true;
}

export class GameTracker {
  constructor({ config, store, service, memberIds, fetchMessage, clock = Date.now }) {
    this.config = config; this.store = store; this.service = service; this.memberIds = memberIds; this.clock = clock;
    this.facts = new GameFacts(config, fetchMessage); this.queue = Promise.resolve(); this.ready = false;
    this.roomId = 'games:' + config.clanGuildId + ':' + config.gamesBotId + ':' + config.gamesChannelId;
    this.waiting = false; this.lastProofAt = null; this.unsaved = []; this.inputSequence = 0;
    this.epoch = 0; this.starting = null; this.gapping = null;
  }
  serial(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async flush(state) {
    // Credit and receipt commit together in a member day. Keep the durable
    // outbox until ALL writes are acknowledged; retries are idempotent.
    for (const entry of state.outbox) await this.service.game(entry);
    if (state.outbox.length) state = await this.store.changeGameRoom(this.roomId, draft => {
      draft.outbox = []; return true;
    }, this.clock());
    this.waiting = state.needsBoundary; this.lastProofAt = state.lastProofAt;
    return state;
  }
  async pump() {
    // A transient failed insert must not silently discard a winner boundary.
    // Lost acknowledgements retry the same unique message receipt safely.
    while (this.unsaved.length) {
      await this.store.saveGameEvent(this.roomId, this.unsaved[0], this.clock());
      this.unsaved.shift();
    }
    let state = await this.store.getGameRoom(this.roomId);
    if (!state) return;
    state = await this.flush(state);
    // Repair a lost final acknowledgement BEFORE sorting other queued events.
    // Otherwise an older delivery can move lastEventId past an unacked winner.
    if (state.lastEventId) await this.store.finishGameEvent(state.lastEventId, this.clock());
    while (true) {
      const events = await this.store.pendingGameEvents(this.roomId);
      if (!events.length) break;
      for (const event of events) {
        state = await this.store.changeGameRoom(this.roomId, draft => recordGameEvent(draft, event), this.clock());
        state = await this.flush(state);
        await this.store.finishGameEvent(event._id, this.clock());
      }
    }
  }
  start() {
    if (this.starting) return this.starting;
    if (this.ready) return Promise.resolve(true);
    const epoch = this.epoch;
    this.starting = this.serial(async () => {
      if (epoch !== this.epoch) return false;
      const exists = await this.store.getGameRoom(this.roomId);
      if (!exists) await this.store.ensureGameRoom(newGameRoom(this.roomId), this.clock());
      await this.pump();
      // Recover credits already observed before the shutdown first, then fence
      // an unfinished round. A clean restart after a winner needs no fence.
      const state = await this.store.changeGameRoom(this.roomId, draft => {
        if (!draft.current || draft.needsBoundary) return false;
        draft.needsBoundary = true; return true;
      }, this.clock());
      if (epoch !== this.epoch) return false;
      this.waiting = state.needsBoundary; this.lastProofAt = state.lastProofAt; this.ready = true;
      return true;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  gap() {
    this.epoch++;
    this.ready = false; this.facts.clear();
    if (this.gapping) return this.gapping;
    this.gapping = this.serial(async () => {
      const state = await this.store.changeGameRoom(this.roomId, draft => {
        if (!draft.current || draft.needsBoundary) return false;
        draft.needsBoundary = true; return true;
      }, this.clock());
      this.waiting = state.needsBoundary;
    }).finally(() => { this.gapping = null; });
    return this.gapping;
  }
  receive(packet) {
    if (!this.ready || !this.facts.accepts(packet)) return Promise.resolve();
    const receivedAt = this.clock();
    const receivedOrder = ++this.inputSequence;
    const snapshot = structuredClone(packet);
    const eligibleAtReceipt = new Set();
    // Eligibility is sampled before any database or message-fetch queue wait.
    // Resolve IDs from the eventual trusted snapshot against this same set.
    for (const id of this.memberIds()) eligibleAtReceipt.add(id);
    return this.serial(async () => {
      let event;
      try { event = await this.facts.read(snapshot, receivedAt); }
      catch (error) {
        // If an inaccessible/uncached edit could have hidden the end of this
        // game, do not silently merge the following game into its participant set.
        const state = await this.store.changeGameRoom(this.roomId, draft => {
          if (!draft.current) return false;
          draft.needsBoundary = true; return true;
        }, this.clock());
        this.waiting = state.needsBoundary;
        throw error;
      }
      if (!event) return;
      event.receivedOrder = receivedOrder;
      event.eligibleUserIds = event.userIds.filter(id => eligibleAtReceipt.has(id));
      this.unsaved.push(event);
      await this.pump();
    });
  }
  retry() { return this.serial(() => this.pump()); }
  drain() { return this.queue; }
}
