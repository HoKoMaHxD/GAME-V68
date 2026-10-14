import { numbersLimit } from './numbers-game.js';
import { ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,MessageFlags,SlashCommandBuilder } from 'discord.js';
import { bankMember } from './bank.js';
import { gameDisplays, playGameAction, STALE_GAME_NOTICE } from './game-display.js';
import { XO_MAX } from './xo.js';
import { XoManager } from './xo-commands.js';
export function buildNumbersCommand(){return new SlashCommandBuilder().setName('ارقام').setDescription('اختر رقمًا أو رقمين بالتناوب؛ النهاية عشوائية من 15 إلى 25؛ من يأخذ آخر رقم يخسر')
 .addUserOption(o=>o.setName('العضو').setDescription('العضو المتحدّى').setRequired(true))
 .addIntegerOption(o=>o.setName('المبلغ').setDescription('المبلغ المحجوز من كل طرف').setMinValue(1).setMaxValue(XO_MAX).setRequired(true));}
export function numbersPayload(g){
 const limit=numbersLimit(g);
 const amount=g.amount.toLocaleString('en-US');
 const title=`🔴 <@${g.x}> — 🟢 <@${g.o}>\nمبلغ التحدّي: **${amount} $** لكل طرف.\n\n`;
 const description=g.status==='pending'?`<@${g.o}>، تحدّاك <@${g.x}>!\nاختر رقمًا أو رقمين بالتتابع؛ من يأخذ الرقم الأخير يخسر مبلغ التحدّي لصالح خصمه كاملًا بدون ضريبة. نهاية العد عشوائية ومخفية حتى قبول التحدّي وبدء القيم.\nيُختار اللاعب الأول عشوائيًا. عند القبول يُحجز المبلغ من الطرفين.\nلكل دور 30 ثانية؛ عدم الاختيار يُحسب خسارة.\nالدعوة 30 ثانية؛ تنتهي <t:${Math.ceil(g.expiresAt/1000)}:R>.\nانتظار إرسال التحدّي: 20 دقيقة على صاحب التحدّي فقط من القبول؛ استقبال التحديات متاح أثناء الانتظار.`:
  g.status==='active'?`الدور على <@${g.turn}> ${g.turn===g.x?'🔴':'🟢'}.\nاختر **1** لأخذ الرقم التالي أو **2** لأخذ الرقمين التاليين. من يأخذ **${limit}** يخسر!\nوصلتم إلى **${g.count}**. مهلة الدور 30 ثانية؛ تنتهي <t:${Math.ceil(g.expiresAt/1000)}:R>.`:
  g.status==='won'?`${g.reason==='timeout'?'⏰ انتهت مهلة الاختيار؛ خسر صاحب الدور.':`اختار <@${g.loser}> الرقم **${limit}** وخسر.`}\n🎉 فاز <@${g.winner}> بمبلغ **${amount} $** من خصمه، واسترجع مبلغه المحجوز. بدون ضريبة.`:
  g.status==='tie'?'🤝 تعادل؛ رجع لكل طرف مبلغه بدون ربح أو خسارة.':
  g.status==='rejected'?'رُفض التحدّي؛ لم يُخصم أي مبلغ.':g.reason==='balance'?'أُلغي التحدّي؛ رصيد أحد الطرفين لم يعد يكفي. لم يُحجز أي مبلغ.':'أُلغي التحدّي؛ أُعيدت أي مبالغ محجوزة للطرفين.';
 const embed=new EmbedBuilder().setColor(0x2b2d31).setTitle(g.acceptedAt || ['active','won','tie'].includes(g.status) ? `أرقام • من 1 إلى ${limit}` : 'أرقام • تحدٍّ جديد').setDescription(title+description);if(g.author)embed.setAuthor(g.author);
 const button=(move,label,style)=>new ButtonBuilder().setCustomId(`numbers:v1:${g.id}:${g.revision}:${move}`).setLabel(label).setStyle(style);
 const components=g.status==='pending'?[new ActionRowBuilder().addComponents(button('accept','قبول',ButtonStyle.Success),button('reject','رفض',ButtonStyle.Danger))]:
  ['active','won','tie'].includes(g.status)&&limit<=20?Array.from({length:Math.ceil(limit/5)},(_,r)=>new ActionRowBuilder().addComponents(...Array.from({length:Math.min(5,limit-r*5)},(_,c)=>{
   const cell=r*5+c+1,picked=g.picks.find(p=>p.cell===cell);
   return button(`cell${cell}`,String(cell),picked?(picked.userId===g.x?ButtonStyle.Danger:ButtonStyle.Success):ButtonStyle.Secondary).setDisabled(true);
  }))):[];
 if(limit>20&&['active','won','tie'].includes(g.status)){
  const cells=Array.from({length:limit},(_,i)=>{const n=i+1,p=g.picks.find(x=>x.cell===n);return `${p?(p.userId===g.x?'🔴':'🟢'):'⬜'}\`${String(n).padStart(2,'0')}\``;});
  embed.addFields({name:'لوحة الأرقام',value:Array.from({length:Math.ceil(limit/5)},(_,i)=>cells.slice(i*5,i*5+5).join('  ')).join('\n')});
 }
 if(g.status==='active')components.push(new ActionRowBuilder().addComponents(...[1,2].map(n=>button(String(n),String(n),ButtonStyle.Primary).setDisabled(g.count+n>limit))));
 return {content:'',embeds:[embed],components,allowedMentions:{parse:[]}};
}
export function createNumbersHandler({config,service,isBankMember,numbersManager,onError=()=>{}}){
 let displays=numbersManager?.displays;
 return async i=>{
  const action=i.isButton?.()?/^numbers:v1:(\d{17,20}):(\d+):(accept|reject|[12])$/.exec(i.customId||''):null;
  if(!action&&i.commandName!=='ارقام'&&i.customId!=='numbers:help')return false;
  if(i.guildId!==config.clanGuildId||i.user.bot){await i.reply({content:'اللعبة لأعضاء سيرفر الكلان فقط.',flags:MessageFlags.Ephemeral});return true;}
  if(i.customId==='numbers:help'){await i.reply({content:'لبدء التحدّي اكتب: ارقام @العضو المبلغ، مثال: ارقام @العضو 1000. لازم الطرفين يملكون المبلغ، ويبدأ اللعب بعد قبول خصمك.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return true;}
  if(action)await i.deferUpdate();else await i.deferReply({});
  displays ||= gameDisplays(service.numbersGame);
  await displays.runSerial(action?.[1]||i.id,async()=>{
   try{
    const eligible=id=>isBankMember?isBankMember(id):bankMember(i,config,id);
    let g,stale=false;
    if(action)({round:g,stale}=await playGameAction(service.numbersGame,{id:action[1],revision:Number(action[2]),move:action[3],userId:i.user.id,channelId:i.channelId,messageId:i.message?.id},eligible));
    else{
     const target=i.options.getUser('العضو');
     const iconURL=i.user.displayAvatarURL?.({extension:'png',size:128});
     g=await service.numbersGame.open({id:i.id,x:i.user.id,o:target?.id,bot:!!target?.bot,channelId:i.channelId,amount:i.options.getInteger('المبلغ'),requireDelivery:true,
      author:{name:(i.member?.displayName||i.user.username||'عضو الكلان').slice(0,256),...(iconURL?{iconURL}:{})}},eligible);
    }
    const msg=await i.editReply(numbersPayload(g));
    if(msg?.id&&!g.messageId)await service.numbersGame.bind(g.id,msg.id);
    await service.numbersGame.displayed(g);
    if(stale)await i.followUp({content:STALE_GAME_NOTICE,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
   }catch(e){onError(e);const p={content:/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر إكمال الطلب؛ حاول مجددًا.',allowedMentions:{parse:[]}};
    if(action)await i.followUp({...p,flags:MessageFlags.Ephemeral});else await i.editReply({...p,embeds:[],components:[]});}
  });return true;
 };
}
export class NumbersManager extends XoManager { constructor(ctx){super({...ctx,game:ctx.service.numbersGame,payload:numbersPayload});} }
