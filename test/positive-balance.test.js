import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at,user,other,snowflake} from './helpers/shop-fixture.js';
const channelId='100000000000000060';
for(const funds of [0,-100])test(`robbery rejects initiating with ${funds} without creating a round`,async()=>{
 const f=await fixture();await f.store.robbery.initialize(at);await f.seed(user,funds);await f.seed(other,1000);
 await assert.rejects(f.service.openRobbery({id:snowflake(at,950),userId:user,targetId:other,channelId,at},async()=>true),/صفر أو بالسالب/);
 assert.equal(f.documents.robbery_rounds.length,0);assert.equal((await f.store.totals(user,'all',at)).total,funds);
});
for(const gameName of ['xo','buttonGame','minesGame','numbersGame'])test(`${gameName} rejects empty wallets and nonpositive stakes for both sides`,async()=>{
 for(const [a,b,amount] of [[0,1000,100],[-100,1000,100],[1000,0,100],[1000,-100,100],[1000,1000,0],[1000,1000,-100]]){
  const f=await fixture();await f.seed(user,a);await f.seed(other,b);const game=f.service[gameName];await game.initialize();
  await assert.rejects(game.open({id:snowflake(at,951),x:user,o:other,amount,channelId},async()=>true));
  assert.equal(f.documents[`${game.prefix}_games`].length,0);
  assert.equal((await f.store.totals(user,'all',at)).total,a);
 }
});
