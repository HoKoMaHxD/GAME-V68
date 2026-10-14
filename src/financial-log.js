import { createHash, randomUUID } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { netPoints } from './point-adjustments.js';
export const FINANCIAL_CHANNEL = '1554179860396642335';
const fields = {points:'مكافآت المهام والحضور',pointAdjustments:'تعديل إداري',shopAdjustments:'شراء من المتجر',robberyAdjustments:'نهب',auctionAdjustments:'حجز / تسوية مزاد أو تحدي',protectionAdjustments:'شراء حماية',miniAdjustments:'نرد / ألوان',bankResetAdjustments:'تصفير البنك',salaryCredits:'راتب',prizeCredits:'جائزة'};
const logs = ['completionLog','adjustmentLog','balanceFloorReceipts','salaryReceipts','prizeReceipts','miniReceipts','auctionReceipts','robberyReceipts','shopReceipts','protectionReceipts','financialSettlementReceipts'];
export function financialEvent(before, after, balance, now) {
 const changes = Object.entries(fields).filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(([key,label])=>({source:label,field:key,before:before[key]??0,after:after[key]??0}));
 const delta = netPoints(after).total-netPoints(before).total;
 const receipts = {};
 for(const key of logs){const known=new Set((before[key]||[]).map(x=>JSON.stringify(x)));const added=(after[key]||[]).filter(x=>!known.has(JSON.stringify(x)));if(added.length)receipts[key]=added;}
 if(!delta && !Object.keys(receipts).length && !changes.length)return null;
 const id=createHash('sha256').update(`${after._id}:${after.financialEpoch || after.createdAt || 0}:${(before.revision||0)+1}`).digest('hex').slice(0,24);
 return {_id:id,clanId:after.clanId,userId:after.userId,dayId:after._id,at:now,delta,before:balance,after:balance+delta,changes,receipts,
  tasks:(receipts.completionLog||[]).map(e=>({...e,title:after.tasks?.find(t=>t.id===e.taskId)?.title})),context:after.financialContext||null,delivered:false};
}
export async function stageFinancial(store,before,after){
 if(!store.financialAudit)return;
 after.financialEpoch ||= randomUUID();
 const event=financialEvent(before,after,0,Date.now());
 if(event){const balance=(await store.totals(after.userId,'all',Date.now())).total;event.before=balance;event.after=balance+event.delta;(after.financialPending ||= []).push(event);}
 delete after.financialContext;
}
export async function archiveFinancial(store,day){
 for(const event of day.financialPending||[])await store.db.collection('financial_logs').updateOne({_id:event._id},{$setOnInsert:event},{upsert:true});
 // Atomic pull leaves concurrently appended events intact. A stale replacement can
 // restore old IDs, but archive IDs and delivered markers prevent another send.
 if(day.financialPending?.length)await store.db.collection('days').updateOne({_id:day._id},{$pull:{financialPending:{_id:{$in:day.financialPending.map(e=>e._id)}}}});
}
export function financialPayload(e){
 const ltr=value=>`\u2066\`${String(value).replaceAll('`','')}\`\u2069`;
 const money=n=>ltr(`${Number(n).toLocaleString('en-US')} $`);
 const signed=n=>ltr(`${n>0?'+':''}${Number(n).toLocaleString('en-US')} $`);
 const context=e.context||{}, result=Number.isFinite(context.netResult)?context.netResult:null;
 const amount=result??e.delta;
 const reason=[...new Set((e.changes||[]).map(c=>c.source))].join(' • ')||'نتيجة التحدي';
 const title=result!==null?(amount>0?'🏆 فوز في التحدي':amount<0?'❌ خسارة في التحدي':'🤝 تعادل / إلغاء التحدي'):(amount>0?'💰 إضافة رصيد':amount<0?'💸 خصم / حجز رصيد':'⚖️ تسوية مالية');
 const embed=new EmbedBuilder().setTitle(title).setColor(amount>0?0x4fb687:amount<0?0xc96565:0xf2b84b)
  .setDescription(`<@${e.userId}>\n**${context.game?`لعبة ${context.game}`:reason}**`)
  .addFields({name:'الرصيد قبل',value:money(e.before),inline:true},
   {name:'حركة الرصيد',value:signed(e.delta),inline:true},
   {name:'الرصيد بعد',value:money(e.after),inline:true});
 if(result!==null)embed.addFields({name:'صافي نتيجة القيم',value:`${signed(result)}\n${e.delta===0?'تم احتساب الحجز والتسوية في سجلاتهما السابقة؛ هذا سجل النتيجة فقط.':'صافي النتيجة يشمل مبلغ التحدي المحجوز.'}`});
 const lines=[];
 const text=value=>String(value).replace(/[\r\n]+/g,' ').slice(0,250);
 const add=(label,value)=>{if(value!==undefined&&value!==null&&value!=='')lines.push(`**${label}:** ${value}`);};
 for(const [key,label] of [['initiator','صاحب التحدي'],['opponent','الطرف الثاني'],['winner','الفائز'],['actorId','المسؤول'],['targetId','الطرف المستهدف']])if(context[key])add(label,`<@${context[key]}>`);
 if(context.stake!==undefined)add('مبلغ التحدي',money(context.stake));
 if(context.channelId)add('الشات',`<#${context.channelId}>`);
 if(context.outcome)add('النتيجة',text(context.outcome));
 const reasons={mine:'اختيار اللغم',timeout:'انتهاء المهلة',delivery:'تعذر عرض اللعبة',settings:'تغيير الإعدادات',membership:'تغير عضوية أحد الطرفين',balance:'الرصيد غير كافٍ'};
 if(context.reason)add('السبب',reasons[context.reason]||text(context.reason));
 for(const [key,label] of [['roundId','معرف الجولة'],['operationId','معرف العملية'],['id','معرف العملية']])if(context[key])add(label,ltr(context[key]));
 for(const task of e.tasks||[])add(task.title||'مهمة',`${money(task.points)}${task.multiplier?` • ${ltr(`×${task.multiplier}`)}`:''}`);
 // Keep useful receipt details in the embed; raw audit records stay in MongoDB.
 for(const [key,entries] of Object.entries(e.receipts||{})){
  if(key==='completionLog'||key==='financialSettlementReceipts')continue;
  for(const receipt of entries||[]){
   if(typeof receipt!=='object'){add('مرجع العملية',ltr(receipt));continue;}
   if(receipt.kind)add('اللعبة',({dice:'نرد',colors:'ألوان',memory:'تشابه'})[receipt.kind]||text(receipt.kind));
   if(receipt.actorId)add('المسؤول',`<@${receipt.actorId}>`);
   if(receipt.reason)add('السبب',text(receipt.reason));
   if(receipt.percent!==undefined)add('النسبة',ltr(`${receipt.percent}%`));
   if(receipt.outcome)add('النتيجة',({win:'فوز',loss:'خسارة',tie:'تعادل'})[receipt.outcome]||text(receipt.outcome));
   if(receipt.amount!==undefined)add('المبلغ',money(receipt.amount));
   if(receipt.id||receipt.operationId)add('مرجع العملية',ltr(receipt.id||receipt.operationId));
  }
 }
 for(const [key,label] of [['name','العنصر'],['productName','المنتج'],['price','السعر'],['source','المصدر']])if(context[key]!==undefined)add(label,key==='price'?money(context[key]):text(context[key]));
 const details=lines.join('\n')||'تم حفظ العملية المالية بنجاح.';
 // One wide field avoids RTL/LTR column collisions and stays within Discord limits.
 embed.addFields({name:'تفاصيل العملية',value:details.length>1024?details.slice(0,970)+'\n… تفاصيل إضافية محفوظة في السجل الداخلي.':details});
 embed.setTimestamp(e.at).setFooter({text:`سجل مالي • ${e._id}`});
 return {embeds:[embed],allowedMentions:{parse:[]},nonce:e._id,enforceNonce:true};
}
export class FinancialLogger{
 constructor(ctx){Object.assign(this,ctx);this.running=null;}
 tick(){if(this.running||!this.canRun())return this.running||Promise.resolve();this.running=this.flush().catch(this.onError).finally(()=>{this.running=null;});return this.running;}
 async drain(){await this.running;}
 async flush(){
  const store=this.store,clanId=store.config.clanGuildId;
  for(const day of await store.db.collection('days').find({clanId,'financialPending.0':{$exists:true}}).limit(100).toArray())await archiveFinancial(store,day);
  const events=await store.db.collection('financial_logs').find({clanId,delivered:false}).sort({at:1,_id:1}).limit(20).toArray();if(!events.length)return;
  const channel=await this.bot.channels.fetch(FINANCIAL_CHANNEL);if(channel?.guildId!==clanId||!channel.isTextBased())throw new Error('شات السجل المالي غير متاح في سيرفر الكلان.');
  const history=await channel.messages.fetch({limit:100});
  for(const e of events){if(!this.canRun())break;await store.requireLease(Date.now());
   const existing=[...history.values()].find(m=>m.author?.id===this.bot.user.id&&m.embeds?.some(x=>[ `سجل مالي • ${e._id}`, `سجل مالي #${e._id}` ].includes(x.footer?.text)));
   const message=existing||await channel.send(financialPayload(e));
   await store.db.collection('financial_logs').updateOne({_id:e._id},{$set:{delivered:true,messageId:message.id,deliveredAt:Date.now()}});
  }
 }
}
