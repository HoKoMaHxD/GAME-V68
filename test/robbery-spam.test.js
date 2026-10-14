import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at, user, other, config, snowflake } from './helpers/shop-fixture.js';
import { createHandler } from '../src/commands.js';
import { commandTimesPayload } from '../src/bank-commands.js';
const channelId='100000000000000060';
const input=(id=1,who=user)=>({id:snowflake(at,id),userId:who,channelId});
const blocked=e=>e.code==='ROBBERY_SPAM_BLOCKED';
test('second attempt within ten seconds blocks five minutes, survives restart and extends by five minutes per new command',async()=>{
 const f=await fixture();let now=at;f.service.clock=()=>now;
 await f.service.registerRobberyAttempt(input());
 await f.service.registerRobberyAttempt(input()); // duplicate delivery is safe
 now+=9999;
 await assert.rejects(f.service.registerRobberyAttempt(input(2)),blocked);
 const end=now+300000;
 assert.equal((await f.store.robbery.spamState(user)).blockedUntil,end);
 const restarted=f.open(end-1);
 await assert.rejects(restarted.service.registerRobberyAttempt(input(3)),blocked);
 assert.equal((await f.store.robbery.spamState(user)).blockedUntil,end+300000);
 await assert.rejects(restarted.service.registerRobberyAttempt(input(2)),blocked);
 assert.equal((await f.store.robbery.spamState(user)).blockedUntil,end+300000);
 const ready=f.open(end+300000);await ready.service.registerRobberyAttempt(input(4));
 assert.equal((await f.store.robbery.spamState(user)).blockedUntil,0);
});
test('ten-second boundary is allowed, simultaneous new commands block only their author',async()=>{
 const f=await fixture();let now=at;f.service.clock=()=>now;
 await f.service.registerRobberyAttempt(input());now+=10000;
 await f.service.registerRobberyAttempt(input(2));now+=10000;
 const results=await Promise.allSettled([3,4,5].map(id=>f.service.registerRobberyAttempt(input(id))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.ok(results.filter(r=>r.status==='rejected').every(r=>blocked(r.reason)));
 await f.service.registerRobberyAttempt(input(6,other));
});
test('failed protected-target attempts across targets trigger punishment and وقت reports remaining ban',async()=>{
 const f=await fixture();await f.store.robbery.initialize(at);await f.seed(user,20000);await f.seed(other,20000);
 await f.service.buyProtection({id:snowflake(at,90),userId:other,channelId,at});
 const handler=createHandler({...f,config,isBankMember:async()=>true});
 const click=(id,target)=>{const calls=[];return {calls,id:snowflake(at,id),commandName:'نهب',createdTimestamp:at,
 guildId:config.clanGuildId,channelId,user:{id:user},isButton:()=>false,isChatInputCommand:()=>true,
 options:{getUser:()=>({id:target})},deferReply:async p=>calls.push(p),editReply:async p=>calls.push(p),reply:async p=>calls.push(p)};};
 const first=click(1,other);await handler(first);assert.match(first.calls.at(-1).content,/محمي/);
 const second=click(2,'100000000000000012');await handler(second);assert.match(second.calls.at(-1).content,/5 دقائق/);
 assert.equal(f.documents.robbery_rounds.length,0);
 const view=await f.service.commandTimes(user,channelId);
 assert.equal(view.robbery.status,'blocked');assert.equal(view.robbery.nextAt,at+300000);
 assert.match(JSON.stringify(commandTimesPayload(view,{},{})),/ممنوع/);
 assert.equal((await f.store.totals(user,'all',at)).total,20000);
});
test('spam ban does not prevent finishing an existing challenge or change balances on its own',async()=>{
 const f=await fixture();await f.store.robbery.initialize(at);await f.seed(user,1000);await f.seed(other,1000);
 await f.service.registerRobberyAttempt(input(1));
 const round=await f.service.openRobbery({...input(1),targetId:other,at},()=>true,min=>min);
 await assert.rejects(f.service.registerRobberyAttempt(input(2)),blocked);
 const result=await f.service.settleRobbery({...input(1),resolutionId:snowflake(at,3),move:'rock'},()=>true);
 assert.equal(result.status,'settled');assert.equal(result.result.outcome,'tie');
 assert.equal((await f.store.totals(user,'all',at)).total,1000);
});
test('lost write acknowledgement is recovered without recording another command',async()=>{
 const f=await fixture();let once=true;
 // Inject directly at the collection boundary to simulate a committed write with lost acknowledgement.
 const db=f.store.db;const collection=db.collection.bind(db);
 db.collection=name=>{const c=collection(name);if(name==='robbery_attempts'){const replace=c.replaceOne;c.replaceOne=async(...args)=>{const r=await replace(...args);if(once){once=false;throw new Error('lost acknowledgement');}return r;};}return c;};
 await f.service.registerRobberyAttempt(input(1));
 await f.service.registerRobberyAttempt(input(1));
 assert.equal((await f.store.robbery.spamState(user)).blockedUntil,0);
});
test('each new blocked command adds five minutes; duplicates and lost acknowledgments never add twice',async()=>{
 const f=await fixture();await f.service.registerRobberyAttempt(input(1));
 await assert.rejects(f.service.registerRobberyAttempt(input(2)),blocked);
 await assert.rejects(f.service.registerRobberyAttempt(input(3)),blocked);
 assert.equal((await f.store.robbery.spamState(user)).blockedUntil,at+600000);
 let once=true;f.intercept(e=>{if(once&&e.name==='robbery_attempts'&&e.method==='replaceOne'&&e.phase==='after'){once=false;throw new Error('lost acknowledgement')}});
 await assert.rejects(f.service.registerRobberyAttempt(input(4)),blocked);
 await assert.rejects(f.service.registerRobberyAttempt(input(4)),blocked);
 await assert.rejects(f.service.registerRobberyAttempt(input(2)),blocked);
 assert.equal((await f.store.robbery.spamState(user)).blockedUntil,at+900000);
});
