import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeHost} from '../src/host.mjs';
import {parseSnapshot,unknownQuota,isSnapshotFresh,snapshotsMatch} from '../../shared/bridge-protocol.mjs';
import {fixture,memoryFiles,noRepeater,readMemory,at,status,session,event,usage} from './helpers.mjs';
function setup(t) {
  let time=at;const files=memoryFiles();const values=new Map();
  const host=createBridgeHost({dshHome:fixture(t),files,now:()=>time,setRepeater:noRepeater,clearRepeater:()=>{},readProjection:s=>({values:values.get(s.id) ?? {tokenUsage:usage(),title:{title:'Public title'}}})});t.after(()=>host.dispose());
  const lease=host.acquire().value.leaseId;host.project({leaseId:lease,seq:1,status:status()});
  return {host,files,values,lease,advance:n=>{time+=n;},read:name=>readMemory(files,name)};
}
test('initial unknown, live source quota and coherent atomic envelope identity',t=>{
  const s=setup(t);for(const kind of ['host','quota','completion']) assert.ok(parseSnapshot(s.files.snapshots.get(`${kind}.json`),kind));
  assert.equal(s.read('quota.json').status.source,'dsh');assert.ok(s.read('host.json').connected);assert.ok(snapshotsMatch(s.read('host.json'),s.read('quota.json')));
});
test('only live completed main turn emits one monotonic completion, no subagent/replay/failed triggers',t=>{
  const s=setup(t),main=session(),sub=session('sub',{origin:'subagent',parentSession:main.id,delegationDepth:1});
  s.host.created(main);s.host.event(main,event(1,'turn/start',{turn:0}));
  s.host.event(main,event(2,'turn/end',{turn:0,reason:{kind:'completed'}}));assert.equal(s.read('completion.json').seq,1);
  s.host.event(main,event(2,'turn/end',{turn:0,reason:{kind:'completed'}}));assert.equal(s.read('completion.json').seq,1);
  s.host.event(sub,event(1,'turn/start',{turn:0}));s.host.event(sub,event(2,'turn/end',{turn:0,reason:{kind:'completed'}}));assert.equal(s.read('completion.json').seq,1);
  s.host.event(main,event(3,'turn/start',{turn:1}));s.host.event(main,event(4,'turn/end',{turn:1,reason:{kind:'aborted'}}));assert.equal(s.read('completion.json').seq,1);
  const resumed=session('restored');resumed.firstLiveSeq=10;s.host.event(resumed,event(2,'turn/start',{turn:0}));s.host.event(resumed,event(3,'turn/end',{turn:0,reason:{kind:'completed'}}));assert.equal(s.read('completion.json').seq,1);
  s.host.event(main,event(5,'turn/start',{turn:2}));s.host.event(main,event(6,'turn/end',{turn:2,reason:{kind:'completed'}}));assert.equal(s.read('completion.json').seq,2);
});
test('official numeric logs contain model metadata but no body/raw identity; account change/failure cleans everything',t=>{
  const s=setup(t),main=session();s.host.created(main);s.host.event(main,event(1,'turn/start',{turn:0}));
  s.values.set(main.id,{tokenUsage:usage(20,3,4,2),title:{title:'Public title'}});
  s.host.event(main,event(2,'assistant/message',{turn:0,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'},get content(){throw Error('private body access');}}}));
  const h=s.read('host.json');assert.equal(h.numericLogs.length,1);assert.equal(s.files.logs.size,1);
  const text=[...s.files.logs.values()].join('');assert.ok(!text.includes(main.id));assert.ok(!text.includes('content'));assert.match(text,/"model":"gpt-5"/);
  assert.deepEqual(s.read('completion.json').sessions[0].usage,{inputTokens:26,outputTokens:3,cacheReadTokens:4,cacheWriteTokens:2});
  s.host.project({leaseId:s.lease,seq:2,status:status('c'.repeat(64))});assert.notEqual(s.read('host.json').epoch,h.epoch);assert.equal(s.files.logs.size,0);assert.equal(s.read('completion.json').sessions.length,0);
  const epoch=s.read('host.json').epoch;s.host.project({leaseId:s.lease,seq:3,status:unknownQuota('QUERY_FAILED',at)});
  assert.notEqual(s.read('host.json').epoch,epoch);assert.equal(s.read('quota.json').status.accountKey,null);assert.equal(s.read('quota.json').status.windows.length,0);assert.equal(s.read('host.json').connected,false);
});
test('lease exclusion/replay and malicious projections cannot restore an older account',t=>{
  const s=setup(t);assert.equal(s.host.acquire().ok,false);assert.equal(s.host.project({leaseId:s.lease,seq:1,status:status('c'.repeat(64))}).ok,false);
  s.host.release(s.lease);const next=s.host.acquire().value.leaseId;assert.notEqual(next,s.lease);
  assert.equal(s.host.project({leaseId:s.lease,seq:100,status:status()}).ok,false);assert.equal(s.read('host.json').accountKey,null);
  assert.equal(s.host.project({leaseId:next,seq:1,status:{...status(),token:'forbidden'}}).ok,false);assert.equal(s.read('host.json').accountKey,null);
});
test('expired client/source and host disposal produce unknown inactive records',t=>{
  const s=setup(t),old=s.read('host.json');s.advance(90001);s.host.heartbeat();
  assert.equal(s.read('quota.json').status.ok,false);assert.equal(s.read('host.json').connected,false);assert.equal(s.read('host.json').numericLogs.length,0);assert.notEqual(old.epoch,s.read('host.json').epoch);
  s.host.dispose();assert.equal(s.read('host.json').hostActive,false);assert.equal(isSnapshotFresh(s.read('host.json'),at+90001),false);
});
