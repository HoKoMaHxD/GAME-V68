import { ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,MessageFlags,SlashCommandBuilder } from 'discord.js';
import { bankMember } from './bank.js';
import { gameDisplays, GameDisplayJobs, STALE_GAME_NOTICE } from './game-display.js';
export function buildMemoryCommand(){return new SlashCommandBuilder().setName('تشابه').setDescription('اكشف 8 أزواج بمستوى عشوائي: سهل أو متوسط أو صعب؛ كل 20 دقيقة');}
export function memoryPayload(g){
  const embed=new EmbedBuilder().setColor(0x8b5cf6).setTitle('🧠 تشابه');if(g.author)embed.setAuthor(g.author);
  if(g.status==='cooldown')return {content:'',embeds:[embed.setDescription(`تقدر تلعب مجددًا <t:${Math.ceil(g.nextAt/1000)}:R>. الانتظار 20 دقيقة بين الجولات.`)],components:[],allowedMentions:{parse:[]}};
  const detail=g.status==='cancelled'?'أُلغيت الجولة دون خصم أو مكافأة.'
    :g.status==='settled'?g.result.outcome==='win'?`🎉 كشفت كل الأزواج! مكافأتك **${g.result.amount.toLocaleString('en-US')} 💵**${g.result.percent?` (${g.result.percent}%)`:''}.\nرصيدك: **${g.result.after.toLocaleString('en-US')} 💵**.`
      :`${g.endReason==='timeout'?'⏰ انتهت مهلة الاختيار.':'انتهت المحاولات.'} ${g.economyVersion===2?`خسرت **${g.result.amount.toLocaleString('en-US')} 💵** (${g.result.percent}%).\nرصيدك: **${g.result.after.toLocaleString('en-US')} 💵**.`:'لم تكمل الأزواج؛ لم يُخصم شيء من رصيدك.'}`
    :g.phase==='reveal'?'الإيموجيان مختلفان! احفظ مكانيهما؛ تُغلق البطاقتان بعد ثانيتين، ثم تقدر تختار من جديد.'
      :`${g.flipped.length?'اختر البطاقة الثانية وابحث عن الإيموجي المطابق.':'اختر بطاقتين متشابهتين. أماكن الإيموجيات ثابتة طول الجولة.'}\n⏱️ لديك 30 ثانية للاختيار؛ تنتهي <t:${Math.ceil(g.expiresAt/1000)}:R>.`;
  embed.setDescription(`<@${g.userId}>\n\n${detail}\n\nالمستوى: **${g.levelName||'النظام السابق'}**\nالأزواج المكتشفة: **${g.matched.length/2} / 8**\nالمحاولات المتبقية: **${g.maxAttempts-g.attempts} / ${g.maxAttempts}**\n${g.status==='open'?`${g.economyVersion===2?'الفوز يزيد رصيدك والخسارة تخصم منه **5%–10%**، تُحسب من رصيدك وقت النتيجة. نفاد المحاولات أو مهلة الاختيار يُحسب خسارة.':`مكافأة الفوز: **${g.reward} 💵** • الخسارة بدون خصم.`}\nكل اختيار لبطاقتين يُحسب محاولة.`:''}`)
    .setFooter({text:'سنو • لعبة فردية • كل 20 دقيقة'});
  const components=Array.from({length:4},(_,row)=>new ActionRowBuilder().addComponents(...Array.from({length:4},(_,col)=>{
    const cell=row*4+col,matched=g.matched.includes(cell),shown=matched||g.flipped.includes(cell);
    // Neither the emoji nor the pairing is encoded in a hidden card's payload.
    const b=new ButtonBuilder().setCustomId(`memory:v1:${g.userId}:${g.id}:${g.revision}:${cell}`)
      .setLabel(shown?'\u200b':String(cell+1)).setStyle(matched?ButtonStyle.Success:shown?ButtonStyle.Primary:ButtonStyle.Secondary)
      .setDisabled(g.status!=='open'||g.phase==='reveal'||shown);
    if(shown)b.setEmoji(g.board[cell]);return b;
  })));
  return {content:'',embeds:[embed],components,allowedMentions:{parse:[]}};
}
export function createMemoryHandler({config,service,isBankMember,memoryManager,onError=()=>{}}){
 let displays=memoryManager?.displays;
 return async i=>{
  const action=i.isButton?.()?/^memory:v1:(\d{17,20}):(\d{17,20}):(\d+):([0-9]|1[0-5])$/.exec(i.customId||''):null;
  if(!action&&i.commandName!=='تشابه'&&i.customId!=='memory:start')return false;
  const deny=content=>i.reply({content,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
  if(i.guildId!==config.clanGuildId||i.user.bot){await deny('اللعبة لأعضاء سيرفر الكلان فقط.');return true;}
  if(action&&action[1]!==i.user.id){await deny('هذه لعبة عضو آخر. اكتب تشابه لبدء لعبتك.');return true;}
  if(action)await i.deferUpdate();else await i.deferReply({});
  displays ||= gameDisplays(service.memory);
  await displays.runSerial(i.user.id,async()=>{
    try{
      const previous=action?(await service.memory.latest(i.user.id))?.miniGames?.memory:null;
      const stale=!!action&&previous?.id===action[2]&&previous?.revision!==Number(action?.[3]);
      const eligible=id=>isBankMember?isBankMember(id):bankMember(i,config,id);
      const g=action?await service.memory.play({userId:i.user.id,id:action[2],revision:Number(action[3]),move:action[4],channelId:i.channelId,messageId:i.message?.id},eligible)
        :await service.memory.open({id:i.id,userId:i.user.id,channelId:i.channelId,at:i.createdTimestamp||service.clock(),author:{name:i.member?.displayName||i.user.username||'عضو الكلان'}},eligible);
      if(!action&&g.status==='open'&&g.id!==i.id&&g.messageId){await i.editReply({content:`عندك جولة مستمرة؛ أكملها هنا: https://discord.com/channels/${config.clanGuildId}/${g.channelId}/${g.messageId}`,allowedMentions:{parse:[]}});return;}
      const message=await i.editReply(memoryPayload(g));
      if(g.status!=='cooldown'&&message?.id){if(!g.messageId)await service.memory.bind(g,message.id);await service.memory.markDisplayed(g);}
      if(stale&&g.status==='open')await i.followUp({content:STALE_GAME_NOTICE,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
    }catch(e){onError(e);const p={content:/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر إكمال اللعبة. حاول مجددًا.',allowedMentions:{parse:[]}};
      if(action)await i.followUp({...p,flags:MessageFlags.Ephemeral});else await i.editReply({...p,embeds:[],components:[]});}
  });return true;
 };
}
export class MemoryManager {
 constructor({bot,service,canRun,onError=()=>{}}){Object.assign(this,{bot,service,canRun,onError});this.displays=gameDisplays(service.memory);this.jobs=new GameDisplayJobs(onError);this.running=null;}
 tick(){if(this.running)return this.running;this.running=this.update().finally(()=>{this.running=null;});return this.running;}
 async update(){
   if(!this.canRun())return;
   await this.service.memory.expire();
   for(const day of await this.service.memory.pending()){
     const row=day.miniGames?.memory;if(!row?.messageId||row.displayRevision===row.revision)continue;
     this.jobs.add(row.userId,()=>this.displays.runSerial(row.userId,async()=>{
       if(!this.canRun())return;
       let g=(await this.service.memory.latest(row.userId))?.miniGames?.memory;
       if(g?.id!==row.id||g.displayRevision===g.revision)return;
       try{
         const channel=await this.bot.channels.fetch(g.channelId);if(channel?.guildId!==this.service.config.clanGuildId)return;
         const message=await channel.messages.fetch(g.messageId);if(message.author.id!==this.bot.user.id)return;
         if(!this.canRun())return;
         g=(await this.service.memory.latest(row.userId))?.miniGames?.memory;
         if(g?.id!==row.id||g.messageId!==row.messageId||g.displayRevision===g.revision)return;
         await message.edit(memoryPayload(g));await this.service.memory.markDisplayed(g);
       }catch(e){
         this.onError(e);
         if([10008,10003,50001,50013].includes(Number(e.code)))await this.service.gate.exclusive(async()=>{
           const d=await this.service.memory.latest(g.userId),latest=d?.miniGames?.memory;
           if(latest?.id===g.id){const r=latest.status==='open'?await this.service.memory.save(d,{...latest,revision:latest.revision+1,status:'cancelled'}):latest;
             await this.service.store.mutateDay(d._id,draft=>{draft.miniGames.memory.displayRevision=r.revision;draft.miniDirty=Object.values(draft.miniGames).some(x=>x.messageId&&x.displayRevision!==x.revision);return true;});}
         });
       }
     }));
   }
 }
 async drain(){await this.running;await this.jobs.drain();}
}
