import { SlashCommandBuilder,MessageFlags } from 'discord.js';
import { themedEmbed,attachmentImageUrl } from './appearance.js';
import { canManageBot,MANAGEMENT_DENIED } from './permissions.js';
import { checkAuctionChannel } from './auction-manager.js';
import { BOOST_ROLE_ID } from './task-boost.js';
export function buildBoostCommand(){return new SlashCommandBuilder().setName('دبل').setDescription('للإدارة: مضاعفة فلوس المهام لمدة محددة ونشر إعلان بالصورة').setDefaultMemberPermissions(null)
 .addIntegerOption(o=>o.setName('المضاعف').setDescription('2 يعني ×2، و3 يعني ×3، وهكذا').setRequired(true).setMinValue(2).setMaxValue(100))
 .addIntegerOption(o=>o.setName('المدة').setDescription('مدة الدبل بالدقائق؛ مثال 60 لساعة').setRequired(true).setMinValue(1).setMaxValue(10080))
 .addAttachmentOption(o=>o.setName('الصورة').setDescription('صورة إعلان الدبل').setRequired(true));}
const footer=id=>`دبل المهام #${id}`;
export function boostPayload(event,appearance,now,{ping=false}={}){
 const ended=now>=event.endsAt;
 const embed=themedEmbed(ended?'🏁 انتهى دبل المهام':`🔥 بدأ دبل المهام ×${event.multiplier}`,appearance)
  .setColor(ended?0x4fb687:0xf2b84b).setImage(event.imageUrl)
  .setDescription(ended?'انتهت فعالية الدبل لهذه المدة.':`وقت الإنجاز! أكمل مهامك خلال الفعالية واحصل على **${event.multiplier} أضعاف مكافأتها** 💰`)
  .addFields({name:'مضاعف المكافآت',value:`**×${event.multiplier}**`,inline:true},
   {name:'مدة الفعالية',value:`**${event.minutes.toLocaleString('en-US')} دقيقة**`,inline:true},
   {name:'مثال للمكافأة',value:`مهمة قيمتها **1,000 $** تصبح **${(1000*event.multiplier).toLocaleString('en-US')} $**`},
   {name:'البداية',value:`<t:${Math.floor(event.startsAt/1000)}:F>`},
   {name:ended?'انتهى في':'ينتهي',value:`<t:${Math.floor(event.endsAt/1000)}:F> • <t:${Math.floor(event.endsAt/1000)}:R>`},
   {name:'المهام المشمولة',value:'مكافآت إنجاز المهام التلقائية، ومنها مهمة الصوت. تُحسب المضاعفة عند إكمال المهمة خلال المدة.'},
   {name:'تنبيه',value:'الحضور المنفصل والراتب والجائزة وأرباح الألعاب والإضافات الإدارية لا يشملها الدبل.'})
  .setFooter({text:footer(event.id)});
 return {content:ended?'':`<@&${BOOST_ROLE_ID}> 🔥 دبل فلوس المهام **×${event.multiplier}** بدأ الآن!`,embeds:[embed],components:[],allowedMentions:{parse:[],roles:ping&&!ended?[BOOST_ROLE_ID]:[]}};
}
export class BoostManager{
 constructor(ctx){Object.assign(this,ctx);this.jobs=new Map();this.running=null;this.nextTick=0;}
 publish(id){if(this.jobs.has(id))return this.jobs.get(id);const job=this.sync(id).finally(()=>this.jobs.delete(id));this.jobs.set(id,job);return job;}
 async sync(id){
  if(!this.canRun())throw new Error('نشر إعلان الدبل غير متاح مؤقتًا.');const g=await this.service.boosts.get(id);if(!g||g.announcementDone)return;
  const now=this.service.clock(),ended=now>=g.endsAt;
  const channel=await this.bot.channels.fetch(g.channelId);if(channel?.guildId!==this.service.config.clanGuildId)throw new Error('روم إعلان الدبل غير متاح.');
  const appearance=(await this.service.store.settings())?.appearance;
  let message;
  if(g.messageId)message=await channel.messages.fetch(g.messageId).catch(e=>{if(Number(e.code)===10008)return null;throw e;});
  if(!message){
   // Recover a send acknowledged by Discord but not by MongoDB, without re-pinging the role.
   const history=await channel.messages.fetch({limit:100});
   message=[...history.values()].find(m=>m.author?.id===this.bot.user.id&&m.embeds?.some(e=>e.footer?.text===footer(g.id)));
   if(!message)message=await channel.send({...boostPayload(g,appearance,now,{ping:!g.messageId}),nonce:g.id,enforceNonce:true});
   await this.service.boosts.patch(g.id,{messageId:message.id});
  }
  if(ended){await message.edit(boostPayload(g,appearance,now));await this.service.boosts.patch(g.id,{announcementDone:true});}
 }
 tick(){if(this.running)return this.running;if(!this.canRun()||this.service.clock()<this.nextTick)return Promise.resolve();this.nextTick=this.service.clock()+10000;
  this.running=(async()=>{for(const g of await this.service.boosts.pending()){try{await this.publish(g.id);}catch(e){this.onError(e);}}})().finally(()=>{this.running=null;});return this.running;}
 async drain(){await this.running;await Promise.allSettled([...this.jobs.values()]);}
}
export function createBoostHandler({config,service,bot,access,boostManager,onError=()=>{}}){return async i=>{
 if(!i.isChatInputCommand?.()||i.commandName!=='دبل')return false;
 if(i.user.bot||!canManageBot(i,config,access?.roleId)){await i.reply({content:MANAGEMENT_DENIED,flags:MessageFlags.Ephemeral});return true;}
 await i.deferReply({flags:MessageFlags.Ephemeral});let saved;
 try{
  await checkAuctionChannel(bot,config.clanGuildId,i.channelId,BOOST_ROLE_ID);
  saved=await service.boosts.create({id:i.id,actorId:i.user.id,channelId:i.channelId,multiplier:i.options.getInteger('المضاعف',true),minutes:i.options.getInteger('المدة',true),imageUrl:attachmentImageUrl(i.options.getAttachment('الصورة',true))});
  await boostManager.publish(saved.id);
  await i.editReply({content:`✅ تم تفعيل دبل فلوس المهام ×${saved.multiplier} وإرسال الإعلان في هذا الشات. ينتهي <t:${Math.ceil(saved.endsAt/1000)}:R>.`,allowedMentions:{parse:[]}});
 }catch(e){onError(e);await i.editReply({content:saved?'الدبل محفوظ ومفعّل؛ تعذر تأكيد إعلان الشات الآن، وسيُعاد نشره تلقائيًا.':(/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر إنشاء الدبل؛ حاول مجددًا.'),allowedMentions:{parse:[]}});}
 return true;
};}
