import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { bankMenuPayload } from '../src/bank-menu.js';
import { createHandler } from '../src/commands.js';
import { dailyFixture, dailyConfig as config } from './helpers/daily-fixture.js';
import { user, other, at, snowflake } from './helpers/shop-fixture.js';
let sequence = 8800;
function click(customId, owner = user) {
 const calls = [];
 return {calls, customId, id:snowflake(at, sequence++), createdTimestamp:at,
 guildId:config.clanGuildId, channelId:'100000000000000060', user:{id:owner},
 guild:{id:config.clanGuildId,name:'SNOW',iconURL:()=>null},
 isButton:()=>true,isChatInputCommand:()=>false,
 reply:async p=>calls.push(['reply',p]), deferReply:async p=>calls.push(['deferReply',p]),
 editReply:async p=>{calls.push(['editReply',p]);return {id:snowflake(at,sequence++)};},
 deferUpdate:async()=>calls.push(['deferUpdate'])};
}
async function setup(){
 const f = await dailyFixture(); await f.seed(user,1000); await f.seed(other,2000);
 const handler=createHandler({...f,config,isMember:async()=>true,isBankMember:async()=>true,
 status:()=>({tracking:true}),onError:e=>{throw e;}});
 return {...f,handler};
}
test('bank launcher has one line and exact six-button order in valid rows',()=>{
 const p=bankMenuPayload(); assert.ok(p.content && !p.content.includes('\n'));
 assert.deepEqual(p.embeds,[]);
 assert.deepEqual(p.components.map(r=>r.toJSON().components.length),[3,3]);
 assert.deepEqual(p.components.flatMap(r=>r.toJSON().components.map(b=>b.label)),['توب البنك','اوامر','مهمتي','العاب','وقت','رصيدي']);
});
test('all six menu buttons open private views for the clicking member',async()=>{
 const f=await setup();
 for(const b of bankMenuPayload().components.flatMap(r=>r.toJSON().components)){
  const i=click(b.custom_id,other);await f.handler(i);
  assert.deepEqual(i.calls[0],['deferReply',{flags:MessageFlags.Ephemeral}],b.label);
  const p=i.calls.at(-1)[1];assert.ok(p.embeds?.length,b.label);assert.equal(i.calls.length,2);
  if(b.label==='اوامر'){
   assert.equal(p.embeds[0].data.title,'أوامر البنك');
   for(const name of ['رصيدي','راتب','توب البنك','نهب','حماية','مهامي','جائزة','وقت','نرد','الوان']) assert.ok(p.embeds[0].data.description.includes(name),name);
  }
  if(b.label==='رصيدي')assert.match(JSON.stringify(p),/2K/);
  if(b.label==='العاب')assert.deepEqual(p.components.flatMap(r=>r.toJSON().components.map(b=>b.label)),['نرد','الوان','اكس','زر','الغام','ارقام','دوت','مربعات','سفينة','تشابه']);
  if(b.label==='مهمتي')assert.ok(p.components[0].toJSON().components[0].custom_id.includes(other));
 }
});
test('game menu buttons start both games through the existing cooldown flow',async()=>{
 const f=await setup();
 for(const kind of ['dice','colors']){
  const first=click('clan-games:play:'+kind);await f.handler(first);
  assert.deepEqual(first.calls[0],['deferReply',{}]);
  assert.match(first.calls.at(-1)[1].components[0].toJSON().components[0].custom_id,new RegExp('mini:v1:'+kind+':'+user));
 }
});
test('menu rejects foreign guilds and wrong bank channels',async()=>{
 const f=await setup();
 const foreign=click('bank-menu:v1:balance');foreign.guildId=config.arenaGuildId;
 await f.handler(foreign);assert.equal(foreign.calls[0][0],'reply');assert.equal(foreign.calls[0][1].flags,MessageFlags.Ephemeral);
 // Expected user-facing configuration errors are handled without displaying private account data.
 const handler=createHandler({...f,config,isBankMember:async()=>true,isMember:async()=>true});
 const wrong=click('bank-menu:v1:balance');wrong.channelId=config.lookChannelId;
 await handler(wrong);assert.equal(wrong.calls.at(-1)[1].embeds.length,0);
});
