import { StaleGameViewError } from './game-display.js';
import { randomInt } from 'node:crypto';
import { XoGame, XO_TURN } from './xo.js';
export const numbersLimit = g => g.limit ?? 15;
export class NumbersGame extends XoGame {
 get prefix(){return 'numbers';}
 get name(){return 'ارقام';}
 initial(){return {count:0,picks:[],limit:randomInt(15,26)};}
 accepted(g,holds,now){return {...super.accepted(g,holds,now),turn:randomInt(0,2)===0?g.x:g.o};}
 async act(input,eligible){
  if(['accept','reject'].includes(input.move))return super.act(input,eligible);
  eligible=await this.members(input,eligible);
  return this.run(async()=>{
   const g=await this.get(input.id);if(!g||g.channelId!==input.channelId)throw new Error('تحدّي ارقام غير صالح.');
   if(![g.x,g.o].includes(input.userId))throw new Error('هذا التحدّي مخصص للطرفين فقط.');
   if(!['pending','active'].includes(g.status))return g;
   const settings=await this.store.settings();const bank=settings?.bank;
   if(bank?.channelId!==g.channelId||bank.channelVersion!==g.bankVersion||[g.x,g.o].some(id=>g.createdAt<=this.service.bankCutoff(id)))return this.finish(g,'cancelled',null,'settings');
   if(!await eligible(g.x)||!await eligible(g.o))return this.finish(g,'cancelled',null,'membership');
   if(g.expiresAt<=this.service.clock())return this.timeout(g);
   if(g.status!=='active')throw new Error('انتظر قبول التحدّي.');
   if(input.revision!==g.revision)throw new StaleGameViewError(g);
   if(g.turn!==input.userId)throw new Error('مو دورك؛ انتظر اختيار خصمك.');
   if(!/^[12]$/.test(input.move)||g.count+Number(input.move)>numbersLimit(g))throw new Error(`اختر رقمًا أو رقمين من المتبقي حتى ${numbersLimit(g)}.`);
   const count=g.count+Number(input.move),picks=[...g.picks,...Array.from({length:Number(input.move)},(_,i)=>({cell:g.count+i+1,userId:input.userId}))];
   if(count===numbersLimit(g))return this.finish({...g,count,picks,loser:input.userId},'won',input.userId===g.x?g.o:g.x,'last_number');
   return this.commit({...g,count,picks,turn:input.userId===g.x?g.o:g.x,expiresAt:this.service.clock()+XO_TURN});
  });
 }
}
