import { AsyncLocalStorage } from 'node:async_hooks';

const WRITES = new Set(['insertOne', 'insertMany', 'replaceOne', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite']);

// Stop old continuations even when a Discord fetch returns AFTER the reset.
// Only already-issued Mongo writes are drained; Discord rendering is never a reset barrier.
export class ResetFence {
  constructor() { this.context = new AsyncLocalStorage(); this.epoch = 0; this.paused = false; this.writes = new Set(); }
  current() {
    const context = this.context.getStore();
    return context?.control || (!this.paused && (!context || context.epoch === this.epoch));
  }
  assertCurrent() {
    if (!this.current()) throw Object.assign(new Error('أُلغي الطلب بسبب الريست الشامل؛ استخدم الأمر من جديد بعد اكتماله.'), { code: 'RESET_INTERRUPTED' });
  }
  bind(operation) {
    const context = this.context.getStore() || { epoch: this.epoch };
    return () => this.context.run(context, operation);
  }
  run(operation) {
    const context = this.context.getStore();
    return this.context.run(context && !context.control ? context : { epoch: this.epoch }, operation);
  }
  control(operation) { return this.context.run({ control: true }, operation); }
  stop() { this.epoch++; this.paused = true; }
  resume() { this.paused = false; }
  async drain() { await Promise.allSettled([...this.writes]); }
  wrap(db) {
    const collections = new Map();
    return new Proxy(db, { get: (target, key) => {
      if (key !== 'collection') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return (name, options) => {
        if (!collections.has(name)) collections.set(name, new Proxy(target.collection(name, options), { get: (collection, method) => {
          const original = collection[method];
          if (typeof original !== 'function') return original;
          if (!WRITES.has(method)) return original.bind(collection);
          return (...args) => {
            this.assertCurrent();
            const write = Promise.resolve().then(() => { this.assertCurrent(); return original.apply(collection, args); });
            this.writes.add(write);
            void write.then(() => this.writes.delete(write), () => this.writes.delete(write));
            return write;
          };
        } }));
        return collections.get(name);
      };
    } });
  }
}
