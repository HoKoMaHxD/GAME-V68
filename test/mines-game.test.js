import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,other,actor,config,snowflake } from './helpers/shop-fixture.js';
import { minesPayload,createMinesHandler,MinesManager } from '../src/mines-game-commands.js';
import { createTextCommands } from '../src/experience-commands.js';
const channelId='100000000000000060';
const input=(patch={})=>({id:snowflake(at,850),x:user,o:other,amount:300,channelId,...patch});
async function setup(){const f=await fixture();await f.seed(user,1000);await f.seed(other,1000);await f.service.minesGame.initialize();return f;}
const balances=f=>Promise.all([user,other].map(id=>f.store.totals(id,'all',at).then(b=>b.total)));
const act=(f,g,move,who=g.status==='pending'?g.o:g.turn)=>f.service.minesGame.act({id:g.id,revision:g.revision,move:String(move),userId:who,channelId},async()=>true);
async function start(f,patch={}){return act(f,await f.service.minesGame.open(input(patch),async()=>true),'accept');}
test('invitation checks both funds, needs target consent and cancels at exactly thirty seconds',async()=>{
 for(const who of [user,other]){const f=await setup();f.documents.days=f.documents.days.filter(d=>d.userId!==who);await f.seed(who,299);await assert.rejects(f.service.minesGame.open(input(),async()=>true),/لا يكفي/);}
 const f=await setup();const g=await f.service.minesGame.open(input(),async()=>true);assert.equal(g.expiresAt,at+30000);
 await assert.rejects(act(f,g,'accept',user),/المتحدّى/);await assert.rejects(act(f,g,'accept',actor),/للطرفين/);assert.deepEqual(await balances(f),[1000,1000]);
 f.service.clock=()=>at+30000;assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balances(f),[1000,1000]);
});
for(const who of [user,other])test('acceptance rechecks available funds of '+who,async()=>{
 const f=await setup();const g=await f.service.minesGame.open(input(),async()=>true);f.documents.days=f.documents.days.filter(d=>d.userId!==who);await f.seed(who,200);
 assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balances(f),who===user?[200,1000]:[1000,200]);
});
test('mine remains hidden in all live payloads and starting player is a participant',async()=>{
 const f=await setup();const g=await start(f);assert.ok(g.mine>=1&&g.mine<=9);assert.ok([user,other].includes(g.turn));assert.deepEqual(await balances(f),[700,700]);
 const p=minesPayload(g);assert.deepEqual(p.components.map(r=>r.toJSON().components.length),[3,3,3]);
 assert.deepEqual(JSON.parse(JSON.stringify(p)),JSON.parse(JSON.stringify(minesPayload({...g,mine:g.mine===1?2:1}))));
 assert.deepEqual(p.components.flatMap(r=>r.toJSON().components.map(b=>b.label)),['1','2','3','4','5','6','7','8','9']);
});
for(let mine=1;mine<=9;mine++)test('mine '+mine+' stays fixed; eight safe picks alternate and final pick loses once',async()=>{
 const f=await setup();let g=await start(f);f.documents.mines_games[0].mine=mine;g=await f.service.minesGame.get(g.id);
 for(const cell of [1,2,3,4,5,6,7,8,9].filter(n=>n!==mine)){const previous=g.turn;g=await act(f,g,cell);assert.equal(g.turn,previous===user?other:user);assert.equal(g.mine,mine);assert.equal(g.status,'active');}
 const loser=g.turn,winner=loser===user?other:user;const result=await act(f,g,mine);assert.equal(result.status,'won');assert.equal(result.winner,winner);assert.equal(result.loser,loser);
 await act(f,g,mine);assert.deepEqual(await balances(f),winner===user?[1300,700]:[700,1300]);assert.ok(minesPayload(result).components.flatMap(r=>r.toJSON().components).every(b=>b.disabled));
});
test('wrong turns, spectators, repeated cells and stale board clicks cannot choose twice',async()=>{
 const f=await setup();let g=await start(f);const safe=g.mine===1?2:1;
 await assert.rejects(act(f,g,safe,g.turn===user?other:user),/مو دورك/);await assert.rejects(act(f,g,safe,actor),/للطرفين/);
 const old=g;g=await act(f,g,safe);await assert.rejects(act(f,g,safe),/غير مكشوف/);await assert.rejects(act(f,old,3,g.turn),/تغيّرت/);
 assert.equal((await f.service.minesGame.get(g.id)).picks.length,1);
});
test('late click and timer racing at thirty seconds lose the turn without another selection',async()=>{
 const f=await setup();const g=await start(f);await f.service.minesGame.displayed(g);assert.equal(g.expiresAt,at+30000);f.service.clock=()=>at+30000;
 await Promise.all([f.service.minesGame.expire(),act(f,g,g.mine===1?2:1)]);const saved=await f.service.minesGame.get(g.id);
 assert.equal(saved.status,'won');assert.equal(saved.winner,g.turn===user?other:user);assert.equal(saved.picks.length,0);
 assert.deepEqual(await balances(f),saved.winner===user?[1300,700]:[700,1300]);
});
test('new safe choice grants thirty seconds; restart retains the mine, turn and picks',async()=>{
 const f=await setup();let g=await start(f);f.service.clock=()=>at+14999;g=await act(f,g,g.mine===1?2:1);assert.equal(g.expiresAt,at+44999);
 const reopened=f.open(at+30000);await reopened.service.minesGame.initialize();await reopened.service.minesGame.recover();assert.deepEqual(await reopened.service.minesGame.get(g.id),g);
});
for(const phase of ['before','after'])test('interrupted mine payout '+phase+' recovers only once',async()=>{
 const f=await setup();const g=await start(f);let hit=false;f.intercept(e=>{if(!hit&&e.name==='days'&&e.method==='replaceOne'&&e.phase===phase){hit=true;throw new Error('disconnect');}});
 await assert.rejects(act(f,g,g.mine));assert.equal(f.service.blocked,true);f.intercept(()=>{});const r=f.open(at);await r.service.minesGame.recover();await r.service.minesGame.recover();
 assert.deepEqual(await balances(f),g.turn===user?[700,1300]:[1300,700]);
});
test('rejection, cancellation and draw refund without profit; bank reset cannot erase held funds',async()=>{
 const f=await setup();let g=await f.service.minesGame.open(input(),async()=>true);assert.equal((await act(f,g,'reject')).status,'rejected');assert.deepEqual(await balances(f),[1000,1000]);
 g=await start(f,{id:snowflake(at,851)});await assert.rejects(f.service.reset({target:'bank',userId:user,actorId:actor,operationId:'mines-reset'}),/الغام/);
 await f.service.minesGame.run(()=>f.service.minesGame.finish(g,'tie'));assert.deepEqual(await balances(f),[1000,1000]);
 await assert.rejects(f.service.minesGame.open(input({id:snowflake(at,852)}),async()=>true),/انتظار إرسال الغام/);
 f.service.clock=()=>at+1200000;g=await start(f,{id:snowflake(at,853)});f.documents.settings[0].bank.channelVersion++;await f.service.minesGame.expire();assert.deepEqual(await balances(f),[1000,1000]);
});
test('text command, private help, public mine board and deleted-message refund',async()=>{
 const f=await setup();const replies=[];const handler=createMinesHandler({service:f.service,config,isBankMember:async()=>true});
 await createTextCommands(handler,config)({id:snowflake(at,900),content:`الغام <@${other}> ٣٠٠`,guildId:config.clanGuildId,channelId,author:{id:user},mentions:{users:new Map([[other,{id:other}]])},reply:async p=>{replies.push(p);return {id:snowflake(at,901)};}});
 let g=await f.service.minesGame.get(snowflake(at,900));assert.equal(g.amount,300);assert.equal(replies[0].components[0].toJSON().components[0].label,'قبول');g=await act(f,g,'accept');
 const help=[];await handler({customId:'mines:help',isButton:()=>true,guildId:config.clanGuildId,user:{id:user},reply:async p=>help.push(p)});assert.equal(help[0].flags,64);assert.match(help[0].content,/الغام/);
 const manager=new MinesManager({service:f.service,canRun:()=>true,onError:()=>{},bot:{user:{id:actor},channels:{fetch:async()=>({guildId:config.clanGuildId,messages:{fetch:async()=>{throw Object.assign(new Error('deleted'),{code:10008});}}})}}});
 await manager.tick();await manager.drain();assert.deepEqual(await balances(f),[1000,1000]);assert.equal((await f.service.minesGame.get(g.id)).status,'cancelled');
});
