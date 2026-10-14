import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { themedEmbed } from './appearance.js';
import { number } from './presentation.js';
export const BANK_OPEN = 'clan-bank:open';
export const buildBankTopCommand = () => new SlashCommandBuilder().setName('توب_البنك').setDescription('جميع المشاركين في البنك مع السابق والتالي والتحديث');
export function parseBankAction(id) {
  if (id === BANK_OPEN) return { page: 1, update: false };
  const match = /^clan-bank:v1:(\d{17,20}):([1-9]\d{0,8}):(previous|next|refresh)$/.exec(id || '');
  return match ? { ownerId: match[1], page: Number(match[2]), update: true } : null;
}
export function bankPagePayload(view, ownerId, appearance) {
  const embed = themedEmbed('توب البنك', appearance, `صفحة ${view.page} / ${view.pages} • ${number(view.count)} مشارك`)
    .setColor(0xffffff).setTimestamp(view.at)
    .setDescription(view.rows.length ? view.rows.map((row, i) =>
      `\u200f\`#${view.offset + i + 1}\` <@${row._id}> — **${number(row.total)} $**`).join('\n') : 'لا يوجد مشاركون مسجلون في البنك حتى الآن.')
    .addFields({ name: 'ترتيبك ورصيدك', value: `${view.self.position ? `#${number(view.self.position)}` : 'غير مصنف'} • **${number(view.self.value)} $**` });
  const button = (page, action, label, disabled = false) => new ButtonBuilder()
    .setCustomId(`clan-bank:v1:${ownerId}:${page}:${action}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  return { content: '', embeds: [embed], allowedMentions: { parse: [] }, components: [new ActionRowBuilder().addComponents(
    button(Math.max(1, view.page - 1), 'previous', 'السابق', view.page === 1),
    button(view.page, 'refresh', 'تحديث'),
    button(Math.min(view.pages, view.page + 1), 'next', 'التالي', view.page === view.pages)
  )] };
}
export function createBankLeaderboardHandler({ config, service, store, bankViews, onError = () => {} }) {
  return async interaction => {
    const action = interaction.isButton?.() ? parseBankAction(interaction.customId) : null;
    if (!action && interaction.commandName !== 'توب_البنك') return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (interaction.guildId !== config.clanGuildId || interaction.user.bot) { await deny('توب البنك متاح داخل سيرفر الكلان فقط.'); return true; }
    if (action?.ownerId && action.ownerId !== interaction.user.id) { await deny('هذه صفحة عضو آخر. افتح توب البنك من الزر العام.'); return true; }
    if (action?.update) await interaction.deferUpdate(); else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (bankViews) { await bankViews.show(interaction, action?.page || 1); return true; }
      const [view, settings] = await Promise.all([service.bankLeaderboard(interaction.user.id, action?.page || 1), store.settings()]);
      await interaction.editReply(bankPagePayload(view, interaction.user.id, settings?.appearance));
    } catch (error) {
      onError(error); await interaction.editReply({ content: 'تعذر تحديث توب البنك. حاول مرة ثانية.', embeds: [], components: [], allowedMentions: { parse: [] } });
    }
    return true;
  };
}
