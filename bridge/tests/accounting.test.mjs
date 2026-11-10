import test from 'node:test';
import assert from 'node:assert/strict';
import {UsageAccounting,officialUsage,safeTitle} from '../src/usage-accounting.mjs';
import {validateNumericLog} from '../../shared/bridge-protocol.mjs';
import {at,otherId,key,usage,event} from './helpers.mjs';
const settle=(a,seq,totals,{turn=0,step=0,model='gpt-5',provider='openai-codex',type='assistant/message'}={})=>{
  const message={source:{provider,model},get content(){throw Error('message body must not be accessed');}};
  a.settle(event(seq,type,{turn,step,message},at+seq),officialUsage(totals));
};
const make=(baseline=usage())=>new UsageAccounting({sessionKey:key,baseline:officialUsage(baseline),at});
test('official four buckets convert uncached input to Codex total input without double counting cache',()=>{
  assert.deepEqual(officialUsage(usage(10,3,4,2)),{inputTokens:16,outputTokens:3,cacheReadTokens:4,cacheWriteTokens:2});
  assert.equal(officialUsage(undefined),null); assert.equal(officialUsage(usage(-1,0)),null);
});
test('replacement, retry, per-model grouping and official aggregate conservation',()=>{
  const a=make();settle(a,1,usage(10,2,3,1),{model:'gpt-5'});
  settle(a,2,usage(12,3,3,1),{model:'gpt-5'}); // replaces same step; no duplicate billing
  assert.equal(a.samples.length,1);assert.equal(a.samples[0].usage.inputTokens,16);
  a.settle(event(3,'llm/retry-started',{turn:0,step:0},at+3),officialUsage(usage(12,3,3,1)));
  settle(a,4,usage(19,5,3,1),{type:'assistant/attempt'}); // no metadata -> unknown, no last-model guess
  settle(a,5,usage(21,7,4,1),{model:'gpt-5-mini'}); // replaces retry attempt sample into verified model
  settle(a,6,usage(25,9,4,1),{step:1,model:'other',provider:'another'});
  assert.equal(a.samples.length,3);assert.deepEqual(a.usage(),officialUsage(usage(25,9,4,1)));
  const logs=a.logs(otherId);assert.equal(logs.length,3);
  const records=logs.flatMap(l=>validateNumericLog(l.text,{epoch:otherId,sessionKey:l.file.slice(37,-6)}));
  const contexts=records.filter(r=>r.type==='turn_context').map(r=>r.payload.model);assert.deepEqual(contexts,['gpt-5','gpt-5-mini','other']);
  assert.ok(records.filter(r=>r.type==='session_meta').every(r=>r.payload.session_key===key));
});
test('unrelated retry markers do not clear another step replacement slot',()=>{
  const a=make();settle(a,1,usage(10,2),{turn:3,step:2,type:'assistant/attempt'});
  a.settle(event(2,'llm/retry-started',{turn:2,step:1},at+2),officialUsage(usage(10,2)));
  settle(a,3,usage(12,3),{turn:3,step:2,model:'gpt-5'});
  assert.equal(a.samples.length,1);assert.equal(a.samples[0].model,'gpt-5');assert.deepEqual(a.usage(),officialUsage(usage(12,3)));
});
test('fork/account startup baseline excludes inherited counters and unknown projections never invent zero',()=>{
  const a=make(usage(100,20,10,3));settle(a,1,usage(105,22,11,3),{turn:8});
  assert.deepEqual(a.usage(),officialUsage(usage(5,2,1,0)));
  const missing=make(null);assert.equal(missing.usage(),null);
  settle(missing,1,usage(100,10),{});assert.equal(missing.usage(),null);assert.equal(missing.logs(otherId).length,0);
  // Official counter decreases beyond the replacement slot cannot be attributed safely.
  settle(a,2,usage(1,0),{turn:9});assert.equal(a.usage(),null);assert.deepEqual(a.logs(otherId),[]);
});
test('bounded segment rotation preserves epoch aggregate and uses a fresh shard id for imported history',()=>{
  const a=make();
  for(let i=0;i<120;i++) settle(a,i+1,usage(i+1,0),{turn:i});
  const [older]=a.logs(otherId);assert.equal(a.samples.length,120);assert.equal(a.usage().inputTokens,120);
  settle(a,121,usage(121,0),{turn:120});const [newer]=a.logs(otherId);
  assert.equal(a.samples.length,1);assert.equal(a.usage().inputTokens,121);assert.notEqual(newer.file,older.file);
  const records=validateNumericLog(newer.text,{epoch:otherId,sessionKey:newer.file.slice(37,-6)});
  assert.equal(records.at(-1).payload.info.total_token_usage.input_tokens,1);
  const recreated=make();settle(recreated,1,usage(1,0),{turn:121});assert.notEqual(recreated.logs(otherId)[0].file,newer.file);
});
test('counter-failure recovery gets a new segment instead of replacing already imported history',()=>{
  const a=make();settle(a,1,usage(10,2),{turn:1});const prior=a.logs(otherId)[0].file;
  settle(a,2,usage(1,0),{turn:2});assert.equal(a.usage(),null);
  settle(a,3,usage(5,1),{turn:3});assert.equal(a.usage(),null);
  settle(a,4,usage(7,2),{turn:4});assert.equal(a.usage().inputTokens,2);assert.notEqual(a.logs(otherId)[0].file,prior);
});
test('attempt has explicit unknown pricing metadata and title controls/secrets are redacted',()=>{
  const a=make();settle(a,1,usage(10,2),{type:'assistant/attempt'});
  const [log]=a.logs(otherId);assert.match(log.text,/"model_provider":"unknown"/);assert.match(log.text,/"model":"unknown"/);
  assert.equal(safeTitle('a\x1b[31m\u202e\n b sk-1234567890'),'a b [redacted]');
  assert.ok(Buffer.byteLength(safeTitle('龙'.repeat(100)))<=120);
});
