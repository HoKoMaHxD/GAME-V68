import { ActivityGate } from './activity-gate.js';
// Discord interaction tokens last 15 minutes; stop proactively before expiry.
export const BANK_VIEW_LIFETIME = 14 * 60 * 1000;
export class BankLiveViews {
 constructor({store,service,payload,clock=Date.now,onError=()=>{},canRun=()=>true}){Object.assign(this,{store,service,payload,clock,onError,canRun});this.views=new Map();this.gate=new ActivityGate();this.running=null;}
 key(i){return i.message?.id||i.id;}
 async show(i,page=1){
  const key=this.key(i);
  return this.gate.runSerial(key,async()=>{
   // Read the revision before the query: a later settlement must trigger another refresh.
   const revision=this.store.walletRevision||0;
   const [view,settings]=await Promise.all([this.service.bankLeaderboard(i.user.id,page),this.store.settings()]);
   this.store.fence?.assertCurrent();
   const rendered = await i.editReply(this.payload(view,i.user.id,settings?.appearance));
   // A button replaces the prior interaction token for this message.
   let messageId=i.message?.id||rendered?.id;
   if(!messageId && i.fetchReply){try{messageId=(await i.fetchReply())?.id;}catch{}}
   this.store.fence?.assertCurrent();
   const id=messageId||key;
   this.views.delete(key);
   this.views.set(id,{i,page:view.page,revision,expiresAt:this.clock()+BANK_VIEW_LIFETIME});
  });
 }
 tick(){if(this.running||!this.canRun())return this.running||Promise.resolve();this.running=this.refresh().finally(()=>{this.running=null});return this.running;}
 async refresh(){
  for(const [id,entry] of this.views){
   if(this.clock()>=entry.expiresAt){this.views.delete(id);continue;}
   if(entry.revision===(this.store.walletRevision||0))continue;
   await this.gate.runSerial(id,async()=>{
    if(this.views.get(id)!==entry||!this.canRun())return;
    try{
     const revision=this.store.walletRevision||0;
     const [view,settings]=await Promise.all([this.service.bankLeaderboard(entry.i.user.id,entry.page),this.store.settings()]);
     await entry.i.editReply(this.payload(view,entry.i.user.id,settings?.appearance));
     entry.revision=revision;entry.page=view.page;
    }catch(e){if([10008,10015,50027,50001,50013].includes(Number(e.code)))this.views.delete(id);this.onError(e);}
   });
  }
 }
 async drain(){await this.running;}
}
