import { randomInt } from 'node:crypto';
import { readProtectionSettings, validateProtectionChange } from './protection.js';
import { isId } from './config.js';
import { usePrizeBonus } from './prizes.js';

export const SALARY_INTERVAL_MS = 3600000;
export const MAX_SALARY = 1000000;
export const BANK_TOP_SIZE = 10;
export const MEMBER_JOB = 'عضو الكلان';
export const BOOSTER_JOB = 'مدير كبير';
export const SHEIKH_JOB = 'شيخ الكلان';
export const SHEIKH_ROLE_ID = '1555677016295219241';
export const SHEIKH_SALARY_MIN = 3000;
export const SHEIKH_SALARY_MAX = 5000;
export const BOOSTER_SALARY_MIN = 2000;
export const BOOSTER_SALARY_MAX = 3500;

export function salaryForMember(bank, boosting, choose = randomInt) {
  if (boosting?.sheikh === true) {
    const baseAmount = choose(SHEIKH_SALARY_MIN, SHEIKH_SALARY_MAX + 1);
    if (!Number.isSafeInteger(baseAmount) || baseAmount < SHEIKH_SALARY_MIN || baseAmount > SHEIKH_SALARY_MAX) throw new Error("تعذر تحديد راتب شيخ الكلان.");
    return { job: SHEIKH_JOB, boosting: boosting.boosting === true, baseAmount };
  }
  if (boosting && typeof boosting === "object") boosting = boosting.boosting;
  if (boosting !== true) return { job: MEMBER_JOB, boosting: false, baseAmount: bank.salaryAmount };
  const amount = choose(BOOSTER_SALARY_MIN, BOOSTER_SALARY_MAX + 1);
  if (!Number.isSafeInteger(amount) || amount < BOOSTER_SALARY_MIN || amount > BOOSTER_SALARY_MAX) {
    throw new Error('تعذر تحديد راتب وظيفة مدير كبير. حاول مجددًا.');
  }
  return { job: BOOSTER_JOB, boosting: true, baseAmount: amount };
}

export async function hasClanBoost(guild, clanId, userId, includeJob = false) {
  if (!isId(userId) || guild?.id !== clanId || !guild.members?.fetch) {
    throw new Error('تعذر التحقق من بوست العضو في سيرفر الكلان. حاول مجددًا.');
  }
  let member;
  try { member = await guild.members.fetch({ user: userId, force: true }); }
  catch (cause) {
    if ([10007, 10013].includes(Number(cause.code))) throw new Error('لم تعد عضوًا في سيرفر الكلان.');
    throw new Error('تعذر التحقق من بوست العضو في سيرفر الكلان. حاول مجددًا.', { cause });
  }
  if (member?.id !== userId || member.guild?.id !== clanId || member.user?.bot !== false) {
    throw new Error('تعذر التحقق من عضويتك في سيرفر الكلان.');
  }
  // Read Discord's actual boost state in this guild, never a role name, Nitro
  // subscription, another guild or a potentially stale interaction snapshot.
  const boosting = Number.isFinite(member.premiumSinceTimestamp) && member.premiumSinceTimestamp > 0;
  return includeJob ? { boosting, sheikh: member.roles?.cache?.has(SHEIKH_ROLE_ID) === true } : boosting;
}

export function readBankSettings(saved = {}) {
  return { ...readProtectionSettings(saved), channelId: isId(saved?.channelId) ? saved.channelId : null,
    salaryAmount: Number.isSafeInteger(saved?.salaryAmount) && saved.salaryAmount >= 0 && saved.salaryAmount <= MAX_SALARY ? saved.salaryAmount : 0,
    // Missing switches preserve the behavior of existing bank configurations.
    salaryEnabled: saved?.salaryEnabled === undefined || saved.salaryEnabled === true,
    robberyEnabled: saved?.robberyEnabled === undefined || saved.robberyEnabled === true,
    channelVersion: Number.isSafeInteger(saved?.channelVersion) ? saved.channelVersion : 0 };
}
export function bankCommandStatus(saved) {
  const bank = readBankSettings(saved);
  return { salary: !!bank.channelId && bank.salaryEnabled && bank.salaryAmount > 0,
    robbery: !!bank.channelId && bank.robberyEnabled };
}
export const commandStatusLabel = enabled => enabled ? '🟢 شغال' : '🔴 طافي';
export function requireBankCommand(saved, command) {
  const bank = readBankSettings(saved);
  if (command === 'راتب') {
    if (!bank.salaryEnabled) throw new Error('أمر راتب طافي حاليًا بقرار الإدارة.');
    if (!bank.salaryAmount) throw new Error('لم تحدد الإدارة مبلغ الراتب بعد، أو أوقفت صرفه. يمكن تحديده من /اعدادات_البنك.');
  } else if (command === 'نهب') {
    if (!bank.robberyEnabled) throw new Error('أمر نهب طافي حاليًا بقرار الإدارة.');
  } else throw new Error('أمر البنك غير صالح.');
}
export function requireBankChannel(saved, channelId) {
  const bank = readBankSettings(saved);
  if (!bank.channelId) throw new Error('لم تحدد الإدارة شات البنك بعد. استخدم /اعدادات_البنك لتحديد الروم ومبلغ الراتب.');
  if (channelId !== bank.channelId) throw new Error(`الأوامر: اوامر، توب، نهب، حماية، راتب، جائزة، رصيدي، وقت، الوان، نرد متاحة في <#${bank.channelId}> فقط.`);
  return bank;
}
export function validateBankChange(input) {
  if (!isId(input.actorId) || !isId(input.operationId)) throw new Error('معرف إعداد البنك غير صالح.');
  const fields = validateProtectionChange(input);
  if (Object.hasOwn(input, 'channelId')) {
    if (!isId(input.channelId)) throw new Error('اختر شات البنك من سيرفر الكلان.');
    fields.channelId = input.channelId;
  }
  if (Object.hasOwn(input, 'salaryAmount')) {
    if (!Number.isSafeInteger(input.salaryAmount) || input.salaryAmount < 0 || input.salaryAmount > MAX_SALARY) {
      throw new Error('الراتب يجب أن يكون عددًا صحيحًا من 0 إلى 1,000,000؛ الصفر يوقف صرفه.');
    }
    fields.salaryAmount = input.salaryAmount;
  }
  for (const key of ['salaryEnabled', 'robberyEnabled']) if (Object.hasOwn(input, key)) {
    if (typeof input[key] !== 'boolean') throw new Error('اختر تشغيل الأمر أو إيقافه بقيمة صحيحة.');
    fields[key] = input[key];
  }
  if (!Object.keys(fields).length) throw new Error('حدد الروم أو مبلغ الراتب أو حالة راتب ونهب لتعديل الإعداد.');
  return fields;
}
export function applySalary(state, receipt) {
  if (state.userId !== receipt.userId || state._id !== receipt.dayId) throw new Error('سجل الراتب لا يطابق العضو.');
  if (state.salaryReceipts?.some(item => item.id === receipt.id)) return false;
  const next = (state.salaryCredits || 0) + receipt.amount;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error('الرصيد يتجاوز الحد الرقمي المسموح.');
  if (receipt.bonusId) usePrizeBonus(state, receipt.bonusId, 'salary', receipt.claimedAt);
  state.salaryCredits = next;
  state.salaryLastAt = receipt.claimedAt;
  (state.salaryReceipts ||= []).push(structuredClone(receipt));
  return true;
}
export function gapToNextRank(target, self, userId) {
  if (!target) return 0; // Already first.
  // An older ID can take the target's place at an equal balance. A newer ID
  // needs one more unit, matching the bank leaderboard's stable tie order.
  return Math.max(0, target.total - self.value + (target._id && userId > target._id ? 1 : 0));
}

// Guild membership is independent of the Arena quest-role requirement.
export async function bankMember(interaction, config, userId) {
  if (interaction.guildId !== config.clanGuildId || !isId(userId)) return false;
  if (userId === interaction.user.id) return !interaction.user.bot;
  const guild = interaction.guild;
  if (guild?.id !== config.clanGuildId || !guild.members?.fetch) return false;
  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    return member?.id === userId && member.guild?.id === config.clanGuildId && member.user?.bot === false;
  } catch (error) {
    if (Number(error.code) === 10007 || Number(error.code) === 10013) return false;
    throw new Error('تعذر التحقق من عضوية الطرف الآخر في السيرفر. حاول مجددًا.', { cause: error });
  }
}
