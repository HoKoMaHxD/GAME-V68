import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,other,config,snowflake } from './helpers/shop-fixture.js';
import { createHandler } from '../src/commands.js';
import { commandTimesPayload,commandTimesLauncher } from '../src/bank-commands.js';
const channelId='100000000000000060';
const pairs=[['xo','xo','اكس'],['numbersGame','numbers','ارقام'],['buttonGame','buttonGame','زر'],['minesGame','mines','الغام']];
for(const [property,key,label] of pairs)test(label+' time uses sender-only twenty-minute cooldown and exact expiry',async()=>{
 const f=await fixture();await f.seed(user,1000);await f.seed(other,1000);const game=f.service[property];await game.initialize();
 let g=await game.open({id:snowflake(at,20),x:user,o:other,amount:100,channelId},async()=>true);
 assert.equal((await f.service.commandTimes(user,channelId))[key].status,'ready');
 g=await game.act({id:g.id,revision:g.revision,move:'accept',userId:other,channelId},async()=>true);await game.run(()=>game.finish(g,'tie'));
 const before=structuredClone(f.documents);let v=await f.service.commandTimes(user,channelId);
 assert.deepEqual(v[key],{status:'cooldown',nextAt:at+1200000});assert.equal((await f.service.commandTimes(other,channelId))[key].status,'ready');
 const field=commandTimesPayload(v).embeds[0].data.fields.find(f=>f.name.includes(label));assert.match(field.value,/00:20:00/);assert.deepEqual(f.documents,before);
 const r=f.open(at+1200000-1);assert.equal((await r.service.commandTimes(user,channelId))[key].status,'cooldown');r.service.clock=()=>at+1200000;
 assert.equal((await r.service.commandTimes(user,channelId))[key].status,'ready');
});
function button(id,who=user){const calls=[];return {calls,customId:id,guildId:config.clanGuildId,channelId,user:{id:who},isButton:()=>true,isChatInputCommand:()=>false,
 reply:async p=>calls.push(['reply',p]),deferReply:async p=>calls.push(['deferReply',p]),editReply:async p=>calls.push(['editReply',p])};}
test('personal time button is private, owner-bound and re-reads time on every press; shared menu uses clicking user',async()=>{
 const f=await fixture();let now=at;f.service.clock=()=>now;const ctx={...f,config,isMember:async()=>false,isBankMember:async()=>true};const handler=createHandler(ctx);
 const id=commandTimesLauncher(user).components[0].toJSON().components[0].custom_id;
 const before=structuredClone(f.documents);const i=button(id);await handler(i);assert.deepEqual(i.calls[0],['deferReply',{flags:64}]);
 assert.equal(i.calls[1][1].embeds[0].data.title,'وقت أوامرك');for(const [, ,label] of pairs)assert.ok(i.calls[1][1].embeds[0].data.fields.some(f=>f.name.includes(label)));
 const denied=button(id,other);await handler(denied);assert.equal(denied.calls.length,1);assert.equal(denied.calls[0][1].flags,64);assert.match(denied.calls[0][1].content,/لصاحب الأمر/);
 now+=1000;const again=button(id);await handler(again);assert.notEqual(again.calls[1][1].embeds[0].data.timestamp,i.calls[1][1].embeds[0].data.timestamp);
 const shared=button('bank-menu:v1:time',other);await handler(shared);assert.deepEqual(shared.calls[0],['deferReply',{flags:64}]);assert.deepEqual(f.documents,before);
});
test('time button still enforces bank channel, clan guild and membership',async()=>{
 const f=await fixture();const handler=createHandler({...f,config,isMember:async()=>false,isBankMember:async()=>false});
 const denied=button(`bank-time:v1:${user}`);await handler(denied);assert.deepEqual(denied.calls.at(-1)[1].embeds,[]);
 const foreign=button(`bank-time:v1:${user}`);foreign.guildId=config.arenaGuildId;await handler(foreign);assert.equal(foreign.calls.length,1);assert.equal(foreign.calls[0][1].flags,64);
 const wrong=button(`bank-time:v1:${user}`);wrong.channelId='100000000000000061';await handler(wrong);assert.deepEqual(wrong.calls.at(-1)[1].embeds,[]);
});
