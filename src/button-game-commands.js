import { ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,MessageFlags,SlashCommandBuilder } from 'discord.js';
import { bankMember } from './bank.js';
import { gameDisplays, playGameAction, STALE_GAME_NOTICE } from './game-display.js';
import { XO_MAX } from './xo.js';
import { XoManager } from './xo-commands.js';
export function buildButtonCommand(){return new SlashCommandBuilder().setName('زر').setDescription('أول من يضغط الزر الأخضر يفوز بمبلغ التحدّي')
 .addUserOption(o=>o.setName('العضو').setDescription('العضو المتحدّى').setRequired(true))
 .addIntegerOption(o=>o.setName('المبلغ').setDescription('المبلغ المحجوز من كل طرف').setMinValue(1).setMaxValue(XO_MAX).setRequired(true));}
export function buttonPayload(g){
 const amount=g.amount.toLocaleString('en-US');
 const title=`<@${g.x}> — <@${g.o}>\nمبلغ التحدّي: **${amount} $** لكل طرف.\n\n`;
 const description=g.status==='pending'?`<@${g.o}>، تحدّاك <@${g.x}>!\nسيتم اختيار زر أخضر بعد عدة ثوانٍ؛ أول من يضغطه يفوز بمبلغ خصمه كاملًا بدون ضريبة.\nعند القبول يُحجز المبلغ من الطرفين. إذا لم يضغطه أحد خلال 30 ثانية، تعادل واسترجاع المبلغين.\nالدعوة 30 ثانية؛ تنتهي <t:${Math.ceil(g.expiresAt/1000)}:R>.\nانتظار إرسال التحدّي: 20 دقيقة على صاحب التحدّي فقط من القبول؛ استقبال التحديات متاح أثناء الانتظار.`:
  g.status==='active'?(g.phase==='waiting'?'استعدوا! سيظهر زر أخضر عشوائي بعد عدة ثوانٍ. أول من يضغطه يفوز.':`🟢 اضغط الزر الأخضر قبل خصمك!\nتنتهي المهلة <t:${Math.ceil(g.expiresAt/1000)}:R>.`):
  g.status==='won'?`🎉 انتهى التحدّي بفوز <@${g.winner}>!\nربحت **${amount} $** من خصمك، واسترجعت مبلغك المحجوز. بدون ضريبة.`:
  g.status==='tie'?'🤝 تعادل؛ لم تُسجّل ضغطة صحيحة في المهلة. رجع لكل طرف مبلغه بدون ربح أو خسارة.':
  g.status==='rejected'?'رُفض التحدّي؛ لم يُخصم أي مبلغ.':g.reason==='balance'?'أُلغي التحدّي؛ رصيد أحد الطرفين لم يعد يكفي. لم يُحجز أي مبلغ.':'أُلغي التحدّي؛ أُعيدت أي مبالغ محجوزة للطرفين.';
 const embed=new EmbedBuilder().setColor(0x2b2d31).setTitle('زر').setDescription(title+description);if(g.author)embed.setAuthor(g.author);
 const button=(move,label,style)=>new ButtonBuilder().setCustomId(`button-game:v1:${g.id}:${g.revision}:${move}`).setLabel(label).setStyle(style);
 const components=g.status==='pending'?[new ActionRowBuilder().addComponents(button('accept','قبول',ButtonStyle.Success),button('reject','رفض',ButtonStyle.Danger))]:
  ['active','won','tie'].includes(g.status)?Array.from({length:4},(_,r)=>new ActionRowBuilder().addComponents(...Array.from({length:4},(_,c)=>{
   const i=r*4+c;return button(String(i),'•',g.phase==='ready'?(g.green===i?ButtonStyle.Success:ButtonStyle.Danger):ButtonStyle.Secondary).setDisabled(g.status!=='active'||g.phase!=='ready');
  }))):[];
 return {content:'',embeds:[embed],components,allowedMentions:{parse:[]}};
}
export function createButtonHandler({config,service,isBankMember,buttonGameManager,onError=()=>{}}){
 let displays=buttonGameManager?.displays;
 return async i=>{
  const action=i.isButton?.()?/^button-game:v1:(\d{17,20}):(\d+):(accept|reject|[0-9]|1[0-5])$/.exec(i.customId||''):null;
  if(!action&&i.commandName!=='زر'&&i.customId!=='button-game:help')return false;
  if(i.guildId!==config.clanGuildId||i.user.bot){await i.reply({content:'اللعبة لأعضاء سيرفر الكلان فقط.',flags:MessageFlags.Ephemeral});return true;}
  if(i.customId==='button-game:help'){await i.reply({content:'لبدء التحدّي اكتب: زر @العضو المبلغ، مثال: زر @العضو 1000. لازم الطرفين يملكون المبلغ، ويبدأ اللعب بعد قبول خصمك.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return true;}
  if(action)await i.deferUpdate();else await i.deferReply({});
  displays ||= gameDisplays(service.buttonGame);
  await displays.runSerial(action?.[1]||i.id,async()=>{
   try{
    const eligible=id=>isBankMember?isBankMember(id):bankMember(i,config,id);
    let g,stale=false;
    if(action)({round:g,stale}=await playGameAction(service.buttonGame,{id:action[1],revision:Number(action[2]),move:action[3],userId:i.user.id,channelId:i.channelId,messageId:i.message?.id},eligible));
    else{
     const target=i.options.getUser('العضو');
     const iconURL=i.user.displayAvatarURL?.({extension:'png',size:128});
     g=await service.buttonGame.open({id:i.id,x:i.user.id,o:target?.id,bot:!!target?.bot,channelId:i.channelId,amount:i.options.getInteger('المبلغ'),requireDelivery:true,
      author:{name:(i.member?.displayName||i.user.username||'عضو الكلان').slice(0,256),...(iconURL?{iconURL}:{})}},eligible);
    }
    const msg=await i.editReply(buttonPayload(g));
    if(msg?.id&&!g.messageId)await service.buttonGame.bind(g.id,msg.id);
    await service.buttonGame.displayed(g);
    if(stale)await i.followUp({content:STALE_GAME_NOTICE,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
   }catch(e){onError(e);const p={content:/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر إكمال الطلب؛ حاول مجددًا.',allowedMentions:{parse:[]}};
    if(action)await i.followUp({...p,flags:MessageFlags.Ephemeral});else await i.editReply({...p,embeds:[],components:[]});}
  });return true;
 };
}
export class ButtonGameManager extends XoManager { constructor(ctx){super({...ctx,game:ctx.service.buttonGame,payload:buttonPayload});} }
