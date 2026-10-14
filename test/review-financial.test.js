import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at,user,other,snowflake} from './helpers/shop-fixture.js';
import {financialPayload} from '../src/financial-log.js';
const channelId='100000000000000060';
test('production audit path preserves challenge payouts and stores both outcomes',async()=>{
 const f=await fixture();f.store.financialAudit=true;await f.seed(user,1000);await f.seed(other,1000);await f.service.xo.initialize();
 let g=await f.service.xo.open({id:snowflake(at,800),x:user,o:other,amount:300,channelId},async()=>true);
 const act=async(move,who)=>f.service.xo.act({id:g.id,userId:who||g.turn,revision:g.revision,move:String(move),channelId},async()=>true);
 g=await act('accept',other);for(const move of [0,3,1,4,2])g=await act(move);
 assert.equal(g.status,'won');
 for(const [id,balance,outcome] of [[user,1300,'فوز'],[other,700,'خسارة']]){
  assert.equal((await f.store.totals(id,'all',at)).total,balance);
  const events=f.documents.days.filter(d=>d.userId===id).flatMap(d=>d.financialPending||[]);
  assert.equal(events.reduce((s,e)=>s+e.delta,0),balance-1000);
  assert.equal(events.filter(e=>e.context?.outcome===outcome).length,1);
  for(const e of events)assert.equal(e.after-e.before,e.delta);
 }
 assert.ok(f.store.walletRevision>=3);
});
test('financial embed renders real newlines and fits Discord field limits',()=>{
 const e={_id:'id',userId:user,delta:1,before:0,after:1,at,changes:[],tasks:[],context:{game:'اكس',winner:user,stake:1000}};
 const embed=financialPayload(e).embeds[0].toJSON();assert.ok(embed.description.includes('\n'));assert.ok(!embed.description.includes('\\n'));assert.ok(embed.fields.at(-1).value.includes('\n'));
});
for(const name of ['xo','buttonGame','minesGame','numbersGame'])test(`${name}: audit-enabled settlement and journal replay keep balances and outcomes unique`,async()=>{
 const f=await fixture();f.store.financialAudit=true;await f.seed(user,1000);await f.seed(other,1000);const game=f.service[name];await game.initialize();
 let g=await game.open({id:snowflake(at,801),x:user,o:other,amount:300,channelId},async()=>true);
 g=await game.act({id:g.id,userId:other,revision:g.revision,move:'accept',channelId},async()=>true);
 let failed=false;
 f.intercept(({name:collection,method,phase})=>{if(!failed&&collection===`${game.prefix}_games`&&method==='replaceOne'&&phase==='before'){failed=true;throw new Error('simulate lost final game save')}});
 await assert.rejects(game.run(()=>game.finish(g,'won',user)));
 f.intercept(()=>{});f.service.clock=()=>at+86400000;await game.recover();await game.recover();f.service.blocked=false;
 assert.deepEqual(await Promise.all([user,other].map(id=>f.store.totals(id,'all',at).then(x=>x.total))),[1300,700]);
 const events=f.documents.days.flatMap(d=>d.financialPending||[]);
 assert.equal(events.filter(e=>e.context?.outcome==='فوز').length,1);assert.equal(events.filter(e=>e.context?.outcome==='خسارة').length,1);
 assert.equal(events.reduce((s,e)=>s+e.delta,0),0);
});
test('full reset of zero balances invalidates open leaderboard membership',async()=>{
 const f=await fixture();await f.seed(user,0);
 const revision=f.store.walletRevision||0;
 await f.store.resetProgress({userId:user,actorId:other,operationId:'review-zero-reset',target:'all'},at);
 assert.ok(f.store.walletRevision>revision);
});
test('full reset archives audit before deletion and recreated day produces new IDs',async()=>{
 const f=await fixture();f.store.financialAudit=true;await f.seed(user,1000);
 await f.store.resetProgress({userId:user,actorId:other,operationId:'first-review-reset',target:'all'},at);
 const first=f.documents.financial_logs[0];assert.equal(first.delta,-1000);assert.equal(f.documents.days.length,0);
 await f.seed(user,1000);
 await f.store.resetProgress({userId:user,actorId:other,operationId:'second-review-reset',target:'all'},at+1);
 assert.equal(f.documents.financial_logs.length,2);assert.notEqual(f.documents.financial_logs[0]._id,f.documents.financial_logs[1]._id);
});
