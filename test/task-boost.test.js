import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,actor,config,snowflake } from './helpers/shop-fixture.js';
import { dailyFixture,dailyConfig as c } from './helpers/daily-fixture.js';
import { boostedReward,BOOST_ROLE_ID } from '../src/task-boost.js';
import { BoostManager,boostPayload,createBoostHandler,buildBoostCommand } from '../src/task-boost-commands.js';
const channelId='100000000000000060',imageUrl='https://example.com/banner.png';
const input=(patch={})=>({id:snowflake(at,900),actorId:actor,channelId,multiplier:3,minutes:60,imageUrl,...patch});
test('multipliers apply only at completion inside the exact event interval',()=>{
 const b={id:'boost',multiplier:4,startsAt:at,endsAt:at+60000};
 for(const [time,amount] of [[at-1,100],[at,400],[at+59999,400],[at+60000,100]])assert.equal(boostedReward(100,time,b).points,amount);
 assert.throws(()=>boostedReward(Number.MAX_SAFE_INTEGER,at,b));assert.equal(boostedReward(100,at,null).points,100);
});
test('event creation validates input, persists, rejects overlap and is idempotent',async()=>{
 const f=await fixture();for(const patch of [{multiplier:1},{multiplier:101},{multiplier:2.5},{minutes:0},{minutes:10081},{imageUrl:'http://bad'},{imageUrl:null}])await assert.rejects(f.service.boosts.create(input(patch)));
 const g=await f.service.boosts.create(input());assert.equal(g.multiplier,3);assert.deepEqual(await f.service.boosts.create(input()),g);
 await assert.rejects(f.service.boosts.create(input({id:snowflake(at,901)})),/فعال/);
 const r=f.open(at+1000);assert.equal((await r.store.taskBoostAt(at+1000)).id,g.id);assert.equal(await r.store.taskBoostAt(g.endsAt),null);
 r.service.clock=()=>g.endsAt;await r.service.boosts.create(input({id:snowflake(at,902),multiplier:2}));
});
test('daily message rewards multiply once, old completions stay unchanged and expired boost does not pay extra',async()=>{
 const f=await dailyFixture();await f.post(c.feelingChannelId,{mentionedRoleIds:[c.memberRole]});const before=await f.service.day(user);assert.equal(before.points.tasks,1500);
 f.time(at+1000);const g=await f.service.boosts.create(input());const event=f.message(c.lookChannelId,{mentionedRoleIds:[c.memberRole],hasMedia:true});
 await f.service.message(event);await f.service.message(event);let state=await f.service.day(user);assert.equal(state.points.tasks,4500);
 const log=state.completionLog.find(e=>e.taskId==='daily-look-media');assert.equal(log.points,3000);assert.equal(log.basePoints,1000);assert.equal(log.multiplier,3);assert.equal(log.boostId,g.id);
 assert.equal(state.completionLog.find(e=>e.taskId==='daily-feeling-mention').points,1500);
 f.time(g.endsAt);for(let i=0;i<50;i++)await f.post(c.generalChannelId);state=await f.service.day(user);assert.equal(state.completionLog.find(e=>e.taskId==='daily-general-50').points,8000);
});
test('voice task is multiplied but separate attendance is not',async()=>{
 const f=await dailyFixture();await f.service.boosts.create(input({multiplier:2}));let state=await f.service.day(user);
 await f.store.mutateDay(state._id,d=>{d.tasks.find(t=>t.type==='voice').progress=180*60000-1000;d.voiceUntil=at;return true;});f.time(at+1000);
 await f.service.voice({guildId:c.arenaGuildId,userId:user,eligible:true,channelId:c.voiceChannelId,from:at,to:at+1000},{...c.attendance,intervalMs:1000,points:10});
 state=await f.service.day(user);assert.equal(state.completionLog.find(e=>e.taskId==='daily-voice-180').points,18000);assert.equal(state.points.attendance,10);
});
test('verified games task multiplies and remains idempotent across restart',async()=>{
 const f=await dailyFixture();await f.service.boosts.create(input({multiplier:4}));f.time(at+1000);
 for(let n=0;n<5;n++){const event={guildId:c.arenaGuildId,channelId:c.gamesChannelId,botId:c.gamesBotId,userId:user,eligible:true,at:at+1000,id:snowflake(at+1000,100+n),gameId:snowflake(at+1000,200+n)};await f.service.game(event);await f.service.game(event);}
 const r=await f.restart();const state=await r.service.day(user);assert.equal(state.completionLog.find(e=>e.taskId==='daily-games-5').points,22000);assert.equal(state.points.tasks,22000);
});
for(const phase of ['before','after'])test('event write failure '+phase+' cannot create stacked multipliers',async()=>{
 const f=await fixture();let failed=false;f.intercept(e=>{if(!failed&&e.name==='task_boosts'&&e.method==='updateOne'&&e.phase===phase){failed=true;throw new Error('disconnect');}});
 if(phase==='before')await assert.rejects(f.service.boosts.create(input()));else await f.service.boosts.create(input());f.intercept(()=>{});await f.service.boosts.create(input());assert.equal(f.documents.task_boosts.length,1);
});
function botFixture(){const messages=new Map(),sent=[];const channel={id:channelId,guildId:config.clanGuildId,type:0,permissionsFor:()=>({has:()=>true}),guild:{roles:{fetch:async id=>({id,mentionable:true})}},messages:{fetch:async arg=>typeof arg==='object'?messages:messages.get(arg)},send:async p=>{sent.push(p);const m={id:snowflake(at,990),author:{id:actor},embeds:p.embeds.map(e=>e.toJSON()),edit:async q=>{m.embeds=q.embeds.map(e=>e.toJSON());m.last=q;}};messages.set(m.id,m);return m;}};return {bot:{user:{id:actor},channels:{fetch:async()=>channel}},channel,sent,messages};}
test('announcement uses same channel, exact role and image, recovers lost bind without duplicate ping, and closes at expiry',async()=>{
 const f=await fixture(),b=botFixture();const g=await f.service.boosts.create(input());const manager=new BoostManager({...b,service:f.service,canRun:()=>true,onError:()=>{}});
 const patch=f.service.boosts.patch.bind(f.service.boosts);let fail=true;f.service.boosts.patch=async(...a)=>{if(fail){fail=false;throw new Error('lost bind');}return patch(...a);};
 await assert.rejects(manager.publish(g.id));await manager.publish(g.id);assert.equal(b.sent.length,1);assert.deepEqual(b.sent[0].allowedMentions.roles,[BOOST_ROLE_ID]);assert.equal(b.sent[0].embeds[0].data.image.url,imageUrl);
 f.service.clock=()=>g.endsAt;await manager.tick();assert.equal((await f.service.boosts.get(g.id)).announcementDone,true);const message=[...b.messages.values()][0];assert.match(message.embeds[0].title,/انتهى/);assert.deepEqual(message.last.allowedMentions.roles,[]);
});
test('slash command requires management and posts the public announcement through the manager',async()=>{
 const f=await fixture(),b=botFixture();const manager=new BoostManager({...b,service:f.service,canRun:()=>true,onError:()=>{}});const handler=createBoostHandler({config,service:f.service,bot:b.bot,boostManager:manager});
 const calls=[];const i={id:snowflake(at,980),guildId:config.clanGuildId,channelId,commandName:'دبل',user:{id:actor},guild:{ownerId:user},isChatInputCommand:()=>true,reply:async p=>calls.push(p),deferReply:async p=>calls.push(p),editReply:async p=>calls.push(p),options:{getInteger:n=>n==='المضاعف'?2:30,getAttachment:()=>({name:'banner.png',contentType:'image/png',url:imageUrl})}};
 await handler(i);assert.equal(f.documents.task_boosts.length,0);assert.equal(calls[0].flags,64);
 i.guild.ownerId=actor;await handler(i);assert.equal(f.documents.task_boosts.length,1);assert.equal(b.sent.length,1);assert.equal(f.documents.task_boosts[0].channelId,channelId);assert.match(calls.at(-1).content,/تم تفعيل/);
 const schema=buildBoostCommand().toJSON();assert.deepEqual(schema.options.map(o=>o.name),['المضاعف','المدة','الصورة']);
});
test('concurrent administrator commands cannot create overlapping boosts',async()=>{
 const f=await fixture();const results=await Promise.allSettled([f.service.boosts.create(input()),f.service.boosts.create(input({id:snowflake(at,901),multiplier:4}))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.documents.task_boosts.length,1);
});
