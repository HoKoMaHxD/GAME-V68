import { randomInt } from 'node:crypto';
import { isId } from './config.js';
import { requireBankChannel } from './bank.js';
import { MiniGames, MINI_COOLDOWN, miniMoney } from './mini-games.js';
export const MEMORY_LEVELS = Object.freeze([
  Object.freeze({id:'easy',name:'سهل',maxAttempts:20}),
  Object.freeze({id:'medium',name:'متوسط',maxAttempts:16}),
  Object.freeze({id:'hard',name:'صعب',maxAttempts:12})
]);
export const MEMORY_TURN_MS = 30000;
export const MEMORY_REVEAL_MS = 2000;
export const MEMORY_EMOJIS = ['🍌','🍎','🍇','🍓','🍒','🍉','🥝','🍍'];
export function memoryBoard(choose=randomInt) {
  const board=[...MEMORY_EMOJIS,...MEMORY_EMOJIS];
  for(let i=board.length-1;i>0;i--){const j=choose(0,i+1);if(!Number.isInteger(j)||j<0||j>i)throw new Error('تعذر خلط البطاقات.');[board[i],board[j]]=[board[j],board[i]];}
  return board;
}
export class MemoryGame extends MiniGames {
  latest(userId){return this.store.latestMiniGame(userId,'memory');}
  pending(){return this.store.db.collection('days').find({clanId:this.service.config.clanGuildId,$or:[{'miniGames.memory.status':'open'},{miniDirty:true}]}).toArray();}
  async open(input,eligible,choose=randomInt){const member=isId(input.userId)&&await eligible(input.userId);return this.service.gate.exclusive(async()=>{
    this.service.assertActive();const now=this.service.clock();
    if(![input.id,input.userId,input.channelId].every(isId)||!Number.isSafeInteger(input.at)||input.at>now+5000||now-input.at>900000||input.at<=this.service.bankCutoff(input.userId))throw new Error('طلب اللعبة غير صالح. اكتب تشابه مجددًا.');
    const bank=requireBankChannel((await this.store.settings())?.bank,input.channelId);
    if(!member)throw new Error('اللعبة لأعضاء سيرفر الكلان فقط.');
    await this.store.requireLease(now);
    const day=await this.latest(input.userId);let round=day?.miniGames?.memory;
    if(round?.status==='open')round=await this.advance(day,round,{timeout:true},bank);
    if(round?.id===input.id||round?.status==='open')return round;
    if(round&&now<round.nextAt)return {kind:'memory',status:'cooldown',nextAt:round.nextAt};
    const balance=await this.store.totals(input.userId,'all',now);
    if(balance.total<=0)throw new Error('تحتاج رصيدًا أكبر من صفر للعب.');
    const percent=choose(5,11);
    if(!Number.isInteger(percent)||percent<5||percent>10)throw new Error('نسبة اللعبة غير صالحة.');
    const levelIndex=choose(0,MEMORY_LEVELS.length);
    if(!Number.isInteger(levelIndex)||levelIndex<0||levelIndex>=MEMORY_LEVELS.length)throw new Error('تعذر تحديد مستوى اللعبة.');
    const level=MEMORY_LEVELS[levelIndex];
    const state=await this.day(input.userId,now);
    return this.save(state,{kind:'memory',id:input.id,userId:input.userId,channelId:input.channelId,bankVersion:bank.channelVersion,
      createdAt:now,nextAt:now+MINI_COOLDOWN,expiresAt:now+MEMORY_TURN_MS,revision:0,displayRevision:-1,delivered:false,
      status:'open',phase:'choose',board:memoryBoard(choose),matched:[],flipped:[],attempts:0,maxAttempts:level.maxAttempts,level:level.id,levelName:level.name,
      economyVersion:2,percent,hideAt:null,author:input.author||{name:'عضو الكلان'}});
  });}
  async settle(day,round,outcome,reason){
    const now=this.service.clock(),balance=await this.store.totals(round.userId,'all',now);
    // Honor the terms of rounds opened before percentage rewards were introduced.
    let result;
    if(round.economyVersion===2)result=miniMoney(balance,outcome,round.percent);
    else {
      const amount=outcome==='win'?round.reward:0;
    if(!Number.isSafeInteger(balance.total+amount)||!Number.isSafeInteger(balance.tasks+amount))throw new Error('الرصيد يتجاوز الحد الرقمي.');
    result={outcome,amount,before:balance.total,after:balance.total+amount,amounts:{tasks:amount,attendance:0}};
    }
    return this.save(day,{...round,revision:round.revision+1,status:'settled',result,settledAt:now,endReason:reason},result);
  }
  async advance(day,saved,input,bank){
    if(saved.status!=='open')return saved;
    const now=this.service.clock(),g=structuredClone(saved);
    if(g.createdAt<=this.service.bankCutoff(g.userId)||bank.channelId!==g.channelId||bank.channelVersion!==g.bankVersion)
      return this.save(day,{...g,revision:g.revision+1,status:'cancelled'});
    if(g.phase==='reveal'){
      if(g.hideAt===null){
        if(now>=g.expiresAt)return this.save(day,{...g,revision:g.revision+1,status:'cancelled'});
        return saved;
      }
      if(now<g.hideAt)return saved;
      if(g.attempts>=g.maxAttempts)return this.settle(day,g,'loss','attempts');
      // Never let the press that triggered hiding select an unseen third card.
      return this.save(day,{...g,revision:g.revision+1,phase:'choose',flipped:[],hideAt:null,expiresAt:now+MEMORY_TURN_MS});
    }
    if(now>=g.expiresAt){
      if(g.displayRevision!==g.revision)return this.save(day,{...g,revision:g.revision+1,status:'cancelled'});
      return this.settle(day,g,'loss','timeout');
    }
    if(input.timeout)return saved;
    if(input.revision!==g.revision||g.displayRevision!==g.revision)return saved;
    if(!/^(?:[0-9]|1[0-5])$/.test(String(input.move)))throw new Error('اختر بطاقة صالحة.');
    const cell=Number(input.move);
    if(g.matched.includes(cell)||g.flipped.includes(cell))return saved;
    g.flipped.push(cell);g.expiresAt=now+MEMORY_TURN_MS;
    if(g.flipped.length===2){
      g.attempts++;
      const [a,b]=g.flipped;
      if(g.board[a]===g.board[b]){
        g.matched.push(a,b);g.flipped=[];
        if(g.matched.length===16)return this.settle(day,g,'win','complete');
        if(g.attempts>=g.maxAttempts)return this.settle(day,g,'loss','attempts');
      }else{g.phase='reveal';g.hideAt=null;}
    }
    return this.save(day,{...g,revision:g.revision+1});
  }
  async play(input,eligible){const member=isId(input.userId)&&await eligible(input.userId);return this.service.gate.exclusive(async()=>{
    this.service.assertActive();
    if(![input.id,input.userId,input.channelId].every(isId))throw new Error('زر اللعبة غير صالح.');
    if(!member)throw new Error('اللعبة لأعضاء سيرفر الكلان فقط.');
    const day=await this.latest(input.userId),g=day?.miniGames?.memory;
    if(!g||g.id!==input.id||g.channelId!==input.channelId)throw new Error('هذه لعبة قديمة. اكتب تشابه مجددًا.');
    this.requireMessage(g,input.messageId);
    return this.advance(day,g,input,(await this.store.settings())?.bank||{});
  });}
  markDisplayed(round){return this.service.gate.exclusive(async()=>{
    this.service.assertActive();await this.store.requireLease(this.service.clock());
    const day=await this.latest(round.userId);if(!day)return;
    await this.store.mutateDay(day._id,draft=>{
      const g=draft.miniGames?.memory;
      if(g?.id!==round.id||g.revision!==round.revision)return false;
      g.displayRevision=g.revision;
      if(g.phase==='reveal'&&g.hideAt===null)g.hideAt=this.service.clock()+MEMORY_REVEAL_MS;
      draft.miniDirty=Object.values(draft.miniGames).some(r=>r.messageId&&r.displayRevision!==r.revision);return true;
    });
  });}
  get kinds(){return ['memory'];}
  maintenanceDue(g,bank,now){return super.maintenanceDue(g,bank,now)||bank.channelVersion!==g.bankVersion
    ||(g.phase==='reveal'&&g.hideAt!==null&&now>=g.hideAt);}
}
