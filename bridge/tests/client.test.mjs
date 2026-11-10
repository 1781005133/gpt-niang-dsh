import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeClient,normalizeDshUsage,activeAccountId,publicAccountIdentity,accountHash} from '../src/client-core.mjs';
import {at,id,account} from './helpers.mjs';
const signed=(active='public-account')=>({ok:true,value:{authenticated:true,provider:'openai-codex',accounts:[{id:active,active:true,email:'never-export@example.test',label:'private'}]}});
const usage=()=>({ok:true,value:{fetchedAt:at,planType:'plus',rateLimits:[{id:'codex',windows:[{windowSeconds:18000,usedPercent:25,resetsAt:Math.floor(at/1000)+100}]},{id:'code_review',windows:[{windowSeconds:18000,usedPercent:99}]}],credits:{balance:'100'},authorization:'must-not-export'}});
function setup(overrides={}) {
  const calls=[],sent=[];let statusCalls=0;let gen={id:1};let listener;
  const conn={isLoopback:true,generation:{getSnapshot:()=>gen,subscribe:fn=>{listener=fn;return ()=>{listener=null;};}},rpc:{call:async(channel,method,payload,signal)=>{
    calls.push({channel,method,payload});assert.equal(channel,'/api');signal?.throwIfAborted();
    if(method==='gpt-companion/lease') return {ok:true,value:{leaseId:id}};
    if(method==='gpt-companion/control')return {ok:true,value:{visible:true,consumerInstanceId:id,refreshSeq:0,pending:false,retryAt:null,granted:false}};
    if(method==='codex-subscription/status') {statusCalls++;return overrides.status ? overrides.status(statusCalls) : signed();}
    if(method==='codex-subscription/usage') {if(overrides.usage) return overrides.usage(signal);return usage();}
    if(method==='gpt-companion/projection') {sent.push(payload);return {ok:true,value:{}};}
    throw Error('Unexpected RPC');
  }}};
  const timers=new Map();let timerId=0;
  const client=createBridgeClient({connection:conn,now:()=>at,setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:n=>timers.delete(n)});
  return {client,conn,calls,sent,timers,change:newGen=>{gen=newGen;listener?.();}};
}
test('genuine client RPC maps only codex quota and hashed identity with exact read-only methods',async()=>{
  const s=setup();await s.client.start();assert.equal(s.sent.length,1);const projected=s.sent[0].status;
  assert.equal(projected.ok,true);assert.equal(projected.windows[0].minutes,300);assert.equal(projected.windows[0].remaining,75);assert.notEqual(projected.accountKey,'public-account');assert.match(projected.accountKey,/^[a-f0-9]{64}$/);
  const disk=JSON.stringify(s.sent);assert.ok(!disk.includes('email'));assert.ok(!disk.includes('balance'));assert.ok(!disk.includes('authorization'));assert.ok(!disk.includes('public-account'));
  assert.deepEqual(s.calls.map(c=>c.method),['gpt-companion/lease','gpt-companion/control','codex-subscription/status','codex-subscription/usage','codex-subscription/status','gpt-companion/projection']);
  assert.deepEqual(s.calls[2].payload,{});await s.client.dispose();assert.equal(s.calls.at(-1).payload.action,'release');assert.equal(s.timers.size,0);
});
test('account switch race, signed-out and upstream failures never forward old quota',async()=>{
  for(const overrides of [{status:n=>signed(n===1?'one':'two')},{status:()=>({ok:true,value:{authenticated:false}})},{usage:()=>{throw Error('Bearer sensitive upstream exception');}}]) {
    const s=setup(overrides);await s.client.start();assert.equal(s.sent[0].status.ok,false);assert.equal(s.sent[0].status.accountKey,null);assert.equal(s.sent[0].status.windows.length,0);assert.ok(!JSON.stringify(s.sent).includes('sensitive'));await s.client.dispose();
  }
  assert.equal(activeAccountId({ok:true,value:{authenticated:true,provider:'openai-codex'}}),null);
});
test('public identity fingerprint includes normalized email and fences a same-slot email switch without persisting it',async()=>{
  const first=signed('same-slot'),second=signed('same-slot');second.value.accounts[0].email='other@example.test';
  assert.notEqual(await accountHash(publicAccountIdentity(first)),await accountHash(publicAccountIdentity(second)));
  second.value.accounts[0].email=' NEVER-EXPORT@EXAMPLE.TEST ';
  assert.equal(await accountHash(publicAccountIdentity(first)),await accountHash(publicAccountIdentity(second)));
  const s=setup({status:n=>{const response=signed('same-slot');response.value.accounts[0].email=n===1?'first@example.test':'second@example.test';return response;}});
  await s.client.start();assert.equal(s.sent[0].status.ok,false);assert.equal(s.sent[0].status.errorCode,'ACCOUNT_CHANGED');assert.ok(!JSON.stringify(s.sent).includes('@'));await s.client.dispose();
  first.value.accounts[0].email='bad\nmetadata';assert.equal(publicAccountIdentity(first),null);
});
test('quota staleness/nonfinite data are unknown, no credit-to-percent fallback',()=>{
  assert.equal(normalizeDshUsage({...usage().value,fetchedAt:at-90000},account,at).ok,false);
  assert.equal(normalizeDshUsage({...usage().value,rateLimits:[{id:'codex',windows:[{windowSeconds:18000,usedPercent:Infinity}]}]},account,at).ok,false);
  assert.equal(normalizeDshUsage({...usage().value,rateLimits:[],credits:{balance:'100'}},account,at).ok,false);
});
test('non-loopback/disconnected clients make zero calls; disposal aborts in-flight query and releases',async()=>{
  const remote=setup();remote.conn.isLoopback=false;await remote.client.start();assert.equal(remote.calls.length,0);await remote.client.dispose();
  let entered;const ready=new Promise(r=>entered=r);
  const s=setup({usage:signal=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const started=s.client.start();await ready;await s.client.dispose();await started;assert.equal(s.sent.length,0);assert.equal(s.calls.at(-1).payload.action,'release');assert.equal(s.timers.size,0);
});
