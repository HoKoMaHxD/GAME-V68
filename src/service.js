import { ShipGame } from './ship-game.js';
import { TaskBoosts } from './task-boost.js';
import { BoxesGame } from './boxes-game.js';
import { DotGame } from './dot-game.js';
import { NumbersGame } from './numbers-game.js';
import { MinesGame } from './mines-game.js';
import { ButtonGame } from './button-game.js';
import { XoGame } from './xo.js';
import { MemoryGame } from './memory-game.js';
import { MiniGames } from './mini-games.js';
import { createDay, activateDailyTasks, applyMessage, applyVoice, applyGame } from './domain.js';
import { countChat, countVoice } from './activity.js';
import { dayKey, splitDays, nextReset } from './time.js';
import { ActivityGate } from './activity-gate.js';
import { validatePointAdjustment, applyPointAdjustment } from './point-adjustments.js';
import { MESSAGE_MAX_AGE_MS } from './message-channels.js';
import { purchaseDebit, validatePurchase } from './shop.js';
import { drawPrize, applyPrize, PRIZE_INTERVAL_MS } from './prizes.js';
import { isId } from './config.js';
import { validateRobberyRequest, newRobberyRound, robberyStatus, resolveRobbery, robberyProtection, applyRobberyTransfer, ROBBERY_MOVES, ROBBERY_COMMAND_COOLDOWN_MS } from './robbery.js';
import { readBankSettings, requireBankChannel, requireBankCommand, bankCommandStatus, applySalary, salaryForMember, SALARY_INTERVAL_MS, BANK_TOP_SIZE, gapToNextRank } from './bank.js';
import { newAuction, bidAmount, applyAuctionLeg, auctionTerminal, AUCTION_LATE_MS, AUCTION_EXTENSION_MS } from './auction.js';
import { resetTarget } from './reset-targets.js';
import { PROTECTION_CONFIRM_MS, readProtectionSettings, requireProtectionRenewal, applyProtectionPurchase } from './protection.js';
import { advanceMine, MINE_CELLS } from './robbery-mine.js';
import { updateDailyRewards } from './daily-rewards.js';
import { DEFAULT_SPAM_SETTINGS } from './spam-settings.js';
import { PUBLIC_VOICE_TASK_ID, appendPublicVoiceTask, availablePublicVoiceTask } from './public-voice-task.js';

export class QuestService {
  constructor(store, config, clock = Date.now) {
    this.store = store; this.config = config; this.clock = clock;
    this.gate = new ActivityGate(operation => store.fence?.bind(operation) || operation); this.paused = false; this.resumedAt = 0; this.blocked = false; this.templateCache = null;
    this.boosts = new TaskBoosts(this);
    this.shipGame = new ShipGame(this, (id, at) => this.#day(id, at));
    this.boxesGame = new BoxesGame(this, (id, at) => this.#day(id, at));
    this.dotGame = new DotGame(this, (id, at) => this.#day(id, at));
    this.numbersGame = new NumbersGame(this, (id, at) => this.#day(id, at));
    this.minesGame = new MinesGame(this, (id, at) => this.#day(id, at));
    this.buttonGame = new ButtonGame(this, (id, at) => this.#day(id, at));
    this.xo = new XoGame(this, (id, at) => this.#day(id, at));
    this.memory = new MemoryGame(this, (id, at) => this.#day(id, at));
    this.mini = new MiniGames(this, (id, at) => this.#day(id, at));
  }
  get blocked() { return this._blocked || false; }
  set blocked(value) { if (!value || !this.store.fence || this.store.fence.current()) this._blocked = value; }
  assertActive() {
    this.store.fence?.assertCurrent();
    if (this.paused) throw new Error('البوت متوقف بالكامل بقرار الإدارة. استخدم /البنك الحالة: تشغيل.');
    if (this.blocked) throw new Error('الاحتساب متوقف مؤقتًا؛ تجري استعادة العمليات المحفوظة تلقائيًا.');
  }
  cutoff(userId) { return this.store.resetCutoff?.(userId) || 0; }
  bankCutoff(userId) { return this.store.scopedResetCutoff?.(userId, 'bank') || this.cutoff(userId); }
  activityCutoff(userId) { return this.store.scopedResetCutoff?.(userId, 'activity') || this.cutoff(userId); }
  day(userId, at = this.clock()) {
    return this.gate.run(() => {
      this.assertActive();
      return this.#day(userId, Math.max(at, this.cutoff(userId)));
    });
  }
  async #day(userId, at) {
    const day = dayKey(at);
    const id = `${this.config.clanGuildId}:${day}:${userId}`;
    let existing = await this.store.getDay(id);
    const activatedAt = this.store.taskSetActivatedAt || 0;
    let templates = this.templateCache ?? await this.store.templates();
    // A durable game proof from an earlier Saudi day may be recovered after
    // this upgrade before its first ledger exists. Keep that day's old price.
    if (this.store.rewardSetActivatedAt && day < dayKey(this.store.rewardSetActivatedAt)) {
      templates = templates.map(task => this.store.rewardSetPrevious?.[task.id] !== undefined
        ? { ...task, reward: this.store.rewardSetPrevious[task.id] } : task);
    }
    if (!existing) {
      const initial = createDay(this.config.clanGuildId, userId, day, at >= activatedAt ? templates : [], at);
      if (this.store.rewardSetVersion) initial.rewardSetVersion = this.store.rewardSetVersion;
      existing = await this.store.ensureDay(initial);
    }
    if (at < activatedAt) return existing;
    const update = draft => {
      const replaced = activateDailyTasks(draft, templates, activatedAt || at);
      if (replaced && this.store.rewardSetVersion) draft.rewardSetVersion = this.store.rewardSetVersion;
      const addedPublicVoice = appendPublicVoiceTask(draft, templates, at);
      return updateDailyRewards(draft, this.store.rewardSetActivatedAt) || replaced || addedPublicVoice;
    };
    return update(structuredClone(existing)) ? this.store.mutateDay(id, update) : existing;
  }

  message(event) {
    const receivedAt = this.clock();
    return this.gate.runSerial(event.userId, () => this.#message(event, receivedAt));
  }
  async #message(event, receivedAt) {
    this.assertActive();
    if (event.guildId !== this.config.arenaGuildId || event.bot || event.system || event.webhook || !event.eligible
        || !/^\d{17,20}$/.test(event.id) || !Number.isFinite(event.at)
        || event.at > receivedAt + 5000 || receivedAt - event.at > MESSAGE_MAX_AGE_MS || event.at < (this.store.taskSetActivatedAt || 0)
        || event.at <= Math.max(this.cutoff(event.userId), this.resumedAt)) return null;
    const state = await this.#day(event.userId, event.at);
    const rewardConfig = { ...this.config, taskBoost: await this.store.taskBoostAt?.(event.at) };
    return this.store.mutateDay(state._id, draft => {
      const activity = event.at > this.activityCutoff(event.userId) && countChat(draft, event, this.config, receivedAt);
      const quest = applyMessage(draft, event, rewardConfig, receivedAt);
      if ((activity || quest) && (!draft.lastMessage || BigInt(event.id) > BigInt(draft.lastMessage.id))) {
        draft.lastMessage = { id: event.id, at: event.at };
      }
      return activity || quest;
    });
  }
  voice(event, rule) { return this.gate.runSerial(event.userId, () => this.#voice(event, rule)); }
  game(event) {
    return this.gate.runSerial(event.userId, async () => {
      this.assertActive();
      if (!event.eligible || event.guildId !== this.config.arenaGuildId || event.botId !== this.config.gamesBotId
        || event.channelId !== this.config.gamesChannelId || !isId(event.userId)
        || !Number.isFinite(event.at) || event.at > this.clock() + 5000
        || event.at < (this.store.taskSetActivatedAt || 0) || event.at <= Math.max(this.cutoff(event.userId), this.resumedAt)) return null;
      const state = await this.#day(event.userId, event.at);
      const rewardConfig = { ...this.config, taskBoost: await this.store.taskBoostAt?.(event.at) };
      return this.store.mutateDay(state._id, draft => applyGame(draft, event, rewardConfig));
    });
  }
  async #voice(event, rule) {
    this.assertActive();
    if (event.guildId !== this.config.arenaGuildId || !event.eligible || !event.channelId
      || !Number.isFinite(event.from) || !Number.isFinite(event.to)
      || event.to - event.from > 60000 || event.to <= event.from || event.to > this.clock() + 5000) return;
    for (const part of splitDays(Math.max(event.from, this.store.taskSetActivatedAt || 0, this.cutoff(event.userId), this.resumedAt), event.to)) {
      const state = await this.#day(event.userId, part.from);
      const rewardConfig = { ...this.config, taskBoost: await this.store.taskBoostAt?.(part.to) };
      await this.store.mutateDay(state._id, draft => {
        const interval = { ...event, ...part };
        const activity = countVoice(draft, { ...interval, from: Math.max(interval.from, this.activityCutoff(event.userId)) }, this.config);
        return applyVoice(draft, interval, rule, rewardConfig) || activity;
      });
    }
  }
  resetPreview(userId = null, target = 'all') {
    if (userId === null && resetTarget(target) === 'all') return this.store.resetPreview(userId, target);
    return this.gate.run(() => { this.assertActive(); return this.store.resetPreview(userId, resetTarget(target)); });
  }
  walletView(userId, periods, at = this.clock()) {
    // A balance request must not read between the debit and credit legs, or
    // combine pre-transfer totals with a post-transfer daily statement.
    return this.gate.run(async () => {
      this.assertActive();
      const state = await this.#day(userId, Math.max(at, this.cutoff(userId)));
      const values = await Promise.all(periods.map(period => this.store.totals(userId, period, at)));
      return { state, totals: Object.fromEntries(periods.map((period, index) => [period, values[index]])) };
    });
  }
  async #bank(channelId, command) {
    const bank = requireBankChannel((await this.store.settings())?.bank, channelId);
    if (command) requireBankCommand(bank, command);
    return bank;
  }
  balance(userId, channelId = null) {
    return this.gate.run(async () => {
      this.assertActive();
      if (channelId !== null) await this.#bank(channelId);
      return this.store.totals(userId, 'all', this.clock());
    });
  }
  commandTimes(userId, channelId, questEligible = false) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      if (!isId(userId)) throw new Error('معرف العضو غير صالح.');
      const bank = await this.#bank(channelId);
      const at = this.clock(), enabled = bankCommandStatus(bank);
      const [salary, prize, previous, protection, round, latestRobbery] = await Promise.all([
        this.store.latestSalary(userId), this.store.latestPrize(userId),
        questEligible ? this.store.getDay(`${this.config.clanGuildId}:${dayKey(at)}:${userId}`) : null,
        this.store.robbery.activeProtection(userId, at), this.store.robbery.activeRound(userId, at), this.store.robbery.latestRound(userId)
      ]);
      const cooldown = nextAt => nextAt > at ? { status: 'cooldown', nextAt } : { status: 'ready' };
      const publicVoiceAvailable = questEligible && availablePublicVoiceTask(this.templateCache ?? await this.store.templates(), userId, at);
      const extraVoiceSlot = publicVoiceAvailable && !previous?.tasks?.some(task => task.id === PUBLIC_VOICE_TASK_ID) ? 1 : 0;
      const quest = questEligible ? { status: 'daily', resetsAt: nextReset(at),
        completed: (previous?.tasks || []).filter(task => task.completed >= task.repeat).length,
        total: (previous?.dailyQuestVersion === 1 ? previous.tasks.length : 6) + extraVoiceSlot } : { status: 'ineligible' };
      const openRound = round && round.bankVersion === bank.channelVersion
        && robberyStatus(round, at, id => this.bankCutoff(id)) === 'open';
      const spam = await this.store.robbery.spamState(userId);
      const [memoryDay, colorsDay, diceDay] = await Promise.all([this.store.latestMiniGame?.(userId, 'memory'),this.store.latestMiniGame?.(userId, 'colors'), this.store.latestMiniGame?.(userId, 'dice')]);
      const [xo, numbers, buttonGame, mines, dot, boxes, ship] = await Promise.all([this.xo, this.numbersGame, this.buttonGame, this.minesGame, this.dotGame, this.boxesGame, this.shipGame].map(game => game.commandTime(userId, at)));
      return { at, xo, numbers, buttonGame, mines, dot, boxes, ship, memory: cooldown(memoryDay?.miniGames?.memory?.nextAt || 0), colors: cooldown(colorsDay?.miniGames?.colors?.nextAt || 0), dice: cooldown(diceDay?.miniGames?.dice?.nextAt || 0),
        salary: enabled.salary ? cooldown((salary?.salaryLastAt || 0) + SALARY_INTERVAL_MS) : { status: 'disabled' },
        prize: cooldown((prize?.prizeLastAt || 0) + PRIZE_INTERVAL_MS), quest,
        robbery: !enabled.robbery ? { status: 'disabled' }
          : spam?.blockedUntil > at ? { status: 'blocked', nextAt: spam.blockedUntil, expiresAt: openRound ? round.expiresAt : null }
          : openRound ? { status: 'open', expiresAt: round.expiresAt }
            : cooldown((latestRobbery?.createdAt || 0) + ROBBERY_COMMAND_COOLDOWN_MS),
        protection: protection ? { status: 'active', expiresAt: protection.expiresAt } : { status: 'none' }
      };
    });
  }
  configureBank(input) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      try { return await this.store.setBankSettings(input, this.clock()); }
      catch (cause) {
        const settings = await this.store.settings().catch(() => null);
        if (settings?.bank?.operationId === input.operationId) return settings.bank;
        throw cause;
      }
    });
  }
  bankTop(userId, channelId) {
    return this.gate.exclusive(async () => {
      this.assertActive(); await this.#bank(channelId);
      const at = this.clock();
      const [rows, self] = await Promise.all([this.store.ranking('all', 'total', at, { limit: BANK_TOP_SIZE }), this.store.bankPosition(userId, at)]);
      const target = await this.store.bankNextTarget(self, at);
      return { rows, self, nextPosition: target?.position ?? null, gap: gapToNextRank(target, self, userId), at };
    });
  }
  bankLeaderboard(userId, requestedPage = 1) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      if (!isId(userId) || !Number.isSafeInteger(requestedPage) || requestedPage < 1) throw new Error('صفحة البنك غير صالحة.');
      const at = this.clock();
      return { ...await this.store.bankPage(userId, requestedPage, BANK_TOP_SIZE, at), at };
    });
  }
  claimSalary(input, isEligible = () => true, isBoosting = () => false, choose) {
    return this.gate.exclusive(async () => {
      this.assertActive(); const now = this.clock();
      if (![input.id, input.userId, input.channelId].every(isId) || !Number.isSafeInteger(input.at)
        || input.at > now + 5000 || now - input.at > 900000 || input.at <= this.bankCutoff(input.userId)) throw new Error('انتهت صلاحية طلب الراتب. اكتب راتب من جديد.');
      const bank = await this.#bank(input.channelId, 'راتب');
      if (!await isEligible(input.userId)) throw new Error('الراتب متاح لأعضاء سيرفر الكلان فقط.');
      await this.store.requireLease(now);
      const previous = await this.store.latestSalary(input.userId);
      const receipt = previous?.salaryReceipts?.find(item => item.id === input.id);
      if (receipt) return { ...receipt, duplicate: true, status: 'paid' };
      if (previous?.salaryLastAt + SALARY_INTERVAL_MS > now) return { status: 'cooldown', nextAt: previous.salaryLastAt + SALARY_INTERVAL_MS };
      const balance = await this.store.totals(input.userId, 'all', now);
      const bonus = await this.store.nextPrizeBonus(input.userId, 'salary');
      if (!await isEligible(input.userId)) throw new Error('لم تعد عضوًا في سيرفر الكلان.');
      const boosting = await isBoosting(input.userId);
      const claimedAt = this.clock();
      await this.store.requireLease(claimedAt);
      const salary = salaryForMember(bank, boosting, choose);
      const bonusAmount = bonus ? Math.floor(salary.baseAmount * bonus.percent / 100) : 0;
      const amount = salary.baseAmount + bonusAmount;
      const after = balance.total + amount;
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(balance.tasks + amount)) throw new Error('الراتب يتجاوز الحد الرقمي للرصيد.');
      const state = await this.#day(input.userId, claimedAt);
      const entry = { id: input.id, userId: input.userId, dayId: state._id, ...salary, amount,
        ...(bonus ? { bonusId: bonus.id, bonusPercent: bonus.percent, bonusAmount } : {}),
        claimedAt, nextAt: claimedAt + SALARY_INTERVAL_MS, after };
      try {
        const saved = await this.store.mutateDay(state._id, draft => applySalary(draft, entry));
        return { ...saved.salaryReceipts.find(item => item.id === input.id), status: 'paid', duplicate: false };
      } catch (cause) {
        const saved = await this.store.getDay(state._id).catch(() => null);
        const verified = saved?.salaryReceipts?.find(item => item.id === input.id);
        if (verified) return { ...verified, status: 'paid', duplicate: false };
        this.blocked = true;
        throw new Error('لم يتأكد صرف الراتب. أُوقف الاحتساب مؤقتًا؛ ستتم الاستعادة تلقائيًا دون تكرار الصرف.', { cause });
      }
    });
  }
  claimPrize(input, isEligible = () => true, choose) {
    return this.gate.exclusive(async () => {
      this.assertActive(); const now = this.clock();
      if (![input.id, input.userId, input.channelId].every(isId) || !Number.isSafeInteger(input.at)
        || input.at > now + 5000 || now - input.at > 900000 || input.at <= this.bankCutoff(input.userId)) {
        throw new Error('انتهت صلاحية طلب الجائزة. اكتب جائزة من جديد.');
      }
      await this.#bank(input.channelId);
      if (!await isEligible(input.userId)) throw new Error('الجائزة متاحة لأعضاء سيرفر الكلان فقط.');
      await this.store.requireLease(now);
      const previous = await this.store.latestPrize(input.userId);
      const receipt = previous?.prizeReceipts?.find(item => item.id === input.id);
      if (receipt) return { ...receipt, status: 'claimed', duplicate: true };
      if (previous?.prizeLastAt + PRIZE_INTERVAL_MS > now) return { status: 'cooldown', nextAt: previous.prizeLastAt + PRIZE_INTERVAL_MS };
      const prize = drawPrize(choose);
      const state = await this.#day(input.userId, now);
      const balance = await this.store.totals(input.userId, 'all', now);
      const after = balance.total + prize.amount;
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(balance.tasks + prize.amount)) throw new Error('الجائزة تتجاوز الحد الرقمي للرصيد.');
      const entry = { ...prize, id: input.id, userId: input.userId, dayId: state._id,
        claimedAt: now, nextAt: now + PRIZE_INTERVAL_MS, after };
      if (!await isEligible(input.userId)) throw new Error('لم تعد عضوًا في سيرفر الكلان.');
      try {
        const saved = await this.store.mutateDay(state._id, draft => applyPrize(draft, entry));
        return { ...saved.prizeReceipts.find(item => item.id === input.id), status: 'claimed', duplicate: false };
      } catch (cause) {
        const saved = await this.store.getDay(state._id).catch(() => null);
        const verified = saved?.prizeReceipts?.find(item => item.id === input.id);
        if (verified) return { ...verified, status: 'claimed', duplicate: false };
        this.blocked = true;
        throw new Error('لم يتأكد حفظ الجائزة. أُوقف الاحتساب مؤقتًا؛ ستتم الاستعادة تلقائيًا دون تكرار الصرف.', { cause });
      }
    });
  }
  buyProtection(input, isEligible = () => true) {
    return this.gate.exclusive(async () => {
      this.assertActive(); const now = this.clock();
      if (![input.id, input.userId, input.channelId].every(isId) || !Number.isSafeInteger(input.at)
        || input.at <= 0 || input.at > now + 5000 || now - input.at >= PROTECTION_CONFIRM_MS) throw new Error('انتهت صلاحية طلب الحماية. اكتب حماية من جديد.');
      const settings = readProtectionSettings(await this.#bank(input.channelId));
      if (!await isEligible(input.userId)) throw new Error('الحماية متاحة لأعضاء سيرفر الكلان فقط.');
      await this.store.requireLease(now);
      const journal = await this.store.robbery.get();
      if (journal.pending) { this.blocked = true; throw new Error('هناك عملية نهب أو حماية قيد الاستكمال. ستتم استعادتها تلقائيًا.'); }
      const previous = await this.store.robbery.protectionPurchase(input.id);
      if (previous) {
        if (previous.userId !== input.userId || previous.channelId !== input.channelId) throw new Error('هذا الطلب يخص عملية حماية أخرى.');
        return { ...previous, status: 'paid', duplicate: true };
      }
      if (input.at <= this.bankCutoff(input.userId)) throw new Error('هذا الطلب أقدم من آخر ريست. اكتب حماية من جديد.');
      const protection = await this.store.robbery.activeProtection(input.userId, now);
      requireProtectionRenewal(settings, protection, now);
      if (input.quote && ['protectionPrice', 'protectionMinutes', 'protectionStack'].some(key => input.quote[key] !== settings[key])) throw new Error('تغيرت إعدادات الحماية. اكتب حماية من جديد لتأكيد السعر والمدة الحالية.');
      const balance = await this.store.totals(input.userId, 'all', now);
      if (balance.total < settings.protectionPrice) throw new Error(`رصيدك غير كافٍ؛ سعر الحماية ${settings.protectionPrice.toLocaleString('en-US')} $ لمدة ${settings.protectionMinutes} دقيقة، ورصيدك ${balance.total.toLocaleString('en-US')} $.`);
      const debit = purchaseDebit(balance, settings.protectionPrice);
      const state = await this.#day(input.userId, now);
      if (!await isEligible(input.userId)) throw new Error('لم تعد عضوًا في سيرفر الكلان. لم تُشترَ الحماية.');
      const startedAt = this.clock();
      const previousExpiresAt = protection?.expiresAt > startedAt ? protection.expiresAt : null;
      const expiresAt = (previousExpiresAt ?? startedAt) + (settings.protectionMinutes * 60000);
      if (!Number.isSafeInteger(expiresAt)) throw new Error('مدة الحماية تتجاوز الحد الرقمي المسموح.');
      const purchase = { kind: 'protection-purchase', id: input.id, userId: input.userId, channelId: input.channelId,
        requestAt: input.at, purchasedAt: startedAt, dayId: state._id, price: settings.protectionPrice, debit,
        before: balance.total, after: balance.total - settings.protectionPrice,
        previousExpiresAt, addedDurationMs: (settings.protectionMinutes * 60000),
        protection: { userId: input.userId, durationMs: expiresAt - startedAt, startedAt, expiresAt } };
      applyProtectionPurchase(structuredClone(state), purchase);
      try {
        await this.store.robbery.reserve(purchase, this.clock());
        return { ...await this.store.robbery.recover(this.clock()), status: 'paid', duplicate: false };
      } catch (cause) {
        this.blocked = true;
        throw new Error(`لم يتأكد اكتمال شراء الحماية ${input.id}. أُوقف الاحتساب مؤقتًا؛ سيُستكمل الطلب تلقائيًا دون خصم مكرر.`, { cause });
      }
    });
  }
  async #requireRobberyTargetAvailable(userId, now) {
    const protection = await this.store.robbery.activeProtection(userId, now);
    if (protection) {
      const end = Math.ceil(protection.expiresAt / 1000);
      throw Object.assign(new Error(`العضو <@${userId}> تحت الحماية من النهب حتى <t:${end}:f>؛ تنتهي <t:${end}:R>.`), {
        code: 'ROBBERY_PROTECTED', protection: { userId, expiresAt: protection.expiresAt }
      });
    }
  }
  async #requireRobberyMembers(round, isEligible) {
    if (!await isEligible(round.userId) || !await isEligible(round.targetId)) {
      await this.store.robbery.close(round, 'cancelled', this.clock(), 'membership');
      throw new Error('لم تعد عضوية أحد الطرفين في السيرفر متاحة. أُلغي التحدي دون خصم عملة.');
    }
  }
  async #retireRobbery(round, bank, now) {
    if (round.status !== 'open') return round;
    const state = round.bankVersion !== bank.channelVersion || round.channelId !== bank.channelId
      || !bankCommandStatus(bank).robbery ? 'cancelled' : robberyStatus(round, now, id => this.bankCutoff(id));
    if (state === 'cancelled') return this.store.robbery.close(round, 'cancelled', this.clock());
    // A shield purchased mid-game makes further play impossible. Close it now
    // instead of rejecting every click and later charging an unavoidable loss.
    if (await this.store.robbery.activeProtection(round.targetId, now)) {
      return this.store.robbery.close(round, 'cancelled', this.clock(), 'protection');
    }
    if (state !== 'expired') return round;
    // Only rounds created under the timeout-loss rule can incur this penalty.
    // Historical abandoned boards must never become retroactive debits.
    if (!round.timeoutLoss) return this.store.robbery.close(round, 'expired', this.clock());
    // A failed initial publication or undelivered safe turn is a technical
    // failure, not player inactivity. Never impose a timeout debit for it.
    if (round.delivery?.required && !round.delivery.complete) {
      return this.store.robbery.close(round, 'cancelled', this.clock(), 'delivery');
    }
    return this.#finishRobbery({ ...round, endReason: 'timeout' }, undefined, `timeout:${round.id}`, now);
  }
  async expireRobberies() {
    this.assertActive();
    // An idle maintenance scan must not reserve the shared financial barrier.
    // Recheck the journal under the gate if recovery or open rounds need work.
    const open = await this.store.robbery.managedOpen();
    if (!open.length && !(await this.store.robbery.get()).pending) return [];
    return this.gate.exclusive(async () => {
      this.assertActive(); await this.store.requireLease(this.clock());
      const journal = await this.store.robbery.get();
      if (journal.pending) { this.blocked = true; throw new Error('هناك تحويل نهب قيد الاستكمال. ستتم استعادتها تلقائيًا.'); }
      const bank = readBankSettings((await this.store.settings())?.bank), retired = [];
      for (let round of await this.store.robbery.managedOpen()) {
        if (!round.delivery) round = await this.store.robbery.queueLegacyDisplay(round, this.clock());
        const next = await this.#retireRobbery(round, bank, this.clock());
        if (next.status !== 'open') retired.push(next);
      }
      return retired;
    });
  }
  bindRobberyMessage(id, messageId, author) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      if (![id, messageId].every(isId)) throw new Error('معرف رسالة النهب غير صالح.');
      await this.store.robbery.bindMessage(id, messageId, author, this.clock());
    });
  }
  confirmRobberyDisplay(round, messageId) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      if (![round.id, messageId].every(isId)) throw new Error('معرف رسالة النهب غير صالح.');
      await this.store.robbery.displayComplete(round, messageId, this.clock());
    });
  }
  missingRobberyMessage(id) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      const round = await this.store.robbery.round(id);
      if (round?.status === 'open') return this.store.robbery.close(round, 'cancelled', this.clock(), 'delivery');
      return round;
    });
  }
  registerRobberyAttempt(input, isEligible = () => true) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      if (![input.id, input.userId, input.channelId].every(isId)) throw new Error('معرف طلب النهب غير صالح.');
      await this.#bank(input.channelId, 'نهب');
      if (!await isEligible(input.userId)) throw new Error('النهب متاح لأعضاء سيرفر الكلان فقط.');
      await this.store.robbery.checkSpam(input.userId, input.id, this.clock());
    });
  }
  openRobbery(input, isEligible = () => true, choose) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      const now = this.clock();
      validateRobberyRequest(input, now);
      const bank = await this.#bank(input.channelId, 'نهب');
      if (!await isEligible(input.userId) || !await isEligible(input.targetId)) throw new Error('النهب متاح بين أعضاء سيرفر الكلان فقط.');
      await this.store.requireLease(now);
      const journal = await this.store.robbery.get();
      if (journal.pending) { this.blocked = true; throw new Error('هناك تحويل نهب قيد الاستكمال. ستتم استعادتها تلقائيًا.'); }
      const previous = await this.store.robbery.round(input.id);
      if (previous) {
        if (previous.userId !== input.userId || previous.targetId !== input.targetId || previous.channelId !== input.channelId) throw new Error('هذا التحدي يخص طلبًا آخر.');
        const saved = await this.#retireRobbery(previous, bank, now);
        if (saved.status === 'open') await this.#requireRobberyTargetAvailable(saved.targetId, now);
        return saved;
      }
      const initiatorBalance = await this.store.totals(input.userId, 'all', now);
      if (!Number.isSafeInteger(initiatorBalance.total) || initiatorBalance.total <= 0) throw new Error('لا تقدر تبدأ نهب ورصيدك صفر أو بالسالب؛ تحتاج رصيدًا أكبر من صفر.');
      if (input.at <= Math.max(this.bankCutoff(input.userId), this.bankCutoff(input.targetId))) throw new Error('هذا الأمر أقدم من آخر ريست. اكتب !نهب @عضو من جديد.');
      const activeRounds = [];
      for (const saved of await this.store.robbery.blockingRounds(input.userId, input.targetId)) {
        const active = await this.#retireRobbery(saved, bank, this.clock());
        if (active.status === 'open') activeRounds.push(active);
      }
      await this.#requireRobberyTargetAvailable(input.targetId, this.clock());
      for (const active of activeRounds) {
        if (active.userId === input.userId) throw new Error(`عندك تحدي نهب مفتوح في <#${active.channelId}>. أكمله قبل تبدأ نهب جديد.`);
        throw new Error(`العضو <@${input.targetId}> عنده تحدي نهب قائم بالفعل. انتظر انتهاءه قبل تتحداه؛ موعد نهايته <t:${Math.ceil(active.expiresAt / 1000)}:R>.`);
      }
      const latest = await this.store.robbery.latestRound(input.userId);
      if (latest) {
        const nextAt = latest.createdAt + ROBBERY_COMMAND_COOLDOWN_MS;
        if (nextAt > now) {
          const seconds = Math.ceil((nextAt - now) / 1000);
          throw new Error(`لازم تنتظر ${seconds} ثانية كاملة قبل تبدأ نهب جديد.`);
        }
      }
      const round = newRobberyRound(input, now, choose);
      round.bankVersion = bank.channelVersion;
      try { return await this.store.robbery.create(round, this.clock()); }
      catch (cause) {
        if (cause.code === 11000) throw new Error('العضو عنده تحدي نهب قائم بالفعل. انتظر انتهاءه قبل تتحداه.', { cause });
        this.blocked = true;
        throw new Error('لم يتأكد حفظ التحدي. أُوقف الاحتساب مؤقتًا؛ انتظر الاستعادة التلقائية قبل إنشاء تحدٍّ آخر.', { cause });
      }
    });
  }
  settleRobbery(input, isEligible = () => true) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      const now = this.clock();
      if (![input.id, input.userId, input.resolutionId, input.channelId].every(isId)
        || !(ROBBERY_MOVES.some(move => move.id === input.move) || (MINE_CELLS.includes(input.cell)
          && Number.isInteger(input.revision) && input.revision >= 0 && input.revision <= 5))) throw new Error('اختيار النهب غير صالح.');
      const bank = await this.#bank(input.channelId, 'نهب');
      await this.store.requireLease(now);
      const journal = await this.store.robbery.get();
      if (journal.pending) { this.blocked = true; throw new Error('هناك تحويل نهب قيد الاستكمال. ستتم استعادتها تلقائيًا.'); }
      let round = await this.store.robbery.round(input.id);
      if (!round || round.userId !== input.userId || round.channelId !== input.channelId) throw new Error('هذا التحدي لا يخصك أو ليس في هذا الروم.');
      if ((round.game === 'mine') !== (input.cell !== undefined)) throw new Error('هذا الزر لا يطابق لعبة هذا التحدي.');
      const saved = await this.#retireRobbery(round, bank, now);
      if (saved.status !== 'open') return { ...saved, duplicate: round.status === 'settled' };
      await this.#requireRobberyMembers(round, isEligible);
      await this.#requireRobberyTargetAvailable(round.targetId, now);
      if (round.game === 'mine') {
        const advanced = advanceMine(round, input);
        if (advanced.duplicate || advanced.stale) return advanced;
        if (!advanced.mine.loser) return this.store.robbery.advanceMine(round, advanced, this.clock());
        round = advanced;
      }
      return this.#finishRobbery(round, input.move, input.resolutionId, now, isEligible);
    });
  }
  async #finishRobbery(round, playerMove, resolutionId, now, isEligible = () => true) {
    const userDay = await this.#day(round.userId, now); const targetDay = await this.#day(round.targetId, now);
    const [user, target] = await Promise.all([round.userId, round.targetId].map(id => this.store.totals(id, 'all', now)));
    const result = resolveRobbery(round, playerMove, { user, target });
    const settled = { ...round, status: 'settled', delivery: { ...round.delivery, complete: false, nextAttemptAt: 0 },
      ...(round.game === 'mine' || round.endReason === 'timeout' ? {} : { playerMove }), result,
      resolutionId, settledAt: now, protection: robberyProtection(round, result, now) };
    if (result.amount) {
      const from = result.fromId === round.userId ? userDay : targetDay;
      const to = result.toId === round.userId ? userDay : targetDay;
      settled.fromDayId = from._id; settled.toDayId = to._id;
      // Fail validation before saving an intent that recovery could not apply.
      applyRobberyTransfer(structuredClone(from), settled);
      applyRobberyTransfer(structuredClone(to), settled);
    }
    await this.#requireRobberyMembers(round, isEligible);
    try {
      await this.store.robbery.reserve(settled, this.clock());
      return { ...await this.store.robbery.recover(this.clock()), duplicate: false };
    } catch (cause) {
      this.blocked = true;
      throw new Error(`لم يتأكد اكتمال تحويل النهب ${round.id}. أُوقف الاحتساب مؤقتًا؛ ستُستكمل النتيجة المحفوظة تلقائيًا دون تكرار التحويل.`, { cause });
    }
  }
  shopView(userId) {
    return this.gate.run(async () => {
      this.assertActive();
      const shop = await this.store.shop.get();
      const balance = await this.store.totals(userId, 'all', this.clock());
      return { shop, balance };
    });
  }
  manageShop(mutation) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      await this.store.requireLease(this.clock());
      return mutation(this.store.shop, this.clock());
    });
  }
  purchase(input, isEligible = () => true) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      if (!isEligible()) throw new Error('لم تعد عضويتك مؤهلة للشراء. تحقق من رتبتك وعضويتك في الكلان.');
      const now = this.clock();
      await this.store.requireLease(now);
      const previous = await this.store.shop.order(input.checkoutId);
      if (previous) {
        if (previous.userId !== input.userId) throw new Error('طلب الشراء يخص عضوًا آخر.');
        return { ...previous, duplicate: true };
      }
      const request = validatePurchase(input, now, this.bankCutoff(input.userId));
      const shop = await this.store.shop.get();
      if (shop.pending) { this.blocked = true; throw new Error('هناك طلب شراء غير مكتمل. سيُستكمل تلقائيًا.'); }
      if (!shop.destination) throw new Error('المتجر غير جاهز للشراء. على الإدارة تحديد روم التنبيهات ورتبتها باستخدام /اعدادات_المتجر.');
      const product = shop.products.find(p => p.id === request.productId);
      if (!product || product.stock < 1) throw new Error('نفدت كمية هذا المنتج أو أزيل من المتجر. افتح القائمة المحدثة.');
      const balance = await this.store.totals(request.userId, 'all', now);
      const debit = purchaseDebit(balance, product.price);
      const state = await this.#day(request.userId, request.at);
      if (!isEligible()) throw new Error('لم تعد عضويتك مؤهلة للشراء. تحقق من رتبتك وعضويتك في الكلان.');
      const order = { id: request.checkoutId, userId: request.userId, at: request.at, dayId: state._id,
        product: { id: product.id, name: product.name, description: product.description, price: product.price },
        quantity: 1, debit, balanceBefore: balance.total, balanceAfter: balance.total - product.price };
      try {
        // Persist the stock reservation and pending intent in one write, then
        // finish the debit/order before allowing any credit, debit or reset.
        await this.store.shop.reserve(shop, order, this.clock());
        return { ...await this.store.shop.recover(this.clock()), duplicate: false };
      } catch (cause) {
        this.blocked = true;
        throw new Error(`لم يتأكد اكتمال الطلب ${order.id}. أُوقف الاحتساب مؤقتًا؛ سيُستكمل الطلب المحفوظ تلقائيًا. لا تنشئ طلبًا جديدًا قبل مراجعة الرصيد والتنبيه.`, { cause });
      }
    });
  }
  auctionRead(id) {
    return this.gate.run(() => { this.assertActive(); return this.store.auctions.get(id); });
  }
  auctionChange(id, mutation) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      const current = await this.store.auctions.get(id);
      if (!current) throw new Error('لم أجد هذا المزاد.');
      const next = structuredClone(current);
      if (!mutation(next, this.clock())) return current;
      return this.store.auctions.save(current, next, this.clock());
    });
  }
  auctionDelivery(id, patch) {
    return this.gate.exclusive(() => {
      this.assertActive();
      return this.store.auctions.delivery(id, patch, this.clock());
    });
  }
  createAuction(input) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      const previous = await this.store.auctions.get(input.id);
      if (previous) return previous;
      return this.store.auctions.create(newAuction(input, this.clock()), this.clock());
    });
  }
  async #auctionCommit(current, next, id, legs, audit) {
    // Validate every leg before persisting an intent that recovery must finish.
    for (const leg of legs) applyAuctionLeg(structuredClone(await this.store.getDay(leg.dayId)), leg);
    try {
      await this.store.auctions.reserve({ id, previousRevision: current.revision, next, legs, audit }, this.clock());
      return await this.store.auctions.recover(this.clock());
    } catch (cause) {
      this.blocked = true;
      throw new Error('لم يتأكد اكتمال عملية المزاد. أوقفنا عمليات الرصيد مؤقتًا؛ سيُستكمل الحجز أو الاسترجاع المحفوظ تلقائيًا بدون تكرار الخصم.', { cause });
    }
  }
  bidAuction(input, isEligible = () => true) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      if (![input.auctionId, input.userId, input.operationId].every(isId)) throw new Error('معرف المزايدة غير صالح.');
      if (!isEligible()) throw new Error('المزايدة متاحة لأعضاء الكلان المؤهلين فقط.');
      const now = this.clock();
      await this.store.requireLease(now);
      const previous = await this.store.auctions.event(input.operationId);
      if (previous) {
        if (previous.type !== 'bid' || previous.userId !== input.userId || previous.auctionId !== input.auctionId) throw new Error('هذا الطلب يخص مزايدة أخرى.');
        return { ...previous, duplicate: true };
      }
      if (!Number.isSafeInteger(input.at) || input.at <= this.bankCutoff(input.userId) || input.at > now + 5000 || now - input.at > 900000) throw new Error('انتهت صلاحية طلب المزايدة. استخدم رسالة المزاد الحالية.');
      const current = await this.store.auctions.get(input.auctionId);
      if (!current || current.channelId !== input.channelId || current.delivery.live.messageId !== input.messageId) throw new Error('استخدم أزرار رسالة المزاد الأصلية في رومها.');
      const amount = bidAmount(current, input, now);
      const ownHold = current.highestBidderId === input.userId ? current.hold : null;
      const extra = amount - (ownHold ? current.amount : 0);
      const balance = await this.store.totals(input.userId, 'all', now);
      if (balance.total < extra) throw new Error(`رصيدك المتاح ${balance.total.toLocaleString('en-US')}؛ المطلوب حجزه الآن ${extra.toLocaleString('en-US')}. لم تُقبل المزايدة.`);
      const debit = purchaseDebit(balance, extra);
      const state = await this.#day(input.userId, now);
      const legs = [{ id: `${input.operationId}:hold`, userId: input.userId, dayId: state._id,
        amounts: { tasks: -debit.tasks, attendance: -debit.attendance } }];
      if (current.hold && !ownHold) {
        const refundDay = await this.#day(current.highestBidderId, now);
        legs.push({ id: `${input.operationId}:refund`, userId: current.highestBidderId, dayId: refundDay._id,
          amounts: { ...current.hold } });
      }
      if (!isEligible()) throw new Error('لم تعد عضويتك مؤهلة للمزايدة.');
      // The deadline is checked again at the commit boundary, not at modal-open time.
      const acceptedAt = this.clock();
      bidAmount(current, input, acceptedAt);
      const extended = current.endsAt - acceptedAt <= AUCTION_LATE_MS;
      const next = { ...current, highestBidderId: input.userId, amount, bidCount: current.bidCount + 1,
        hold: { tasks: debit.tasks + (ownHold?.tasks || 0), attendance: debit.attendance + (ownHold?.attendance || 0) },
        endsAt: current.endsAt + (extended ? AUCTION_EXTENSION_MS : 0), extensions: current.extensions + (extended ? 1 : 0) };
      return this.#auctionCommit(current, next, input.operationId, legs, { type: 'bid', userId: input.userId,
        amount, increment: amount - current.amount, chargedNow: extra, balanceAfter: balance.total - extra,
        refundedUserId: current.hold && !ownHold ? current.highestBidderId : null,
        refundedAmount: current.hold && !ownHold ? current.amount : 0, at: acceptedAt, extended, endsAt: next.endsAt });
    });
  }
  settleAuction(id, cancellation = null) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      const current = await this.store.auctions.get(id);
      if (!current) throw new Error('لم أجد هذا المزاد.');
      if (auctionTerminal(current)) return current;
      const now = this.clock();
      await this.store.requireLease(now);
      if (!cancellation && (current.status !== 'active' || now < current.endsAt)) return current;
      if (cancellation && current.status === 'active' && now >= current.endsAt) throw new Error('انتهى وقت المزاد؛ تُثبت نتيجته ولا يمكن إلغاؤه بعد النهاية.');
      if (cancellation && (!isId(cancellation.actorId) || !isId(cancellation.operationId))) throw new Error('معرف إلغاء المزاد غير صالح.');
      const operationId = cancellation?.operationId || `end:${id}`;
      const legs = [];
      if (cancellation && current.hold) {
        const day = await this.#day(current.highestBidderId, now);
        legs.push({ id: `${operationId}:refund`, userId: current.highestBidderId, dayId: day._id,
          amounts: { ...current.hold } });
      }
      const settlement = { at: now, winnerId: cancellation ? null : current.highestBidderId,
        amount: !cancellation && current.highestBidderId ? current.amount : 0,
        refundedAmount: cancellation && current.hold ? current.amount : 0,
        quantity: current.quantity, actorId: cancellation?.actorId || null, reason: String(cancellation?.reason || '').slice(0, 200) };
      const next = { ...current, status: cancellation ? 'cancelled' : 'ended', endedAt: now, hold: null, settlement };
      // Settlement consumes the existing hold; there is deliberately no second debit.
      await this.#auctionCommit(current, next, operationId, legs, { type: next.status, ...settlement });
      return this.store.auctions.get(id);
    });
  }
  configureSpam(input) {
    return this.gate.exclusive(() => {
      this.assertActive();
      return this.store.setSpamSettings(input, this.clock());
    });
  }
  penalizeSpam(input) {
    return this.adjustPoints({ ...input, mode: 'remove', category: 'total', amount: input.amount ?? DEFAULT_SPAM_SETTINGS.amount }, true);
  }
  adjustPoints(input, spamPenalty = false) {
    // The balance check and commit run between activity batches, including resets.
    // Concurrent debits therefore cannot spend the same member balance twice.
    return this.gate.exclusive(async () => {
      this.assertActive();
      const now = this.clock();
      const request = validatePointAdjustment(input, now);
      if (request.at <= this.bankCutoff(request.userId)) throw new Error('هذا الطلب أقدم من آخر ريست. اكتب أمر تعديل النقاط من جديد.');
      await this.store.requireLease(now);
      // Use the immutable interaction date so retries around Saudi midnight
      // still address the exact same day and operation record.
      const day = dayKey(request.at);
      const id = `${this.config.clanGuildId}:${day}:${request.userId}`;
      const previous = (await this.store.getDay(id))?.adjustmentLog?.find(item => item.operationId === request.operationId);
      if (previous) return { ...previous, day, duplicate: true };
      if (!spamPenalty && now - request.at > 900000) throw new Error('انتهت صلاحية طلب تعديل النقاط. اكتب الأمر من جديد.');
      const totals = await this.store.totals(request.userId, 'all', now);
      const before = totals[request.category] || 0;
      const requestedAmount = request.amount;
      if (spamPenalty) {
        // Charge only spendable funds. Keep a receipt even at zero so retries
        // cannot collect an old penalty from a later salary or quest reward.
        request.amount = Math.min(requestedAmount, Math.max(0, before));
        request.delta = request.amount ? -request.amount : 0;
      }
      const after = before + request.delta;
      const totalAfter = (totals.total || 0) + request.delta;
      if (after < 0 || totalAfter < 0) throw new Error(`الرصيد المتاح من هذا النوع ${before.toLocaleString('en-US')} نقطة فقط؛ لم يتم الخصم.`);
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(totalAfter)) throw new Error('نتيجة التعديل تتجاوز الحد الرقمي المسموح.');
      const entry = { ...request, before, after, totalAfter, ...(spamPenalty ? { spamPenalty: true, requestedAmount } : {}) };
      if (request.category === 'total') {
        const debit = request.mode === 'remove' ? purchaseDebit(totals, request.amount) : null;
        entry.amounts = debit ? { tasks: -debit.tasks, attendance: -debit.attendance }
          : { tasks: request.amount, attendance: 0 };
      }
      await this.#day(request.userId, request.at);
      let saved;
      try { saved = await this.store.mutateDay(id, draft => applyPointAdjustment(draft, entry)); }
      catch (error) {
        // A lost acknowledgement can follow a successful atomic write. Inspect
        // the operation record before reporting an uncertain outcome; never re-credit.
        const verified = await this.store.getDay(id).catch(() => null);
        if (!verified?.adjustmentLog?.some(item => item.operationId === request.operationId)) throw error;
        saved = verified;
      }
      return { ...saved.adjustmentLog.find(item => item.operationId === request.operationId), day, duplicate: false };
    });
  }
  reset(request) {
    return this.gate.exclusive(async () => {
      this.assertActive();
      const target = resetTarget(request.target);
      if (target !== 'activity' && (await this.shipGame.holds(request.userId ?? null)).length) throw new Error('انتظر انتهاء لعبة سفينة قبل عمل ريست للمبالغ المحجوزة.');
      if (target !== 'activity' && (await this.boxesGame.holds(request.userId ?? null)).length) throw new Error('انتظر انتهاء لعبة مربعات قبل عمل ريست للمبالغ المحجوزة.');
      if (target !== 'activity' && (await this.dotGame.holds(request.userId ?? null)).length) throw new Error('انتظر انتهاء لعبة دوت قبل عمل ريست للمبالغ المحجوزة.');
      if (target !== 'activity' && (await this.numbersGame.holds(request.userId ?? null)).length) throw new Error('انتظر انتهاء لعبة ارقام قبل عمل ريست للمبالغ المحجوزة.');
      if (target !== 'activity' && (await this.minesGame.holds(request.userId ?? null)).length) throw new Error('انتظر انتهاء لعبة الغام قبل عمل ريست للمبالغ المحجوزة.');
      if (target !== 'activity' && (await this.buttonGame.holds(request.userId ?? null)).length) throw new Error('انتظر انتهاء لعبة زر قبل عمل ريست للمبالغ المحجوزة.');
      if (target !== 'activity' && (await this.xo.holds(request.userId ?? null)).length) throw new Error('انتظر انتهاء لعبة اكس قبل عمل ريست للمبالغ المحجوزة.');
      if (target !== 'activity' && this.store.auctions && (await this.store.auctions.holds(request.userId ?? null)).length) {
        throw new Error('لا يمكن عمل ريست لرصيد عليه حجز مزاد. انتظر نهاية المزاد أو استخدم /الغاء_مزاد لإرجاع الحجز أولًا.');
      }
      try { return await this.store.resetProgress(request, this.clock()); }
      catch (cause) {
        // An uncertain database write must never be followed by new credits.
        // Journal recovery resumes the persisted reset before allowing any activity.
        this.blocked = true;
        throw new Error('لم يتأكد اكتمال الريست. أُوقف الاحتساب مؤقتًا؛ ستُستكمل العملية المحفوظة تلقائيًا.', { cause });
      }
    });
  }
}
