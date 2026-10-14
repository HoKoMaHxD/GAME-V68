// Activity writes may run together; a reset waits for them and blocks later writes.
// Capture the barrier at entry so work queued before a reset cannot run after it.
export class ActivityGate {
  constructor(bind = operation => operation) { this.barrier = Promise.resolve(); this.active = new Set(); this.serial = new Map(); this.bind = bind; }
  run(operation) {
    const task = this.barrier.then(this.bind(operation));
    this.active.add(task);
    void task.then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }
  runSerial(key, operation) {
    const previous = this.serial.get(key) || Promise.resolve();
    const task = this.run(async () => { await previous.catch(() => {}); return operation(); });
    this.serial.set(key, task);
    const cleanup = () => { if (this.serial.get(key) === task) this.serial.delete(key); };
    void task.then(cleanup, cleanup);
    return task;
  }
  exclusive(operation) {
    const task = Promise.allSettled([this.barrier, ...this.active]).then(this.bind(operation));
    this.barrier = task.catch(() => {});
    return task;
  }
}
