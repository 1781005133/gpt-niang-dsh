import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createBridgeHost} from '../src/host.mjs';
import {createSnapshotFiles} from '../src/filesystem.mjs';
import {validateAttentionSnapshot,parseSnapshot,snapshotsMatch,isSnapshotFresh,BridgeProtocolError,HOST_TTL_MS} from '../../shared/bridge-protocol.mjs';
import {fixture,at,status,session,event,usage,envelope,key} from './helpers.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const questionKey=(s,call)=>hash(JSON.stringify([s.id,call]));
const view=(...calls)=>({active:calls.map(callId=>({callId,questions:[{question:'PRIVATE QUESTION',id:'PRIVATE QUESTION ID'}],state:'open'})),settled:[]});
function setup(t,{sessions=[],values=new Map(),home}={}) {
  let time=at,projectionReads=0,repeat,dispose=()=>{};
  // Registered before the fixture directory exists: node runs after-hooks in
  // registration order, so disposing must happen while the directory is still
  // there rather than after the fixture cleanup has removed it.
  t.after(()=>dispose());
  home ??= fixture(t);
  const files=createSnapshotFiles(path.join(home,'state','dsh-gpt-companion','desktop'));
  const host=createBridgeHost({dshHome:home,files,now:()=>time,listSessions:()=>sessions,readProjection:s=>{projectionReads++;return {asOfSeq:values.get(s.id)?.seq ?? 0,values:{tokenUsage:usage(),title:{title:'Public title'},userQuestions:values.get(s.id)?.view ?? view()}};},setRepeater:fn=>{repeat=fn;return {unref(){}};},clearRepeater:()=>{}});
  dispose=()=>host.dispose();
  const read=(kind='attention')=>parseSnapshot(fs.readFileSync(path.join(host.root,`${kind}.json`),'utf8'),kind);
  const lease=host.acquire().value.leaseId;let projectSeq=0;
  const project=(account='a'.repeat(64))=>host.project({leaseId:lease,seq:++projectSeq,status:status(account)});
  project();
  const fold=(s,v,seq,{notify=true}={})=>{values.set(s.id,{view:v,seq});if(notify)host.changed(s,'userQuestions',v,seq);};
  return {host,home,files,read,lease,project,sessions,values,fold,repeat:()=>repeat(),advance:n=>{time+=n;},reads:()=>projectionReads};
}
test('real host/filesystem publishes one event per question call batch; continuation, repeats and settled are idempotent',t=>{
  const x=setup(t),s=session();x.host.created(s);assert.deepEqual(x.read().pending,[]);
  const active=view('private-call-1');active.active[0].questions.push({id:'second',question:'PRIVATE SECOND QUESTION'});
  x.fold(s,active,1);let a=x.read();
  assert.equal(a.seq,1);assert.deepEqual(a.events,[{seq:1,sessionKey:hash(s.id),questionKey:questionKey(s,'private-call-1'),createdAt:at}]);
  assert.deepEqual(a.pending,[{sessionKey:hash(s.id),questionKey:questionKey(s,'private-call-1')}]);
  x.fold(s,active,1);x.host.heartbeat();x.repeat();assert.equal(x.read().seq,1);
  active.active[0].state='continued';x.fold(s,active,2);assert.equal(x.read().seq,1);assert.equal(x.read().pending.length,1);
  x.fold(s,{active:[],settled:[{callId:'private-call-1',get answers(){throw Error('Must never read answers');}}]},3);
  assert.deepEqual(x.read().pending,[]);assert.equal(x.read().seq,1);
  // Even an abnormal reappearance of a settled call cannot announce it again.
  x.fold(s,active,4);assert.equal(x.read().seq,1);
  assert.ok(snapshotsMatch(x.read('host'),x.read()));assert.equal(x.read().expiresAt-x.read().lastSeenAt,HOST_TTL_MS);
  assert.equal(fs.readdirSync(x.host.root).some(n=>n.endsWith('.tmp')),false);
});
test('tool/call before official fold is caught by onChanged or bounded existing heartbeat without quota reads',t=>{
  const x=setup(t),s=session();x.host.created(s);x.host.event(s,event(1,'tool/call',{get arguments(){throw Error('No transcript read');}}));
  assert.equal(x.read().seq,0);x.fold(s,view('late-fold'),1);assert.equal(x.read().seq,1);
  x.host.event(s,event(2,'tool/call'));x.fold(s,view('late-fold','heartbeat-fold'),2,{notify:false});assert.equal(x.read().seq,1);
  const before=x.reads();x.repeat();assert.equal(x.reads(),before+1);assert.equal(x.read().seq,2);x.repeat();assert.equal(x.read().seq,2);
  x.fold(s,view(),3,{notify:false});x.host.heartbeat();assert.deepEqual(x.read().pending,[]);
});
test('startup/adoption and real restart baseline existing pending without replaying notifications',t=>{
  const s=session('restored-private'),values=new Map([[s.id,{seq:8,view:view('existing-private')}]]),sessions=[s];
  s.firstLiveSeq=9;const x=setup(t,{sessions,values});assert.equal(x.read().seq,0);assert.equal(x.read().pending.length,1);
  x.host.changed(s,'userQuestions',view('existing-private'),8);x.repeat();assert.equal(x.read().seq,0);
  x.fold(s,view('existing-private','live-private'),9);assert.equal(x.read().seq,1);
  const before=x.read();x.host.dispose();assert.equal(x.read().hostActive,false);assert.deepEqual(x.read().pending,[]);
  const restarted=setup(t,{home:x.home,sessions,values});assert.notEqual(restarted.read().instanceId,before.instanceId);assert.notEqual(restarted.read().epoch,before.epoch);
  assert.equal(restarted.read().seq,0);assert.equal(restarted.read().events.length,0);assert.equal(restarted.read().pending.length,2);
  restarted.repeat();assert.equal(restarted.read().seq,0);
  restarted.fold(s,view('live-private'),10);assert.equal(restarted.read().pending.length,1);
});
test('newly adopted sessions, missing projection registration and inherited event changes baseline silently',t=>{
  const x=setup(t),s=session('adopted');x.fold(s,view('pre-existing'),4);assert.equal(x.read().seq,0);assert.equal(x.read().pending.length,1);
  const replay=session('inherited');replay.firstLiveSeq=100;x.host.created(replay);
  x.fold(replay,view('replayed'),4);assert.equal(x.read().seq,0);
  x.host.event(replay,event(5,'tool/call'));x.repeat();assert.equal(x.read().seq,0);
  x.fold(replay,view('replayed','real'),100);assert.equal(x.read().seq,1);
  // Unregistered official userQuestions must first baseline when it appears.
  const missing=session('late-registration');const root=fixture(t);let projected={tokenUsage:usage()};const h=createBridgeHost({dshHome:root,now:()=>at,listSessions:()=>[missing],readProjection:()=>({values:projected,asOfSeq:0}),setRepeater:()=>null,clearRepeater:()=>{}});t.after(()=>h.dispose());
  const lease=h.acquire().value.leaseId;h.project({leaseId:lease,seq:1,status:status()});projected={...projected,userQuestions:view('already-there')};h.heartbeat();
  assert.equal(parseSnapshot(fs.readFileSync(path.join(h.root,'attention.json'),'utf8'),'attention').seq,0);
});
test('account changes/disconnect/expiry invalidate events and current pending; new account baseline never reannounces',t=>{
  const s=session(),x=setup(t,{sessions:[s]});x.fold(s,view('private'),1);const before=x.read();assert.equal(before.seq,1);
  x.project('c'.repeat(64));assert.notEqual(x.read().epoch,before.epoch);assert.equal(x.read().seq,0);assert.equal(x.read().pending.length,1);x.repeat();assert.equal(x.read().seq,0);
  x.fold(s,view('private','new-account-call'),2);assert.equal(x.read().seq,1);const scope=x.read().epoch;
  x.host.release(x.lease);assert.notEqual(x.read().epoch,scope);assert.deepEqual(x.read().events,[]);assert.deepEqual(x.read().pending,[]);
  const lease=x.host.acquire().value.leaseId;x.host.project({leaseId:lease,seq:1,status:status()});assert.equal(x.read().seq,0);
  x.advance(90001);x.host.heartbeat();assert.deepEqual(x.read().pending,[]);assert.equal(x.read('host').connected,false);
});
test('subagent, parent-linked and delegated child projections never enter pending/events; replay fenced before discovery',t=>{
  const children=[session('sub',{origin:'subagent'}),session('parent-linked',{parentSession:'private-parent'}),session('delegated',{delegationDepth:1})],x=setup(t,{sessions:children});
  for(const s of children){x.fold(s,view('private-child-call'),1);x.host.event(s,event(2,'tool/call'));}
  x.repeat();assert.deepEqual(x.read().pending,[]);assert.deepEqual(x.read().events,[]);
  const restored=session('unseen-replay');restored.firstLiveSeq=50;x.host.event(restored,event(1,'tool/call'));assert.equal(x.read('completion').sessions.some(s=>s.sessionKey===hash(restored.id)),false);
});
test('attention does not inspect or persist questions, answers, titles, raw call/session ids or tool arguments',t=>{
  const x=setup(t),s=session('RAW_PRIVATE_SESSION_ID');x.host.created(s);
  const active=[{callId:'RAW_PRIVATE_CALL_ID',state:'open',get questions(){throw Error('Questions must not be read');}}];
  x.fold(s,{active,get settled(){throw Error('Settled answers must not be read');}},1);
  const text=fs.readFileSync(path.join(x.host.root,'attention.json'),'utf8');assert.equal(x.read().seq,1);
  for(const privateText of ['RAW_PRIVATE','questions','answers','title','callId','arguments','PRIVATE QUESTION'])assert.equal(text.includes(privateText),false);
  x.host.disposed(s);assert.deepEqual(x.read().pending,[]);x.repeat();assert.deepEqual(x.read().pending,[]);
});
test('chronological global ring is bounded32 and current pending is bounded64 across maintained sessions',t=>{
  const x=setup(t),s=session('ring');x.host.created(s);
  for(let i=1;i<=40;i++){x.advance(1);x.fold(s,view(`call-${i}`),i);}
  const a=x.read();assert.equal(a.seq,40);assert.equal(a.events.length,32);assert.deepEqual(a.events.map(e=>e.seq),Array.from({length:32},(_,i)=>i+9));
  assert.ok(a.events.every((e,i)=>i===0 || e.createdAt>=a.events[i-1].createdAt));
  x.fold(s,view(...Array.from({length:64},(_,i)=>`pending-${i}`)),41);const other=session('other');x.host.created(other);x.fold(other,view('other-call'),1);
  assert.equal(x.read().pending.length,64);assert.equal(x.read().events.length,32);
});
test('strict attention validator rejects extra/privacy fields, malformed ids, sequences, clocks and capacities',()=>{
  const event1={seq:1,sessionKey:key,questionKey:'c'.repeat(64),createdAt:at};
  const sample={...envelope(),seq:1,events:[event1],pending:[{sessionKey:key,questionKey:event1.questionKey}]};
  assert.deepEqual(parseSnapshot(JSON.stringify(sample),'attention'),sample);assert.ok(isSnapshotFresh(sample,at));assert.ok(!isSnapshotFresh(sample,at+HOST_TTL_MS));
  const bad=v=>assert.throws(()=>validateAttentionSnapshot(v),BridgeProtocolError);
  for(const prop of ['text','title','questions','answers','callId','sessionId','accountKey'])bad({...sample,[prop]:'PRIVATE'});
  for(const prop of ['text','title','question','answers']){bad({...sample,events:[{...event1,[prop]:'PRIVATE'}]});bad({...sample,pending:[{...sample.pending[0],[prop]:'PRIVATE'}]});}
  for(const seq of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1'])bad({...sample,seq});
  bad({...sample,seq:0});bad({...sample,seq:2});bad({...sample,events:[]});bad({...sample,events:[{...event1,seq:0}]});bad({...sample,events:[{...event1,questionKey:'raw-call'}]});
  bad({...sample,pending:[{...sample.pending[0],sessionKey:'raw-session'}]});bad({...sample,events:[{...event1,createdAt:0}]});bad({...sample,events:[{...event1,createdAt:at+5001}]});
  bad({...sample,seq:2,events:[{...event1,seq:2},event1]});bad({...sample,seq:2,events:[event1,{...event1,seq:2}]});
  bad({...sample,seq:2,events:[event1,{...event1,seq:2,questionKey:'d'.repeat(64),createdAt:at-1}]});
  bad({...sample,pending:[sample.pending[0],sample.pending[0]]});bad({...sample,events:Array(33).fill(event1)});bad({...sample,pending:Array(65).fill(sample.pending[0])});
  bad({...sample,hostActive:false});bad({...sample,expiresAt:at+HOST_TTL_MS+1});
  assert.deepEqual(validateAttentionSnapshot({...envelope(),seq:0,events:[],pending:[]}).events,[]);
});

test('a legacy-mode question announces from the tool call alone and clears on its result',t=>{
  // The published userQuestions projection only folds the timed variant, so in
  // the default legacy mode it stays empty. The tool call must still announce.
  const x=setup(t),s=session('legacy-user');x.host.created(s);
  x.fold(s,view(),1);
  assert.equal(x.read().seq,0);
  const call={turn:1,step:1,callId:'legacy-call-1',name:'ask_user_question',arguments:'{"questions":[{"id":"PRIVATE","question":"PRIVATE"}]}'};
  x.host.event(s,event(2,'tool/call',call));
  let a=x.read();
  assert.equal(a.seq,1);assert.equal(a.pending.length,1);
  assert.equal(a.pending[0].questionKey,questionKey(s,'legacy-call-1'));
  // The projection stays empty throughout; it must not clear the live question.
  x.fold(s,view(),3);x.host.heartbeat();x.repeat();
  assert.equal(x.read().pending.length,1);assert.equal(x.read().seq,1);
  // The result ends it, and no second announcement is produced.
  x.host.event(s,event(4,'tool/result',{turn:1,step:1,message:{role:'tool',toolCallId:'legacy-call-1',content:[{type:'text',text:'PRIVATE ANSWER'}]}}));
  assert.deepEqual(x.read().pending,[]);assert.equal(x.read().seq,1);
  // A repeated identical call id never re-announces.
  x.host.event(s,event(5,'tool/call',call));assert.equal(x.read().seq,1);
  const text=fs.readFileSync(path.join(x.host.root,'attention.json'),'utf8');
  for(const secret of ['PRIVATE','legacy-call-1','legacy-user'])assert.equal(text.includes(secret),false);
});

test('a non-question tool call and child sessions never announce anything',t=>{
  const x=setup(t),s=session('tools');x.host.created(s);
  x.host.event(s,event(1,'tool/call',{callId:'c1',name:'pwsh',arguments:'{}'}));
  x.host.event(s,event(2,'tool/call',{callId:'c2',name:'todo_write',arguments:'{}'}));
  assert.equal(x.read().seq,0);assert.deepEqual(x.read().pending,[]);
  const child=session('child',{origin:'subagent'});x.host.created(child);
  x.host.event(child,event(1,'tool/call',{callId:'c3',name:'ask_user_question',arguments:'{}'}));
  assert.equal(x.read().seq,0);assert.deepEqual(x.read().pending,[]);
});