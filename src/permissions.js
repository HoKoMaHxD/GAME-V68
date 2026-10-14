import { PermissionFlagsBits } from 'discord.js';
import { isId } from './config.js';

export const MANAGEMENT_DENIED = 'تحتاج رتبة إدارة البوت المحددة أو صلاحية إدارة السيرفر لاستخدام هذا الأمر.';

function inClan(subject, config) {
  return subject.guildId === config.clanGuildId
    && (!subject.member?.guild?.id || subject.member.guild.id === config.clanGuildId);
}
function owner(subject) {
  const id = subject.user?.id || subject.author?.id;
  return !!id && subject.guild?.ownerId === id;
}
function hasPermission(subject, permission) {
  return (subject.memberPermissions || subject.member?.permissions)?.has?.(permission) === true;
}

export function canConfigurePermissions(subject, config) {
  return inClan(subject, config) && (owner(subject) || hasPermission(subject, PermissionFlagsBits.Administrator));
}

export function canManageBot(subject, config, roleId = null) {
  if (!inClan(subject, config)) return false;
  if (owner(subject) || hasPermission(subject, PermissionFlagsBits.Administrator)
    || hasPermission(subject, PermissionFlagsBits.ManageGuild)) return true;
  if (!isId(roleId) || roleId === config.clanGuildId) return false;
  // discord.js patches interaction.member from this interaction's Discord
  // payload. Support both GuildMember and raw API member role representations.
  const roles = subject.member?.roles;
  return Array.isArray(roles) ? roles.includes(roleId) : roles?.cache?.has(roleId) === true;
}

export function validatePermissionChange(input, clanId) {
  if (input.roleId !== null && (!isId(input.roleId) || input.roleId === clanId)) throw new Error('اختر رتبة مخصصة من سيرفر الكلان؛ لا يمكن اختيار @everyone.');
  if (!isId(input.actorId) || !isId(input.operationId)) throw new Error('معرف المسؤول أو أمر الصلاحية غير صالح.');
  return { roleId: input.roleId, actorId: input.actorId, operationId: input.operationId };
}

export class BotPermissions {
  constructor({ store, config, clock = Date.now }) {
    Object.assign(this, { store, config, clock });
    this.roleId = null;
    this.tail = Promise.resolve();
  }
  load(settings) {
    const id = settings?.botPermissions?.roleId;
    this.roleId = isId(id) && id !== this.config.clanGuildId ? id : null;
  }
  read() {
    const result = this.tail.then(async () => {
      const settings = await this.store.settings();
      this.load(settings);
      return settings;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  change(input) {
    // Keep the saved role and live authorization in the same update order.
    const result = this.tail.then(async () => {
      const request = validatePermissionChange(input, this.config.clanGuildId);
      try {
        const settings = await this.store.setBotPermissions(request, this.clock());
        this.load(settings);
        return settings.botPermissions;
      } catch (cause) {
        // A lost acknowledgement must never leave a revoked role active, or
        // grant a proposed role without a confirmed saved configuration.
        this.roleId = null;
        let settings;
        try { settings = await this.store.settings(); this.load(settings); } catch { /* Native administrators retain recovery access. */ }
        if (settings?.botPermissions?.operationId === request.operationId) return settings.botPermissions;
        throw new Error('لم يتأكد حفظ الصلاحية. اعرض /صلاحية للتحقق، وأعد تشغيل الخدمة إذا تعذر اتصال قاعدة البيانات.', { cause });
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
