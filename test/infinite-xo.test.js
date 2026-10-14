import test from 'node:test';
import assert from 'node:assert/strict';
import {infiniteMove} from '../src/infinite-xo.js';
import {xoWinner} from '../src/xo.js';
import {xoPayload} from '../src/xo-commands.js';
import {fixture,at,user,other,snowflake} from './helpers/shop-fixture.js';
const channelId='100000000000000060';
function position(X,O){const board=Array(9).fill(null);for(const i of X)board[i]='X';for(const i of O)board[i]='O';return {board,markOrder:{X,O}};}
test('fourth mark removes own oldest and cannot win using a vanished mark',()=>{
 const before=position([0,1,8],[3,4,7]);const next=infiniteMove(before,2,'X');
 assert.deepEqual(next.markOrder.X,[1,8,2]);assert.equal(next.board[0],null);assert.equal(xoWinner(next.board),null);assert.equal(before.board[0],'X');
});
test('line remaining after oldest disappears wins; occupied oldest cannot be selected early',()=>{
 const g=position([8,0,1],[3,4,7]);assert.deepEqual(xoWinner(infiniteMove(g,2,'X').board),[0,1,2]);assert.throws(()=>infiniteMove(g,8,'X'),/فارغة/);
});
async function setup(){const f=await fixture();await f.seed(user,1000);await f.seed(other,1000);await f.service.xo.initialize();let g=await f.service.xo.open({id:snowflake(at,970),x:user,o:other,amount:300,channelId},async()=>true);g=await f.service.xo.act({id:g.id,userId:other,revision:g.revision,move:'accept',channelId},async()=>true);return {...f,g};}
const act=(f,g,cell)=>f.service.xo.act({id:g.id,userId:g.turn,revision:g.revision,move:String(cell),channelId},async()=>true);
test('new game persists FIFO queues across restart and keeps original 3x3 design',async()=>{
 const f=await setup();let g=f.g;for(const n of [0,3,1,4,8,7,2])g=await act(f,g,n);
 assert.equal(g.status,'active');assert.equal(g.board[0],null);assert.equal(g.board.filter(Boolean).length,6);
 const r=f.open(at);assert.deepEqual((await r.service.xo.get(g.id)).markOrder,g.markOrder);
 const p=xoPayload(g);assert.deepEqual(p.components.map(row=>row.toJSON().components.length),[3,3,3]);assert.equal(p.embeds[0].toJSON().title,'اكس-او');
 const cells=p.components.flatMap(row=>row.toJSON().components);assert.ok(cells.every(b=>b.style===2));assert.equal(cells[g.markOrder.O[0]].disabled,true);assert.ok(!p.embeds[0].toJSON().description.includes('الصف **'));
});
test('infinite winning payout is conserved and duplicate final click never pays twice',async()=>{
 const f=await setup();let g=f.g;for(const n of [8,3,0,4,1,7])g=await act(f,g,n);const before=g;g=await act(f,g,2);
 assert.equal(g.status,'won');assert.equal(g.winner,user);assert.equal(g.board[8],null);
 await act(f,before,2);
 assert.deepEqual(await Promise.all([user,other].map(id=>f.store.totals(id,'all',at).then(b=>b.total))),[1300,700]);
});
