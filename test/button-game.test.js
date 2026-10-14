import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,other,actor,config,snowflake } from './helpers/shop-fixture.js';
import { buttonPayload,createButtonHandler,ButtonGameManager } from '../src/button-game-commands.js';
import { createTextCommands } from '../src/experience-commands.js';
const channelId='100000000000000060';
const input=(patch={})=>({id:snowflake(at,650),x:user,o:other,amount:300,channelId,...patch});
async function setup(){const f=await fixture();await f.seed(user,1000);await f.seed(other,1000);await f.service.buttonGame.initialize();return f;}
const balance=f=>Promise.all([user,other].map(id=>f.store.totals(id,'all',at).then(b=>b.total)));
const act=(f,g,move,who=other)=>f.service.buttonGame.act({id:g.id,revision:g.revision,move:String(move),userId:who,channelId},async()=>true);
async function accepted(f){const g=await f.service.buttonGame.open(input(),async()=>true);return act(f,g,'accept');}
async function ready(f){let g=await accepted(f);f.service.clock=()=>g.revealAt;await f.service.buttonGame.expire();g=await f.service.buttonGame.get(g.id);await f.service.buttonGame.displayed(g);return g;}
test('30-second consent deadline and both players minimum balances; rejection costs nothing',async()=>{
 const f=await setup();await assert.rejects(f.service.buttonGame.open(input({amount:1001}),async()=>true),/لا يكفي/);
 const g=await f.service.buttonGame.open(input(),async()=>true);assert.equal(g.expiresAt,at+30000);
 await assert.rejects(act(f,g,'accept',user),/المتحدّى/);await assert.rejects(act(f,g,'accept',actor),/للطرفين/);
 const declined=await act(f,g,'reject');assert.equal(declined.status,'rejected');assert.deepEqual(await balance(f),[1000,1000]);
 const next=await f.service.buttonGame.open(input({id:snowflake(at,651)}),async()=>true);f.service.clock=()=>at+30000;
 assert.equal((await act(f,next,'accept')).status,'cancelled');assert.deepEqual(await balance(f),[1000,1000]);
});
for(const who of [user,other])test('balance recheck cancels if '+who+' spends before acceptance',async()=>{
 const f=await setup();const g=await f.service.buttonGame.open(input(),async()=>true);
 f.documents.days=f.documents.days.filter(d=>d.userId!==who);await f.seed(who,200);
 assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balance(f),who===user?[200,1000]:[1000,200]);
});
test('waiting has sixteen disabled gray buttons; reveal has exactly one green and fifteen red',async()=>{
 const f=await setup();let g=await accepted(f);assert.ok(g.revealAt>=at+3000&&g.revealAt<=at+7000);
 let rows=buttonPayload(g).components.map(r=>r.toJSON().components);assert.deepEqual(rows.map(r=>r.length),[4,4,4,4]);assert.ok(rows.flat().every(b=>b.disabled&&b.style===2));
 await assert.rejects(act(f,g,0,user),/انتظر/);f.service.clock=()=>g.revealAt-1;await f.service.buttonGame.expire();assert.equal((await f.service.buttonGame.get(g.id)).phase,'waiting');
 f.service.clock=()=>g.revealAt;await f.service.buttonGame.expire();g=await f.service.buttonGame.get(g.id);
 await assert.rejects(act(f,g,g.green,user),/انتظر/);await f.service.buttonGame.displayed(g);
 rows=buttonPayload(g).components.map(r=>r.toJSON().components);assert.equal(rows.flat().filter(b=>b.style===3).length,1);assert.equal(rows.flat().filter(b=>b.style===4).length,15);assert.ok(rows.flat().every(b=>!b.disabled));
 await assert.rejects(act(f,g,(g.green+1)%16,user),/مو الزر/);assert.deepEqual(await balance(f),[700,700]);
});
for(const who of [user,other])test('first valid green click pays '+who+' only once',async()=>{
 const f=await setup();const g=await ready(f);await assert.rejects(act(f,g,g.green,actor),/للطرفين/);
 const result=await act(f,g,g.green,who);assert.equal(result.winner,who);assert.equal(result.status,'won');
 await act(f,g,g.green,who===user?other:user);
 assert.deepEqual(await balance(f),who===user?[1300,700]:[700,1300]);assert.ok(buttonPayload(result).components.flatMap(r=>r.toJSON().components).every(b=>b.disabled));
});
test('simultaneous clicks produce one winner and preserve wallet sum',async()=>{
 const f=await setup();const g=await ready(f);const [a,b]=await Promise.all([act(f,g,g.green,user),act(f,g,g.green,other)]);
 assert.equal(a.winner,b.winner);assert.equal(a.winner,user);assert.deepEqual(await balance(f),[1300,700]);
});
test('no click by 30-second boundary draws with no transfer; late click cannot win',async()=>{
 const f=await setup();const g=await ready(f);assert.equal(g.expiresAt,f.service.clock()+30000);f.service.clock=()=>g.expiresAt;
 await Promise.all([f.service.buttonGame.expire(),act(f,g,g.green,user)]);
 assert.equal((await f.service.buttonGame.get(g.id)).status,'tie');assert.deepEqual(await balance(f),[1000,1000]);
});
test('restart preserves green selection and independent twenty-minute cooldown',async()=>{
 const f=await setup();const g=await ready(f);const r=f.open(g.expiresAt-1);await r.service.buttonGame.initialize();await r.service.buttonGame.recover();
 assert.equal((await r.service.buttonGame.get(g.id)).green,g.green);await act(r,g,g.green,user);
 await assert.rejects(r.service.buttonGame.open(input({id:snowflake(at,651)}),async()=>true),/انتظار إرسال زر/);
 // XO has its own cooldown, and its wallet receipt IDs cannot collide with button-game holds.
 await r.service.xo.initialize();const x=await r.service.xo.open(input(),async()=>true);
 await r.service.xo.act({id:x.id,revision:x.revision,move:'accept',userId:other,channelId},async()=>true);
 assert.deepEqual(await balance(f),[1000,400]);
});
for(const phase of ['before','after'])test('interrupted payout '+phase+' persists one winner and pays once',async()=>{
 const f=await setup();const g=await ready(f);let hit=false;
 f.intercept(e=>{if(!hit&&e.name==='days'&&e.method==='replaceOne'&&e.phase===phase){hit=true;throw new Error('disconnect');}});
 await assert.rejects(act(f,g,g.green,user));f.intercept(()=>{});const r=f.open(g.revealAt);await r.service.buttonGame.recover();await r.service.buttonGame.recover();assert.deepEqual(await balance(f),[1300,700]);
});
test('bank reset blocked while money held, and changed bank cancels safely',async()=>{
 const f=await setup();await accepted(f);await assert.rejects(f.service.reset({target:'bank',userId:user,actorId:actor,operationId:'button-reset'}),/لعبة زر/);
 f.documents.settings[0].bank.channelVersion++;await f.service.buttonGame.expire();assert.deepEqual(await balance(f),[1000,1000]);
});
test('text alias parses Arabic stake and manager reveals the public green board',async()=>{
 const f=await setup();const replies=[];const handler=createButtonHandler({service:f.service,config,isBankMember:async()=>true});
 await createTextCommands(handler,config)({id:snowflake(at,800),content:`زر <@${other}> ٣٠٠`,guildId:config.clanGuildId,channelId,author:{id:user},mentions:{users:new Map([[other,{id:other}]])},reply:async p=>{replies.push(p);return {id:snowflake(at,801)};}});
 let g=await f.service.buttonGame.get(snowflake(at,800));assert.equal(g.amount,300);assert.equal(replies[0].components[0].toJSON().components[0].label,'قبول');g=await act(f,g,'accept');f.service.clock=()=>g.revealAt;
 const messages=[];const manager=new ButtonGameManager({service:f.service,canRun:()=>true,onError:e=>{throw e;},bot:{user:{id:actor},channels:{fetch:async()=>({guildId:config.clanGuildId,messages:{fetch:async()=>({author:{id:actor},edit:async p=>messages.push(p)})}})}}});
 await manager.tick();await manager.drain();assert.equal(messages[0].components.length,4);assert.equal((await f.service.buttonGame.get(g.id)).dirty,false);
});
