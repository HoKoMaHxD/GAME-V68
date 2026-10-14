import { EmbedBuilder } from 'discord.js';

export const DEFAULT_APPEARANCE = Object.freeze({
  name: 'SNOW', color: 0x8fd6ff, imageUrl: null, thumbnailUrl: null, revision: 0
});

function imageUrl(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 2000) throw new Error('رابط الصورة طويل أو غير صالح.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('استخدم رابط HTTPS مباشرًا للصورة.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('استخدم رابط HTTPS للصورة بدون بيانات تسجيل دخول.');
  // Discord refreshes unsigned attachment URLs when they are used in embed
  // image fields. Leave signatures on every other host untouched.
  if (url.hostname === 'cdn.discordapp.com' && !url.port && /^\/attachments\/\d+\/\d+\/[^/]+$/.test(url.pathname)) {
    url.search = ''; url.hash = '';
  }
  return url.href;
}

export function attachmentImageUrl(attachment) {
  if (!attachment || !/\.(png|jpe?g|gif|webp)$/i.test(attachment.name || '')
    || (attachment.contentType && !attachment.contentType.startsWith('image/'))) {
    throw new Error('ارفع صورة بصيغة PNG أو JPEG أو GIF أو WebP.');
  }
  return imageUrl(attachment.url);
}

export function validateAppearancePatch(input) {
  const fields = {};
  if (Object.hasOwn(input, 'name')) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 50
      || /[\r\n\u0000-\u001f]/.test(input.name)) throw new Error('اسم التصميم يجب أن يكون من 1 إلى 50 حرفًا في سطر واحد.');
    fields.name = input.name.trim();
  }
  if (Object.hasOwn(input, 'color')) {
    const color = String(input.color).trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(color)) throw new Error('اكتب اللون بصيغة HEX من 6 خانات، مثل #8FD6FF.');
    fields.color = Number.parseInt(color, 16);
  }
  for (const key of ['imageUrl', 'thumbnailUrl']) {
    if (Object.hasOwn(input, key)) fields[key] = imageUrl(input[key]);
  }
  return fields;
}

export function readAppearance(saved = {}) {
  const result = { ...DEFAULT_APPEARANCE };
  if (typeof saved?.name === 'string' && saved.name.trim() && saved.name.length <= 50) result.name = saved.name.trim();
  if (Number.isSafeInteger(saved?.color) && saved.color >= 0 && saved.color <= 0xffffff) result.color = saved.color;
  for (const key of ['imageUrl', 'thumbnailUrl']) {
    try { if (saved?.[key]) result[key] = imageUrl(saved[key]); } catch { /* Use a usable default for old malformed optional styling. */ }
  }
  if (Number.isSafeInteger(saved?.revision) && saved.revision >= 0) result.revision = saved.revision;
  return result;
}

export function themedEmbed(title, saved = {}, footer = 'المهام والعملة • توقيت السعودية') {
  const appearance = readAppearance(saved);
  const embed = new EmbedBuilder().setColor(appearance.color).setAuthor({ name: `${appearance.name}  •  CLAN HUB` })
    .setTitle(title).setFooter({ text: `${appearance.name} • ${footer}` });
  if (appearance.imageUrl) embed.setImage(appearance.imageUrl);
  if (appearance.thumbnailUrl) embed.setThumbnail(appearance.thumbnailUrl);
  return embed;
}
