import { ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,MessageFlags,SlashCommandBuilder } from 'discord.js';
import { bankMember } from './bank.js';
import { gameDisplays, playGameAction, STALE_GAME_NOTICE } from './game-display.js';
import { XO_MAX } from './xo.js';
import { XoManager } from './xo-commands.js';
export function buildMinesCommand(){return new SlashCommandBuilder().setName('الغام').setDescription('تحدّي لغم مخفي ضد عضو؛ من يختار اللغم يخسر مبلغ التحدّي')
 .addUserOption(o=>o.setName('العضو').setDescription('العضو المتحدّى').setRequired(true))
 .addIntegerOption(o=>o.setName('المبلغ').setDescription('المبلغ المحجوز من كل طرف').setMinValue(1).setMaxValue(XO_MAX).setRequired(true));}
export function minesPayload(g){
 const amount=g.amount.toLocaleString('en-US');
 const title=`<@${g.x}> — <@${g.o}>\nمبلغ التحدّي: **${amount} $** لكل طرف.\n\n`;
 const description=g.status==='pending'?`<@${g.o}>، تحدّاك <@${g.x}>!\nلغم واحد مخفي بين الأرقام 1–9؛ تتناوبون الاختيار ومن يختار اللغم يخسر مبلغ التحدّي لصالح خصمه كاملًا بدون ضريبة.\nيُختار اللاعب الأول عشوائيًا. عند القبول يُحجز المبلغ من الطرفين.\nلكل دور 30 ثانية؛ عدم الاختيار يُحسب خسارة.\nالدعوة 30 ثانية؛ تنتهي <t:${Math.ceil(g.expiresAt/1000)}:R>.\nانتظار إرسال التحدّي: 20 دقيقة على صاحب التحدّي فقط من القبول؛ استقبال التحديات متاح أثناء الانتظار.`:
  g.status==='active'?`الدور على <@${g.turn}>. اختر رقمًا غير مكشوف وتجنّب اللغم!\nمهلة الدور 30 ثانية؛ تنتهي <t:${Math.ceil(g.expiresAt/1000)}:R>. عدم الاختيار يُحسب خسارة.`:
  g.status==='won'?`${g.reason==='timeout'?'⏰ انتهت مهلة الاختيار؛ خسر صاحب الدور.':`💣 اختار <@${g.loser}> اللغم رقم **${g.mine}**.`}\n🎉 فاز <@${g.winner}> بمبلغ **${amount} $** من خصمه، واسترجع مبلغه المحجوز. بدون ضريبة.`:
  g.status==='tie'?'🤝 تعادل؛ رجع لكل طرف مبلغه بدون ربح أو خسارة.':
  g.status==='rejected'?'رُفض التحدّي؛ لم يُخصم أي مبلغ.':g.reason==='balance'?'أُلغي التحدّي؛ رصيد أحد الطرفين لم يعد يكفي. لم يُحجز أي مبلغ.':'أُلغي التحدّي؛ أُعيدت أي مبالغ محجوزة للطرفين.';
 const embed=new EmbedBuilder().setColor(0x2b2d31).setTitle('الغام').setDescription(title+description);if(g.author)embed.setAuthor(g.author);
 const button=(move,label,style)=>new ButtonBuilder().setCustomId(`mines:v1:${g.id}:${g.revision}:${move}`).setLabel(label).setStyle(style);
 const components=g.status==='pending'?[new ActionRowBuilder().addComponents(button('accept','قبول',ButtonStyle.Success),button('reject','رفض',ButtonStyle.Danger))]:
  ['active','won','tie'].includes(g.status)?Array.from({length:3},(_,r)=>new ActionRowBuilder().addComponents(...Array.from({length:3},(_,c)=>{
   const cell=r*3+c+1,picked=g.picks.some(p=>p.cell===cell),bomb=g.status==='won'&&cell===g.mine;
   return button(String(cell),bomb?'💣':picked?'✅':String(cell),bomb?ButtonStyle.Danger:picked?ButtonStyle.Success:ButtonStyle.Secondary).setDisabled(g.status!=='active'||picked);
  }))):[];
 return {content:'',embeds:[embed],components,allowedMentions:{parse:[]}};
}
export function createMinesHandler({config,service,isBankMember,minesManager,onError=()=>{}}){
 let displays=minesManager?.displays;
 return async i=>{
  const action=i.isButton?.()?/^mines:v1:(\d{17,20}):(\d+):(accept|reject|[1-9])$/.exec(i.customId||''):null;
  if(!action&&i.commandName!=='الغام'&&i.customId!=='mines:help')return false;
  if(i.guildId!==config.clanGuildId||i.user.bot){await i.reply({content:'اللعبة لأعضاء سيرفر الكلان فقط.',flags:MessageFlags.Ephemeral});return true;}
  if(i.customId==='mines:help'){await i.reply({content:'لبدء التحدّي اكتب: الغام @العضو المبلغ، مثال: الغام @العضو 1000. لازم الطرفين يملكون المبلغ، ويبدأ اللعب بعد قبول خصمك.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return true;}
  if(action)await i.deferUpdate();else await i.deferReply({});
  displays ||= gameDisplays(service.minesGame);
  await displays.runSerial(action?.[1]||i.id,async()=>{
   try{
    const eligible=id=>isBankMember?isBankMember(id):bankMember(i,config,id);
    let g,stale=false;
    if(action)({round:g,stale}=await playGameAction(service.minesGame,{id:action[1],revision:Number(action[2]),move:action[3],userId:i.user.id,channelId:i.channelId,messageId:i.message?.id},eligible));
    else{
     const target=i.options.getUser('العضو');
     const iconURL=i.user.displayAvatarURL?.({extension:'png',size:128});
     g=await service.minesGame.open({id:i.id,x:i.user.id,o:target?.id,bot:!!target?.bot,channelId:i.channelId,amount:i.options.getInteger('المبلغ'),requireDelivery:true,
      author:{name:(i.member?.displayName||i.user.username||'عضو الكلان').slice(0,256),...(iconURL?{iconURL}:{})}},eligible);
    }
    const msg=await i.editReply(minesPayload(g));
    if(msg?.id&&!g.messageId)await service.minesGame.bind(g.id,msg.id);
    await service.minesGame.displayed(g);
    if(stale)await i.followUp({content:STALE_GAME_NOTICE,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
   }catch(e){onError(e);const p={content:/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر إكمال الطلب؛ حاول مجددًا.',allowedMentions:{parse:[]}};
    if(action)await i.followUp({...p,flags:MessageFlags.Ephemeral});else await i.editReply({...p,embeds:[],components:[]});}
  });return true;
 };
}
export class MinesManager extends XoManager { constructor(ctx){super({...ctx,game:ctx.service.minesGame,payload:minesPayload});} }
