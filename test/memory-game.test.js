import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at,user,other,actor,config,snowflake} from './helpers/shop-fixture.js';
import {memoryBoard,MEMORY_EMOJIS} from '../src/memory-game.js';
import {memoryPayload,createMemoryHandler,MemoryManager} from '../src/memory-commands.js';
import {createTextCommands} from '../src/experience-commands.js';
const channelId='100000000000000060';
const input=(patch={})=>({id:snowflake(at,995),userId:user,channelId,at,...patch});
async function setup(){const f=await fixture();await f.seed(user,1000);let now=at;f.service.clock=()=>now;return {...f,time:t=>{now=t;}};}
async function open(f){const g=await f.service.memory.open(input(),async()=>true,(min,max)=>max-1);await f.service.memory.bind(g,snowflake(at,996));await f.service.memory.markDisplayed(g);return (await f.service.memory.latest(user)).miniGames.memory;}
async function play(f,g,cell,display=true){const r=await f.service.memory.play({id:g.id,userId:user,channelId,revision:g.revision,move:String(cell)},async()=>true);if(display)await f.service.memory.markDisplayed(r);return (await f.service.memory.latest(user)).miniGames.memory;}
const balance=f=>f.store.totals(user,'all',at).then(b=>b.total);
const current=async f=>(await f.service.memory.latest(user)).miniGames.memory;

test('16 shuffled cards contain exactly two of each of the eight emojis',()=>{
 for(let i=0;i<20;i++){const b=memoryBoard();assert.equal(b.length,16);for(const e of MEMORY_EMOJIS)assert.equal(b.filter(v=>v===e).length,2);}
 assert.throws(()=>memoryBoard(()=>99));
});
test('hidden card payload never contains the emoji, pair index or full board',async()=>{
 const f=await setup();const g=await open(f);let p=memoryPayload(g);assert.deepEqual(p.components.map(r=>r.toJSON().components.length),[4,4,4,4]);
 for(const e of MEMORY_EMOJIS)assert.ok(!JSON.stringify(p).includes(e));
 const r=await play(f,g,0);p=memoryPayload(r);const buttons=p.components.flatMap(r=>r.toJSON().components);assert.equal(buttons[0].emoji.name,'🍌');assert.equal(buttons[8].emoji,undefined);
});
test('matching cards stay revealed, attempts count pairs only, win pays once even with repeated requests',async()=>{
 const f=await setup();let g=await open(f);
 for(let i=0;i<8;i++){g=await play(f,g,i);assert.equal(g.attempts,i);g=await play(f,g,i+8);assert.equal(g.attempts,i+1);assert.equal(g.matched.length,(i+1)*2);}
 assert.equal(g.status,'settled');assert.equal(g.result.outcome,'win');assert.equal(await balance(f),1100);
 await play(f,g,0);await f.service.memory.expire();assert.equal(await balance(f),1100);
 assert.equal(f.documents.days[0].miniReceipts.filter(r=>r.kind==='memory').length,1);
 assert.ok(memoryPayload(g).components.flatMap(r=>r.toJSON().components).every(b=>b.disabled));
});
test('mismatch reveals for two seconds after delivery, blocks third card then hides without shuffling',async()=>{
 const f=await setup();let g=await open(f);const board=[...g.board];g=await play(f,g,0);g=await play(f,g,1,false);assert.equal(g.hideAt,null);
 f.time(at+1000);await f.service.memory.expire();assert.equal((await current(f)).phase,'reveal');
 await f.service.memory.markDisplayed(g);g=await current(f);assert.equal(g.hideAt,at+3000);
 assert.ok(memoryPayload(g).components.flatMap(r=>r.toJSON().components).every(b=>b.disabled));
 g=await play(f,g,2);assert.deepEqual(g.flipped,[0,1]);assert.equal(g.attempts,1);
 f.time(at+2999);await f.service.memory.expire();assert.equal((await current(f)).phase,'reveal');
 f.time(at+3000);await f.service.memory.expire();g=await current(f);assert.equal(g.phase,'choose');assert.deepEqual(g.flipped,[]);assert.deepEqual(g.board,board);assert.equal(g.expiresAt,at+33000);
});
test('twelve wrong pairs debit the percentage once',async()=>{
 const f=await setup();let g=await open(f);
 for(let i=0;i<12;i++){
  g=await play(f,g,0);g=await play(f,g,1);f.time(at+(i+1)*2000);await f.service.memory.expire();g=await current(f);await f.service.memory.markDisplayed(g);g=await current(f);
 }
 assert.equal(g.attempts,12);assert.equal(g.result.outcome,'loss');assert.equal(g.endReason,'attempts');assert.equal(await balance(f),900);
 await f.service.memory.expire();await play(f,g,0);assert.equal(await balance(f),900);
});
test('each valid flip renews 30 seconds; same card or stale version cannot buy more time',async()=>{
 const f=await setup();const first=await open(f);f.time(at+29999);const g=await play(f,first,0);assert.equal(g.expiresAt,at+59999);
 f.time(at+35000);assert.equal((await play(f,g,0)).expiresAt,g.expiresAt);assert.equal((await play(f,first,1)).revision,g.revision);
 f.time(at+59999);await f.service.memory.expire();assert.equal((await current(f)).endReason,'timeout');assert.equal(await balance(f),900);
});
test('concurrent presses and retries reveal at most one card per version',async()=>{
 const f=await setup();const g=await open(f);
 await Promise.all([play(f,g,0),play(f,g,1),play(f,g,0)]);
 assert.equal((await current(f)).flipped.length,1);assert.equal((await current(f)).attempts,0);
});
test('cooldown survives a restart and cannot be bypassed by starting another round',async()=>{
 const f=await setup();let g=await open(f);const again=await f.service.memory.open(input({id:snowflake(at,997)}),async()=>true);assert.equal(again.id,g.id);
 f.time(at+30000);await f.service.memory.expire();
 const restarted=f.open(at+30001);assert.equal((await restarted.service.memory.open(input({id:snowflake(at+30001,997),at:at+30001}),async()=>true)).status,'cooldown');
 const later=f.open(at+1200000);g=await later.service.memory.open(input({id:snowflake(at+1200000,997),at:at+1200000}),async()=>true);assert.equal(g.status,'open');
});
test('restart during mismatch retains hidden layout and finishes the reveal phase',async()=>{
 const f=await setup();let g=await open(f);g=await play(f,g,0);g=await play(f,g,1);
 const restarted=f.open(at+2000);await restarted.service.memory.expire();const next=(await restarted.service.memory.latest(user)).miniGames.memory;
 assert.equal(next.phase,'choose');assert.deepEqual(next.board,g.board);assert.equal(next.attempts,1);assert.deepEqual(next.flipped,[]);
});
test('wrong channel or member cannot use a game, and moving the bank cancels it without reward',async()=>{
 const f=await setup();const g=await open(f);
 await assert.rejects(f.service.memory.play({id:g.id,userId:other,channelId,revision:0,move:'0'},async()=>true),/قديمة/);
 await assert.rejects(f.service.memory.play({id:g.id,userId:user,channelId:other,revision:0,move:'0'},async()=>true),/قديمة/);
 await assert.rejects(f.service.memory.play({id:g.id,userId:user,channelId,revision:0,move:'0'},async()=>false),/الكلان/);
 f.documents.settings[0].bank.channelVersion++;await f.service.memory.expire();assert.equal((await current(f)).status,'cancelled');assert.equal(await balance(f),1000);
});
test('new games require a positive balance',async()=>{
 const f=await setup();f.documents.days[0].points.tasks=0;await assert.rejects(open(f),/رصيد/);
});
test('undelivered board never awards money or an inactivity result',async()=>{
 const f=await setup();await f.service.memory.open(input(),async()=>true);f.time(at+30000);await f.service.memory.expire();assert.equal((await current(f)).status,'cancelled');assert.equal(await balance(f),1000);
});
for(const phase of ['before','after'])test('reward write failure '+phase+' cannot duplicate the prize',async()=>{
 const f=await setup();let g=await open(f);for(let i=0;i<7;i++){g=await play(f,g,i);g=await play(f,g,i+8);}g=await play(f,g,7);
 let failed=false;f.intercept(e=>{if(!failed&&e.name==='days'&&e.method==='replaceOne'&&e.phase===phase){failed=true;throw new Error('disconnect');}});
 if(phase==='before')await assert.rejects(play(f,g,15));else await play(f,g,15);
 f.intercept(()=>{});const r=f.open(at);await r.service.memory.play({id:g.id,userId:user,channelId,revision:g.revision,move:'15'},async()=>true);
 assert.equal(await balance(f),1100);assert.equal(f.documents.days[0].miniReceipts.filter(x=>x.kind==='memory').length,1);
});
test('text command routes and the button handler denies other users before updating the game',async()=>{
 const f=await setup();let payload;const msg={id:snowflake(at,996)};const handler=createMemoryHandler({config,service:f.service,isBankMember:async()=>true});
 await createTextCommands(handler,config)({content:'تشابه',id:input().id,createdTimestamp:at,author:{id:user,username:'اللاعب'},guildId:config.clanGuildId,channelId,reply:async p=>{payload=p;return msg;}});
 const customId=payload.components[0].toJSON().components[0].custom_id;
 await handler({customId,user:{id:other},guildId:config.clanGuildId,isButton:()=>true,reply:async p=>{payload=p;}});
 assert.match(payload.content,/عضو آخر/);assert.equal((await current(f)).flipped.length,0);
});
test('background worker hides unmatched cards and edits the same message',async()=>{
 const f=await setup();let g=await open(f);g=await play(f,g,0);g=await play(f,g,1);let payload;
 const bot={user:{id:actor},channels:{fetch:async()=>({guildId:config.clanGuildId,messages:{fetch:async()=>({author:{id:actor},edit:async p=>{payload=p;}})}})}};
 const manager=new MemoryManager({bot,service:f.service,canRun:()=>true,onError:e=>{throw e;}});
 f.time(at+2000);await manager.tick();await manager.drain();assert.equal((await current(f)).phase,'choose');assert.ok(payload.components.flatMap(r=>r.toJSON().components).every(b=>!b.disabled));
});

test('percentage uses the balance at settlement and survives restart',async()=>{
 const f=await setup();const g=await f.service.memory.open(input(),async()=>true,(min,max)=>min);
 assert.equal(g.percent,5);await f.service.memory.markDisplayed(g);
 f.documents.days[0].points.tasks=2000;
 const restarted=f.open(at+30000);await restarted.service.memory.expire();
 const r=await current(f);assert.equal(r.result.percent,5);assert.equal(r.result.amount,100);assert.equal(r.result.before,2000);assert.equal(await balance(f),1900);
 assert.match(memoryPayload(r).embeds[0].toJSON().description,/5%/);
});
test('legacy open rounds keep their fixed reward and no loss debit',async()=>{
 for(const win of [true,false]){
  const f=await setup();let g=await open(f);const saved=f.documents.days[0].miniGames.memory;
  delete saved.economyVersion;delete saved.percent;saved.reward=500;g=await current(f);
  if(win)for(let i=0;i<8;i++){g=await play(f,g,i);g=await play(f,g,i+8);}
  else {f.time(at+30000);await f.service.memory.expire();}
  assert.equal(await balance(f),win?1500:1000);
 }
});

const levelRandom=index=>{let calls=0;return (min,max)=>++calls===2?index:max-1;};
for(const [index,name,attempts] of [[0,'سهل',20],[1,'متوسط',16],[2,'صعب',12]]){
 test('random level '+name+' is shown and persists through retries and restart',async()=>{
  const f=await setup();const choose=levelRandom(index);
  const g=await f.service.memory.open(input(),async()=>true,choose);
  assert.equal(g.levelName,name);assert.equal(g.maxAttempts,attempts);
  assert.match(memoryPayload(g).embeds[0].toJSON().description,new RegExp(name));
  const repeat=await f.service.memory.open(input(),async()=>true,()=>{throw new Error('must not reroll');});
  assert.equal(repeat.level,g.level);
  const restarted=f.open(at);const saved=(await restarted.service.memory.latest(user)).miniGames.memory;
  assert.equal(saved.maxAttempts,attempts);assert.equal(saved.level,g.level);assert.deepEqual(saved.board,g.board);
 });
 test(name+' permits a win on the final attempt',async()=>{
  const f=await setup();let g=await f.service.memory.open(input(),async()=>true,levelRandom(index));
  await f.service.memory.markDisplayed(g);
  for(let i=0;i<attempts-8;i++){
   g=await play(f,g,0);g=await play(f,g,1);f.time(at+(i+1)*2000);
   await f.service.memory.expire();g=await current(f);await f.service.memory.markDisplayed(g);
  }
  for(let i=0;i<8;i++){g=await play(f,g,i);g=await play(f,g,i+8);}
  assert.equal(g.attempts,attempts);assert.equal(g.result.outcome,'win');assert.equal(await balance(f),1100);
 });
}
test('invalid random level cannot open a round',async()=>{
 const f=await setup();await assert.rejects(f.service.memory.open(input(),async()=>true,(min,max)=>max===3?3:max-1),/مستوى/);
 assert.equal((await f.service.memory.latest(user))?.miniGames?.memory,undefined);
});
test('rounds predating levels retain their sixteen attempts',async()=>{
 const f=await setup();let g=await open(f);const saved=f.documents.days[0].miniGames.memory;
 delete saved.level;delete saved.levelName;saved.maxAttempts=16;
 const restarted=f.open(at);g=await restarted.service.memory.open(input(),async()=>true,()=>{throw new Error('must not reroll');});
 assert.equal(g.maxAttempts,16);assert.equal(g.level,undefined);
 assert.match(memoryPayload(g).embeds[0].toJSON().description,/النظام السابق/);
});
