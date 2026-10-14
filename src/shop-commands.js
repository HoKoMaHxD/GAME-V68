import { SlashCommandBuilder, MessageFlags, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { themedEmbed } from './appearance.js';
import { number, safe } from './presentation.js';
import { parsePanelAction, personalNavigation } from './panel.js';
import { MAX_SHOP_PRICE, MAX_SHOP_STOCK } from './shop.js';
import { checkShopDestination } from './shop-notifications.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';

const ADMIN = new Set(['اضافة_منتج', 'ازالة_منتج', 'اعدادات_المتجر']);
const NAMES = new Set(['المتجر', ...ADMIN]);
const PAGE_SIZE = 5;
const key = (owner, mode, ticket = '0', page = 1) => `clan-shop:v1:${owner}:${mode}:${ticket}:${page}`;

export function buildShopCommands() {
  return [
    new SlashCommandBuilder().setName('المتجر').setDescription('منتجات الكلان وشراء المنتجات باستخدام رصيدك'),
    new SlashCommandBuilder().setName('اضافة_منتج').setDescription('إضافة منتج إلى متجر الكلان')
      .setDefaultMemberPermissions(null)
      .addStringOption(o => o.setName('الاسم').setDescription('اسم المنتج').setRequired(true).setMaxLength(80))
      .addIntegerOption(o => o.setName('السعر').setDescription('سعر القطعة بالعملة 💵').setRequired(true).setMinValue(1).setMaxValue(MAX_SHOP_PRICE))
      .addIntegerOption(o => o.setName('الكمية').setDescription('عدد القطع المتاحة').setRequired(true).setMinValue(0).setMaxValue(MAX_SHOP_STOCK))
      .addStringOption(o => o.setName('الوصف').setDescription('وصف اختياري للمنتج').setMaxLength(300)),
    new SlashCommandBuilder().setName('ازالة_منتج').setDescription('إزالة منتج من المتجر مع الاحتفاظ بالطلبات السابقة')
      .setDefaultMemberPermissions(null)
      .addStringOption(o => o.setName('المنتج').setDescription('اسم المنتج المطابق أو معرفه الظاهر في المتجر').setRequired(true).setMaxLength(80)),
    new SlashCommandBuilder().setName('اعدادات_المتجر').setDescription('تحديد روم تنبيهات الشراء والرتبة التي يتم منشنها')
      .setDefaultMemberPermissions(null)
      .addChannelOption(o => o.setName('الروم').setDescription('روم تنبيهات الشراء في سيرفر الكلان').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addRoleOption(o => o.setName('الرتبة').setDescription('رتبة مسؤولي التسليم في سيرفر الكلان').setRequired(true))
  ];
}

export function parseShopAction(id) {
  const panel = parsePanelAction(id);
  if (panel?.kind === 'shop') return { ...panel, mode: 'view', page: 1 };
  const match = /^clan-shop:v1:(\d{17,20}):(view|open|buy|select):(0|\d{17,20}):(\d{1,2})(?::(?:previous|next))?$/.exec(id || '');
  if (!match || Number(match[4]) < 1 || Number(match[4]) > 20) return null;
  if (['buy', 'select'].includes(match[2]) && match[3] === '0') return null;
  return { ownerId: match[1], mode: match[2], ticket: match[3], page: Number(match[4]), update: true };
}

export function shopPayload({ shop, balance }, userId, appearance, action = { mode: 'view', page: 1 }) {
  const buying = action.mode === 'buy';
  const products = buying ? shop.products.filter(p => p.stock > 0) : shop.products;
  const pages = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
  const page = Math.max(1, Math.min(pages, action.page || 1));
  const visible = products.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const embed = themedEmbed(buying ? 'اختر منتجك' : 'متجر الكلان', appearance, `صفحة ${page} / ${pages} • رصيدك يفتح لك المزيد`)
    .setDescription(`**رصيدك المتاح: ${number(balance.total)} $ 💵**\n`
      + (buying ? 'اختيار منتج من القائمة يُتم شراء **قطعة واحدة** ويخصم سعرها مباشرة.\n' : 'استبدل عملتك بمنتجات الكلان. اضغط **شراء** لفتح قائمة المنتجات.\n')
      + 'الدفع من رصيد عملتك المتاح؛ ترتيب النشاط لا يتغير.\n'
      + (!shop.destination ? '\n⏳ المتجر بانتظار إعداد روم تنبيهات الشراء من الإدارة.' : 'تصل تفاصيل طلبك إلى الإدارة لمتابعة التسليم.'));
  for (const p of visible) embed.addFields({ name: `${p.stock ? '🛍️' : '⛔'} ${safe(p.name)}`,
    value: `**${number(p.price)} $ 💵** • ${p.stock ? `المتاح: **${number(p.stock)}**` : '**نفدت الكمية**'}\n`
      + (p.description ? `${safe(p.description)}\n` : '') + `معرف المنتج: \`${p.id}\`` });
  if (!visible.length) embed.addFields({ name: 'المنتجات', value: buying ? 'لا توجد منتجات متاحة للشراء حاليًا.' : 'لا توجد منتجات مضافة حاليًا.' });
  const components = [personalNavigation(userId, 'shop')];
  if (buying && visible.length && shop.destination) components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(key(userId, 'select', action.ticket, page))
      .setPlaceholder('اختر المنتج لإتمام الشراء وخصم سعره').setMinValues(1).setMaxValues(1)
      .addOptions(visible.map(p => ({ label: p.name, value: p.id,
        description: `${number(p.price)} $ 💵 • المتاح ${number(p.stock)} • شراء قطعة واحدة` })))
  ));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(key(userId, 'open', '0', 1)).setLabel(buying ? 'قائمة شراء جديدة' : 'شراء')
      .setEmoji('🛒').setStyle(ButtonStyle.Success).setDisabled(!shop.destination || !shop.products.some(p => p.stock > 0)),
    new ButtonBuilder().setCustomId(key(userId, buying ? 'buy' : 'view', buying ? action.ticket : '0', Math.max(1, page - 1)))
      .setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
    new ButtonBuilder().setCustomId(key(userId, buying ? 'buy' : 'view', buying ? action.ticket : '0', Math.min(pages, page + 1)))
      .setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page === pages)
  ));
  // At a single page previous/next must still have distinct custom IDs.
  const row = components.at(-1);
  row.components[1].setCustomId(`${row.components[1].data.custom_id}:previous`);
  row.components[2].setCustomId(`${row.components[2].data.custom_id}:next`);
  return { embeds: [embed], components };
}

export function createShopHandler({ config, store, service, isMember, bot, notifyPurchase, access, onError = () => {} }) {
  return async interaction => {
    const component = interaction.isButton() || interaction.isStringSelectMenu?.();
    const action = component ? parseShopAction(interaction.customId) : null;
    if (!action && !NAMES.has(interaction.commandName) && !interaction.customId?.startsWith('clan-shop:v1:')) return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId) { await deny('المتجر متاح داخل سيرفر الكلان فقط.'); return true; }
    if (component && !action) { await deny('هذا الزر غير صالح. افتح /المتجر من جديد.'); return true; }
    if (action?.ownerId && action.ownerId !== interaction.user.id) { await deny('هذه قائمة عضو آخر. افتح /المتجر لقائمتك الخاصة.'); return true; }
    const admin = ADMIN.has(interaction.commandName);
    if (admin && !canManageBot(interaction, config, access?.roleId)) { await deny(MANAGEMENT_DENIED); return true; }
    if (!admin && !isMember(interaction.user.id)) { await deny('الشراء وعرض الرصيد متاحان لأعضاء الكلان المؤهلين. تحقق من عضويتك ورتبتك في أرينا.'); return true; }
    if (action?.update) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = payload => interaction.editReply({ content: '', embeds: [], components: [], allowedMentions: { parse: [] }, ...payload });
    let order;
    try {
      const appearance = (await store.settings())?.appearance;
      if (interaction.commandName === 'اضافة_منتج') {
        const product = await service.manageShop((shop, now) => shop.add({ id: interaction.id, createdBy: interaction.user.id,
          name: interaction.options.getString('الاسم', true), price: interaction.options.getInteger('السعر', true),
          stock: interaction.options.getInteger('الكمية', true), description: interaction.options.getString('الوصف') }, now));
        await reply({ content: `✅ أُضيف **${safe(product.name)}** بسعر **${number(product.price)} $ 💵** وكمية **${number(product.stock)}**.\nمعرف المنتج: \`${product.id}\`` });
      } else if (interaction.commandName === 'ازالة_منتج') {
        const product = await service.manageShop((shop, now) => shop.remove(interaction.options.getString('المنتج', true), now));
        await reply({ content: `✅ أُزيل **${safe(product.name)}** من المتجر. الطلبات السابقة محفوظة.` });
      } else if (interaction.commandName === 'اعدادات_المتجر') {
        const destination = { channelId: interaction.options.getChannel('الروم', true).id, roleId: interaction.options.getRole('الرتبة', true).id };
        await checkShopDestination(bot, config.clanGuildId, destination);
        await service.manageShop((shop, now) => shop.configure(destination, now));
        await reply({ content: `✅ تنبيهات الشراء في <#${destination.channelId}> مع منشن <@&${destination.roleId}>. تشمل اسم العضو والمنتج والسعر ورقم الطلب.` });
        notifyPurchase?.();
      } else if (action?.mode === 'select') {
        if (!interaction.isStringSelectMenu?.() || interaction.values?.length !== 1) throw new Error('اختر منتجًا واحدًا من قائمة الشراء.');
        // Recheck eligibility here; a menu opened before leaving the clan cannot buy.
        order = await service.purchase({ userId: interaction.user.id, productId: interaction.values[0], checkoutId: action.ticket, at: interaction.createdTimestamp }, () => isMember(interaction.user.id));
        await reply({ embeds: [themedEmbed(order.duplicate ? 'طلبك مسجل مسبقًا' : 'تم الشراء بنجاح', appearance)
          .setDescription(`🛍️ **${safe(order.product.name)}** • قطعة واحدة\n`
            + (order.duplicate ? 'هذا طلب القائمة نفسها؛ لم نخصم مرة أخرى.' : 'حُفظ طلبك، وسيصل تنبيه إلى الإدارة لمتابعة التسليم.'))
          .addFields({ name: 'السعر', value: `${number(order.product.price)} $ 💵`, inline: true },
            { name: 'رصيدك بعد هذا الطلب', value: `${number(order.balanceAfter)} $ 💵`, inline: true },
            { name: 'رقم الطلب', value: `\`${order.id}\`` })], components: [personalNavigation(interaction.user.id, 'shop')] });
        notifyPurchase?.();
      } else {
        const view = await service.shopView(interaction.user.id);
        const selected = action?.mode === 'open' ? { mode: 'buy', ticket: interaction.id, page: 1 } : action;
        await reply(shopPayload(view, interaction.user.id, appearance, selected || undefined));
      }
    } catch (error) {
      onError(error);
      await reply({ content: '❌ ' + (order ? `طلبك ${order.id} محفوظ. راجع /رصيدي وتنبيه الإدارة قبل الشراء مرة أخرى.`
        : /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تأكيد العملية. راجع المتجر والرصيد وسجل Render قبل المحاولة مجددًا.'),
        components: !admin ? [personalNavigation(interaction.user.id, 'shop')] : [] });
    }
    return true;
  };
}
