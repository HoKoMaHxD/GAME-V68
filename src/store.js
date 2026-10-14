import { stageFinancial, archiveFinancial } from './financial-log.js';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { seedTemplates, defaultGameTemplate, validateTemplate, DAILY_QUEST_VERSION, TASK_SET_VERSION, DEFAULT_GAME_TASK_VERSION } from './domain.js';
import { periodStart, dayKey } from './time.js';
import { pointSum, netPoints } from './point-adjustments.js';
import { splitChatTemplates, CHAT_SPLIT_VERSION, LEGACY_CHAT_TASK_ID } from './split-chat-tasks.js';
import { seedSpecialTasks, validateSpecialTask, MAX_SPECIAL_TASKS } from './special-tasks.js';
import { isId } from './config.js';
import { ShopStore } from './shop-store.js';
import { RobberyStore } from './robbery-store.js';
import { AuctionStore } from './auction-store.js';
import { validatePermissionChange } from './permissions.js';
import { ACTIVITY_VERSION, activityPipeline, activityMetric } from './activity.js';
import { readBankSettings, validateBankChange } from './bank.js';
import { resetTarget, applyScopedReset } from './reset-targets.js';
import { NotificationStore } from './notification-store.js';
import { dayNotices, notice } from './notification-events.js';
import { DAILY_REWARD_VERSION, DAILY_REWARDS, DAILY_ATTENDANCE, withDailyReward } from './daily-rewards.js';
import { readSpamSettings, validateSpamChange } from './spam-settings.js';
import { ResetFence } from './reset-fence.js';
import { RESET_DB_OPTIONS } from './full-reset-store.js';
import { PUBLIC_VOICE_TASK_VERSION, publicVoiceTemplate } from './public-voice-task.js';

export class MongoStore {
  constructor(config) {
    this.config = config;
    this.financialAudit = true;
    this.client = new MongoClient(config.mongoUri, { timeoutMS: 15000, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, socketTimeoutMS: 45000, waitQueueTimeoutMS: 15000, maxPoolSize: 10 });
    this.fence = new ResetFence();
    this.db = this.fence.wrap(this.client.db(config.dbName));
    this.owner = randomUUID();
    this.settingsId = `settings:${config.clanGuildId}`;
    this.leaseId = `worker:${config.clanGuildId}`;
    this.taskSetActivatedAt = 0;
    this.resetAllAt = 0;
    this.memberResetAt = new Map();
    this.scopedResetCutoffs = new Map();
    this.shop = new ShopStore(this);
    this.robbery = new RobberyStore(this);
    this.auctions = new AuctionStore(this);
    this.notifications = new NotificationStore(this);
  }
  async connect() {
    await this.client.connect();
    await this.db.collection('financial_logs').createIndex({clanId:1,delivered:1,at:1});
    await this.db.collection('days').createIndex({ clanId: 1, day: 1, userId: 1 });
    await this.db.collection('days').createIndex({ clanId: 1, userId: 1, salaryLastAt: -1 });
    await this.db.collection('days').createIndex({ clanId: 1, userId: 1, prizeLastAt: -1 });
    for (const kind of ['colors', 'dice', 'memory']) {
      await this.db.collection('days').createIndex({ clanId: 1, userId: 1, [`miniGames.${kind}.createdAt`]: -1 });
      await this.db.collection('days').createIndex({ clanId: 1, [`miniGames.${kind}.status`]: 1 });
    }
    await this.db.collection('days').createIndex({ clanId: 1, miniDirty: 1 });
    await this.db.collection('templates').createIndex({ clanId: 1, id: 1 }, { unique: true });
    await this.db.collection('game_events').createIndex({ roomId: 1, applied: 1, receivedAt: 1, receivedOrder: 1, _id: 1 });
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $setOnInsert: { attendance: this.config.attendance, seeded: false }
    }, { upsert: true });
  }
  taskBoostAt(at) {
    return this.db.collection('task_boosts').findOne({ clanId: this.config.clanGuildId, startsAt: { $lte: at }, endsAt: { $gt: at } }, { sort: { startsAt: -1 } });
  }
  async initializeTasks(now = Date.now()) {
    // Run after acquiring the worker lease, before accepting Discord activity.
    const lease = await this.db.collection('leases').findOne({
      _id: this.leaseId, owner: this.owner, expiresAt: { $gt: now }
    });
    if (!lease) throw new Error('يلزم قفل تشغيل فعال قبل تحديث المهام.');
    const settings = await this.settings();
    if (settings.taskSetVersion === TASK_SET_VERSION) {
      this.taskSetActivatedAt = settings.taskSetActivatedAt;
      return false;
    }
    const tasks = seedTemplates(this.config).map(validateTemplate);
    if (!this.config.memberRole) throw new Error('CLAN_MEMBER_ROLE_ID مطلوب لمهام منشن رتبة الكلان في أرينا.');
    const activatedAt = settings.pendingTaskSet?.version === TASK_SET_VERSION ? settings.pendingTaskSet.at : now;
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { pendingTaskSet: { version: TASK_SET_VERSION, at: activatedAt } }
    });
    for (const task of tasks) {
      await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id: task.id }, {
        $set: { ...task, clanId: this.config.clanGuildId, taskSetVersion: TASK_SET_VERSION, archived: false }
      }, { upsert: true });
    }
    await this.db.collection('templates').updateMany({ clanId: this.config.clanGuildId, taskSetVersion: { $ne: TASK_SET_VERSION } }, {
      $set: { enabled: false, archived: true }
    });
    // Publish the completed set last; a partial installation can safely resume.
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { seeded: true, taskSetVersion: TASK_SET_VERSION, taskSetActivatedAt: activatedAt },
      $unset: { pendingTaskSet: '' }
    });
    this.taskSetActivatedAt = activatedAt;
    return true;
  }
  async initializeDailyQuests(now = Date.now()) {
    await this.requireLease(now);
    const settings = await this.settings();
    if (settings.dailyQuestVersion === DAILY_QUEST_VERSION) {
      this.taskSetActivatedAt = settings.dailyQuestActivatedAt;
      return false;
    }
    const activatedAt = settings.pendingDailyQuests?.at || now;
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { pendingDailyQuests: { version: DAILY_QUEST_VERSION, at: activatedAt } }
    });
    const tasks = [...splitChatTemplates(this.config, activatedAt),
      ...seedTemplates(this.config).filter(task => task.id !== LEGACY_CHAT_TASK_ID),
      defaultGameTemplate(this.config, activatedAt)].map(withDailyReward).map(validateTemplate);
    await this.db.collection('templates').updateMany({ clanId: this.config.clanGuildId }, {
      $set: { enabled: false, archived: true }
    });
    for (const task of tasks) await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id: task.id }, {
      $set: { ...task, createdAt: activatedAt, clanId: this.config.clanGuildId,
        taskSetVersion: TASK_SET_VERSION, enabled: true, archived: false }
    }, { upsert: true });
    // Keep voice eligibility preferences, restore the reference attendance rule.
    const attendance = { ...this.config.attendance, ...settings.attendance, enabled: true,
      points: this.config.attendance.points, intervalMs: this.config.attendance.intervalMs,
      dailyCap: this.config.attendance.dailyCap, version: (settings.attendance?.version || 0) + 1 };
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { attendance, seeded: true, dailyQuestVersion: DAILY_QUEST_VERSION,
        dailyQuestActivatedAt: activatedAt, taskSetActivatedAt: activatedAt,
        taskSetVersion: TASK_SET_VERSION, chatSplitVersion: CHAT_SPLIT_VERSION,
        defaultGameTaskVersion: DEFAULT_GAME_TASK_VERSION }, $unset: { pendingDailyQuests: '' }
    });
    this.taskSetActivatedAt = activatedAt;
    return true;
  }
  async initializePublicVoiceTask(now = Date.now()) {
    await this.requireLease(now);
    const settings = await this.settings();
    if (settings.publicVoiceTaskVersion === PUBLIC_VOICE_TASK_VERSION) return false;
    if (settings.dailyQuestVersion !== DAILY_QUEST_VERSION) throw new Error('يجب تهيئة المهام اليومية قبل مهمة الرومات العامة.');
    const installedAt = settings.pendingPublicVoiceTask?.version === PUBLIC_VOICE_TASK_VERSION
      ? settings.pendingPublicVoiceTask.at : now;
    const task = validateTemplate(publicVoiceTemplate(installedAt));
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { pendingPublicVoiceTask: { version: PUBLIC_VOICE_TASK_VERSION, at: installedAt } }
    });
    await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id: task.id }, {
      $set: { ...task, clanId: this.config.clanGuildId, taskSetVersion: TASK_SET_VERSION, archived: false }
    }, { upsert: true });
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { publicVoiceTaskVersion: PUBLIC_VOICE_TASK_VERSION, publicVoiceTaskInstalledAt: installedAt },
      $unset: { pendingPublicVoiceTask: '' }
    });
    return true;
  }
  async initializeVoiceAttendance(now = Date.now()) {
    await this.requireLease(now);
    const settings = await this.settings();
    if (settings.voiceAttendanceVersion === 1) return false;
    const previous = settings.attendance || this.config.attendance;
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, { $set: {
      attendance: { ...previous, points: 200, intervalMs: 21 * 60000,
        dailyCap: 4000,
        version: (previous.version || 1) + 1 },
      voiceAttendanceVersion: 1, voiceAttendanceActivatedAt: now
    } });
    return true;
  }
  async initializeDailyRewards(now = Date.now()) {
    await this.requireLease(now);
    const settings = await this.settings();
    if (settings.rewardSetVersion === DAILY_REWARD_VERSION) {
      this.rewardSetVersion = settings.rewardSetVersion;
      this.rewardSetActivatedAt = settings.rewardSetActivatedAt;
      this.rewardSetPrevious = settings.rewardSetPrevious;
      return false;
    }
    const activatedAt = settings.pendingDailyRewards?.at || now;
    const previousRewards = settings.pendingDailyRewards?.previous || Object.fromEntries((await this.templates())
      .filter(task => Object.hasOwn(DAILY_REWARDS, task.id)).map(task => [task.id, task.reward]));
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { pendingDailyRewards: { version: DAILY_REWARD_VERSION, at: activatedAt, previous: previousRewards } }
    });
    for (const [id, reward] of Object.entries(DAILY_REWARDS)) {
      await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id,
        taskSetVersion: TASK_SET_VERSION }, { $set: { reward } });
    }
    const previous = settings.attendance || this.config.attendance;
    // Raising only the cap must not discard the member's partial ten minutes.
    const sameRate = previous.points === DAILY_ATTENDANCE.points && previous.intervalMs === DAILY_ATTENDANCE.intervalMs;
    const attendance = { ...previous, ...DAILY_ATTENDANCE,
      version: (previous.version || 1) + (sameRate ? 0 : 1) };
    // Publish the marker and attendance rule together after all template writes.
    // An interrupted installation resumes; later restarts keep admin changes.
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { attendance, rewardSetVersion: DAILY_REWARD_VERSION, rewardSetActivatedAt: activatedAt,
        rewardSetPrevious: previousRewards },
      $unset: { pendingDailyRewards: '' }
    });
    this.rewardSetVersion = DAILY_REWARD_VERSION;
    this.rewardSetActivatedAt = activatedAt;
    this.rewardSetPrevious = previousRewards;
    return true;
  }
  async initializeActivity(now = Date.now()) {
    await this.requireLease(now);
    await this.db.collection('settings').updateOne({ _id: this.settingsId, activityVersion: { $exists: false } }, {
      $set: { activityVersion: ACTIVITY_VERSION, activityStartedAt: now }
    });
    const settings = await this.settings();
    if (settings.activityVersion !== ACTIVITY_VERSION || !Number.isSafeInteger(settings.activityStartedAt)) {
      throw new Error('تعذر التحقق من بدء نظام ترتيب النشاط.');
    }
    this.config.activityStartedAt = settings.activityStartedAt;
    return settings.activityStartedAt;
  }
  async initializeGameTask(now = Date.now()) {
    await this.requireLease(now);
    const settings = await this.settings();
    if (settings.defaultGameTaskVersion === DEFAULT_GAME_TASK_VERSION) return false;
    if (settings.taskSetVersion !== TASK_SET_VERSION) throw new Error('يجب تهيئة المهام الأساسية قبل إضافة مهمة الألعاب.');
    const installedAt = settings.pendingDefaultGameTask?.version === DEFAULT_GAME_TASK_VERSION
      ? settings.pendingDefaultGameTask.at : now;
    const task = validateTemplate(defaultGameTemplate(this.config, installedAt));
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { pendingDefaultGameTask: { version: DEFAULT_GAME_TASK_VERSION, at: installedAt } }
    });
    await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id: task.id }, {
      $set: { ...task, clanId: this.config.clanGuildId, taskSetVersion: TASK_SET_VERSION, archived: false }
    }, { upsert: true });
    // Publish last so interruption can resume. Never reinstall base tasks,
    // delete balances, or overwrite later admin edits on an ordinary restart.
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { defaultGameTaskVersion: DEFAULT_GAME_TASK_VERSION, defaultGameTaskInstalledAt: installedAt },
      $unset: { pendingDefaultGameTask: '' }
    });
    return true;
  }
  async initializeChatTasks(now = Date.now()) {
    await this.requireLease(now);
    const settings = await this.settings();
    if (settings.chatSplitVersion === CHAT_SPLIT_VERSION) return false;
    if (settings.taskSetVersion !== TASK_SET_VERSION) throw new Error('يجب تهيئة المهام الأساسية قبل فصل مهمتي الكتابة.');
    const installedAt = settings.pendingChatSplit?.version === CHAT_SPLIT_VERSION ? settings.pendingChatSplit.at : now;
    const tasks = splitChatTemplates(this.config, installedAt).map(validateTemplate);
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { pendingChatSplit: { version: CHAT_SPLIT_VERSION, at: installedAt } }
    });
    for (const task of tasks) await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id: task.id }, {
      $set: { ...task, clanId: this.config.clanGuildId, taskSetVersion: TASK_SET_VERSION, archived: false }
    }, { upsert: true });
    await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id: LEGACY_CHAT_TASK_ID }, {
      $set: { enabled: false, archived: true }
    });
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $set: { chatSplitVersion: CHAT_SPLIT_VERSION, chatSplitInstalledAt: installedAt },
      $unset: { pendingChatSplit: '' }
    });
    return true;
  }
  async acquireLease(now = Date.now()) {
    try {
      const record = await this.db.collection('leases').findOneAndUpdate({
        _id: this.leaseId, $or: [{ owner: this.owner }, { expiresAt: { $lte: now } }]
      }, { $set: { owner: this.owner, expiresAt: now + 45000 } }, { upsert: true, returnDocument: 'after' });
      return record?.owner === this.owner;
    } catch (error) { if (error.code === 11000) return false; throw error; }
  }
  async releaseLease() {
    await this.db.collection('leases').deleteOne({ _id: this.leaseId, owner: this.owner });
  }
  async requireLease(now, options = {}) {
    this.fence?.assertCurrent();
    const lease = await this.db.collection('leases').findOne({
      _id: this.leaseId, owner: this.owner, expiresAt: { $gt: now }
    }, options);
    if (!lease) throw new Error('يلزم قفل تشغيل فعال قبل تعديل البيانات.');
    this.fence?.assertCurrent();
  }
  resetScope(userId = null) {
    if (userId !== null && (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId))) throw new Error('معرف العضو غير صالح للريست.');
    return { clanId: this.config.clanGuildId, ...(userId === null ? {} : { userId }) };
  }
  resetCutoff(userId) { return Math.max(this.resetAllAt || 0, this.memberResetAt?.get(userId) || 0); }
  scopedResetCutoff(userId, target) {
    resetTarget(target);
    return Math.max(this.resetCutoff(userId), this.scopedResetCutoffs?.get(`${target}:all`) || 0,
      this.scopedResetCutoffs?.get(`${target}:${userId}`) || 0);
  }
  rememberReset(record) {
    const target = resetTarget(record.target);
    if (target !== 'all') {
      const key = `${target}:${record.userId ?? 'all'}`;
      this.scopedResetCutoffs ||= new Map();
      this.scopedResetCutoffs.set(key, Math.max(this.scopedResetCutoffs.get(key) || 0, record.cutoff));
      return;
    }
    if (record.userId === null) this.resetAllAt = Math.max(this.resetAllAt || 0, record.cutoff);
    else this.memberResetAt.set(record.userId, Math.max(this.memberResetAt.get(record.userId) || 0, record.cutoff));
  }
  async finishReset(record, now) {
    await this.requireLease(now);
    const target = resetTarget(record.target);
    let deletedDays = 0, changedDays;
    if (target === 'all') {
      if (this.financialAudit) {
        const days = await this.db.collection('days').find(this.resetScope(record.userId)).toArray();
        for (const day of days) {
          await this.requireLease(now);
          const saved = await this.mutateDay(day._id, state => {
            state.financialContext = { source: 'تصفير شامل', actorId: record.actorId, operationId: record.operationId };
            return applyScopedReset(state, { ...record, target: 'bank' });
          });
          await archiveFinancial(this, saved);
        }
      }
      deletedDays = (await this.db.collection('days').deleteMany(this.resetScope(record.userId))).deletedCount;
      if (deletedDays) this.walletRevision = (this.walletRevision || 0) + 1;
    } else {
      // Repeated resets skip already-zero bank days instead of rereading,
      // replacing and auditing every historical document again.
      const projection = target === 'bank' ? Object.fromEntries([
        '_id', 'userId', 'points', 'pointAdjustments', 'shopAdjustments', 'robberyAdjustments',
        'auctionAdjustments', 'protectionAdjustments', 'miniAdjustments', 'bankResetAdjustments',
        'salaryCredits', 'prizeCredits', 'scopedResets'
      ].map(key => [key, 1])) : { _id: 1, userId: 1, scopedResets: 1 };
      const days = await this.db.collection('days').find(this.resetScope(record.userId), { projection, maxTimeMS: 30000 }).toArray();
      const groups = new Map();
      for (const day of days) {
        if (day.scopedResets?.[target]?.operationId === record.operationId) continue;
        const balance = target === 'bank' ? netPoints(day) : null;
        if (balance && balance.tasks === 0 && balance.attendance === 0) continue;
        if (!groups.has(day.userId)) groups.set(day.userId, []);
        groups.get(day.userId).push(day);
      }
      // Keep one member's days serial for accurate financial before/after logs.
      const jobs = [...groups.values()]; let cursor = 0, failure;
      await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
        while (!failure && cursor < jobs.length) {
          const group = jobs[cursor++];
          for (const day of group) {
            if (failure) break;
            try {
              await this.requireLease(now);
              await this.mutateDay(day._id, state => applyScopedReset(state, record));
            } catch (error) { failure ||= error; break; }
          }
        }
      }));
      // Wait for every worker before exposing a partial operation to recovery.
      if (failure) throw failure;
      changedDays = days.length;
    }
    // Publish completion last. Scoped resets resume using per-day markers;
    // full deletion is also safe to repeat while startup blocks activity writes.
    const result = { ...record, pending: false, completedAt: now, deletedDays,
      ...(changedDays === undefined ? {} : { changedDays }) };
    const saved = await this.db.collection('resets').updateOne({ _id: record._id, operationId: record.operationId }, {
      $set: { pending: false, completedAt: now, deletedDays,
        ...(changedDays === undefined ? {} : { changedDays }) }
    });
    if (saved.matchedCount !== 1) throw new Error('تعذر تأكيد حفظ نتيجة الريست.');
    this.rememberReset(result);
    return result;
  }
  async initializeResets(now = Date.now()) {
    await this.requireLease(now);
    this.resetAllAt = 0; this.memberResetAt = new Map(); this.scopedResetCutoffs = new Map();
    const records = await this.db.collection('resets').find({ clanId: this.config.clanGuildId }).toArray();
    for (const record of records) {
      if (record.pending) await this.finishReset(record, now);
      else this.rememberReset(record);
    }
    return records.filter(record => record.pending).length;
  }
  async resetPreview(userId = null, target = 'all') {
    resetTarget(target);
    if (target === 'activity') {
      const rows = await this.db.collection('days').aggregate([
        { $match: this.resetScope(userId) },
        { $group: { _id: '$userId', days: { $sum: 1 }, chat: { $sum: { $ifNull: ['$activity.clanMessages', 0] } },
          voice: { $sum: { $ifNull: ['$activity.voiceMs', 0] } } } },
        { $group: { _id: null, members: { $sum: 1 }, days: { $sum: '$days' }, chat: { $sum: '$chat' }, voice: { $sum: '$voice' } } }
      ], RESET_DB_OPTIONS).toArray();
      return rows[0] || { members: 0, days: 0, chat: 0, voice: 0 };
    }
    const rows = await this.db.collection('days').aggregate([
      { $match: this.resetScope(userId) },
      { $group: { _id: '$userId', days: { $sum: 1 }, tasks: pointSum('tasks'),
        attendance: pointSum('attendance'), milliseconds: { $sum: '$attendance.milliseconds' } } },
      { $group: { _id: null, members: { $sum: 1 }, days: { $sum: '$days' }, tasks: { $sum: '$tasks' },
        attendance: { $sum: '$attendance' }, milliseconds: { $sum: '$milliseconds' } } }
    ], RESET_DB_OPTIONS).toArray();
    return rows[0] || { members: 0, days: 0, tasks: 0, attendance: 0, milliseconds: 0 };
  }
  async resetProgress({ userId = null, actorId, operationId, target = 'all' }, now = Date.now()) {
    resetTarget(target);
    this.resetScope(userId);
    if (typeof actorId !== 'string' || !/^\d{17,20}$/.test(actorId)
      || typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(operationId)
      || !Number.isSafeInteger(now) || now <= 0) throw new Error('طلب الريست غير صالح.');
    await this.requireLease(now);
    const collection = this.db.collection('resets');
    const _id = `reset:${this.config.clanGuildId}:${userId ?? 'all'}${target === 'all' ? '' : `:${target}`}`;
    const previous = await collection.findOne({ _id });
    if (previous?.operationId === operationId) return previous.pending ? this.finishReset(previous, now) : previous;
    if (previous?.pending) throw new Error('هناك ريست غير مكتمل؛ أعد تشغيل الخدمة لاستكماله أولًا.');
    const record = { _id, clanId: this.config.clanGuildId, userId, actorId, operationId,
      ...(target === 'all' ? {} : { target }),
      cutoff: Math.max(now, this.scopedResetCutoff(userId, target)), pending: true, requestedAt: now };
    if (this.notifications?.startedAt) {
      const affected = userId ? [userId] : [...new Set((await this.db.collection('days').find(this.resetScope()).toArray()).map(day => day.userId))];
      // Keep earlier undelivered reset notices when this scope is reset again.
      record.dmEvents = previous?.dmEvents || []; record.dmRevision = previous?.dmRevision || 0;
      this.notifications.stage(record, affected.map(id => notice(id, 'progress_reset', operationId, now, { target })));
    }
    // Persist intent/cutoff before touching balances; never delete settings or templates.
    await collection.replaceOne({ _id }, record, { upsert: true });
    return this.finishReset(record, now);
  }
  async settings(options = {}) { return this.db.collection('settings').findOne({ _id: this.settingsId }, options); }
  async setSpamSettings(input, now) {
    const fields = validateSpamChange(input);
    await this.requireLease(now);
    const previous = (await this.settings())?.spam;
    if (previous?.operationId === input.operationId) return previous;
    if (previous?.operationId && BigInt(previous.operationId) > BigInt(input.operationId)) {
      throw new Error('هذا الأمر أقدم من آخر تعديل. استخدم /خصم من جديد.');
    }
    const spam = { ...readSpamSettings(previous), ...fields, actorId: input.actorId,
      operationId: input.operationId, updatedAt: now };
    try {
      const result = await this.db.collection('settings').updateOne({ _id: this.settingsId,
        'spam.operationId': previous?.operationId ?? { $exists: false } }, { $set: { spam } });
      if (result.matchedCount !== 1) throw new Error('تغيرت الإعدادات بالتزامن مع طلبك. استخدم /خصم للتحقق أو التعديل.');
    } catch (error) {
      const saved = (await this.settings().catch(() => null))?.spam;
      if (saved?.operationId !== input.operationId) throw error;
      return saved;
    }
    return spam;
  }
  async setBankSettings(input, now) {
    const fields = validateBankChange(input);
    await this.requireLease(now);
    const settings = await this.settings(); const previous = settings?.bank;
    if (previous?.operationId === input.operationId) return previous;
    if (previous?.operationId && BigInt(previous.operationId) > BigInt(input.operationId)) throw new Error('هذا الأمر أقدم من آخر إعداد للبنك. افتح /اعدادات_البنك من جديد.');
    const previousBank = readBankSettings(previous);
    const bank = { ...previousBank, ...fields, operationId: input.operationId, actorId: input.actorId, updatedAt: now };
    // The existing challenge version also invalidates unpaid buttons across an
    // off/on cycle. Salary changes alone never invalidate a robbery challenge.
    if (bank.channelId !== previousBank.channelId || bank.robberyEnabled !== previousBank.robberyEnabled) bank.channelVersion++;
    if (!bank.channelId) throw new Error('حدد شات البنك أولًا باستخدام خيار الروم.');
    if (fields.salaryEnabled === true && !bank.salaryAmount) throw new Error('حدد مبلغ الراتب أكبر من صفر لتشغيل أمر راتب.');
    const result = await this.db.collection('settings').updateOne({ _id: this.settingsId,
      'bank.operationId': previous?.operationId ?? { $exists: false } }, { $set: { bank } });
    if (result.matchedCount !== 1) throw new Error('تعذر تأكيد حفظ إعداد البنك.');
    return bank;
  }
  async latestMiniGame(userId, kind) {
    const field = `miniGames.${kind}.createdAt`;
    const rows = await this.db.collection('days').find({ clanId: this.config.clanGuildId, userId, [field]: { $exists: true } })
      .sort({ [field]: -1 }).limit(1).toArray();
    return rows[0] || null;
  }
  pendingMiniGames() {
    return this.db.collection('days').find({ clanId: this.config.clanGuildId,
      $or: [{ 'miniGames.colors.status': 'open' }, { 'miniGames.dice.status': 'open' }, { miniDirty: true }] }).toArray();
  }
  async latestSalary(userId) {
    const rows = await this.db.collection('days').find({ clanId: this.config.clanGuildId, userId, salaryLastAt: { $exists: true } })
      .sort({ salaryLastAt: -1 }).limit(1).toArray();
    return rows[0] || null;
  }
  async latestPrize(userId) {
    const rows = await this.db.collection('days').find({ clanId: this.config.clanGuildId, userId, prizeLastAt: { $exists: true } })
      .sort({ prizeLastAt: -1 }).limit(1).toArray();
    return rows[0] || null;
  }
  async nextPrizeBonus(userId, type) {
    const rows = await this.db.collection('days').find({ clanId: this.config.clanGuildId, userId,
      $or: [{ prizeReceipts: { $exists: true } }, { prizeUses: { $exists: true } }] }).toArray();
    const used = new Set(rows.flatMap(row => (row.prizeUses || []).map(item => item.id)));
    // Repeated wins are queued, not stacked or overwritten. A use is written
    // atomically with its effect while the service holds its exclusive gate.
    return rows.flatMap(row => row.prizeReceipts || []).filter(item => (item.type === type || (type === 'salary' && item.type === 'quest_wait')) && !used.has(item.id))
      .sort((a, b) => a.claimedAt - b.claimedAt || a.id.localeCompare(b.id))[0] || null;
  }
  async setBotPermissions(input, now = Date.now()) {
    const request = validatePermissionChange(input, this.config.clanGuildId);
    await this.requireLease(now);
    const settings = await this.settings();
    if (settings?.botPermissions?.operationId === request.operationId) return settings;
    if (settings?.botPermissions?.operationId && BigInt(settings.botPermissions.operationId) > BigInt(request.operationId)) {
      throw new Error('هذا الأمر أقدم من آخر تعديل للصلاحية. اكتب /صلاحية من جديد.');
    }
    const botPermissions = { ...request, updatedAt: now };
    // Compare the previous operation as well as serializing in the worker, so
    // a delayed old write cannot overwrite a newer role after a lease handoff.
    const result = await this.db.collection('settings').updateOne({ _id: this.settingsId,
      'botPermissions.operationId': settings?.botPermissions?.operationId ?? { $exists: false }
    }, { $set: { botPermissions } });
    if (result.matchedCount !== 1) throw new Error('تعذر تأكيد حفظ إعداد صلاحية البوت.');
    return { ...settings, botPermissions };
  }
  async initializeSpecialTasks(now = Date.now()) {
    await this.requireLease(now);
    // Seed only a missing catalog. Keep an existing or deliberately empty list,
    // and never rewrite balances, automatic task templates or other settings.
    const result = await this.db.collection('settings').updateOne({ _id: this.settingsId, specialTasks: { $exists: false } }, {
      $set: { specialTasks: seedSpecialTasks(now) }
    });
    return result.modifiedCount > 0;
  }
  async addSpecialTask(input, now = Date.now()) {
    const fields = validateSpecialTask(input);
    if (!isId(input.id) || !isId(input.createdBy)) throw new Error('معرف أمر إضافة المهمة الخاصة أو المسؤول غير صالح.');
    await this.requireLease(now);
    const task = { id: input.id, ...fields, createdBy: input.createdBy, createdAt: now };
    let result, writeError;
    try {
      result = await this.db.collection('settings').findOneAndUpdate({
        _id: this.settingsId, specialTasks: { $type: 'array' }, 'specialTasks.id': { $ne: task.id },
        [`specialTasks.${MAX_SPECIAL_TASKS - 1}`]: { $exists: false }
      }, { $push: { specialTasks: task } }, { returnDocument: 'after' });
    } catch (error) { writeError = error; }
    if (result) return { task, duplicate: false };
    // An interaction retry or a lost write acknowledgement must not add twice.
    const settings = await this.settings();
    const existing = settings?.specialTasks?.find(t => t.id === task.id);
    if (existing) return { task: existing, duplicate: true };
    if (writeError) throw writeError;
    if (!Array.isArray(settings?.specialTasks)) throw new Error('قائمة المهمات الخاصة غير مهيأة. أعد تشغيل النسخة المحدثة.');
    throw new Error(`وصلت قائمة المهمات الخاصة إلى الحد الأقصى: ${MAX_SPECIAL_TASKS} مهمة.`);
  }
  async setAppearance(fields) {
    const set = Object.fromEntries(Object.entries(fields).map(([key, value]) => [`appearance.${key}`, value]));
    return this.db.collection('settings').findOneAndUpdate({ _id: this.settingsId }, {
      $set: set, $inc: { 'appearance.revision': 1 }
    }, { returnDocument: 'after' });
  }
  async getPanel() { return this.db.collection('panels').findOne({ _id: `panel:${this.config.clanGuildId}` }); }
  async savePanel(panel) {
    const _id = `panel:${this.config.clanGuildId}`;
    await this.db.collection('panels').replaceOne({ _id }, { ...panel, _id }, { upsert: true });
  }
  async setAttendance(fields) {
    const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`attendance.${k}`, v]));
    return this.db.collection('settings').findOneAndUpdate({ _id: this.settingsId }, {
      $set: set, $inc: { 'attendance.version': 1 }
    }, { returnDocument: 'after' });
  }
  async templates() {
    return this.db.collection('templates').find({ clanId: this.config.clanGuildId, taskSetVersion: TASK_SET_VERSION })
      .sort({ order: 1, id: 1 }).toArray();
  }
  async activeTaskSnapshots(at = Date.now()) {
    const days = await this.db.collection('days').find({ clanId: this.config.clanGuildId,
      day: { $gte: dayKey(at - 120000), $lte: dayKey(at) }, dailyQuestVersion: DAILY_QUEST_VERSION },
    { projection: { tasks: 1 } }).toArray();
    return days.flatMap(day => day.tasks || []);
  }
  async addTemplate(task) {
    await this.db.collection('templates').insertOne({ ...task, clanId: this.config.clanGuildId, taskSetVersion: TASK_SET_VERSION });
  }
  async updateTemplate(id, fields) {
    return this.db.collection('templates').findOneAndUpdate({ clanId: this.config.clanGuildId, id, taskSetVersion: TASK_SET_VERSION }, {
      $set: fields
    }, { returnDocument: 'after' });
  }
  async ensureDay(initial) {
    if (this.notifications?.startedAt) this.notifications.stage(initial, dayNotices({}, initial));
    try { await this.db.collection('days').insertOne(initial); }
    catch (error) { if (error.code !== 11000) throw error; }
    return this.db.collection('days').findOne({ _id: initial._id });
  }
  async getDay(id) { return this.db.collection('days').findOne({ _id: id }); }
  async getGameRoom(id) { return this.db.collection('game_rooms').findOne({ _id: id }); }
  async ensureGameRoom(initial, now) {
    await this.requireLease(now);
    try { await this.db.collection('game_rooms').insertOne(initial); }
    catch (error) { if (error.code !== 11000) throw error; }
    return this.getGameRoom(initial._id);
  }
  async changeGameRoom(id, mutation, now) {
    await this.requireLease(now);
    for (let attempt = 0; attempt < 30; attempt++) {
      const original = await this.getGameRoom(id);
      if (!original) throw new Error('سجل رصد الألعاب غير موجود.');
      const next = structuredClone(original);
      if (!mutation(next)) return original;
      next.revision++;
      const saved = await this.db.collection('game_rooms').replaceOne({ _id: id, revision: original.revision }, next);
      if (saved.matchedCount === 1) return next;
    }
    throw new Error('تعذر حفظ حالة القيم بسبب تحديث متزامن.');
  }
  async saveGameEvent(roomId, event, now) {
    await this.requireLease(now);
    // Message IDs stay unique across edits, restarts and Saudi midnight.
    // Store only proof/identity metadata, never message text or images.
    // A registration card can later become the winner image under the SAME
    // message ID. Keep these two phases separate while preserving 1.7.0's
    // terminal receipt keys, so upgrading cannot replay old rewards.
    const record = { ...event, _id: roomId + ':' + (event.kind === 'lobby' ? 'lobby:' : '') + event.id, roomId, applied: false };
    try { await this.db.collection('game_events').insertOne(record); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
  async pendingGameEvents(roomId) {
    return this.db.collection('game_events').find({ roomId, applied: false })
      .sort({ receivedAt: 1, receivedOrder: 1, _id: 1 }).limit(100).toArray();
  }
  async finishGameEvent(id, now) {
    await this.requireLease(now);
    await this.db.collection('game_events').updateOne({ _id: id }, { $set: { applied: true } });
  }
  // Points and task progress commit in ONE atomic document replacement. No split credit writes.
  async mutateDay(id, mutation) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const original = await this.getDay(id);
      if (!original) throw new Error('سجل اليوم غير موجود.');
      const next = structuredClone(original);
      if (!mutation(next)) return original;
      if (this.notifications?.startedAt) this.notifications.stage(next, dayNotices(original, next));
      await stageFinancial(this, original, next);
      next.revision = original.revision + 1;
      const saved = await this.db.collection('days').replaceOne({ _id: id, revision: original.revision }, next);
      if (saved.matchedCount === 1) {
        if (netPoints(original).total !== netPoints(next).total) this.walletRevision = (this.walletRevision || 0) + 1;
        return next;
      }
    }
    throw new Error('ضغط متزامن على سجل العضو؛ حاول مجددًا.');
  }
  async totals(userId, period, at) {
    const rows = await this.ranking(period, 'total', at, { userId, limit: 1 });
    return rows[0] || { tasks: 0, attendance: 0, total: 0, milliseconds: 0 };
  }
  // Run during startup, after saved financial operations and resets recover,
  // while the worker lease is held and before accepting new activity.
  async repairNegativeBalances(now = Date.now()) {
    await this.requireLease(now);
    const rows = await this.db.collection('days').aggregate([
      ...this.walletPipeline('all', now),
      { $match: { $or: [{ tasks: { $lt: 0 } }, { attendance: { $lt: 0 } }] } }
    ]).toArray();
    let repaired = 0;
    for (const balance of rows) {
      await this.requireLease(now);
      if (![balance.tasks, balance.attendance, balance.total].every(Number.isSafeInteger)) {
        throw new Error('تعذر تصحيح رصيد يتجاوز الحد الرقمي المسموح.');
      }
      // Normalize the lifetime wallet, never individual daily ledger entries:
      // a negative day can legitimately spend funds earned on an earlier day.
      const total = Math.max(0, balance.total);
      const tasks = Math.min(Math.max(0, balance.tasks), total);
      const amounts = { tasks: tasks - balance.tasks, attendance: total - tasks - balance.attendance };
      const day = await this.db.collection('days').findOne({ clanId: this.config.clanGuildId, userId: balance._id },
        { sort: { day: -1, _id: 1 } });
      if (!day) throw new Error('سجل العضو غير موجود أثناء تصحيح الرصيد.');
      const entry = { id: `balance-floor:${day._id}:${day.revision}`, at: now,
        before: balance.total, after: total, amount: total - balance.total, amounts,
        reason: 'تصحيح الرصيد القديم لمنع الرصيد السالب' };
      await this.mutateDay(day._id, draft => {
        if (draft.balanceFloorReceipts?.some(item => item.id === entry.id)) return false;
        const next = Object.fromEntries(['tasks', 'attendance'].map(key => [key,
          (draft.pointAdjustments?.[key] || 0) + amounts[key]]));
        if (!Object.values(next).every(Number.isSafeInteger)) throw new Error('تصحيح الرصيد يتجاوز الحد الرقمي المسموح.');
        draft.pointAdjustments = next;
        (draft.balanceFloorReceipts ||= []).push(structuredClone(entry));
        draft.financialContext = { source: 'تصحيح الرصيد السالب', reason: entry.reason };
        return true;
      });
      repaired++;
    }
    return repaired;
  }
  async activityRanking(period, metric, at, { limit = 6, skip = 0, userId } = {}) {
    activityMetric(metric);
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('صفحة الترتيب غير صالحة.');
    }
    return this.db.collection('days').aggregate([
      ...activityPipeline(this.config, period, at, userId),
      { $match: { [metric]: { $gt: 0 } } },
      { $sort: { [metric]: -1, _id: 1 } }, { $skip: skip }, { $limit: limit }
    ]).toArray();
  }
  async activityPosition(userId, period, metric, at) {
    activityMetric(metric);
    const [self] = await this.activityRanking(period, metric, at, { userId, limit: 1 });
    if (!self) return { position: null, value: 0 };
    // Same tie-break as every page, so personal ranks match the visible list.
    const rows = await this.db.collection('days').aggregate([
      ...activityPipeline(this.config, period, at),
      { $match: { $or: [{ [metric]: { $gt: self[metric] } },
        { [metric]: self[metric], _id: { $lt: userId } }] } },
      { $count: 'count' }
    ]).toArray();
    return { position: (rows[0]?.count || 0) + 1, value: self[metric] };
  }
  walletPipeline(period, at, userId) {
    // The lifetime wallet must include every saved debit. A Discord timestamp
    // within the accepted 5-second clock skew can land in tomorrow's document
    // just before Saudi midnight; hiding it would let another operation spend
    // that balance again. Calendar-specific leaderboards retain their end date.
    const match = { clanId: this.config.clanGuildId,
      day: { $gte: periodStart(period, at, this.config.weekStart), ...(period === 'all' ? {} : { $lte: dayKey(at) }) } };
    if (userId) match.userId = userId;
    return [
      { $match: match },
      { $group: { _id: '$userId', tasks: pointSum('tasks'), attendance: pointSum('attendance'), milliseconds: { $sum: '$attendance.milliseconds' } } },
      { $addFields: { total: { $add: ['$tasks', '$attendance'] } } }
    ];
  }
  async bankPage(userId, requestedPage, size, at) {
    const base = this.walletPipeline('all', at);
    const [counts, selfRows] = await Promise.all([
      this.db.collection('days').aggregate([...base, { $count: 'count' }]).toArray(),
      this.db.collection('days').aggregate(this.walletPipeline('all', at, userId)).toArray()
    ]);
    const count = counts[0]?.count || 0, pages = Math.max(1, Math.ceil(count / size));
    const page = Math.min(requestedPage, pages), offset = (page - 1) * size;
    const self = selfRows[0];
    const [rows, positions] = await Promise.all([
      this.db.collection('days').aggregate([...base, { $sort: { total: -1, _id: 1 } }, { $skip: offset }, { $limit: size }]).toArray(),
      self ? this.db.collection('days').aggregate([...base, { $match: { $or: [
        { total: { $gt: self.total } }, { total: self.total, _id: { $lt: userId } }
      ] } }, { $count: 'count' }]).toArray() : []
    ]);
    return { rows, page, pages, count, offset, self: { position: self ? (positions[0]?.count || 0) + 1 : null, value: self?.total || 0 } };
  }
  async bankPosition(userId, at) {
    const self = await this.totals(userId, 'all', at);
    if (self.total <= 0) return { position: null, value: self.total };
    const rows = await this.db.collection('days').aggregate([
      ...this.walletPipeline('all', at),
      { $match: { $or: [{ total: { $gt: self.total } }, { total: self.total, _id: { $lt: userId } }] } },
      { $count: 'count' }
    ]).toArray();
    return { position: (rows[0]?.count || 0) + 1, value: self.total };
  }
  async bankNextTarget(self, at) {
    if (self.position === 1) return null;
    if (self.position > 1) {
      const [row] = await this.ranking('all', 'total', at, { skip: self.position - 2, limit: 1 });
      if (!row) throw new Error('تعذر تحديد المركز التالي. اطلب توب من جديد.');
      return { ...row, position: self.position - 1 };
    }
    // An unranked member first aims to enter at the lowest positive place.
    // With no ranked members, one currency unit establishes first place.
    const pipeline = [...this.walletPipeline('all', at), { $match: { total: { $gt: 0 } } }];
    const [counts, rows] = await Promise.all([
      this.db.collection('days').aggregate([...pipeline, { $count: 'count' }]).toArray(),
      this.db.collection('days').aggregate([...pipeline, { $sort: { total: 1, _id: -1 } }, { $limit: 1 }]).toArray()
    ]);
    return rows[0] ? { ...rows[0], position: counts[0].count } : { _id: null, total: 1, position: 1 };
  }
  async ranking(period, category, at, { userId, limit = 10, skip = 0 } = {}) {
    const score = ['tasks', 'attendance'].includes(category) ? category : 'total';
    return this.db.collection('days').aggregate([
      ...this.walletPipeline(period, at, userId),
      ...(!userId ? [{ $match: { [score]: { $gt: 0 } } }] : []),
      { $sort: { [score]: -1, _id: 1 } }, { $skip: skip }, { $limit: limit }
    ]).toArray();
  }
  async close() { await this.client.close(); }
}
