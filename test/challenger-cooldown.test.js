import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,at,user,other,actor,snowflake } from './helpers/shop-fixture.js';
const channelId='100000000000000060';
for(const kind of ['xo','buttonGame','minesGame','numbersGame']){
 test(kind+': only outgoing challenges wait; incoming games neither block nor extend own cooldown',async()=>{
  const f=await fixture();for(const id of [user,other,actor])await f.seed(id,10000);
  let now=at;f.service.clock=()=>now;const game=f.service[kind];await game.initialize();
  const open=(seq,x,o)=>game.open({id:snowflake(at,seq),x,o,amount:100,channelId},async()=>true);
  const accept=g=>game.act({id:g.id,revision:g.revision,move:'accept',userId:g.o,channelId},async()=>true);
  const finish=g=>game.run(()=>game.finish(g,'tie'));
  const first=await accept(await open(990,user,other));await finish(first);
  await assert.rejects(open(991,user,actor),/انتظار/);
  // The prior recipient can initiate immediately, targeting the member who has a cooldown.
  now+=10000;const incoming=await open(992,other,user);assert.equal(incoming.status,'pending');
  const accepted=await accept(incoming);assert.equal(accepted.status,'active');await finish(accepted);
  await assert.rejects(open(993,user,actor),/انتظار/);
  // Restart cannot erase either initiator's cooldown. Received challenges do not move its boundary.
  const restarted=f.open(at+1200000-1);await assert.rejects(restarted.service[kind].open({id:snowflake(at,994),x:user,o:actor,amount:100,channelId},async()=>true),/انتظار/);
  const exact=f.open(at+1200000);const next=await exact.service[kind].open({id:snowflake(at,995),x:user,o:other,amount:100,channelId},async()=>true);
  assert.equal(next.status,'pending');
  // Other is still inside their own cooldown, but may accept the incoming invitation.
  assert.equal((await exact.service[kind].act({id:next.id,revision:next.revision,move:'accept',userId:other,channelId},async()=>true)).status,'active');
 });
 test(kind+': incoming cooldown exemption does not allow overlapping active rounds',async()=>{
  const f=await fixture();for(const id of [user,other,actor])await f.seed(id,10000);const game=f.service[kind];await game.initialize();
  const g=await game.open({id:snowflake(at,980),x:user,o:other,amount:100,channelId},async()=>true);
  await game.act({id:g.id,revision:g.revision,move:'accept',userId:other,channelId},async()=>true);
  await assert.rejects(game.open({id:snowflake(at,981),x:actor,o:user,amount:100,channelId},async()=>true),/قائم/);
 });
}
