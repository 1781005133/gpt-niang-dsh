import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeHost} from '../src/host.mjs';
import {createBridgeClient} from '../src/client-core.mjs';
import {validateDesktopControl} from '../../shared/bridge-protocol.mjs';
import {at,id,fixture,memoryFiles,noRepeater,readMemory} from './helpers.mjs';
async function setup(t) {
  let close=()=>{};t.after(()=>close());const root=fixture(t),files=memoryFiles(),calls=[];let time=at,host,client,writerSeq=0;
  const create=()=>{
    host=createBridgeHost({dshHome:root,files,now:()=>time,setRepeater:noRepeater,clearRepeater:()=>{}});
    const connection={isLoopback:true,generation:{getSnapshot:()=>id,subscribe:()=>()=>{}},rpc:{call:async(channel,method,payload)=>{
      calls.push({method,payload});assert.equal(channel,'/api');
      if(method==='gpt-companion/lease')return payload.action==='acquire'?host.acquire():host.release(payload.leaseId);
      if(method==='gpt-companion/control')return host.control(payload);
      if(method==='gpt-companion/projection')return host.project(payload);
      if(method==='codex-subscription/status')return {ok:true,value:{authenticated:true,provider:'openai-codex',accounts:[{id:'one',active:true}]}};
      if(method==='codex-subscription/usage')return {ok:true,value:{fetchedAt:time,rateLimits:[{id:'codex',windows:[{windowSeconds:18000,usedPercent:25}]}]}};
      throw Error('unexpected RPC');
    }}};
    client=createBridgeClient({connection,now:()=>time,setTimer:()=>0,clearTimer:()=>{}});
  };
  const read=name=>readMemory(files,`${name}.json`);
  const write=(refreshSeq,active,visible)=>{
    const h=read('host');files.controlFrame=validateDesktopControl({schemaVersion:1,producer:'dsh-gpt-companion-desktop',instanceId:id,hostInstanceId:h.instanceId,epoch:h.epoch,seq:++writerSeq,issuedAt:time,expiresAt:time+15000,active,visible,refreshSeq});host.heartbeat();
  };
  const baseline=refreshSeq=>{
    write(refreshSeq,false,false);const h=read('host'),ack=read('control-status');assert.equal(ack.instanceId,h.instanceId);assert.equal(ack.epoch,h.epoch);assert.equal(ack.control.consumerInstanceId,id);assert.equal(ack.control.refreshSeq,refreshSeq);assert.equal(ack.control.active,false);
  };
  create();await client.start();close=async()=>{await client.dispose();host.dispose();};
  return {read,write,baseline,calls,files,client:()=>client,host:()=>host,advance:n=>{time+=n;},forceCount:()=>calls.filter(c=>c.method==='codex-subscription/usage'&&c.payload.force===true).length,
    async restart(){await client.dispose();host.dispose();create();await client.start();},
  };
}
test('original host inactive-first consumes historical initial counter; only post-handshake new click forces',async t=>{
  const s=await setup(t);s.baseline(42);s.write(42,true,true);await s.client().refresh();assert.equal(s.forceCount(),0);
  const ack=s.read('control-status').control;assert.equal(ack.refreshSeq,42);assert.ok(['failed','idle'].includes(ack.state));
  // An explicit first click waited in runtime memory; it increments only after the baseline ACK.
  s.advance(1);s.write(43,true,true);await s.client().refresh();assert.equal(s.forceCount(),1);assert.equal(s.read('control-status').control.state,'succeeded');assert.equal(s.read('control-status').control.refreshSeq,43);
});
test('account epoch rebind does not replay old queued or completed refresh counters',async t=>{
  const s=await setup(t);s.baseline(5);s.write(5,true,true);await s.client().refresh();
  s.write(6,true,false);assert.equal(s.read('control-status').control.state,'queued');const oldEpoch=s.read('host').epoch;
  s.host().invalidate('ACCOUNT_CHANGED');await s.client().refresh();assert.notEqual(s.read('host').epoch,oldEpoch);
  s.baseline(6);s.write(6,true,true);await s.client().refresh();assert.equal(s.forceCount(),0);
  s.advance(1);s.write(7,true,true);await s.client().refresh();assert.equal(s.forceCount(),1);
  const oldAck=s.calls.filter(c=>c.method==='gpt-companion/projection'&&c.payload.refreshResult).at(-1).payload;
  s.host().invalidate('ACCOUNT_CHANGED');await s.client().refresh();s.baseline(7);s.write(7,true,true);await s.client().refresh();assert.equal(s.forceCount(),1);
  assert.equal(s.host().project(oldAck).ok,false);assert.equal(s.forceCount(),1); // late/replayed old capability cannot issue force
});
test('host restart with empty books never replays process-lifetime historical counter after inactive handshake',async t=>{
  const s=await setup(t);s.baseline(17);s.write(17,true,true);await s.client().refresh();const old=s.read('host');
  await s.restart();assert.notEqual(s.read('host').instanceId,old.instanceId);assert.equal(s.forceCount(),0);
  s.baseline(17);s.write(17,true,true);await s.client().refresh();assert.equal(s.forceCount(),0);
  s.advance(1);s.write(18,true,true);await s.client().refresh();assert.equal(s.forceCount(),1);
});
