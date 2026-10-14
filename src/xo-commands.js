import { ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,MessageFlags,SlashCommandBuilder } from 'discord.js';
import { bankMember } from './bank.js';
import { gameDisplays, GameDisplayJobs, playGameAction, STALE_GAME_NOTICE } from './game-display.js';
import { XO_MAX } from './xo.js';
export function buildXoCommand(){return new SlashCommandBuilder().setName('اكس').setDescription('تحدّي اكس أو ضد عضو بمبلغ متساوٍ؛ الفائز يأخذ مبلغ خصمه')
 .addUserOption(o=>o.setName('العضو').setDescription('العضو المتحدّى').setRequired(true))
 .addIntegerOption(o=>o.setName('المبلغ').setDescription('المبلغ المحجوز من كل طرف').setMinValue(1).setMaxValue(XO_MAX).setRequired(true));}
export function xoPayload(g){
 const money=g.amount.toLocaleString('en-US');
 const embed=new EmbedBuilder().setColor(0x2b2d31).setTitle('اكس-او').setDescription(
  `<@${g.x}> **X** — <@${g.o}> **O**\nمبلغ التحدّي: **${money} $** لكل طرف.\n\n`+
  (g.status==='pending'?`<@${g.o}>، تحدّاك <@${g.x}>!\nعند القبول يُحجز المبلغ من رصيد كل طرف. الفائز يأخذ مبلغ خصمه كاملًا، والتعادل يعيد المبلغين.\nالقبول خلال 30 ثانية؛ لكل دور 30 ثانية، ومن تنتهي مهلته بدون اختيار يخسر مبلغ التحدّي لصالح خصمه.\nانتظار إرسال تحدّي اكس: 20 دقيقة على صاحب التحدّي فقط من القبول؛ استقبال التحديات متاح أثناء الانتظار.\nتنتهي الدعوة <t:${Math.ceil(g.expiresAt/1000)}:R>.`:
  g.status==='active'?`الدور على <@${g.turn}> **${g.turn===g.x?'X':'O'}**\nالمبلغ محجوز من الطرفين. لديك 30 ثانية؛ عدم الاختيار يُحسب خسارة. مهلة الدور <t:${Math.ceil(g.expiresAt/1000)}:R>.`:
  g.status==='won'?`${g.reason==='timeout'?'⏰ انتهت مهلة الاختيار؛ خسر صاحب الدور.\n':''}🎉 مبروك <@${g.winner}>!\nربحت **${money} $** من خصمك، واسترجعت مبلغك المحجوز. بدون ضريبة.`:
  g.status==='tie'?'🤝 تعادل! رجع لكل طرف مبلغه، بدون ربح أو خسارة.':
  g.status==='rejected'?'رُفض التحدّي؛ لم يُخصم أي مبلغ.':g.reason==='balance'?'أُلغي التحدّي لأن رصيد أحد الطرفين لم يعد يكفي؛ لم يُحجز أي مبلغ.':'أُلغي التحدّي؛ أُعيدت أي مبالغ محجوزة للطرفين.'));
 if(g.xoMode==='infinite'&&['pending','active'].includes(g.status)){
  let note='♾️ Infinite XO: لكل لاعب 3 علامات؛ عند وضع الرابعة تختفي أقدم علامة له. كوّن ثلاث علامات في خط واحد للفوز.';
  embed.setDescription(embed.data.description+'\n\n'+note);
 }
 if(g.author)embed.setAuthor(g.author);
 const button=(move,label,style)=>new ButtonBuilder().setCustomId(`xo:v1:${g.id}:${g.revision}:${move}`).setLabel(label).setStyle(style);
 const components=g.status==='pending'?[new ActionRowBuilder().addComponents(button('accept','قبول',ButtonStyle.Success),button('reject','رفض',ButtonStyle.Danger))]:
  ['active','won','tie'].includes(g.status)?Array.from({length:3},(_,r)=>new ActionRowBuilder().addComponents(...Array.from({length:3},(_,c)=>{
   const i=r*3+c;return button(String(i),g.board[i]||'ـ',g.line?.includes(i)?ButtonStyle.Primary:ButtonStyle.Secondary).setDisabled(g.status!=='active'||!!g.board[i]);
  }))):[];
 return {content:'',embeds:[embed],components,allowedMentions:{parse:[]}};
}
export function createXoHandler({config,service,isBankMember,xoManager,onError=()=>{}}){
 let displays=xoManager?.displays;
 return async i=>{
  const action=i.isButton?.()?/^xo:v1:(\d{17,20}):(\d+):(accept|reject|[0-8])$/.exec(i.customId||''):null;
  if(!action&&i.commandName!=='اكس'&&i.customId!=='xo:help')return false;
  if(i.guildId!==config.clanGuildId||i.user.bot){await i.reply({content:'اللعبة لأعضاء سيرفر الكلان فقط.',flags:MessageFlags.Ephemeral});return true;}
  if(i.customId==='xo:help'){await i.reply({content:'لبدء التحدّي اكتب: اكس @العضو المبلغ، مثال: اكس @العضو 1000. لازم الطرفين يملكون المبلغ، ويبدأ اللعب بعد قبول خصمك.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return true;}
  if(action)await i.deferUpdate();else await i.deferReply({});
  displays ||= gameDisplays(service.xo);
  await displays.runSerial(action?.[1]||i.id,async()=>{
   try{
    const eligible=id=>isBankMember?isBankMember(id):bankMember(i,config,id);
    let g,stale=false;
    if(action)({round:g,stale}=await playGameAction(service.xo,{id:action[1],revision:Number(action[2]),move:action[3],userId:i.user.id,channelId:i.channelId,messageId:i.message?.id},eligible));
    else{
     const target=i.options.getUser('العضو');
     const iconURL=i.user.displayAvatarURL?.({extension:'png',size:128});
     g=await service.xo.open({id:i.id,x:i.user.id,o:target?.id,bot:!!target?.bot,channelId:i.channelId,amount:i.options.getInteger('المبلغ'),requireDelivery:true,
      author:{name:(i.member?.displayName||i.user.username||'عضو الكلان').slice(0,256),...(iconURL?{iconURL}:{})}},eligible);
    }
    const msg=await i.editReply(xoPayload(g));
    if(msg?.id&&!g.messageId)await service.xo.bind(g.id,msg.id);
    await service.xo.displayed(g);
    if(stale)await i.followUp({content:STALE_GAME_NOTICE,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
   }catch(e){onError(e);const p={content:/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر إكمال الطلب؛ حاول مجددًا.',allowedMentions:{parse:[]}};
    if(action)await i.followUp({...p,flags:MessageFlags.Ephemeral});else await i.editReply({...p,embeds:[],components:[]});}
  });return true;
 };
}
export class XoManager{
 constructor(ctx){Object.assign(this,ctx);this.game=ctx.game||ctx.service.xo;this.payload=ctx.payload||xoPayload;this.displays=gameDisplays(this.game);this.jobs=new GameDisplayJobs(this.onError||(()=>{}));this.running=null;}
 tick(){if(this.running)return this.running;this.running=this.update().finally(()=>{this.running=null;});return this.running;}
 async update(){
  if(!this.canRun())return;await this.game.expire();
  for(const row of await this.game.dirty())this.jobs.add(row.id,()=>this.displays.runSerial(row.id,async()=>{
   if(!this.canRun())return;
   let g=await this.game.get(row.id);
   if(!g?.messageId||!g.dirty)return;
   try{const channel=await this.bot.channels.fetch(g.channelId);if(channel?.guildId!==this.service.config.clanGuildId)return;
    const message=await channel.messages.fetch(g.messageId);if(message.author.id!==this.bot.user.id)return;
    if(!this.canRun())return;
    g=await this.game.get(row.id);
    if(!g?.dirty||g.messageId!==row.messageId)return;
    await message.edit(this.payload(g));await this.game.displayed(g);
   }catch(e){this.onError(e);if([10008,10003,50001,50013].includes(Number(e.code))){
    await this.game.run(async()=>{const latest=await this.game.get(g.id);if(['pending','active'].includes(latest.status))await this.game.finish(latest,'cancelled',null,'delivery');});
    await this.game.displayed(await this.game.get(g.id));
   }}
  }));
 }
 async drain(){await this.running;await this.jobs.drain();}
}
