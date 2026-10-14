import assert from 'node:assert/strict';
import { MongoStore } from '../../src/store.js';
import { ShopStore } from '../../src/shop-store.js';
import { RobberyStore } from '../../src/robbery-store.js';
import { AuctionStore } from '../../src/auction-store.js';
import { NotificationStore } from '../../src/notification-store.js';
import { QuestService } from '../../src/service.js';
import { createDay } from '../../src/domain.js';
import { dayKey, dayStart } from '../../src/time.js';

export const at = dayStart('2026-09-11') + 3600000;
export const user = '100000000000000010';
export const other = '100000000000000011';
export const actor = '100000000000000099';
export const productId = '100000000000000050';
export const config = { clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  memberRole: '100000000000000003', weekStart: 0 };
export const destination = { channelId: '100000000000000030', roleId: '100000000000000031' };
export const snowflake = (time = at, sequence = 0) => String((BigInt(time - 1420070400000) << 22n) + BigInt(sequence));
export const request = (overrides = {}) => ({ checkoutId: snowflake(), productId, userId: user, at, ...overrides });
const clone = value => structuredClone(value);
const value = (doc, path) => path.split('.').reduce((object, field) => object?.[field], doc);
const set = (doc, path, item) => {
  const parts = path.split('.'); const last = parts.pop();
  let target = doc;
  for (const part of parts) target = target[part] ||= {};
  target[last] = clone(item);
};
function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(item => matches(doc, item));
    const actual = value(doc, key);
    if (expected && typeof expected === 'object') return Object.entries(expected).every(([op, operand]) => {
      if (op === '$gt') return actual > operand;
      if (op === '$gte') return actual >= operand;
      if (op === '$lt') return actual < operand;
      if (op === '$lte') return actual <= operand;
      if (op === '$exists') return (actual !== undefined) === operand;
      if (op === '$ne') return actual !== operand;
      if (op === '$in') return operand.includes(actual);
      if (op === '$regex') return new RegExp(operand).test(actual);
      throw new Error(`Unsupported query ${op}`);
    });
    return actual === expected;
  });
}
function expression(doc, expr) {
  if (typeof expr === 'string' && expr.startsWith('$')) return value(doc, expr.slice(1));
  if (expr && typeof expr === 'object') {
    if (expr.$ifNull) return expression(doc, expr.$ifNull[0]) ?? expression(doc, expr.$ifNull[1]);
    if (expr.$add) return expr.$add.reduce((sum, term) => sum + expression(doc, term), 0);
    throw new Error('Unsupported expression');
  }
  return expr;
}
const sort = (rows, fields) => rows.sort((a, b) => {
  for (const [key, direction] of Object.entries(fields)) if (value(a, key) !== value(b, key)) return (value(a, key) > value(b, key) ? 1 : -1) * direction;
  return 0;
});
function aggregate(input, pipeline) {
  return pipeline.reduce((rows, stage) => {
    if (stage.$match) return rows.filter(d => matches(d, stage.$match));
    if (stage.$group) {
      const groups = new Map();
      for (const doc of rows) {
        const id = expression(doc, stage.$group._id);
        if (!groups.has(id)) groups.set(id, { _id: id });
        const group = groups.get(id);
        for (const [field, expr] of Object.entries(stage.$group)) if (field !== '_id') {
          assert.ok('$sum' in expr); group[field] = (group[field] || 0) + (expression(doc, expr.$sum) || 0);
        }
      }
      return [...groups.values()];
    }
    if (stage.$addFields) return rows.map(d => ({ ...d, ...Object.fromEntries(Object.entries(stage.$addFields).map(([key, expr]) => [key, expression(d, expr)])) }));
    if (stage.$sort) return sort(rows, stage.$sort);
    if ('$skip' in stage) return rows.slice(stage.$skip);
    if ('$limit' in stage) return rows.slice(0, stage.$limit);
    if ('$count' in stage) return rows.length ? [{ [stage.$count]: rows.length }] : [];
    throw new Error('Unsupported stage');
  }, clone(input));
}

// Deterministic atomic-collection double; faults can occur before a write or
// after it commits (lost acknowledgement). Integration test covers real MongoDB.
export async function fixture({ price = 150, stock = 3 } = {}) {
  const documents = { ship_games: [], ship_journals: [], boxes_games: [], boxes_journals: [], dot_games: [], dot_journals: [], task_boosts: [], numbers_games: [], numbers_journals: [], mines_games: [], mines_journals: [], button_games: [], button_journals: [], xo_games: [], xo_journals: [], shops: [], shop_orders: [], robberies: [], robbery_attempts: [], robbery_rounds: [], protection_purchases: [], days: [], resets: [], templates: [],
    auctions: [], auction_journals: [], auction_events: [], member_notifications: [], notification_preferences: [],
    settings: [{ _id: `settings:${config.clanGuildId}`, appearance: { name: 'SNOW' },
      bank: { channelId: '100000000000000060', salaryAmount: 0, channelVersion: 1 } }],
    leases: [{ _id: `worker:${config.clanGuildId}`, owner: 'worker', expiresAt: at + 86400000 * 40 }] };
  let hook = () => {};
  const db = { collection: name => {
    documents[name] ||= [];
    const operation = (method, mutate) => async (...args) => {
      await hook({ name, method, phase: 'before', args });
      const result = mutate(...args);
      await hook({ name, method, phase: 'after', args });
      return clone(result);
    };
    return {
      createIndex: async () => {},
      findOne: operation('findOne', (filter, options = {}) => sort(documents[name].filter(d => matches(d, filter)), options.sort || {})[0] || null),
      countDocuments: operation('countDocuments', filter => documents[name].filter(d => matches(d, filter)).length),
      find: filter => {
        let ordering = {}, limit = Infinity;
        const cursor = { sort: fields => { ordering = fields; return cursor; }, limit: n => { limit = n; return cursor; },
          toArray: async () => sort(clone(documents[name].filter(d => matches(d, filter))), ordering).slice(0, limit) };
        return cursor;
      },
      aggregate: pipeline => ({ toArray: async () => aggregate(documents[name], pipeline) }),
      insertOne: operation('insertOne', doc => {
        if (documents[name].some(d => d._id === doc._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
        documents[name].push(clone(doc)); return { insertedId: doc._id };
      }),
      replaceOne: operation('replaceOne', (filter, doc, options = {}) => {
        const index = documents[name].findIndex(d => matches(d, filter));
        if (index < 0 && options.upsert) documents[name].push(clone(doc));
        if (index >= 0) documents[name][index] = clone(doc);
        return { matchedCount: index >= 0 ? 1 : 0 };
      }),
      updateOne: operation('updateOne', (filter, change, options = {}) => {
        let doc = documents[name].find(d => matches(d, filter)); const existing = !!doc;
        if (!doc && options.upsert) { doc = { ...clone(filter), _id: filter._id || `${name}:${documents[name].length}` }; documents[name].push(doc); }
        if (doc) {
          for (const key of Object.keys(change.$unset || {})) { const parts = key.split('.'); const last = parts.pop(); let target = doc; for (const part of parts) target = target?.[part]; if (target) delete target[last]; }
          if (!existing) for (const [key, item] of Object.entries(change.$setOnInsert || {})) set(doc, key, item);
          for (const [key, item] of Object.entries(change.$set || {})) set(doc, key, item);
          for (const [key, item] of Object.entries(change.$inc || {})) set(doc, key, (value(doc, key) || 0) + item);
        }
        return { matchedCount: existing ? 1 : 0 };
      }),
      updateMany: operation('updateMany', (filter, change) => {
        const rows = documents[name].filter(d => matches(d, filter));
        for (const doc of rows) for (const [key, item] of Object.entries(change.$set || {})) set(doc, key, item);
        return { matchedCount: rows.length };
      }),
      deleteOne: operation('deleteOne', filter => {
        const index = documents[name].findIndex(d => matches(d, filter));
        if (index >= 0) documents[name].splice(index, 1);
        return { deletedCount: index >= 0 ? 1 : 0 };
      }),
      deleteMany: operation('deleteMany', filter => {
        const before = documents[name].length;
        documents[name] = documents[name].filter(d => !matches(d, filter));
        return { deletedCount: before - documents[name].length };
      })
    };
  } };
  const open = (time = at) => {
    const store = Object.assign(Object.create(MongoStore.prototype), { db, config, owner: 'worker',
      settingsId: `settings:${config.clanGuildId}`, leaseId: `worker:${config.clanGuildId}`,
      taskSetActivatedAt: 0, resetAllAt: 0, memberResetAt: new Map() });
    store.shop = new ShopStore(store);
    store.robbery = new RobberyStore(store);
    store.auctions = new AuctionStore(store);
    store.notifications = new NotificationStore(store);
    const service = new QuestService(store, config, () => time); service.templateCache = [];
    return { store, service };
  };
  const { store, service } = open();
  await store.shop.initialize(at);
  await service.manageShop((shop, now) => shop.configure(destination, now));
  await service.manageShop((shop, now) => shop.add({ id: productId, createdBy: actor, name: 'بطاقة هدية', price, stock }, now));
  const seed = async (id = user, tasks = 1000, attendance = 0, time = at) => {
    const state = createDay(config.clanGuildId, id, dayKey(time), [], time - 1000);
    state.points = { tasks, attendance }; await store.ensureDay(state); return state;
  };
  return { documents, store, service, seed, open, intercept: callback => { hook = callback; } };
}
