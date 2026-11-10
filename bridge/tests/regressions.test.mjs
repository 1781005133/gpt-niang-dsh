import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDshUsage} from '../src/client-core.mjs';
import {createBridgeHost} from '../src/host.mjs';
import {validateQuotaStatus,parseSnapshot} from '../../shared/bridge-protocol.mjs';
import {at,account,fixture,status,memoryFiles,noRepeater,readMemory,usage,event,session} from './helpers.mjs';
const value=individual=>({fetchedAt:at,planType:'business',rateLimits:[],individualLimit:individual});
test('Business individual-only limits preserve genuine percentages and decimal amounts through strict roundtrip',()=>{
  const normalized=normalizeDshUsage(value({limit:'120.50',used:'20.25',remainingPercent:83.2,resetsAt:1800001000}),account,at);
  assert.equal(normalized.ok,true);assert.equal(normalized.windows.length,1);const w=normalized.windows[0];
  assert.deepEqual(w,{kind:'individual',label:'个人额度',minutes:null,used:100-83.2,remaining:83.2,resetsAt:1800001000,total:120.5,amountUsed:20.25,amountRemaining:100.25});
  assert.deepEqual(validateQuotaStatus(normalized),normalized);
  const zero=normalizeDshUsage(value({limit:0,used:0,remainingPercent:0}),account,at);assert.equal(zero.ok,true);assert.equal(zero.windows[0].remaining,0);assert.equal(zero.windows[0].total,0);
  const nulls=normalizeDshUsage(value({limit:null,used:null,remainingPercent:40,resetsAt:null}),account,at);assert.equal(nulls.ok,true);assert.equal(nulls.windows[0].amountRemaining,null);
  assert.equal(normalizeDshUsage(value({limit:'100',used:'10'}),account,at).ok,false); // no guessed percentage
  for(const raw of [{limit:'NaN',used:'1',remainingPercent:90},{limit:'1e3',used:'1',remainingPercent:90},{limit:'1',used:-1,remainingPercent:90},{limit:'1',used:'1',remainingPercent:101},{limit:'1',used:'1',remainingPercent:Infinity},{limit:'1',used:'1',remainingPercent:90,resetsAt:Infinity}]) assert.equal(normalizeDshUsage(value(raw),account,at).ok,false);
});
test('arbitrary hour/day/month windows keep readable original-style labels and coexist with individual limits',()=>{
  const result=normalizeDshUsage({...value({limit:'100',used:'40',remainingPercent:60}),rateLimits:[{id:'codex',windows:[{windowSeconds:6*3600,usedPercent:4},{windowSeconds:30*86400,usedPercent:12}]}]},account,at);
  assert.equal(result.ok,true);assert.deepEqual(result.windows.map(w=>w.label),['个人额度','6 小时','30 天']);
});
test('pre-existing sessions are swept at successful account adoption before the first live settlement',t=>{
  const files=memoryFiles(),main=session('already-present');let total=usage(100,20,5,2);
  const host=createBridgeHost({dshHome:fixture(t),files,now:()=>at,setRepeater:noRepeater,clearRepeater:()=>{},listSessions:()=>[main],readProjection:()=>({values:{tokenUsage:total,title:{title:'Existing'}}})});t.after(()=>host.dispose());
  host.created(main);assert.equal(readMemory(files,'completion.json').sessions.length,0);
  const lease=host.acquire().value.leaseId;host.project({leaseId:lease,seq:1,status:status()});assert.equal(readMemory(files,'completion.json').sessions.length,1);
  total=usage(109,24,7,3);host.event(main,event(10,'assistant/message',{turn:5,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}}));
  const result=parseSnapshot(files.snapshots.get('completion.json'),'completion');assert.equal(result.seq,0);assert.deepEqual(result.sessions[0].usage,{inputTokens:12,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:1});assert.equal(files.logs.size,1);
});
test('unavailable projection remains null until a verified post-baseline sample, never fabricated zero',t=>{
  const files=memoryFiles(),main=session();let projection;
  const host=createBridgeHost({dshHome:fixture(t),files,now:()=>at,setRepeater:noRepeater,clearRepeater:()=>{},listSessions:()=>[main],readProjection:()=>({values:{tokenUsage:projection}})});t.after(()=>host.dispose());
  const lease=host.acquire().value.leaseId;host.project({leaseId:lease,seq:1,status:status()});assert.equal(readMemory(files,'completion.json').sessions[0].usage,null);
  projection=usage(20,3);host.event(main,event(1,'assistant/attempt',{turn:0,step:0}));assert.equal(readMemory(files,'completion.json').sessions[0].usage,null);assert.equal(files.logs.size,0);
  projection=usage(25,4);host.event(main,event(2,'assistant/message',{turn:1,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}}));assert.equal(readMemory(files,'completion.json').sessions[0].usage.inputTokens,5);
});
