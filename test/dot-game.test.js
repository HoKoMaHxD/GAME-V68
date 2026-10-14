import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,other,actor,config,snowflake,request } from './helpers/shop-fixture.js';
import { dotLine,dropDot } from '../src/dot-game.js';
import { dotPayload,createDotHandler,DotManager,buildDotCommand } from '../src/dot-game-commands.js';
import { createTextCommands } from '../src/experience-commands.js';
const channelId='100000000000000060';
const input=(patch={})=>({id:snowflake(at,950),x:user,o:other,amount:300,channelId,names:{[user]:'HoKoMaH',[other]:'عضو سنو'},...patch});
async function setup(){const f=await fixture();await f.seed(user,1000);await f.seed(other,1000);await f.service.dotGame.initialize();return f;}
const balances=f=>Promise.all([user,other].map(id=>f.store.totals(id,'all',at).then(b=>b.total)));
const act=(f,g,move,who=g.status==='pending'?g.o:g.turn)=>f.service.dotGame.act({id:g.id,revision:g.revision,move:String(move),userId:who,channelId},async()=>true);
async function start(f,patch={}){return act(f,await f.service.dotGame.open(input(patch),async()=>true),'accept');}

test('gravity places pieces at the bottom and full or invalid columns cannot change the board',()=>{
 let board=Array(42).fill(null);
 for(let i=0;i<6;i++){const move=dropDot(board,3,i%2?'Y':'R');assert.equal(move.lastCell,(5-i)*7+3);board=move.board;}
 const original=[...board];assert.throws(()=>dropDot(board,3,'R'),/ممتلئ/);assert.deepEqual(board,original);
 for(const c of [-1,7,1.5,NaN])assert.throws(()=>dropDot(board,c,'R'));
});
for(const [name,cells] of [['horizontal',[35,36,37,38]],['vertical',[3,10,17,24]],['down-right',[1,9,17,25]],['down-left',[6,12,18,24]]])test('four '+name+' wins and three does not',()=>{
 for(const mark of ['R','Y']){const b=Array(42).fill(null);for(const c of cells.slice(0,3))b[c]=mark;assert.equal(dotLine(b),null);b[cells[3]]=mark;assert.deepEqual(dotLine(b),cells);}
});
test('row wrapping does not count as a connected line',()=>{const b=Array(42).fill(null);for(const c of [5,6,7,8])b[c]='R';assert.equal(dotLine(b),null);});
test('both balances and target consent are required, invitation times out without taking money',async()=>{
 const f=await setup();const g=await f.service.dotGame.open(input(),async()=>true);
 await assert.rejects(act(f,g,'accept',user),/المتحدّى/);await assert.rejects(act(f,g,'accept',actor),/للطرفين/);
 assert.deepEqual(await balances(f),[1000,1000]);f.service.clock=()=>at+30000;
 assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balances(f),[1000,1000]);
});
test('insufficient funds at opening or acceptance never make balances negative',async()=>{
 const f=await setup();f.documents.days.find(d=>d.userId===other).points.tasks=299;
 await assert.rejects(f.service.dotGame.open(input(),async()=>true),/لا يكفي/);
 f.documents.days.find(d=>d.userId===other).points.tasks=1000;const g=await f.service.dotGame.open(input(),async()=>true);
 f.documents.days.find(d=>d.userId===other).points.tasks=299;
 assert.equal((await act(f,g,'accept')).status,'cancelled');assert.deepEqual(await balances(f),[1000,299]);
});
test('horizontal winning sequence pays exactly once and every next turn has 30 seconds',async()=>{
 const f=await setup();let g=await start(f);assert.deepEqual(await balances(f),[700,700]);
 for(const [i,c] of [1,7,2,7,3,6,4].entries()){
  const old=g;g=await act(f,g,c);if(i<6){assert.equal(g.expiresAt,at+30000);assert.notEqual(g.turn,old.turn);}
 }
 assert.equal(g.status,'won');assert.equal(g.winner,user);assert.deepEqual(await balances(f),[1300,700]);
 await act(f,g,4);assert.deepEqual(await balances(f),[1300,700]);
 assert.ok(dotPayload(g).components.flatMap(r=>r.toJSON().components).every(b=>b.disabled));
});
test('outsiders, wrong turns, stale and concurrent clicks cannot play another move',async()=>{
 const f=await setup();let g=await start(f);
 await assert.rejects(act(f,g,1,actor),/للطرفين/);await assert.rejects(act(f,g,1,other),/دورك/);
 const rs=await Promise.allSettled([act(f,g,1),act(f,g,2)]);assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);
 const latest=await f.service.dotGame.get(g.id);assert.equal(latest.board.filter(Boolean).length,1);
 await assert.rejects(act(f,g,3,other),/سابق/);assert.deepEqual(await balances(f),[700,700]);
});
test('full board without four refunds both stakes exactly once',async()=>{
 const f=await setup();let g=await start(f);
 const b=Array.from({length:6},(_,r)=>(r%2?'YYRRYYR':'RRYYRRY').split('')).flat();assert.equal(dotLine(b),null);b[0]=null;
 const doc=f.documents.dot_games[0];doc.board=b;doc.turn=user;g=await f.service.dotGame.get(g.id);
 g=await act(f,g,1);assert.equal(g.status,'tie');assert.deepEqual(await balances(f),[1000,1000]);
 await act(f,g,1);assert.deepEqual(await balances(f),[1000,1000]);
});
test('late turn at exactly 30 seconds loses once even when timer races with click',async()=>{
 const f=await setup();const g=await start(f,{requireDelivery:true});await f.service.dotGame.displayed(g);
 f.service.clock=()=>at+30000;await Promise.all([f.service.dotGame.expire(),act(f,g,1)]);
 const saved=await f.service.dotGame.get(g.id);assert.equal(saved.reason,'timeout');assert.equal(saved.winner,other);assert.equal(saved.board.filter(Boolean).length,0);
 assert.deepEqual(await balances(f),[700,1300]);
});
test('undelivered boards refund instead of charging a technical timeout',async()=>{
 const f=await setup();await start(f,{requireDelivery:true});f.service.clock=()=>at+30000;await f.service.dotGame.expire();assert.deepEqual(await balances(f),[1000,1000]);assert.equal(f.documents.dot_games[0].status,'cancelled');
});
test('full column is disabled, live embed mentions the current player and updates attachment names',async()=>{
 const f=await setup();let g=await start(f);for(let i=0;i<6;i++)g=await act(f,g,1);
 const p=dotPayload(g);assert.match(p.embeds[0].data.description,new RegExp(`<@${g.turn}>`));assert.match(p.embeds[0].data.description,/30 ثانية/);
 assert.deepEqual(p.components.map(r=>r.toJSON().components.length),[4,3]);assert.equal(p.components[0].toJSON().components[0].disabled,true);
 assert.equal(p.files[0].attachment.subarray(1,4).toString(),'PNG');assert.ok(p.embeds[0].data.image.url.endsWith(p.files[0].name));
 await assert.rejects(act(f,g,1),/ممتلئ/);assert.equal((await f.service.dotGame.get(g.id)).revision,g.revision);
});
for(const phase of ['before','after'])test('interrupted payout '+phase+' is recovered without duplicate credit',async()=>{
 const f=await setup();let g=await start(f);for(const c of [1,7,2,7,3,6])g=await act(f,g,c);
 let hit=false;f.intercept(e=>{if(!hit&&e.name==='days'&&e.method==='replaceOne'&&e.phase===phase){hit=true;throw new Error('disconnect');}});
 await assert.rejects(act(f,g,4));assert.equal(f.service.blocked,true);f.intercept(()=>{});
 const restarted=f.open(at);await restarted.service.dotGame.recover();await restarted.service.dotGame.recover();assert.deepEqual(await balances(f),[1300,700]);
});
test('restart retains board, turn and deadline and changed bank cancels with refund',async()=>{
 const f=await setup();let g=await start(f);g=await act(f,g,3);const restarted=f.open(at+1000);await restarted.service.dotGame.initialize();await restarted.service.dotGame.recover();assert.deepEqual(await restarted.service.dotGame.get(g.id),g);
 f.documents.settings[0].bank.channelVersion++;await restarted.service.dotGame.expire();assert.deepEqual(await balances(f),[1000,1000]);
});
test('dot slash and text command route target and Arabic stake correctly',async()=>{
 assert.equal(buildDotCommand().toJSON().name,'دوت');let parsed;
 await createTextCommands(async i=>{parsed=i;},config)({content:`دوت <@${other}> ١٠٠٠`,id:snowflake(at,991),author:{id:user},guildId:config.clanGuildId,channelId,mentions:{users:new Map([[other,{id:other}]])}});
 assert.equal(parsed.commandName,'دوت');assert.equal(parsed.options.getInteger('المبلغ'),1000);assert.equal(parsed.options.getUser('العضو').id,other);
});
test('background manager settles and edits a timed-out game with disabled columns',async()=>{
 const f=await setup();const g=await start(f,{requireDelivery:true});await f.service.dotGame.bind(g.id,snowflake(at,990));await f.service.dotGame.displayed(g);
 f.service.clock=()=>at+30000;let payload;const message={author:{id:actor},edit:async p=>{payload=p;}};
 const bot={user:{id:actor},channels:{fetch:async()=>({guildId:config.clanGuildId,messages:{fetch:async()=>message}})}};
 const manager=new DotManager({bot,service:f.service,canRun:()=>true,onError:e=>{throw e;}});await manager.tick();await manager.drain();
 assert.ok(payload.components.flatMap(r=>r.toJSON().components).every(b=>b.disabled));assert.match(payload.embeds[0].data.description,/انتهت مهلة/);assert.deepEqual(await balances(f),[700,1300]);
});

test('held stakes cannot be reset and only the challenger receives the twenty-minute sending cooldown',async()=>{
 const f=await setup();let g=await start(f);
 await assert.rejects(f.service.reset({target:'bank',userId:user,actorId:actor,operationId:'reset-dot'}),/دوت/);
 assert.equal((await f.service.dotGame.commandTime(user,at)).nextAt,at+1200000);
 assert.equal((await f.service.dotGame.commandTime(other,at)).status,'ready');
 for(const c of [1,7,2,7,3,6,4])g=await act(f,g,c);
 await assert.rejects(f.service.dotGame.open(input({id:snowflake(at,980)}),async()=>true),/انتظار إرسال/);
 const reversed=await f.service.dotGame.open(input({id:snowflake(at,981),x:other,o:user}),async()=>true);assert.equal(reversed.status,'pending');
});

test('text invitation binds its message and button handlers edit it with the board and deny spectators',async()=>{
 const f=await setup();const errors=[];
 const handler=createDotHandler({config,service:f.service,isBankMember:async()=>true,onError:e=>errors.push(e)});
 let payload;const message={id:snowflake(at,980)};
 await createTextCommands(handler,config)({content:`دوت <@${other}> 300`,id:input().id,author:{id:user,username:'صاحب التحدي'},guildId:config.clanGuildId,channelId,createdTimestamp:at,
  mentions:{users:new Map([[other,{id:other,username:'الخصم'}]])},reply:async p=>{payload=p;return message;}});
 assert.equal(f.documents.dot_games[0].messageId,message.id);
 const accept=payload.components[0].toJSON().components[0].custom_id;
 let error;
 const press=async(customId,who)=>handler({customId,user:{id:who},guildId:config.clanGuildId,channelId,isButton:()=>true,deferUpdate:async()=>{},
  editReply:async p=>{payload=p;return message;},followUp:async p=>{error=p;}});
 await press(accept,other);assert.equal(payload.files.length,1);assert.equal(f.documents.dot_games[0].dirty,false);
 const move=payload.components[0].toJSON().components[0].custom_id;
 await press(move,actor);assert.match(error.content,/للطرفين/);assert.equal(f.documents.dot_games[0].board.filter(Boolean).length,0);
 await press(move,user);assert.equal(f.documents.dot_games[0].board[35],'R');assert.match(payload.embeds[0].data.description,new RegExp(`<@${other}>`));
});
