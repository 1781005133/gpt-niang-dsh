import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBridgeHost} from '../src/host.mjs';
import {createBridgeClient} from '../src/client-core.mjs';
import {registerBridgeTransport,isLocalRequest} from '../src/transport.mjs';
import {parseSnapshot,isSnapshotFresh,snapshotsMatch,validateNumericLog} from '../../shared/bridge-protocol.mjs';
import {fixture,noRepeater,at,session,event,usage,id} from './helpers.mjs';
const sdkPath=process.env.DSH_BRIDGE_TEST_SDK_ROOT;
const schema=sdkPath ? (await import(pathToFileURL(path.join(sdkPath,'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')).href)).clientRequestSchema : {safeParse:v=>({success:Boolean(v?.type==='client-request' && typeof v.rpcId==='string' && typeof v.method==='string' && Object.hasOwn(v,'payload')),data:v})};
const request=(method,payload={},origin='http://127.0.0.1:54075')=>new Request(`${origin}/api/${method}`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({type:'client-request',rpcId:'test-rpc',method,payload})});
function routesFor(host) {
  const routes=new Map();const connection={fetch:{register:route=>{routes.set(route.path,route);return ()=>routes.delete(route.path);}}};
  const dispose=registerBridgeTransport(connection,host,schema);return {routes,dispose};
}
test('uses installed SDK client request schema without creating a host, cookie, or Peer',{skip:!sdkPath},()=>{
  assert.equal(schema.safeParse({type:'client-request',rpcId:'x',method:'gpt-companion/lease',payload:{action:'acquire'}}).success,true);
  assert.equal(schema.safeParse({type:'server-response',rpcId:'x',method:'gpt-companion/lease',payload:{}}).success,false);
});
test('exact authenticated DSH route contract, loopback fence, field/body bounds and cleanup',async()=>{
  let called=0;const fake={acquire:()=>{called++;return {ok:true,value:{leaseId:id}};},release:()=>({ok:true,value:{}}),project:()=>({ok:true,value:{}})};
  const {routes,dispose}=routesFor(fake);assert.deepEqual([...routes.keys()],['/api/gpt-companion/lease','/api/gpt-companion/projection','/api/gpt-companion/control']);
  for(const route of routes.values()){assert.deepEqual(route.methods,['POST']);assert.equal(route.requestBody,'streaming');}
  const route=routes.get('/api/gpt-companion/lease');assert.equal((await route.fetch(request('gpt-companion/lease',{action:'acquire'}))).status,200);assert.equal(called,1);
  assert.equal((await route.fetch(request('gpt-companion/lease',{action:'acquire'},'http://evil.example'))).status,403);assert.equal(called,1);
  const cross=request('gpt-companion/lease',{action:'acquire'});cross.headers.set('origin','http://evil.example');assert.equal(isLocalRequest(cross),false);
  const bridged=new Request('http://dsh.internal/api/gpt-companion/lease',{method:'POST',headers:{host:'127.0.0.1:54075',origin:'http://127.0.0.1:54075','content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'sdk-http-bridge',method:'gpt-companion/lease',payload:{action:'acquire'}})});
  assert.equal(isLocalRequest(bridged),true);assert.equal((await route.fetch(bridged)).status,200);
  const noOrigin=new Request('http://dsh.internal/api/gpt-companion/lease',{headers:{host:'127.0.0.1:54075'}});assert.equal(isLocalRequest(noOrigin),true);
  assert.equal((await route.fetch(request('other/method',{}))).status,400);
  const tooBig=request('gpt-companion/lease',{action:'acquire',secret:'x'.repeat(70000)});assert.equal((await route.fetch(tooBig)).status,400);
  assert.equal((await route.fetch(request('gpt-companion/lease',{action:'acquire',path:'../../outside'}))).status,400);
  dispose();assert.equal(routes.size,0);
});
test('mock admitted client -> registered RPC -> atomic filesystem -> shared runtime reader integration',async t=>{
  let cleanup=()=>{};t.after(()=>cleanup());
  const dir=fixture(t);let publicAccount='one',sourceUsage=usage(),clock=at;
  const host=createBridgeHost({dshHome:dir,profile:'desktop',now:()=>clock,setRepeater:noRepeater,clearRepeater:()=>{},readProjection:()=>({values:{tokenUsage:sourceUsage,title:{title:'Metadata title'}}})});
  const {routes,dispose}=routesFor(host);let authenticated=true;const calls=[];
  const connection={isLoopback:true,generation:{getSnapshot:()=>id,subscribe:()=>()=>{}},rpc:{call:async(channel,method,payload)=>{
    calls.push(method);if(!authenticated) throw Error('Mock DSH admission rejects unauthorized caller');
    assert.equal(channel,'/api');
    if(method==='codex-subscription/status')return {ok:true,value:{authenticated:true,provider:'openai-codex',accounts:[{id:publicAccount,active:true,email:'must-not-copy'}]}};
    if(method==='codex-subscription/usage')return {ok:true,value:{fetchedAt:at,planType:'plus',rateLimits:[{id:'codex',windows:[{windowSeconds:18000,usedPercent:40,resetsAt:1800001000}]}]}};
    const route=routes.get(`/api/${method}`);assert.ok(route);const response=await route.fetch(request(method,payload));assert.equal(response.status,200);return (await response.json()).result;
  }}};
  const client=createBridgeClient({connection,now:()=>clock,setTimer:()=>0,clearTimer:()=>{}});
  cleanup=async()=>{await client.dispose();dispose();host.dispose();};
  await client.start();const root=host.root;
  const read=kind=>parseSnapshot(fs.readFileSync(path.join(root,`${kind}.json`),'utf8'),kind);
  const adopted=read('host');fs.writeFileSync(path.join(root,'desktop-control.json'),JSON.stringify({schemaVersion:1,producer:'dsh-gpt-companion-desktop',instanceId:id,hostInstanceId:adopted.instanceId,epoch:adopted.epoch,seq:1,issuedAt:at,expiresAt:at+15000,active:true,visible:true,refreshSeq:0}));await client.refresh();
  const first=read('host');assert.ok(first.connected);assert.ok(isSnapshotFresh(first,at));assert.ok(snapshotsMatch(first,read('quota')));assert.equal(read('quota').status.windows[0].remaining,60);
  const main=session();host.created(main);host.event(main,event(1,'turn/start',{turn:0}));sourceUsage=usage(10,4,2,1);host.event(main,event(2,'assistant/message',{turn:0,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'},get content(){throw Error('body forbidden');}}}));host.event(main,event(3,'turn/end',{turn:0,reason:{kind:'completed'}}));
  const complete=read('completion'),metadata=read('host');assert.equal(complete.seq,1);assert.equal(metadata.numericLogs.length,1);
  const [log]=metadata.numericLogs;const file=path.join(root,'numeric-logs','sessions',log.file);const text=fs.readFileSync(file,'utf8');assert.equal(Buffer.byteLength(text),log.bytes);assert.ok(validateNumericLog(text,{epoch:metadata.epoch,sessionKey:log.file.slice(37,-6)}).every(r=>!JSON.stringify(r).includes('must-not-copy')));
  publicAccount='two';await client.refresh();assert.notEqual(read('host').epoch,metadata.epoch);assert.equal(read('host').numericLogs.length,0);assert.equal(fs.existsSync(file),false);
  // Mock admission blocks before our route. No fabricated credential or in-process Peer.
  authenticated=false;await client.refresh();
  // A transport failure cannot notify the host; its bounded lease must expire, never be stolen.
  clock+=90001;host.heartbeat();assert.equal(read('host').accountKey,null);assert.equal(read('quota').status.ok,false);
  assert.ok(calls.every(m=>!m.includes('login')&&!m.includes('logout')));
  assert.ok(!fs.readdirSync(root).some(n=>n.endsWith('.tmp')));
});
