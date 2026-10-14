import { StaleGameViewError } from './game-display.js';
import { infiniteMove } from './infinite-xo.js';
import { isId } from './config.js';
import { requireBankChannel } from './bank.js';
import { purchaseDebit } from './shop.js';
import { applyAuctionLeg } from './auction.js';
export const XO_WAIT = 30000, XO_TURN = 30000, XO_COOLDOWN = 20 * 60000, XO_MAX = 1000000000;
export const XO_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
export function xoWinner(board) { return XO_LINES.find(line => board[line[0]] && line.every(i => board[i] === board[line[0]])) || null; }
export class XoGame {
 constructor(service, day) { this.service=service; this.store=service.store; this.day=day; this.clanId=service.config.clanGuildId; }
 get prefix(){return 'xo';}
 get name(){return 'اكس';}
 initial(){return {board:Array(9).fill(null),turn:null,xoMode:'infinite',markOrder:{X:[],O:[]}};}
 accepted(g,holds,now){return {...g,status:'active',holds,acceptedAt:now,expiresAt:now+XO_TURN};}
 get games(){return this.store.db.collection(`${this.prefix}_games`);}
 get journals(){return this.store.db.collection(`${this.prefix}_journals`);}
 key(id){return `${this.clanId}:${id}`;}
 get(id){return this.games.findOne({_id:this.key(id)});}
 async initialize(){
  await this.store.requireLease(this.service.clock());
  await this.journals.updateOne({_id:this.clanId},{$setOnInsert:{pending:null}},{upsert:true});
  await this.games.createIndex({clanId:1,status:1,expiresAt:1});
  await this.games.createIndex({clanId:1,dirty:1});
 }
 async recover(){
  const op=(await this.journals.findOne({_id:this.clanId}))?.pending;if(!op)return;
  for(const leg of op.legs){await this.store.requireLease(this.service.clock());await this.store.mutateDay(leg.dayId,s=>{s.financialContext={game:this.name,roundId:op.next.id,initiator:op.next.x,opponent:op.next.o,stake:op.next.amount,status:op.next.status,winner:op.next.winner,reason:op.next.reason,channelId:op.next.channelId,leg};return applyAuctionLeg(s,leg);});}
  if(this.store.financialAudit && ['won','tie','cancelled'].includes(op.next.status)) {
   for(const userId of [op.next.x,op.next.o]) {
    await this.store.requireLease(this.service.clock());
    const day=await this.day(userId,op.next.closedAt || this.service.clock());
    await this.store.mutateDay(day._id,s=>{
     const key=`${this.prefix}:${op.next.id}:result`;
     if(s.financialSettlementReceipts?.includes(key))return false;
     (s.financialSettlementReceipts ||= []).push(key);
     s.financialContext={game:this.name,roundId:op.next.id,initiator:op.next.x,opponent:op.next.o,stake:op.next.amount,winner:op.next.winner,reason:op.next.reason,
      outcome:op.next.winner?(op.next.winner===userId?'فوز':'خسارة'):'تعادل / إلغاء',netResult:op.next.winner?(op.next.winner===userId?op.next.amount:-op.next.amount):0};
     return true;
    });
   }
  }
  await this.store.requireLease(this.service.clock());
  await this.games.replaceOne({_id:op.next._id},op.next,{upsert:true});
  await this.journals.updateOne({_id:this.clanId},{$set:{pending:null}});
 }
 async commit(next,legs=[]){
  // Shared wallet receipts use an xo-prefixed ID; the established balance ledger includes these adjustments.
  for(const leg of legs)applyAuctionLeg(structuredClone(await this.store.getDay(leg.dayId)),leg);
  next={...next,revision:next.revision+1,dirty:true};
  try{
   await this.store.requireLease(this.service.clock());
   if((await this.journals.findOne({_id:this.clanId}))?.pending)throw new Error('Pending XO transfer');
   await this.journals.updateOne({_id:this.clanId},{$set:{pending:{next,legs}}},{upsert:true});
   await this.recover();return next;
  }catch(cause){this.service.blocked=true;throw new Error(`تعذر تأكيد عملية ${this.name}. أُوقفت عمليات الرصيد مؤقتًا؛ ستُستكمل العملية المحفوظة تلقائيًا دون خصم مكرر.`,{cause});}
 }
 run(fn){return this.service.gate.exclusive(()=>{this.service.assertActive();return fn();});}
 // Resolve Discord membership before taking the shared wallet gate. All
 // balances, revisions, settings and settlements are still checked inside it.
 async members(input,eligible,opening=false){
  let ids;
  if(opening)ids=[input.x,input.o].filter(isId);
  else {
   const g=await this.get(input.id);
   if(!g||g.channelId!==input.channelId)throw new Error(`تحدّي ${this.name} غير صالح.`);
   if(![g.x,g.o].includes(input.userId))throw new Error('هذا التحدّي مخصص للطرفين فقط.');
   if(input.messageId&&g.messageId&&input.messageId!==g.messageId)throw new Error(`أكمل التحدّي من رسالته الأصلية: https://discord.com/channels/${this.clanId}/${g.channelId}/${g.messageId}`);
   ids=['pending','active'].includes(g.status)?[g.x,g.o]:[];
  }
  const checks=new Map(await Promise.all([...new Set(ids)].map(async id=>[id,await eligible(id)])));
  return id=>!!checks.get(id);
 }

 async holds(userId=null){return this.games.find({clanId:this.clanId,status:'active',...(userId?{$or:[{x:userId},{o:userId}]}:{})}).toArray();}
 async commandTime(userId,now){
  const latest=await this.games.find({clanId:this.clanId,x:userId,acceptedAt:{$gt:now-XO_COOLDOWN}}).sort({acceptedAt:-1}).limit(1).toArray();
  return latest[0]?{status:'cooldown',nextAt:latest[0].acceptedAt+XO_COOLDOWN}:{status:'ready'};
 }
 async memberReady(id,exclude=null,checkCooldown=true){
  const active=await this.games.find({clanId:this.clanId,status:{$in:['pending','active']},$or:[{x:id},{o:id}]}).toArray();
  if(active.some(g=>g.id!==exclude&&(g.status==='active'||g.x===id)))throw new Error(`أحد الطرفين لديه تحدّي ${this.name} قائم. انتظر انتهاءه.`);
  if(!checkCooldown)return;
  const latest=await this.games.find({clanId:this.clanId,x:id,acceptedAt:{$gt:this.service.clock()-XO_COOLDOWN}}).sort({acceptedAt:-1}).limit(1).toArray();
  if(latest[0])throw new Error(`صاحب التحدّي عليه انتظار إرسال ${this.name}؛ متاح <t:${Math.ceil((latest[0].acceptedAt+XO_COOLDOWN)/1000)}:R>.`);
 }
 async bank(channelId){const settings=await this.store.settings();requireBankChannel(settings?.bank,channelId);return settings.bank;}
 async open(input,eligible){eligible=await this.members(input,eligible,true);return this.run(async()=>{
  const now=this.service.clock();
  if(![input.id,input.x,input.o,input.channelId].every(isId)||input.x===input.o||input.bot)throw new Error(`اكتب ${this.name} @عضو المبلغ؛ لا يمكن تحدي نفسك أو بوت.`);
  if(!Number.isSafeInteger(input.amount)||input.amount<1||input.amount>XO_MAX)throw new Error('المبلغ عدد صحيح من 1 إلى 1,000,000,000.');
  const bank=await this.bank(input.channelId);
  if(!await eligible(input.x)||!await eligible(input.o))throw new Error('الطرفان لازم يكونون أعضاء في سيرفر الكلان.');
  const previous=await this.get(input.id);if(previous)return previous;
  for(const id of [input.x,input.o]){
   await this.memberReady(id,null,id===input.x);
   const available = (await this.store.totals(id,'all',now)).total;
   if(!Number.isSafeInteger(available)||available<=0||available<input.amount)throw new Error(`رصيد <@${id}> لا يكفي مبلغ التحدّي.`);
  }
  return this.commit({...input,_id:this.key(input.id),clanId:this.clanId,bankVersion:bank.channelVersion,createdAt:now,
   timeoutLoss:true,revision:-1,status:'pending',expiresAt:now+XO_WAIT,...this.initial(),turn:input.x,holds:null});
 });}
 async finish(g,status,winner=null,reason=null){
  const legs=[];const now=this.service.clock();
  if(g.holds){
   for(const id of winner?[winner]:[g.x,g.o]){
    const day=await this.day(id,now);const amounts=winner?{tasks:g.amount*2,attendance:0}:g.holds[id];
    const balance=await this.store.totals(id,'all',now);
    if(!Number.isSafeInteger(balance.total+amounts.tasks+amounts.attendance))throw new Error('الرصيد يتجاوز الحد الرقمي.');
    legs.push({id:`${this.prefix}:${g.id}:release:${id}`,userId:id,dayId:day._id,amounts});
   }
  }
  return this.commit({...g,status,winner,reason,closedAt:now,holds:null},legs);
 }
 async timeout(g){
  // Old invitations promised refunds. An undelivered board is not player inactivity.
  if(g.status==='active'&&g.timeoutLoss&&!(g.requireDelivery&&g.dirty))
   return this.finish(g,'won',g.turn===g.x?g.o:g.x,'timeout');
  return this.finish(g,'cancelled',null,'timeout');
 }
 async act({id,userId,revision,move,channelId,messageId},eligible){eligible=await this.members({id,userId,channelId,messageId},eligible);return this.run(async()=>{
  let g=await this.get(id);if(!g||g.channelId!==channelId)throw new Error(`تحدّي ${this.name} غير صالح.`);
  if(![g.x,g.o].includes(userId))throw new Error('هذا التحدّي مخصص للطرفين فقط.');
  if(!['pending','active'].includes(g.status))return g;
  const settings=await this.store.settings();const bank=settings?.bank;
  if(bank?.channelId!==g.channelId)return this.finish(g,'cancelled',null,'settings');
  if(bank.channelVersion!==g.bankVersion||[g.x,g.o].some(id=>g.createdAt<=this.service.bankCutoff(id)))return this.finish(g,'cancelled',null,'settings');
  if(!await eligible(g.x)||!await eligible(g.o))return this.finish(g,'cancelled',null,'membership');
  if(g.expiresAt<=this.service.clock())return this.timeout(g);
  if(revision!==g.revision)throw new StaleGameViewError(g);
  if(g.status==='pending'){
   if(userId!==g.o)throw new Error('القبول والرفض للعضو المتحدّى فقط.');
   if(move==='reject')return this.finish(g,'rejected');
   if(move!=='accept')throw new Error('انتظر قبول التحدّي.');
   const legs=[],holds={},now=this.service.clock();
   for(const who of [g.x,g.o]){
    await this.memberReady(who,g.id,who===g.x);
    const balance=await this.store.totals(who,'all',now);
    if(balance.total<g.amount)return this.finish(g,'cancelled',null,'balance');
    const debit=purchaseDebit(balance,g.amount);holds[who]=debit;
    const day=await this.day(who,now);
    legs.push({id:`${this.prefix}:${g.id}:hold:${who}`,userId:who,dayId:day._id,amounts:{tasks:-debit.tasks,attendance:-debit.attendance}});
   }
   return this.commit(this.accepted(g,holds,now),legs);
  }
  if(g.turn!==userId)throw new Error('مو دورك؛ انتظر حركة خصمك.');
  if(!/^[0-8]$/.test(move)||g.board[Number(move)])throw new Error('اختر خانة فارغة.');
  const mark=userId===g.x?'X':'O';
  if(g.xoMode==='infinite')g={...g,...infiniteMove(g,Number(move),mark)};
  else {const board=[...g.board];board[Number(move)]=mark;g={...g,board};}
  const board=g.board;
  const line=xoWinner(board);if(line)return this.finish({...g,line},'won',userId);
  if(g.xoMode!=='infinite'&&board.every(Boolean))return this.finish(g,'tie');
  return this.commit({...g,turn:userId===g.x?g.o:g.x,expiresAt:this.service.clock()+XO_TURN});
 });}
 maintenanceDue(g,bank,now){return bank?.channelId!==g.channelId||bank?.channelVersion!==g.bankVersion||g.expiresAt<=now;}
 async maintain(g,bank,now){
  if(bank?.channelId!==g.channelId||bank?.channelVersion!==g.bankVersion)await this.finish(g,'cancelled',null,'settings');
  else if(g.expiresAt<=now)await this.timeout(g);
 }
 async expire(){
  this.service.assertActive();
  // Discovery is read-only. Never hold the shared wallet barrier while an
  // idle game's scan waits for MongoDB; recheck each candidate under the gate.
  const games=await this.games.find({clanId:this.clanId,status:{$in:['pending','active']}}).toArray();
  if(!games.length)return;
  const bank=(await this.store.settings())?.bank;
  for(const candidate of games){
   if(!this.maintenanceDue(candidate,bank,this.service.clock()))continue;
   await this.run(async()=>{
    const g=await this.get(candidate.id);
    if(!g||!['pending','active'].includes(g.status))return;
    const currentBank=(await this.store.settings())?.bank;
    await this.maintain(g,currentBank,this.service.clock());
   });
  }
 }
 bind(id,messageId){return this.run(async()=>{await this.store.requireLease(this.service.clock());await this.games.updateOne({_id:this.key(id),$or:[{messageId:{$exists:false}},{messageId:null},{messageId}]},{$set:{messageId}});});}
 displayed(g){return this.run(async()=>{await this.store.requireLease(this.service.clock());await this.games.updateOne({_id:g._id,revision:g.revision},{$set:{dirty:false}});});}
 dirty(){return this.games.find({clanId:this.clanId,dirty:true,messageId:{$exists:true}}).toArray();}
}
