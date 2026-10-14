import test from 'node:test';
import assert from 'node:assert/strict';
import { financialEvent,stageFinancial,archiveFinancial,FinancialLogger,FINANCIAL_CHANNEL } from '../src/financial-log.js';
const before={_id:'day',clanId:'clan',userId:'user',revision:4,points:{tasks:100,attendance:20},tasks:[{id:'t',title:'مهمة'}]};
test('task payout logs wallet delta and boost without replaying old receipts',()=>{
 const after=structuredClone(before);after.points.tasks+=300;after.completionLog=[{taskId:'t',cycle:1,points:300,multiplier:3,basePoints:100}];
 const e=financialEvent(before,after,5000,1000);assert.equal(e.after,5300);assert.equal(e.delta,300);assert.equal(e.tasks[0].multiplier,3);
 assert.equal(financialEvent(after,after,5300,1000),null);
});
test('equal net change still records component transfer and zero result receipt',()=>{
 const after=structuredClone(before);after.pointAdjustments={tasks:10,attendance:-10};assert.equal(financialEvent(before,after,120,1).delta,0);
 after.financialSettlementReceipts=['xo:round:result'];assert.ok(financialEvent(before,after,120,1).receipts.financialSettlementReceipts);
});
test('staged event shares day write and archival is idempotent',async()=>{
 const archive=new Map();const removed=[];const store={financialAudit:true,totals:async()=>({total:900}),db:{collection:name=>({updateOne:async(q,u)=>{if(name==='financial_logs'){if(!archive.has(q._id))archive.set(q._id,u.$setOnInsert);}else removed.push(u);}})}};
 const after=structuredClone(before);after.salaryCredits=50;await stageFinancial(store,before,after);assert.equal(after.financialPending[0].after,950);
 await archiveFinancial(store,after);await archiveFinancial(store,after);assert.equal(archive.size,1);assert.equal(removed.length,2);
});
test('delivery recovers existing Discord message after acknowledgment failure',async()=>{
 const e=financialEvent(before,{...before,salaryCredits:50},120,1000);let sent=0,marked=0;
 const cursor=data=>({limit(){return this},sort(){return this},toArray:async()=>data});
 const store={config:{clanGuildId:'clan'},requireLease:async()=>{},db:{collection:name=>name==='days'?{find:()=>cursor([])}:{find:()=>cursor([e]),updateOne:async()=>marked++}}};
 const channel={guildId:'clan',isTextBased:()=>true,messages:{fetch:async()=>new Map([['m',{id:'m',author:{id:'bot'},embeds:[{footer:{text:`سجل مالي #${e._id}`}}]}]])},send:async()=>{sent++;return{id:'new'}}};
 const logger=new FinancialLogger({store,bot:{user:{id:'bot'},channels:{fetch:async id=>{assert.equal(id,FINANCIAL_CHANNEL);return channel;}}},canRun:()=>true,onError:e=>{throw e}});
 await logger.tick();assert.equal(sent,0);assert.equal(marked,1);
});

test('full reset recreation cannot reuse an archived financial ID',async()=>{
 const store={financialAudit:true,totals:async()=>({total:100})};
 const a={...structuredClone(before),salaryCredits:20};const b={...structuredClone(before),salaryCredits:20};
 await stageFinancial(store,before,a);await stageFinancial(store,before,b);
 assert.notEqual(a.financialPending[0]._id,b.financialPending[0]._id);
 const saved=structuredClone(a),next=structuredClone(a);next.salaryCredits=30;
 await stageFinancial(store,saved,next);assert.equal(next.financialEpoch,saved.financialEpoch);
});
