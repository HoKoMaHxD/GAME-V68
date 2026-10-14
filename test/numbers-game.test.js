import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,other,actor,config,snowflake } from './helpers/shop-fixture.js';
import { numbersPayload,createNumbersHandler,NumbersManager } from '../src/numbers-game-commands.js';
import { gamesMenuPayload } from '../src/bank-menu.js';
import { createTextCommands } from '../src/experience-commands.js';
const channelId='100000000000000060';
const input=(patch={})=>({id:snowflake(at,950),x:user,o:other,amount:300,channelId,...patch});
async function setup(){const f=await fixture();await f.seed(user,1000);await f.seed(other,1000);await f.service.numbersGame.initialize();f.service.numbersGame.initial=()=>({count:0,picks:[],limit:15});return f;}
const balances=f=>Promise.all([user,other].map(id=>f.store.totals(id,'all',at).then(b=>b.total)));
const act=(f,g,move,who=g.status==='pending'?g.o:g.turn)=>f.service.numbersGame.act({id:g.id,revision:g.revision,move:String(move),userId:who,channelId},async()=>true);
async function start(f){return act(f,await f.service.numbersGame.open(input(),async()=>true),'accept');}
test('one and two consume consecutive numbers and each player owns a distinct board color',async()=>{
 const f=await setup();let g=await start(f);assert.deepEqual(await balances(f),[700,700]);const first=g.turn;
 let p=numbersPayload(g);assert.deepEqual(p.components.map(r=>r.toJSON().components.length),[5,5,5,2]);assert.deepEqual(p.components[3].toJSON().components.map(b=>b.label),['1','2']);
 g=await act(f,g,2);assert.equal(g.count,2);assert.deepEqual(g.picks,[{cell:1,userId:first},{cell:2,userId:first}]);assert.equal(g.turn,first===user?other:user);
 g=await act(f,g,1);assert.equal(g.count,3);p=numbersPayload(g);const cells=p.components.slice(0,3).flatMap(r=>r.toJSON().components);
 assert.equal(cells[0].style,first===user?4:3);assert.equal(cells[1].style,cells[0].style);assert.equal(cells[2].style,first===user?3:4);assert.ok(cells.every(b=>b.disabled));
});
for(const mode of ['ones','twos'])test(mode+' reaches fifteen and the player taking it loses once',async()=>{
 const f=await setup();let g=await start(f);
 while(g.count<13)g=await act(f,g,mode==='ones'?1:2);
 if(mode==='ones')g=await act(f,g,1);
 assert.equal(g.count,14);await assert.rejects(act(f,g,2),/المتبقي/);assert.equal(numbersPayload(g).components[3].toJSON().components[1].disabled,true);
 const loser=g.turn;const result=await act(f,g,1);assert.equal(result.status,'won');assert.equal(result.loser,loser);assert.equal(result.count,15);await act(f,g,1);
 assert.deepEqual(await balances(f),loser===user?[700,1300]:[1300,700]);assert.equal(numbersPayload(result).components.length,3);
});
test('taking two from thirteen includes fifteen and loses',async()=>{
 const f=await setup();let g=await start(f);for(let i=0;i<6;i++)g=await act(f,g,2);g=await act(f,g,1);assert.equal(g.count,13);
 const loser=g.turn;g=await act(f,g,2);assert.equal(g.loser,loser);assert.deepEqual(g.picks.slice(-2).map(p=>p.cell),[14,15]);assert.equal(g.status,'won');
});
test('target alone can consent, both balances are rechecked and invitation expires at thirty seconds',async()=>{
 for(const who of [user,other]){const f=await setup();await assert.rejects(f.service.numbersGame.open(input({amount:1001}),async()=>true),/لا يكفي/);const g=await f.service.numbersGame.open(input(),async()=>true);
 await assert.rejects(act(f,g,'accept',user),/المتحدّى/);f.documents.days=f.documents.days.filter(d=>d.userId!==who);await f.seed(who,200);assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balances(f),who===user?[200,1000]:[1000,200]);}
 const f=await setup();const g=await f.service.numbersGame.open(input(),async()=>true);f.service.clock=()=>at+30000;assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balances(f),[1000,1000]);
});
test('wrong player, invalid input, spectators and simultaneous stale picks do not advance twice',async()=>{
 const f=await setup();const g=await start(f);await assert.rejects(act(f,g,1,g.turn===user?other:user),/مو دورك/);await assert.rejects(act(f,g,1,actor),/للطرفين/);
 for(const move of [0,3,15,'1.5','cell1'])await assert.rejects(act(f,g,move));
 const r=await Promise.allSettled([act(f,g,1),act(f,g,2)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await f.service.numbersGame.get(g.id)).count,1);
});
test('restart keeps colors/count; exact turn deadline loses once despite timer/click race',async()=>{
 const f=await setup();let g=await start(f);g=await act(f,g,2);const r=f.open(at+30000);await r.service.numbersGame.initialize();await r.service.numbersGame.recover();assert.deepEqual(await r.service.numbersGame.get(g.id),g);
 await Promise.all([r.service.numbersGame.expire(),act(r,g,1)]);assert.deepEqual(await balances(f),g.turn===user?[700,1300]:[1300,700]);assert.equal((await r.service.numbersGame.get(g.id)).count,2);
});
test('payout interruption recovers once and held funds prevent bank reset',async()=>{
 const f=await setup();let g=await start(f);await assert.rejects(f.service.reset({target:'bank',userId:user,actorId:actor,operationId:'numbers-reset'}),/ارقام/);
 for(let i=0;i<7;i++)g=await act(f,g,2);let hit=false;f.intercept(e=>{if(!hit&&e.name==='days'&&e.method==='replaceOne'&&e.phase==='after'){hit=true;throw new Error('disconnect');}});
 await assert.rejects(act(f,g,1));f.intercept(()=>{});const r=f.open(at);await r.service.numbersGame.recover();await r.service.numbersGame.recover();assert.deepEqual(await balances(f),g.turn===user?[700,1300]:[1300,700]);
});
test('draw refunds; cooldown independent and available exactly after twenty minutes',async()=>{
 const f=await setup();const g=await start(f);await f.service.numbersGame.run(()=>f.service.numbersGame.finish(g,'tie'));assert.deepEqual(await balances(f),[1000,1000]);
 await assert.rejects(f.service.numbersGame.open(input({id:snowflake(at,951)}),async()=>true),/انتظار إرسال ارقام/);f.service.clock=()=>at+1200000;await f.service.numbersGame.open(input({id:snowflake(at,951)}),async()=>true);
});
test('text command, menu row limits and manager render the complete colored board',async()=>{
 const f=await setup();const replies=[];const handler=createNumbersHandler({service:f.service,config,isBankMember:async()=>true});
 await createTextCommands(handler,config)({id:snowflake(at,980),content:`ارقام <@${other}> ٣٠٠`,guildId:config.clanGuildId,channelId,author:{id:user},mentions:{users:new Map([[other,{id:other}]])},reply:async p=>{replies.push(p);return {id:snowflake(at,981)};}});
 let g=await f.service.numbersGame.get(snowflake(at,980));assert.equal(g.amount,300);g=await act(f,g,'accept');g=await act(f,g,2);
 const views=[];const manager=new NumbersManager({service:f.service,canRun:()=>true,onError:e=>{throw e;},bot:{user:{id:actor},channels:{fetch:async()=>({guildId:config.clanGuildId,messages:{fetch:async()=>({author:{id:actor},edit:async p=>views.push(p)})}})}}});
 await manager.tick();await manager.drain();assert.equal(views[0].components.length,4);assert.equal((await f.service.numbersGame.get(g.id)).dirty,false);
 const rows=gamesMenuPayload().components.map(r=>r.toJSON().components);assert.deepEqual(rows.map(r=>r.length),[5,5]);assert.equal(rows[1][0].label,'ارقام');
});
for(let limit=15;limit<=25;limit++)test(`last number ${limit} stays fixed and loses with legal Discord layout`,async()=>{
 const f=await setup();f.service.numbersGame.initial=()=>({count:0,picks:[],limit});let g=await start(f);
 const reopened=f.open(at);assert.equal((await reopened.service.numbersGame.get(g.id)).limit,limit);
 while(g.count<limit-1)g=await act(f,g,Math.min(2,limit-1-g.count));
 const payload=numbersPayload(g);assert.ok(payload.components.length<=5);assert.ok(payload.components.every(r=>r.toJSON().components.length<=5));
 assert.equal(payload.components.at(-1).toJSON().components[1].disabled,true);
 assert.match(payload.embeds[0].toJSON().title,new RegExp(String(limit)));
 const loser=g.turn;g=await act(f,g,1);assert.equal(g.count,limit);assert.equal(g.loser,loser);assert.equal(g.status,'won');
 assert.deepEqual(await balances(f),loser===user?[700,1300]:[1300,700]);
});

test('hidden endpoint cannot be inferred from invitation, rejection or unaccepted expiry payload',()=>{
 for(const status of ['pending','rejected','cancelled']){
  const g={...input(),status,revision:0,expiresAt:at+30000,count:0,picks:[]};
  const serialized=limit=>JSON.stringify(numbersPayload({...g,limit}));
  for(let limit=16;limit<=25;limit++)assert.equal(serialized(limit),serialized(15));
 }
 const active={...input(),status:'active',revision:1,acceptedAt:at,count:0,picks:[],turn:user,expiresAt:at+30000,limit:23};
 assert.match(numbersPayload(active).embeds[0].toJSON().title,/23/);
});
