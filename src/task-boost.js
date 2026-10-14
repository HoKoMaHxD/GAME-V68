import { isId } from './config.js';
import { validateAppearancePatch } from './appearance.js';
export const BOOST_ROLE_ID='1516418133131268187';
export function boostedReward(base,at,boost){
 const active=boost&&at>=boost.startsAt&&at<boost.endsAt;
 const multiplier=active?boost.multiplier:1;
 if(!Number.isSafeInteger(multiplier)||multiplier<1||multiplier>100)throw new Error('مضاعف مكافآت المهام غير صالح.');
 const points=base*multiplier;
 if(!Number.isSafeInteger(points)||points<0)throw new Error('مكافأة المهمة تتجاوز الحد الرقمي للرصيد.');
 return {points,multiplier,...(active?{boostId:boost.id}:{})};
}
export class TaskBoosts{
 constructor(service){this.service=service;this.store=service.store;this.clanId=service.config.clanGuildId;}
 get collection(){return this.store.db.collection('task_boosts');}
 key(id){return `${this.clanId}:${id}`;}
 get(id){return this.collection.findOne({_id:this.key(id)});}
 create(input){return this.service.gate.exclusive(async()=>{
  this.service.assertActive();const now=this.service.clock();
  if(![input.id,input.actorId,input.channelId].every(isId))throw new Error('معرف أمر الدبل غير صالح.');
  if(!Number.isSafeInteger(input.multiplier)||input.multiplier<2||input.multiplier>100)throw new Error('المضاعف من 2 إلى 100، مثل 2 لدبل ×2.');
  if(!Number.isSafeInteger(input.minutes)||input.minutes<1||input.minutes>10080)throw new Error('مدة الدبل من دقيقة إلى 10080 دقيقة.');
  const imageUrl=validateAppearancePatch({imageUrl:input.imageUrl}).imageUrl;if(!imageUrl)throw new Error('صورة إعلان الدبل مطلوبة.');
  const previous=await this.get(input.id);if(previous)return previous;
  const active=await this.store.taskBoostAt(now);if(active)throw new Error(`يوجد دبل ×${active.multiplier} فعال حتى <t:${Math.ceil(active.endsAt/1000)}:R>. انتظر انتهاءه قبل بدء دبل آخر.`);
  const event={...input,imageUrl,clanId:this.clanId,startsAt:now,endsAt:now+input.minutes*60000,announcementDone:false};
  await this.store.requireLease(now);
  try{await this.collection.updateOne({_id:this.key(input.id)},{$setOnInsert:event},{upsert:true});}
  catch(error){const saved=await this.get(input.id).catch(()=>null);if(!saved)throw error;}
  return this.get(input.id);
 });}
 patch(id,fields){return this.service.gate.exclusive(async()=>{this.service.assertActive();await this.store.requireLease(this.service.clock());await this.collection.updateOne({_id:this.key(id)},{$set:fields});});}
 pending(){return this.collection.find({clanId:this.clanId,announcementDone:false}).toArray();}
}
