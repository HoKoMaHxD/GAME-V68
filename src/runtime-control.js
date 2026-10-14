import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';
import { isId } from './config.js';

// Bound driver I/O itself; do not abandon a write via Promise.race.
export const CONTROL_DB_OPTIONS = Object.freeze({ timeoutMS: 5000, maxTimeMS: 4000 });

export const PAUSED_MESSAGE = 'البوت متوقف بالكامل بقرار الإدارة. لإعادة تشغيله استخدم /البنك الحالة: تشغيل.';
export function buildRuntimeCommand() {
  return new SlashCommandBuilder().setName('البنك').setDescription('تشغيل البوت بالكامل أو إيقاف جميع وظائفه واحتسابه')
    .setDefaultMemberPermissions(null)
    .addStringOption(o => o.setName('الحالة').setDescription('اختر تشغيل البوت بالكامل أو إيقافه').setRequired(true)
      .addChoices({ name: 'تشغيل', value: 'on' }, { name: 'إيقاف', value: 'off' }));
}
export class RuntimeControl {
  constructor({ store, service, clock = Date.now, onChanged = async () => {}, onResumed = async () => {}, onError = () => {} }) {
    Object.assign(this, { store, service, clock, onChanged, onResumed, onError }); this.tail = Promise.resolve();
  }
  background(action) {
    try { void Promise.resolve(action()).catch(this.onError); }
    catch (error) { this.onError(error); }
  }
  load(settings) {
    this.service.paused = !!this.service.resetting || settings?.runtimeControl?.enabled === false;
    this.service.resumedAt = settings?.runtimeControl?.resumedAt || 0;
  }
  exclusive(action) {
    const operation = this.tail.then(action);
    this.tail = operation.catch(() => {}); return operation;
  }
  change({ enabled, actorId, operationId }) {
    const operation = this.exclusive(async () => {
      if (this.service.resetting) throw new Error('الريست الشامل جارٍ؛ سيعود البوت تلقائيًا بعد اكتماله.');
      if (typeof enabled !== 'boolean' || !isId(actorId) || !isId(operationId)) throw new Error('طلب تشغيل البوت غير صالح.');
      // Stop new work immediately. The control state has its own serial queue:
      // it must remain available even when an accounting task is waiting on I/O.
      this.service.paused = true;
      let state, changed = false;
      try {
        state = await (async () => {
          await this.store.requireLease(this.clock(), CONTROL_DB_OPTIONS);
          const previous = (await this.store.settings(CONTROL_DB_OPTIONS)).runtimeControl;
          if (previous?.operationId && BigInt(operationId) <= BigInt(previous.operationId)) {
            if (previous.operationId !== operationId) throw new Error('طلب قديم؛ استخدم أمر البنك مجددًا.');
            return previous;
          }
          changed = (previous?.enabled !== false) !== enabled;
          const now = this.clock();
          const next = { enabled, actorId, operationId, changedAt: now,
            resumedAt: enabled && previous?.enabled === false ? now : previous?.resumedAt || 0 };
          try {
            await this.store.db.collection('settings').updateOne({ _id: this.store.settingsId }, { $set: { runtimeControl: next } }, { upsert: true, ...CONTROL_DB_OPTIONS });
          } catch (error) {
            const saved = (await this.store.settings(CONTROL_DB_OPTIONS)).runtimeControl;
            if (saved?.operationId !== operationId) throw error;
            return saved;
          }
          return next;
        })();
      } catch (error) {
        try { this.load(await this.store.settings(CONTROL_DB_OPTIONS)); } catch { this.service.paused = true; }
        throw error;
      }
      this.service.resumedAt = state.resumedAt;
      // Hooks reset local boundaries synchronously, then may schedule I/O.
      // Never tie the slash reply or the next control command to that I/O.
      if (changed) this.background(() => this.onChanged(state.enabled));
      this.load({ runtimeControl: state });
      if (changed && state.enabled) this.background(() => this.onResumed());
      return state;
    });
    this.tail = operation.catch(() => {}); return operation;
  }
}
export function createRuntimeHandler({ config, access, runtimeControl }) {
  return async interaction => {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'البنك') return false;
    if (!canManageBot(interaction, config, access?.roleId)) {
      await interaction.reply({ content: MANAGEMENT_DENIED, flags: MessageFlags.Ephemeral }); return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const stateChoice = interaction.options.getString('الحالة', true);
      if (!['on', 'off'].includes(stateChoice)) throw new Error('اختر تشغيل أو إيقاف.');
      const enabled = stateChoice === 'on';
      const state = await runtimeControl.change({ enabled, actorId: interaction.user.id, operationId: interaction.id });
      await interaction.editReply({ content: state.enabled
        ? '✅ تم تشغيل البوت بالكامل. يستأنف الاحتساب من الآن دون احتساب فترة الإيقاف.'
        : '⛔ تم إيقاف البوت بالكامل: الاحتساب، الرواتب، الجوائز، الألعاب، النهب، المزادات، خصم السبام والتنبيهات. الحالة محفوظة بعد إعادة التشغيل. استخدم /البنك الحالة: تشغيل للاستئناف.' });
    } catch (error) {
      await interaction.editReply({ content: `❌ ${/[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تأكيد حالة البنك بسبب تأخر الاتصال. جرّب الأمر مجددًا؛ لن تُعرض رسالة نجاح قبل تأكيد الحفظ.'}` });
    }
    return true;
  };
}
