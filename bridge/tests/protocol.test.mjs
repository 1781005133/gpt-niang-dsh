import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeProtocolError,validateHostSnapshot,validateQuotaSnapshot,validateCompletionSnapshot,validateProjection,parseSnapshot,isSnapshotFresh,snapshotsMatch,unknownQuota,MAX_SNAPSHOT_BYTES,MAX_LOG_BYTES,validateNumericLog} from '../../shared/bridge-protocol.mjs';
import {envelope,status,at,id,otherId,key} from './helpers.mjs';
const host=()=>({...envelope(),profile:'desktop',connected:true,accountKey:'a'.repeat(64),numericLogs:[]});
const quota=()=>({...envelope(90000),status:status()});
const completion=()=>({...envelope(),seq:0,sessions:[],completion:null});
const bad=fn=>assert.throws(fn,BridgeProtocolError);
test('canonical envelope, source quota and strict whitelist round trip',()=>{
  const h=validateHostSnapshot(host()),q=validateQuotaSnapshot(quota()),c=validateCompletionSnapshot(completion());
  assert.deepEqual(parseSnapshot(JSON.stringify(h),'host'),h);assert.deepEqual(parseSnapshot(JSON.stringify(q),'quota'),q);assert.deepEqual(parseSnapshot(JSON.stringify(c),'completion'),c);
  assert.ok(isSnapshotFresh(h,at));assert.ok(snapshotsMatch(h,q));assert.ok(!snapshotsMatch(h,{...q,epoch:id}));
  bad(()=>validateHostSnapshot({...h,token:'never-persist'}));bad(()=>validateQuotaSnapshot({...q,status:{...q.status,email:'private'}}));
  bad(()=>validateCompletionSnapshot({...c,prompt:'private'}));bad(()=>parseSnapshot('{','host'));bad(()=>parseSnapshot(' '.repeat(MAX_SNAPSHOT_BYTES+1),'host'));
});
test('clock TTL, future skew, disconnected and failed statuses fail closed',()=>{
  assert.ok(!isSnapshotFresh(host(),at+20000));assert.ok(!isSnapshotFresh(host(),at-5001));assert.ok(!isSnapshotFresh({...host(),hostActive:false},at));
  bad(()=>validateHostSnapshot({...host(),expiresAt:at+20001}));bad(()=>validateHostSnapshot({...host(),connected:false}));
  bad(()=>validateQuotaSnapshot({...quota(),status:{...status(),observedAt:at-1}}));
  const unknown=unknownQuota('NO_ACCOUNT',at);assert.deepEqual(validateQuotaSnapshot({...envelope(90000),status:unknown}).status,unknown);
  bad(()=>validateQuotaSnapshot({...quota(),status:{...unknown,windows:status().windows}}));
  bad(()=>validateQuotaSnapshot({...quota(),status:{...unknown,error:'Bearer secret'}}));
});
test('numeric counters, windows, profiles, UUIDs and completion cursor are bounded',()=>{
  for(const profile of ['../desktop','C:\\desktop','desktop/x','.','a'.repeat(65)]) bad(()=>validateHostSnapshot({...host(),profile}));
  for(const used of [NaN,Infinity,-1,101,'10']) bad(()=>validateQuotaSnapshot({...quota(),status:{...status(),windows:[{...status().windows[0],used}]}}));
  bad(()=>validateQuotaSnapshot({...quota(),status:{...status(),windows:[...status().windows,...status().windows]}}));
  bad(()=>validateHostSnapshot({...host(),epoch:'bad'}));bad(()=>validateProjection({leaseId:otherId,seq:0,status:status(),token:'bad'}));
  bad(()=>validateCompletionSnapshot({...completion(),seq:1}));bad(()=>validateCompletionSnapshot({...completion(),seq:1,completion:{seq:2,sessionKey:key,turn:0,completedAt:at}}));
  bad(()=>validateCompletionSnapshot({...completion(),sessions:[{sessionKey:key,title:'x',active:true,updatedAt:at,usage:{inputTokens:1,outputTokens:0,cacheReadTokens:2,cacheWriteTokens:0}}]}));
});
test('numeric export validator rejects text, traversal, secret fields and oversize',()=>{
  const meta={timestamp:at,type:'session_meta',payload:{id:key,session_key:key,epoch:otherId,origin:'dsh-gpt-companion-bridge',model_provider:'openai-codex',source:'dsh'}};
  const token={timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:3,cached_input_tokens:2,cache_write_input_tokens:1,reasoning_output_tokens:0}}}};
  const text=[meta,token].map(JSON.stringify).join('\n')+'\n'; assert.equal(validateNumericLog(text,{epoch:otherId,sessionKey:key}).length,2);
  bad(()=>validateNumericLog(text,{epoch:id,sessionKey:key}));
  bad(()=>validateNumericLog(JSON.stringify({...meta,payload:{...meta.payload,body:'private'}}),{epoch:otherId,sessionKey:key}));
  bad(()=>validateNumericLog(text+'{"timestamp":1800000000000,"type":"assistant","payload":{"text":"secret"}}\n',{epoch:otherId,sessionKey:key}));
  bad(()=>validateNumericLog(' '.repeat(MAX_LOG_BYTES+1),{epoch:otherId,sessionKey:key}));
  bad(()=>validateHostSnapshot({...host(),numericLogs:[{file:`${otherId}-../bad.jsonl`,bytes:20,sessionKey:key}]}));
});
