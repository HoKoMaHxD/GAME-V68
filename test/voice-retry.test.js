import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTracker} from '../src/voice.js';
const rule={minPeople:1,ignoreMuted:false,ignoreDeafened:false};
const person=id=>({userId:id,channelId:'voice',bot:false});
test('one failed member cannot discard other members or credit departed time',async()=>{
 const saved=[],until=new Map();let fail=true;
 const tracker=new VoiceTracker({guildId:'g',service:{voice:async e=>{if(e.userId==='a'&&fail)throw new Error('db');const from=Math.max(e.from,until.get(e.userId)||0);saved.push({id:e.userId,amount:Math.max(0,e.to-from)});until.set(e.userId,e.to);}}});
 await tracker.transition(['a','b','c'].map(person),rule,new Set(['a','b','c']),0);
 await assert.rejects(tracker.transition([person('b'),person('c')],rule,new Set(['a','b','c']),15000));
 assert.equal(saved.filter(x=>x.id!=='a').reduce((s,x)=>s+x.amount,0),30000);
 fail=false;await tracker.tick(30000);
 assert.equal(saved.filter(x=>x.id==='a').reduce((s,x)=>s+x.amount,0),15000);
 assert.equal(saved.filter(x=>x.id==='b').reduce((s,x)=>s+x.amount,0),30000);
 assert.equal(tracker.pending.size,0);
});
test('committed interval with lost acknowledgment retries without duplicate time',async()=>{
 let until=0,total=0,once=true;
 const tracker=new VoiceTracker({guildId:'g',service:{voice:async e=>{total+=Math.max(0,e.to-Math.max(until,e.from));until=Math.max(until,e.to);if(once){once=false;throw new Error('lost ack')}}}});
 await tracker.transition([person('a')],rule,new Set(['a']),0);await assert.rejects(tracker.tick(15000));await tracker.tick(30000);assert.equal(total,30000);
});
test('slow member does not prevent another member starting its save',async()=>{
 let release;const started=[];const tracker=new VoiceTracker({guildId:'g',service:{voice:async e=>{started.push(e.userId);if(e.userId==='a')await new Promise(r=>release=r)}}});
 await tracker.transition(['a','b'].map(person),rule,new Set(['a','b']),0);const job=tracker.tick(15000);
 await new Promise(r=>setImmediate(r));assert.deepEqual(started,['a','b']);release();await job;
});
test('pending known time survives disconnect without counting disconnected gap',async()=>{
 let fail=true,total=0;const tracker=new VoiceTracker({guildId:'g',service:{voice:async e=>{if(fail)throw new Error('db');total+=e.to-e.from}}});
 await tracker.transition([person('a')],rule,new Set(['a']),0);await assert.rejects(tracker.tick(15000));tracker.drop();fail=false;
 await tracker.transition([person('a')],rule,new Set(['a']),90000);await tracker.tick(105000);assert.equal(total,30000);
});
