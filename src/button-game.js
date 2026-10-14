import { StaleGameViewError } from './game-display.js';
import { randomInt } from 'node:crypto';
import { XoGame } from './xo.js';
export class ButtonGame extends XoGame {
 get prefix(){return 'button';}
 get name(){return 'زر';}
 initial(){return {phase:'waiting',green:null};}
 accepted(g,holds,now){return {...g,status:'active',holds,acceptedAt:now,phase:'waiting',green:null,revealAt:now+randomInt(3000,7001),expiresAt:now+37000};}
 async timeout(g){return this.finish(g,g.status==='active'?'tie':'cancelled',null,'timeout');}
 async act(input,eligible){
  if(['accept','reject'].includes(input.move))return super.act(input,eligible);
  eligible=await this.members(input,eligible);
  return this.run(async()=>{
   const g=await this.get(input.id);if(!g||g.channelId!==input.channelId)throw new Error('تحدّي زر غير صالح.');
   if(![g.x,g.o].includes(input.userId))throw new Error('هذا التحدّي مخصص للطرفين فقط.');
   if(!['pending','active'].includes(g.status))return g;
   const settings=await this.store.settings();const bank=settings?.bank;
   if(bank?.channelId!==g.channelId||bank.channelVersion!==g.bankVersion)return this.finish(g,'cancelled',null,'settings');
   if(!await eligible(g.x)||!await eligible(g.o))return this.finish(g,'cancelled',null,'membership');
   if(g.expiresAt<=this.service.clock())return this.timeout(g);
   if(input.revision!==g.revision||g.dirty)throw new StaleGameViewError(g,'انتظر ظهور الزر الأخضر في اللوحة الحالية.');
   if(g.status!=='active'||g.phase!=='ready')throw new Error('انتظر ظهور الزر الأخضر في اللوحة الحالية.');
   if(!/^([0-9]|1[0-5])$/.test(input.move)||Number(input.move)!==g.green)throw new Error('هذا مو الزر الأخضر؛ اضغط الأخضر للفوز.');
   return this.finish(g,'won',input.userId);
  });
 }
 maintenanceDue(g,bank,now){return super.maintenanceDue(g,bank,now)
  ||(g.status==='active'&&g.phase==='waiting'&&now>=g.revealAt);}
 async maintain(g,bank,now){
  if(super.maintenanceDue(g,bank,now))return super.maintain(g,bank,now);
  if(g.status==='active'&&g.phase==='waiting'&&now>=g.revealAt)await this.commit({...g,phase:'ready',green:randomInt(0,16),expiresAt:now+30000});
 }
}
