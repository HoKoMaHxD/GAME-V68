import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const fingerprint = value => createHash('sha256').update(value).digest('hex');

// Keep secrets out of general settings, embeds, reset exports and log objects.
// A stable dedicated key is optional; the bot secret is the default key source.
export class ReaderCredentials {
  constructor({ store, config, encryptionKey = process.env.READER_TOKEN_KEY }) {
    this.store = store;
    this.id = `reader:${config.clanGuildId}`;
    this.environment = fingerprint(config.userToken || '');
    this.key = createHash('sha256').update(`reader-token:v1:${config.clanGuildId}:`)
      .update(encryptionKey || config.botToken).digest();
  }
  get collection() { return this.store.db.collection('reader_credentials'); }
  seal(token) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.id));
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  open(value) {
    if (value?.version !== 1) throw new Error('Unsupported reader credential');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(this.id)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
  }
  async load(fallback) {
    const record = await this.collection.findOne({ _id: this.id });
    // An explicit token change in Render takes precedence over the saved override.
    if (!record || record.environment !== this.environment) return fallback;
    return this.open(record.secret);
  }
  async save(token, { actorId, operationId, accountId }, now = Date.now()) {
    await this.store.requireLease(now);
    const record = { _id: this.id, environment: this.environment, secret: this.seal(token), actorId, operationId, accountId, updatedAt: now };
    try { await this.collection.replaceOne({ _id: this.id }, record, { upsert: true }); }
    catch {
      // A timeout can follow a committed write; verify before saying it failed.
      const saved = await this.collection.findOne({ _id: this.id });
      if (saved?.operationId !== operationId || this.open(saved.secret) !== token) {
        throw new Error('لم يتأكد حفظ التوكن؛ بقي القارئ الحالي كما هو. أعد المحاولة بعد عودة قاعدة البيانات.');
      }
    }
  }
}
