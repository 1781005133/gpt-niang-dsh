import test from 'node:test';
import assert from 'node:assert/strict';
import {isLocalRequest,registerBridgeTransport} from '../src/transport.mjs';
const schema={safeParse:v=>({success:v?.type==='client-request'&&typeof v.rpcId==='string'&&typeof v.method==='string'&&Object.hasOwn(v,'payload'),data:v})};
const shellRequest=(endpoint='lease',{host='127.0.0.1:54075',origin,site,url='http://dsh.internal',payload={action:'acquire'}}={})=>{
  const headers={'content-type':'application/json'};if(host!==null)headers.host=host;if(origin!==undefined)headers.origin=origin;if(site!==undefined)headers['sec-fetch-site']=site;
  return new Request(`${url}/api/gpt-companion/${endpoint}`,{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId:'desktop-conformance',method:`gpt-companion/${endpoint}`,payload})});
};
test('owned desktop shell stripped-Origin headers reach exact lease/projection/control routes after mock owner admission',async()=>{
  const routes=new Map(),calls=[];const connection={fetch:{register:r=>{routes.set(r.path,r);return()=>routes.delete(r.path);}}};
  const host={acquire:()=>{calls.push('lease');return{ok:true,value:{}};},project:()=>{calls.push('projection');return{ok:true,value:{}};},control:()=>{calls.push('control');return{ok:true,value:{}};}};
  const dispose=registerBridgeTransport(connection,host,schema);
  for(const endpoint of ['lease','projection','control']){const request=shellRequest(endpoint);assert.equal(isLocalRequest(request),true);assert.equal((await routes.get(`/api/gpt-companion/${endpoint}`).fetch(request)).status,200);}
  assert.deepEqual(calls,['lease','projection','control']);dispose();assert.equal(routes.size,0);
});
test('NoOrigin acceptance is a local fence, never a substitute for Connection owner admission',async()=>{
  let called=0;const routes=new Map();const dispose=registerBridgeTransport({fetch:{register:r=>{routes.set(r.path,r);return()=>routes.delete(r.path);}}},{acquire:()=>{called++;return{ok:true,value:{}};}},schema);
  // This is an explicit mock gate, not a fabricated SDK Peer or proof of login.
  const admittedDispatch=(request,ownerAdmitted)=>ownerAdmitted?routes.get('/api/gpt-companion/lease').fetch(request):Promise.resolve(new Response('forbidden',{status:403}));
  assert.equal((await admittedDispatch(shellRequest(),false)).status,403);assert.equal(called,0);
  assert.equal((await admittedDispatch(shellRequest(),true)).status,200);assert.equal(called,1);dispose();
});
test('strict Host and existing Origin/cross-site rules reject malformed/foreign authorities even without Origin',()=>{
  for(const host of ['localhost','localhost:54075','127.0.0.1:54075','[::1]:54075','[::1]'])assert.equal(isLocalRequest(shellRequest('lease',{host})),true,host);
  for(const host of [null,'evil.example:54075','127.0.0.1.evil:54075','localhost@evil.example:54075','user:pass@localhost:54075','localhost/path','localhost?x','localhost#x','localhost:0','localhost:65536','localhost:-1','localhost:abc','localhost:00080','[::1]:65536','[::1]/path','127.1:54075','2130706433:54075','127.0.0.1:54075,evil'])assert.equal(isLocalRequest(shellRequest('lease',{host})),false,String(host));
  assert.equal(isLocalRequest(shellRequest('lease',{origin:'http://evil.example'})),false);
  assert.equal(isLocalRequest(shellRequest('lease',{origin:'null'})),false);
  assert.equal(isLocalRequest(shellRequest('lease',{origin:'http://127.0.0.1:54075/path'})),false);
  assert.equal(isLocalRequest(shellRequest('lease',{origin:'http://127.0.0.1:54075',site:'cross-site'})),false);
  assert.equal(isLocalRequest(shellRequest('lease',{site:'cross-site'})),false);
  assert.equal(isLocalRequest(shellRequest('lease',{url:'http://evil.example'})),false);
  assert.equal(isLocalRequest(shellRequest('lease',{origin:'http://127.0.0.1:54075'})),true);
});
