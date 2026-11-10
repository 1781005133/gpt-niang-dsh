import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createBridgeHost} from '../src/host.mjs';
import {createBridgeClient} from '../src/client-core.mjs';
import {validateDesktopControl,parseDesktopControl,isDesktopControlFresh,validateControlStatusSnapshot,parseSnapshot,MAX_CONTROL_BYTES} from '../../shared/bridge-protocol.mjs';
import {at,id,otherId,account,envelope,fixture,noRepeater,event,session,usage,status} from './helpers.mjs';
const frame=(host,{instanceId=id,seq=1,refreshSeq=0,visible=true,active=true,time=at}={})=>({schemaVersion:1,producer:'dsh-gpt-companion-desktop',instanceId,hostInstanceId:host.instanceId,epoch:host.epoch,seq,issuedAt:time,expiresAt:time+15000,active,visible,refreshSeq});
async function setup(t) {
  let close=()=>{};t.after(()=>close());const dir=fixture(t);let clock=at,rawUsage=usage(),usageHook=null,publicIdentity='one',allowed=true;
  const host=createBridgeHost({dshHome:dir,now:()=>clock,setRepeater:noRepeater,clearRepeater:()=>{},readProjection:()=>({values:{tokenUsage:rawUsage,title:{title:'Public'}}})});
  const calls=[],timers=new Map();let timerSeq=0;
  const source=()=>({ok:true,value:{fetchedAt:clock,planType:'plus',rateLimits:[{id:'codex',windows:[{windowSeconds:18000,usedPercent:30,resetsAt:Math.floor(clock/1000)+100}]}]}});
  const connection={isLoopback:true,generation:{getSnapshot:()=>id,subscribe:()=>()=>{}},rpc:{call:async(channel,method,payload,signal)=>{
    calls.push({method,payload,time:clock});assert.equal(channel,'/api');signal?.throwIfAborted();if(!allowed)throw Error('mock admission refused');
    if(method==='gpt-companion/lease')return payload.action==='acquire'?host.acquire():host.release(payload.leaseId);
    if(method==='gpt-companion/control')return host.control(payload);
    if(method==='gpt-companion/projection')return host.project(payload);
    if(method==='codex-subscription/status')return {ok:true,value:{authenticated:Boolean(publicIdentity),provider:'openai-codex',accounts:publicIdentity?[{id:publicIdentity,active:true,email:'fake@example.test'}]:[]}};
    if(method==='codex-subscription/usage')return usageHook?usageHook(payload,signal):source();
    throw Error('unexpected RPC');
  }}};
  const client=createBridgeClient({connection,now:()=>clock,setTimer:fn=>{timers.set(++timerSeq,fn);return timerSeq;},clearTimer:i=>timers.delete(i)});
  const read=kind=>parseSnapshot(fs.readFileSync(path.join(host.root,`${kind}.json`),'utf8'),kind);
  const seqs=new Map();let current={visible:false,active:true,refreshSeq:0,instanceId:id};
  const write=changes=>{Object.assign(current,changes);const selected=current.instanceId,seq=(seqs.get(selected)??0)+1;seqs.set(selected,seq);const value=frame(read('host'),{...current,seq,time:clock});fs.writeFileSync(path.join(host.root,'desktop-control.json'),JSON.stringify(validateDesktopControl(value)));return value;};
  close=async()=>{await client.dispose();host.dispose();};
  await client.start(); // default hidden: public identity only, no quota query
  return {host,client,calls,timers,read,write,source,now:()=>clock,advance:n=>{clock+=n;host.heartbeat();},setUsageHook:fn=>{usageHook=fn;},setIdentity:v=>{publicIdentity=v;},setAllowed:v=>{allowed=v;},setUsage:v=>{rawUsage=v;},usageCalls:()=>calls.filter(c=>c.method==='codex-subscription/usage')};
}
test('control schemas strictly bound producer/epoch/TTL/sequence and host-owned ACK states',()=>{
  const host=envelope(),valid=frame(host);assert.deepEqual(parseDesktopControl(JSON.stringify(valid)),valid);assert.ok(isDesktopControlFresh(valid,host,at));
  for(const bad of [{...valid,path:'../outside'},{...valid,expiresAt:at+20001},{...valid,seq:-1},{...valid,active:false},{...valid,token:'no'}])assert.throws(()=>validateDesktopControl(bad));
  assert.throws(()=>parseDesktopControl(' '.repeat(MAX_CONTROL_BYTES+1)));assert.equal(isDesktopControlFresh({...valid,epoch:id},host,at),false);assert.equal(isDesktopControlFresh(valid,host,at+15000),false);
  const control={consumerInstanceId:id,active:true,visible:true,refreshSeq:1,state:'succeeded',requestedAt:at,startedAt:at+1,completedAt:at+2,observedAt:at,retryAt:null,errorCode:null};
  assert.throws(()=>validateControlStatusSnapshot({...host,control}));
});
test('default hidden performs no usage; visible is immediate, then 60-second periodic, and resume is immediate',async t=>{
  const s=await setup(t);assert.equal(s.usageCalls().length,0);s.write({visible:true});await s.client.start();assert.equal(s.usageCalls().length,1);
  s.advance(30000);s.write({});await s.client.start();assert.equal(s.usageCalls().length,1);
  s.advance(30000);s.write({});await s.client.start();assert.equal(s.usageCalls().length,2);
  s.advance(1);s.write({visible:false});await s.client.start();assert.equal(s.usageCalls().length,2);
  s.advance(1);s.write({visible:true});await s.client.start();assert.equal(s.usageCalls().length,3);assert.deepEqual(s.usageCalls().at(-1).payload,{});
});
test('hidden public identity keeps account epoch and numeric ledger while quota independently expires unknown',async t=>{
  const s=await setup(t);s.write({visible:true});await s.client.start();const before=s.read('host'),main=session();s.host.created(main);s.host.event(main,event(1,'turn/start',{turn:0},s.now()));s.setUsage(usage(10,2));s.host.event(main,event(2,'assistant/message',{turn:0,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}},s.now()));
  s.write({visible:false});await s.client.start();const count=s.usageCalls().length;
  for(let i=0;i<4;i++){s.advance(30000);s.write({});await s.client.start();}
  assert.equal(s.usageCalls().length,count);assert.equal(s.read('host').accountKey,before.accountKey);assert.equal(s.read('host').epoch,before.epoch);assert.equal(s.read('host').numericLogs.length,1);assert.equal(s.read('quota').status.ok,false);assert.equal(s.read('quota').status.errorCode,'STALE_QUOTA');
  s.setIdentity(null);await s.client.refresh();assert.equal(s.read('host').accountKey,null);assert.equal(s.read('host').numericLogs.length,0);assert.notEqual(s.read('host').epoch,before.epoch);
});
test('real manual force is acknowledged by matching source observation, coalesced and rate-limited',async t=>{
  const s=await setup(t);s.write({visible:true});await s.client.start();const baseline=s.read('quota').status.observedAt;
  s.advance(1);s.write({refreshSeq:1});await s.client.start();let ack=s.read('control-status').control;
  assert.equal(ack.state,'succeeded');assert.equal(ack.consumerInstanceId,id);assert.equal(ack.refreshSeq,1);assert.ok(ack.observedAt>baseline);assert.equal(ack.observedAt,s.read('quota').status.observedAt);assert.ok(ack.observedAt>=ack.startedAt);assert.deepEqual(s.usageCalls().at(-1).payload,{force:true});
  const count=s.usageCalls().length;await s.client.start();assert.equal(s.usageCalls().length,count);
  s.advance(1000);s.write({refreshSeq:2});await s.client.start();ack=s.read('control-status').control;assert.equal(ack.state,'rate-limited');assert.ok(ack.retryAt>s.now());assert.equal(s.usageCalls().length,count);
  s.write({refreshSeq:4});s.advance(10000);s.write({});await s.client.start();ack=s.read('control-status').control;assert.equal(ack.state,'succeeded');assert.equal(ack.refreshSeq,4);assert.equal(s.usageCalls().length,count+1);
});
test('manual refresh stays queued while hidden, then consumes once on show',async t=>{
  const s=await setup(t);s.write({visible:false,refreshSeq:3});await s.client.start();assert.equal(s.usageCalls().length,0);assert.equal(s.read('control-status').control.state,'queued');
  s.advance(1);s.write({visible:true});await s.client.start();assert.equal(s.usageCalls().length,1);assert.deepEqual(s.usageCalls()[0].payload,{force:true});assert.equal(s.read('control-status').control.refreshSeq,3);
});
test('fixed control file rejects owner stealing, same-seq mutations, replay, expired frames and symlinks',async t=>{
  const s=await setup(t);const first=s.write({visible:true,refreshSeq:1});s.host.heartbeat();
  const file=path.join(s.host.root,'desktop-control.json');fs.writeFileSync(file,JSON.stringify({...first,visible:false,expiresAt:first.expiresAt+1}));s.host.heartbeat();assert.equal(s.read('control-status').control.visible,false);
  s.write({instanceId:otherId,visible:true,refreshSeq:0});s.host.heartbeat();assert.equal(s.read('control-status').control.visible,false);
  s.advance(15001);s.write({});s.host.heartbeat();assert.equal(s.read('control-status').control.consumerInstanceId,otherId);assert.equal(s.read('control-status').control.visible,true);
  const outside=path.join(s.host.root,'unrelated');fs.mkdirSync(outside);fs.unlinkSync(file);fs.symlinkSync(outside,file,'junction');s.host.heartbeat();assert.equal(s.read('control-status').control.visible,false);assert.equal(fs.existsSync(outside),true);
});
test('orderly inactive owner releases immediately and queued expiry is explicit, not replayable',async t=>{
  const s=await setup(t);s.write({visible:true});s.host.heartbeat();s.write({visible:false,active:false});s.host.heartbeat();
  s.write({instanceId:otherId,visible:false,active:true,refreshSeq:1});s.host.heartbeat();assert.equal(s.read('control-status').control.consumerInstanceId,otherId);assert.equal(s.read('control-status').control.state,'queued');
  s.advance(15001);assert.equal(s.read('control-status').control.state,'failed');assert.equal(s.read('control-status').control.errorCode,'CONTROL_EXPIRED');
  s.write({visible:true});s.host.heartbeat();assert.equal(s.host.control({leaseId:s.calls.find(c=>c.method==='gpt-companion/control').payload.leaseId}).value.pending,false);
});
test('matching manual sequence cannot succeed using an old source or without its own matching status',async t=>{
  const s=await setup(t);s.write({visible:true});await s.client.start();const prior=s.read('quota').status,lease=s.calls.find(c=>c.method==='gpt-companion/control').payload.leaseId;
  s.advance(1);s.write({refreshSeq:1});assert.equal(s.host.control({leaseId:lease,claimRefresh:{consumerInstanceId:id,refreshSeq:1}}).value.granted,true);
  assert.equal(s.host.project({leaseId:lease,seq:1000,identity:{accountKey:prior.accountKey,observedAt:s.now()},status:prior,refreshResult:{consumerInstanceId:id,refreshSeq:1,ok:true,observedAt:prior.observedAt,errorCode:null}}).ok,true);
  assert.equal(s.read('control-status').control.state,'failed');assert.equal(s.read('control-status').control.errorCode,'STALE_RESULT');
  s.advance(10000);s.write({refreshSeq:2});assert.equal(s.host.control({leaseId:lease,claimRefresh:{consumerInstanceId:id,refreshSeq:2}}).value.granted,true);
  s.host.project({leaseId:lease,seq:1001,identity:{accountKey:prior.accountKey,observedAt:s.now()},refreshResult:{consumerInstanceId:id,refreshSeq:2,ok:true,observedAt:s.now(),errorCode:null}});
  assert.equal(s.read('control-status').control.state,'failed');assert.equal(s.read('control-status').control.errorCode,'STALE_RESULT');
  assert.equal(s.host.project({leaseId:otherId,seq:2000,status:prior}).ok,false);
});
test('in-flight manual calls serialize, later clicks do not borrow an older completion, and stale ACKs fail',async t=>{
  const s=await setup(t);s.write({visible:true});await s.client.start();s.advance(1);let resolve;const entered=new Promise(r=>{s.setUsageHook((p,signal)=>new Promise(done=>{resolve=done;r();}));});
  s.write({refreshSeq:1});const first=s.client.start();await entered;assert.equal(s.read('control-status').control.state,'running');s.write({refreshSeq:2});const overlap=s.client.start();resolve(s.source());await Promise.all([first,overlap]);assert.equal(s.usageCalls().filter(c=>c.payload.force).length,1);assert.equal(s.read('control-status').control.refreshSeq,2);assert.notEqual(s.read('control-status').control.state,'succeeded');
  const lease=s.calls.find(c=>c.method==='gpt-companion/control').payload.leaseId;const oldStatus=s.read('quota').status;const result=s.host.project({leaseId:lease,seq:999,identity:{accountKey:oldStatus.accountKey,observedAt:s.now()},status:oldStatus,refreshResult:{consumerInstanceId:id,refreshSeq:1,ok:true,observedAt:oldStatus.observedAt,errorCode:null}});assert.equal(result.ok,true);assert.notEqual(s.read('control-status').control.state,'succeeded');
  s.setUsageHook(null);
});
test('query failure preserves verified account and gives failed ACK; timeout and disposal never fake success',async t=>{
  const s=await setup(t);s.write({visible:true});await s.client.start();const before=s.read('host');s.advance(1);s.write({refreshSeq:1});s.setUsageHook(()=>({ok:false,error:{message:'not exported'}}));await s.client.start();assert.equal(s.read('host').accountKey,before.accountKey);assert.equal(s.read('host').epoch,before.epoch);assert.equal(s.read('quota').status.ok,false);assert.equal(s.read('control-status').control.state,'failed');
  s.advance(10000);s.write({refreshSeq:2});let resolve;let entered;const ready=new Promise(r=>entered=r);s.setUsageHook(()=>new Promise(r=>{resolve=r;entered();}));const pending=s.client.start();await ready;s.advance(30001);s.write({});s.host.heartbeat();assert.equal(s.read('control-status').control.state,'timedout');resolve(s.source());await pending;assert.equal(s.read('control-status').control.state,'timedout');
  await s.client.dispose();assert.equal(s.timers.size,0);assert.equal(s.read('host').connected,false);
});
