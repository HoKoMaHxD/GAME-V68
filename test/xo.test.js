import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,other,actor,config,snowflake } from './helpers/shop-fixture.js';
import { XO_LINES,xoWinner,XO_COOLDOWN } from '../src/xo.js';
import { xoPayload,createXoHandler,XoManager } from '../src/xo-commands.js';
import { createTextCommands } from '../src/experience-commands.js';
const channelId='100000000000000060';
const input=(patch={})=>({id:snowflake(at,500),x:user,o:other,amount:300,channelId,...patch});
async function setup(){const f=await fixture();await f.seed(user,1000);await f.seed(other,1000);await f.service.xo.initialize();f.service.xo.initial=()=>({board:Array(9).fill(null),turn:null});return f;}
const balances=f=>Promise.all([user,other].map(id=>f.store.totals(id,'all',at).then(b=>b.total)));
const act=(f,g,move,who=g.status==='pending'?g.o:g.turn)=>f.service.xo.act({id:g.id,userId:who,revision:g.revision,move:String(move),channelId},async()=>true);
async function start(f){const g=await f.service.xo.open(input(),async()=>true);return act(f,g,'accept');}
test('all eight winning lines recognized for X and O',()=>{for(const line of XO_LINES)for(const symbol of ['X','O']){const b=Array(9).fill(null);line.forEach(i=>b[i]=symbol);assert.deepEqual(xoWinner(b),line);}assert.equal(xoWinner(Array(9).fill(null)),null);});
for(const patch of [{amount:0},{amount:-1},{amount:1.5},{amount:1000000001},{o:user},{bot:true},{o:'bad'}])test('reject invalid challenge '+JSON.stringify(patch),async()=>{const f=await setup();await assert.rejects(f.service.xo.open(input(patch),async()=>true));assert.deepEqual(await balances(f),[1000,1000]);});
test('both balances checked on creation and again at consent; rejection has no cost',async()=>{
 const f=await setup();await assert.rejects(f.service.xo.open(input({amount:1001}),async()=>true),/لا يكفي/);
 const g=await f.service.xo.open(input(),async()=>true);assert.deepEqual(await balances(f),[1000,1000]);
 await assert.rejects(act(f,g,'accept',user),/للمتحدّى|المتحدّى/);
 await assert.rejects(act(f,g,'accept',actor),/للطرفين/);
 assert.equal((await act(f,g,'reject')).status,'rejected');assert.deepEqual(await balances(f),[1000,1000]);
 const second=await f.service.xo.open(input({id:snowflake(at,501)}),async()=>true);
 f.documents.days = f.documents.days.filter(d=>d.userId!==other);await f.seed(other,100);assert.equal((await act(f,second,'accept')).status,'cancelled');assert.deepEqual(await balances(f),[1000,100]);
});
for(const [name,moves,expected] of [['X wins',[0,3,1,4,2],[1300,700]],['O wins',[0,3,1,4,8,5],[700,1300]],['draw',[0,1,2,4,3,5,7,6,8],[1000,1000]]])test(name+' conserves money and duplicate terminal clicks never pay twice',async()=>{
 const f=await setup();let g=await start(f);assert.deepEqual(await balances(f),[700,700]);
 for(const move of moves)g=await act(f,g,move);
 assert.equal(g.status,name==='draw'?'tie':'won');assert.deepEqual(await balances(f),expected);
 const retry=await act(f,g,0,user);assert.equal(retry.status,g.status);assert.deepEqual(await balances(f),expected);
 assert.equal(xoPayload(g).components.length,3);assert.ok(xoPayload(g).components.every(r=>r.toJSON().components.every(b=>b.disabled)));
});
test('turn ownership, occupied cells, wrong channel and stale clicks cannot change the board',async()=>{
 const f=await setup();let g=await start(f);
 await assert.rejects(act(f,g,0,other),/مو دورك/);
 await assert.rejects(f.service.xo.act({id:g.id,userId:user,revision:g.revision,move:'0',channelId:'100000000000000061'},async()=>true),/غير صالح/);
 const old=g;g=await act(f,g,0);await assert.rejects(act(f,g,0),/فارغة/);
 await assert.rejects(act(f,old,1,other),/تغيّرت/);
 assert.deepEqual((await f.service.xo.get(g.id)).board,['X',null,null,null,null,null,null,null,null]);
});
test('simultaneous accepts reserve once and simultaneous clicks apply once',async()=>{
 const f=await setup();const g=await f.service.xo.open(input(),async()=>true);
 const results=await Promise.allSettled([act(f,g,'accept'),act(f,g,'accept')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.deepEqual(await balances(f),[700,700]);const current=await f.service.xo.get(g.id);
 const clicks=await Promise.allSettled([act(f,current,0),act(f,current,1)]);assert.equal(clicks.filter(r=>r.status==='fulfilled').length,1);
});
test('held funds cannot be spent by other bank features, nor reset before release',async()=>{
 const f=await setup();const g=await start(f);
 await assert.rejects(f.service.reset({target:'bank',userId:user,actorId:actor,operationId:'reset-xo'}),/اكس/);
 await assert.rejects(f.service.xo.open(input({id:snowflake(at,501),amount:800}),async()=>true));
 f.service.clock=()=>at+30000;await f.service.xo.expire();assert.deepEqual(await balances(f),[700,1300]);
 assert.equal((await f.service.xo.get(g.id)).status,'won');
});
test('restart retains board/holds; expiry loses, cooldown ends exactly at 20 minutes',async()=>{
 const f=await setup();let g=await start(f);g=await act(f,g,0);
 const reopened=f.open(at+60000);await reopened.service.xo.initialize();await reopened.service.xo.recover();
 assert.equal((await reopened.service.xo.get(g.id)).board[0],'X');await reopened.service.xo.expire();
 assert.deepEqual(await balances(f),[1300,700]);await assert.rejects(reopened.service.xo.open(input({id:snowflake(at,501)}),async()=>true),/انتظار/);
 reopened.service.clock=()=>at+XO_COOLDOWN;await reopened.service.xo.open(input({id:snowflake(at,502)}),async()=>true);
});
test('invitation expires without debit and bank changes release active holds',async()=>{
 const f=await setup();let g=await f.service.xo.open(input(),async()=>true);f.service.clock=()=>at+60000;
 assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balances(f),[1000,1000]);
 g=await f.service.xo.open(input({id:snowflake(at,501)}),async()=>true);g=await act(f,g,'accept');
 f.documents.settings[0].bank.channelVersion++;await f.service.xo.expire();assert.deepEqual(await balances(f),[1000,1000]);
});
for(const phase of ['before','after'])for(const collection of ['xo_journals','days','xo_games'])test(`recovery after ${collection} ${phase} fault preserves both escrow legs`,async()=>{
 const f=await setup();const g=await f.service.xo.open(input(),async()=>true);let failed=false;
 f.intercept(e=>{if(!failed&&e.name===collection&&e.phase===phase&&['updateOne','replaceOne'].includes(e.method)){failed=true;throw new Error('disconnect');}});
 await assert.rejects(act(f,g,'accept'));assert.equal(f.service.blocked,true);f.intercept(()=>{});
 const r=f.open(at);await r.service.xo.initialize();await r.service.xo.recover();await r.service.xo.recover();
 const restored=await r.service.xo.get(g.id);assert.deepEqual(await balances(f),restored.status==='active'?[700,700]:[1000,1000]);
});
test('terminal payout recovers once after interrupted second wallet write',async()=>{
 const f=await setup();let g=await start(f);for(const m of [0,3,1,4])g=await act(f,g,m);
 let hit=false;f.intercept(e=>{if(!hit&&e.name==='xo_games'&&e.method==='replaceOne'&&e.phase==='before'){hit=true;throw new Error('disconnect');}});
 await assert.rejects(act(f,g,2));f.intercept(()=>{});const r=f.open(at);await r.service.xo.recover();await r.service.xo.recover();
 assert.deepEqual(await balances(f),[1300,700]);assert.equal((await r.service.xo.get(g.id)).status,'won');
});
test('text command supports Arabic digits and target/amount plus public board rendering',async()=>{
 const f=await setup();const handler=createXoHandler({config,service:f.service,isBankMember:async()=>true});const text=createTextCommands(handler,config);const replies=[];
 await text({id:snowflake(at,700),content:`اكس <@${other}> ٣٠٠`,guildId:config.clanGuildId,channelId,author:{id:user},mentions:{users:new Map([[other,{id:other}]])},reply:async p=>{replies.push(p);return {id:snowflake(at,701)};}});
 assert.equal(replies[0].components[0].toJSON().components[0].label,'قبول');assert.equal(f.documents.xo_games[0].amount,300);
 assert.equal(f.documents.xo_games[0].messageId,snowflake(at,701));
 const g=await start(await setup());const board=xoPayload(g);assert.deepEqual(board.components.map(r=>r.toJSON().components.length),[3,3,3]);
});
test('insufficient funds of either member at invitation are refused',async()=>{
 for(const who of [user,other]){const f=await setup();f.documents.days=f.documents.days.filter(d=>d.userId!==who);await f.seed(who,299);await assert.rejects(f.service.xo.open(input(),async()=>true),/لا يكفي/);assert.equal(f.documents.xo_games.length,0);}
});
test('timeout payout recovers once after interrupted wallet write',async()=>{
 const f=await setup();await start(f);f.service.clock=()=>at+60000;let writes=0;
 f.intercept(e=>{if(e.name==='days'&&e.method==='replaceOne'&&e.phase==='after'&&++writes===1)throw new Error('lost refund');});
 await assert.rejects(f.service.xo.expire());f.intercept(()=>{});const r=f.open(at+60000);await r.service.xo.recover();await r.service.xo.recover();assert.deepEqual(await balances(f),[700,1300]);
});
test('manager updates expired games and a deleted game message releases funds',async()=>{
 const f=await setup();let g=await start(f);await f.service.xo.bind(g.id,snowflake(at,800));
 const manager=new XoManager({service:f.service,canRun:()=>true,onError:()=>{},bot:{user:{id:actor},channels:{fetch:async()=>({guildId:config.clanGuildId,messages:{fetch:async()=>{throw Object.assign(new Error('deleted'),{code:10008});}}})}}});
 await manager.tick();await manager.drain();assert.deepEqual(await balances(f),[1000,1000]);assert.equal((await f.service.xo.get(g.id)).status,'cancelled');
});
test('slash command and component handler enforce ownership and expose private errors',async()=>{
 const f=await setup();const handler=createXoHandler({config,service:f.service,isBankMember:async()=>true});
 const make=(who,customId)=>{const calls=[];return {calls,id:snowflake(at,890),guildId:config.clanGuildId,channelId,user:{id:who},
 commandName:customId?undefined:'اكس',customId,isButton:()=>!!customId,options:{getUser:()=>({id:other}),getInteger:()=>300},
 reply:async p=>calls.push(p),deferReply:async()=>{},deferUpdate:async()=>{},followUp:async p=>calls.push(p),editReply:async p=>{calls.push(p);return {id:snowflake(at,891)};}};};
 const open=make(user);await handler(open);let g=await f.service.xo.get(open.id);assert.equal(g.status,'pending');
 const outsider=make(actor,`xo:v1:${g.id}:${g.revision}:accept`);await handler(outsider);assert.equal(outsider.calls[0].flags,64);
 const accept=make(other,`xo:v1:${g.id}:${g.revision}:accept`);await handler(accept);assert.equal(accept.calls[0].components.length,3);
 const foreign=make(other,'xo:help');foreign.guildId=config.arenaGuildId;await handler(foreign);assert.match(foreign.calls[0].content,/الكلان/);
});
test('invitation accepts at 29999 ms but expires at exactly 30000 ms without debit',async()=>{
 for(const delay of [29999,30000]){const f=await setup();const g=await f.service.xo.open(input(),async()=>true);assert.equal(g.expiresAt,at+30000);f.service.clock=()=>at+delay;
 const result=await act(f,g,'accept');assert.equal(result.status,delay===30000?'cancelled':'active');assert.deepEqual(await balances(f),delay===30000?[1000,1000]:[700,700]);}
});
test('each valid move resets a 30 second turn; deadline click loses without placing a mark',async()=>{
 const f=await setup();let g=await start(f);assert.equal(g.expiresAt,at+30000);
 f.service.clock=()=>at+14999;g=await act(f,g,0);assert.equal(g.expiresAt,at+44999);
 f.service.clock=()=>at+44999;g=await act(f,g,1);assert.equal(g.status,'won');assert.equal(g.winner,user);assert.equal(g.reason,'timeout');assert.equal(g.board[1],null);assert.deepEqual(await balances(f),[1300,700]);
 assert.match(xoPayload(g).embeds[0].data.description,/خسر صاحب الدور/);
});
test('timer and late button racing settle a timeout exactly once',async()=>{
 const f=await setup();const g=await start(f);f.service.clock=()=>at+30000;
 await Promise.all([f.service.xo.expire(),act(f,g,0)]);await f.service.xo.expire();
 assert.deepEqual(await balances(f),[700,1300]);assert.equal((await f.service.xo.get(g.id)).board[0],null);
});
test('old games and undelivered boards refund instead of retroactive or technical timeout losses',async()=>{
 for(const mode of ['old','undelivered']){const f=await setup();await start(f);const saved=f.documents.xo_games[0];
 if(mode==='old')delete saved.timeoutLoss;else saved.requireDelivery=true;
 f.service.clock=()=>at+30000;await f.service.xo.expire();assert.deepEqual(await balances(f),[1000,1000]);assert.equal(f.documents.xo_games[0].status,'cancelled');}
});
test('delivered board timeout charges its owner; configuration cancellation has priority',async()=>{
 for(const changed of [false,true]){const f=await setup();const invite=await f.service.xo.open(input({requireDelivery:true}),async()=>true);const g=await act(f,invite,'accept');await f.service.xo.displayed(g);
 if(changed)f.documents.settings[0].bank.channelVersion++;
 f.service.clock=()=>at+30000;await f.service.xo.expire();assert.deepEqual(await balances(f),changed?[1000,1000]:[700,1300]);}
});
