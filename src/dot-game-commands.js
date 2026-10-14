import { ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,MessageFlags,SlashCommandBuilder } from 'discord.js';
import { dotBoard } from './dot-board.js';
import { escapeMarkdown } from 'discord.js';
import { bankMember } from './bank.js';
import { gameDisplays, playGameAction, STALE_GAME_NOTICE } from './game-display.js';
import { XO_MAX } from './xo.js';
import { XoManager } from './xo-commands.js';
export function buildDotCommand(){return new SlashCommandBuilder().setName('دوت').setDescription('تحدّي دوت: وصّل 4 أقراص أفقيًا أو عموديًا أو قطريًا للفوز')
 .addUserOption(o=>o.setName('العضو').setDescription('العضو المتحدّى').setRequired(true))
 .addIntegerOption(o=>o.setName('المبلغ').setDescription('المبلغ المحجوز من كل طرف').setMinValue(1).setMaxValue(XO_MAX).setRequired(true));}
export function dotPayload(g) {
 const name=id=>escapeMarkdown((g.names?.[id]||'لاعب').slice(0,60));
 const amount=g.amount.toLocaleString('en-US');
 const turn=g.turn===g.x?'🔴':'🟡';
 const status=g.status==='pending'
  ? `<@${g.o}>، تحدّاك <@${g.x}> في دوت!\nكوّن 4 أقراص متصلة أفقيًا أو عموديًا أو قطريًا للفوز. اختر العمود؛ القرص ينزل إلى أسفل خانة فارغة.\nعند القبول يُحجز **${amount} $** من كل طرف. الفائز يأخذ مبلغ خصمه كاملًا بدون ضريبة، والتعادل يعيد المبلغين.\nالقبول خلال 30 ثانية، ولكل دور 30 ثانية؛ عدم اللعب خسارة.\nانتظار إرسال تحدٍّ جديد: 20 دقيقة؛ استقبال التحديات متاح أثناء الانتظار.\nتنتهي الدعوة <t:${Math.ceil(g.expiresAt/1000)}:R>.`
  :g.status==='active'?`بانتظار <@${g.turn}> ${turn} ⏳\nاختر عمودًا من الأزرار أدناه. لديك **30 ثانية**؛ تنتهي <t:${Math.ceil(g.expiresAt/1000)}:R>.\nمبلغ التحدّي: **${amount} $** لكل طرف.`
  :g.status==='won'?`${g.reason==='timeout'?'⏰ انتهت مهلة صاحب الدور؛ تُحسب عليه خسارة.\n':''}🏆 فاز <@${g.winner}>!\nربح **${amount} $** من خصمه واسترجع مبلغه المحجوز، بدون ضريبة.`
  :g.status==='tie'?'🤝 امتلأت اللوحة دون فائز؛ تعادل، ورجع لكل طرف مبلغه.'
  :g.status==='rejected'?'رُفض التحدّي؛ لم يُخصم أي مبلغ.'
  :g.reason==='balance'?'أُلغي التحدّي؛ رصيد أحد الطرفين لا يكفي. لم يُحجز أي مبلغ.'
  :'أُلغي التحدّي؛ أُعيدت أي مبالغ محجوزة للطرفين.';
 const color=g.status==='won'?(g.winner===g.x?0xf32642:0xffd544):g.status==='active'?(g.turn===g.x?0xf32642:0xffd544):0x5865f2;
 const embed=new EmbedBuilder().setColor(color).setTitle(`${name(g.x)} ضد ${name(g.o)}`)
  .setDescription(status).setFooter({text:`دوت • رقم اللعبة: ${g.id}`});
 const button=(move,label,style)=>new ButtonBuilder().setCustomId(`dot:v1:${g.id}:${g.revision}:${move}`).setLabel(label).setStyle(style);
 let components=[],files=[];
 if(g.status==='pending')components=[new ActionRowBuilder().addComponents(button('accept','قبول',ButtonStyle.Success),button('reject','رفض',ButtonStyle.Danger))];
 if(['active','won','tie'].includes(g.status)) {
  const filename=`dot-${g.id}-${g.revision}.png`;
  embed.setImage(`attachment://${filename}`);files=[{attachment:dotBoard(g),name:filename}];
  components=[[1,2,3,4],[5,6,7]].map(columns=>new ActionRowBuilder().addComponents(...columns.map(c=>button(String(c),String(c),ButtonStyle.Primary).setDisabled(g.status!=='active'||!!g.board[c-1]))));
 }
 return {content:'',embeds:[embed],components,files,attachments:[],allowedMentions:{parse:[]}};
}
export function createDotHandler({config,service,isBankMember,dotManager,onError=()=>{}}){
 let displays=dotManager?.displays;
 return async i=>{
  const action=i.isButton?.()?/^dot:v1:(\d{17,20}):(\d+):(accept|reject|[1-7])$/.exec(i.customId||''):null;
  if(!action&&i.commandName!=='دوت'&&i.customId!=='dot:help')return false;
  if(i.guildId!==config.clanGuildId||i.user.bot){await i.reply({content:'اللعبة لأعضاء سيرفر الكلان فقط.',flags:MessageFlags.Ephemeral});return true;}
  if(i.customId==='dot:help'){await i.reply({content:'لبدء التحدّي اكتب: دوت @العضو المبلغ، مثال: دوت @العضو 1000. لازم الطرفين يملكون المبلغ، ويبدأ اللعب بعد قبول خصمك.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return true;}
  if(action)await i.deferUpdate();else await i.deferReply({});
  displays ||= gameDisplays(service.dotGame);
  await displays.runSerial(action?.[1]||i.id,async()=>{
   try{
    const eligible=id=>isBankMember?isBankMember(id):bankMember(i,config,id);
    let g,stale=false;
    if(action)({round:g,stale}=await playGameAction(service.dotGame,{id:action[1],revision:Number(action[2]),move:action[3],userId:i.user.id,channelId:i.channelId,messageId:i.message?.id},eligible));
    else{
     const target=i.options.getUser('العضو');
     const targetMember=target?.id ? await i.guild?.members?.fetch?.(target.id) : null;
     const names={ [i.user.id]:i.member?.displayName||i.user.username||'اللاعب الأحمر', [target?.id]:targetMember?.displayName||target?.globalName||target?.username||'اللاعب الأصفر' };
     const iconURL=i.user.displayAvatarURL?.({extension:'png',size:128});
     g=await service.dotGame.open({id:i.id,x:i.user.id,o:target?.id,bot:!!target?.bot,channelId:i.channelId,amount:i.options.getInteger('المبلغ'),requireDelivery:true,names,
      author:{name:(i.member?.displayName||i.user.username||'عضو الكلان').slice(0,256),...(iconURL?{iconURL}:{})}},eligible);
    }
    const msg=await i.editReply(dotPayload(g));
    if(msg?.id&&!g.messageId)await service.dotGame.bind(g.id,msg.id);
    await service.dotGame.displayed(g);
    if(stale)await i.followUp({content:STALE_GAME_NOTICE,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
   }catch(e){onError(e);const p={content:/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر إكمال الطلب؛ حاول مجددًا.',allowedMentions:{parse:[]}};
    if(action)await i.followUp({...p,flags:MessageFlags.Ephemeral});else await i.editReply({...p,embeds:[],components:[]});}
  });return true;
 };
}
export class DotManager extends XoManager { constructor(ctx){super({...ctx,game:ctx.service.dotGame,payload:dotPayload});} }
