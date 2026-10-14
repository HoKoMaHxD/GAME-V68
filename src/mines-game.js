import { StaleGameViewError } from './game-display.js';
import { randomInt } from 'node:crypto';
import { XoGame, XO_TURN } from './xo.js';
import { MINE_CELLS } from './robbery-mine.js';
export class MinesGame extends XoGame {
 get prefix(){return 'mines';}
 get name(){return 'الغام';}
 initial(){return {mine:randomInt(1,10),picks:[]};}
 accepted(g,holds,now){return {...super.accepted(g,holds,now),turn:randomInt(0,2)===0?g.x:g.o};}
 async act(input,eligible){
  if(['accept','reject'].includes(input.move))return super.act(input,eligible);
  eligible=await this.members(input,eligible);
  return this.run(async()=>{
   const g=await this.get(input.id);if(!g||g.channelId!==input.channelId)throw new Error('تحدّي الغام غير صالح.');
   if(![g.x,g.o].includes(input.userId))throw new Error('هذا التحدّي مخصص للطرفين فقط.');
   if(!['pending','active'].includes(g.status))return g;
   const settings=await this.store.settings();const bank=settings?.bank;
   if(bank?.channelId!==g.channelId||bank.channelVersion!==g.bankVersion||[g.x,g.o].some(id=>g.createdAt<=this.service.bankCutoff(id)))return this.finish(g,'cancelled',null,'settings');
   if(!await eligible(g.x)||!await eligible(g.o))return this.finish(g,'cancelled',null,'membership');
   if(g.expiresAt<=this.service.clock())return this.timeout(g);
   if(g.status!=='active')throw new Error('انتظر قبول التحدّي.');
   if(input.revision!==g.revision)throw new StaleGameViewError(g);
   if(g.turn!==input.userId)throw new Error('مو دورك؛ انتظر اختيار خصمك.');
   const cell=Number(input.move);
   if(!/^[1-9]$/.test(input.move)||!MINE_CELLS.includes(cell)||g.picks.some(p=>p.cell===cell))throw new Error('اختر رقمًا غير مكشوف من 1 إلى 9.');
   const picks=[...g.picks,{cell,userId:input.userId}];
   if(cell===g.mine)return this.finish({...g,picks,loser:input.userId},'won',input.userId===g.x?g.o:g.x,'mine');
   return this.commit({...g,picks,turn:input.userId===g.x?g.o:g.x,expiresAt:this.service.clock()+XO_TURN});
  });
 }
}
