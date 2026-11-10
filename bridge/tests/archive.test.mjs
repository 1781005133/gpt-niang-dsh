import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {NumericArchive} from '../src/archive.mjs';
import {atomicTextFile} from '../src/filesystem.mjs';
import {UsageAccounting,officialUsage} from '../src/usage-accounting.mjs';
import {createBridgeHost} from '../src/host.mjs';
import {parseArchiveFileName,validateNumericLog,validateArchiveState,validateArchiveStatusSnapshot,MAX_LOG_BYTES,PRODUCER} from '../../shared/bridge-protocol.mjs';
import {fixture,at,id,otherId,key,account,status,usage,event,session,memoryFiles,noRepeater,readMemory,envelope} from './helpers.mjs';
const otherAccount='c'.repeat(64);
function sample({sessionKey=key,epoch=otherId,input=10,step=0,turn=0,model='gpt-5'}={}) {
  const a=new UsageAccounting({sessionKey,baseline:officialUsage(usage()),at});a.settle(event(1,'assistant/message',{turn,step,message:{source:{provider:'openai-codex',model}}},at+1),officialUsage(usage(input,2)));return a.logs(epoch)[0];
}
const listing=(root,who)=>fs.readdirSync(path.join(root,'archive',who)).filter(name=>name.endsWith('.jsonl'));
function records(root,who,file){const {originEpoch,logId}=parseArchiveFileName(file);return validateNumericLog(fs.readFileSync(path.join(root,'archive',who,file),'utf8'),{epoch:originEpoch,sessionKey:logId});}
function lastTotal(list){return list.filter(r=>r.type==='event_msg'&&r.payload.type==='token_count').at(-1)?.payload.info.total_token_usage.input_tokens??0;}
function store(t,options={}) {
  let close=()=>{};t.after(()=>close());const root=fixture(t),archive=new NumericArchive({root,now:()=>at,...options});close=()=>archive.dispose();return {root,archive};
}
test('archive schemas, filenames and numeric-only source linkage reject arbitrary paths and fields',t=>{
  const {root,archive}=store(t),log=sample();assert.equal(archive.write(account,log.file,log.text),true);assert.equal(records(root,account,log.file)[0].payload.session_key,key);
  for(const bad of ['../outside','C:\\outside','a'.repeat(63)])assert.throws(()=>archive.write(bad,log.file,log.text));
  for(const bad of ['../'+log.file,log.file+'/../outside','quota.json'])assert.throws(()=>archive.write(account,bad,log.text));
  assert.throws(()=>archive.write(account,log.file,' '.repeat(MAX_LOG_BYTES+1)));assert.throws(()=>validateArchiveState({schemaVersion:1,producer:PRODUCER,accountKey:account,pending:false,collectionGap:false,firstGapAt:null,lastErrorAt:null,errorCode:null,body:'private'}));
  assert.ok(!log.text.includes('session-private'));assert.equal(fs.readdirSync(path.join(root,'archive',account)).some(n=>n.endsWith('.tmp')),false);
  const state=archive.status(account);assert.equal(state.totalFiles,1);assert.equal(state.totalBytes,Buffer.byteLength(log.text));assert.ok(validateArchiveStatusSnapshot({...envelope(),archive:state}));
});
test('global file/byte budgets retain old files and persist a sticky account-specific gap',async t=>{
  const {root,archive}=store(t,{maxFiles:1}),one=sample(),two=sample({sessionKey:'d'.repeat(64)});assert.ok(archive.write(account,one.file,one.text));assert.equal(archive.write(otherAccount,two.file,two.text),false);
  assert.equal(fs.readFileSync(path.join(root,'archive',account,one.file),'utf8'),one.text);assert.equal(archive.status(otherAccount).errorCode,'BUDGET_EXCEEDED');assert.equal(archive.status(account).collectionGap,false);
  archive.dispose();const again=new NumericArchive({root,now:()=>at,maxFiles:1});t.after(()=>again.dispose());await again.ready;assert.equal(again.status(otherAccount).collectionGap,true);assert.equal(again.status(otherAccount).errorCode,'BUDGET_EXCEEDED');assert.equal(again.status(account).totalFiles,1);
  const limited=new NumericArchive({root:path.join(root,'bytes'),now:()=>at,maxBytes:Buffer.byteLength(one.text)});t.after(()=>limited.dispose());assert.equal(limited.write(account,one.file,one.text),true);assert.equal(limited.write(account,two.file,two.text),false);assert.equal(limited.status(account).errorCode,'BUDGET_EXCEEDED');
  const empty=one.text.slice(0,one.text.indexOf('\n')+1);assert.equal(limited.write(account,one.file,empty),true);assert.equal(limited.status(account).collectionGap,true); // corrections may shrink, never silently purge history
});
test('archive write errors preserve the prior canonical file and remain visible after restart',async t=>{
  let broken=false;const {root,archive}=store(t,{writeFile:(target,text,max)=>{if(broken&&target.endsWith('.jsonl'))throw Error('simulated disk failure');return atomicTextFile(target,text,max);}}),one=sample();assert.ok(archive.write(account,one.file,one.text));broken=true;
  assert.equal(archive.write(account,one.file,one.text.slice(0,one.text.indexOf('\n')+1)),false);assert.equal(fs.readFileSync(path.join(root,'archive',account,one.file),'utf8'),one.text);assert.equal(archive.status(account).available,false);assert.equal(archive.status(account).collectionGap,true);
  archive.dispose();const again=new NumericArchive({root,now:()=>at});t.after(()=>again.dispose());await again.ready;assert.equal(again.status(account).available,true);assert.equal(again.status(account).collectionGap,true);assert.equal(again.status(account).errorCode,'STORAGE_ERROR');
});
test('archive roots/account directories and existing entries refuse symlinks without touching the target',t=>{
  const root=fixture(t),outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'untouched.txt'),'original');fs.mkdirSync(path.join(root,'archive'));fs.symlinkSync(outside,path.join(root,'archive',account),'junction');
  const a=new NumericArchive({root,now:()=>at}),log=sample();t.after(()=>a.dispose());assert.equal(a.write(account,log.file,log.text),false);assert.equal(a.status(account).available,false);assert.equal(fs.readFileSync(path.join(outside,'untouched.txt'),'utf8'),'original');assert.deepEqual(fs.readdirSync(outside),['untouched.txt']);
});
test('initial index yields in bounded batches, queues/coalesces durably signalled writes, and never rescans per sample',async t=>{
  const {root,archive}=store(t);for(let i=0;i<8;i++){const log=sample({sessionKey:String(i).repeat(64)});archive.write(account,log.file,log.text);}archive.dispose();
  const callbacks=[];const next=new NumericArchive({root,now:()=>at,batchSize:2,schedule:fn=>{callbacks.push(fn);return fn;},cancel:()=>{}});t.after(()=>next.dispose());assert.equal(next.scanDone,false);assert.equal(next.scanBatches,1);
  const one=sample({sessionKey:'e'.repeat(64)});next.write(account,one.file,one.text);assert.equal(next.status(account).pendingFiles,1);assert.equal(next.status(account).initializing,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'archive',account,'.collection-state.json'),'utf8')).pending,true);
  while(callbacks.length)callbacks.shift()();await next.ready;assert.ok(next.scanBatches>1);assert.equal(next.status(account).pendingFiles,0);assert.equal(next.status(account).totalFiles,9);assert.equal(next.status(account).collectionGap,false);
  const batches=next.scanBatches;for(let i=0;i<20;i++)next.status(account);next.write(account,one.file,one.text);assert.equal(next.scanBatches,batches);assert.equal(next.status(account).totalFiles,9);
});
test('queue overflow and interrupted initialization keep old data and persist explicit collection gaps',async t=>{
  const {root,archive}=store(t),seed=sample();archive.write(account,seed.file,seed.text);archive.dispose();const callbacks=[];
  const next=new NumericArchive({root,now:()=>at,batchSize:1,maxPendingFiles:1,schedule:fn=>{callbacks.push(fn);return fn;},cancel:()=>{}});const a=sample({sessionKey:'e'.repeat(64)}),b=sample({sessionKey:'f'.repeat(64)});assert.equal(next.write(account,a.file,a.text),true);assert.equal(next.write(account,b.file,b.text),false);assert.equal(next.status(account).errorCode,'QUEUE_FULL');
  next.dispose();const recovered=new NumericArchive({root,now:()=>at});t.after(()=>recovered.dispose());await recovered.ready;assert.equal(recovered.status(account).collectionGap,true);assert.equal(recovered.status(account).errorCode,'UNCLEAN_PENDING');assert.equal(fs.existsSync(path.join(root,'archive',account,seed.file)),true);
});
async function hostSetup(t) {
  let close=()=>{};t.after(()=>close());const root=fixture(t),files=memoryFiles();let raw=usage(),host,lease,projectionSeq=0;
  const make=()=>{host=createBridgeHost({dshHome:root,files,now:()=>at,setRepeater:noRepeater,clearRepeater:()=>{},readProjection:()=>({values:{tokenUsage:raw,title:{title:'Public title must not be archived'}}})});lease=host.acquire().value.leaseId;projectionSeq=0;host.project({leaseId:lease,seq:++projectionSeq,status:status()});};
  make();await host.archive.ready;close=()=>host.dispose();
  return {root:()=>host.root,files,host:()=>host,read:name=>readMemory(files,`${name}.json`),setRaw:value=>{raw=value;},async restart(){host.dispose();make();await host.archive.ready;},account:key=>host.project({leaseId:lease,seq:++projectionSeq,status:status(key)})};
}
test('closed-panel history survives segment rotation, active clearing, host restart and same-account return',async t=>{
  const s=await hostSetup(t),main=session('private-session');s.host().created(main);
  for(let i=1;i<=121;i++){s.setRaw(usage(i,0));s.host().event(main,event(i,'assistant/message',{turn:i,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}},at+i));}
  let names=listing(s.root(),account);assert.equal(names.length,2);assert.equal(s.read('host').numericLogs.length,1);assert.equal(names.reduce((n,file)=>n+lastTotal(records(s.root(),account,file)),0),121);
  await s.restart();names=listing(s.root(),account);assert.equal(names.length,2);assert.equal(s.read('archive-status').archive.totalFiles,2);assert.equal(s.read('host').numericLogs.length,0);
  s.account(otherAccount);assert.equal(s.read('archive-status').archive.accountKey,otherAccount);assert.equal(s.read('archive-status').archive.totalFiles,0);assert.equal(s.read('host').numericLogs.length,0);assert.equal(listing(s.root(),account).length,2);
  s.account(account);assert.equal(s.read('archive-status').archive.totalFiles,2);assert.equal(s.read('archive-status').archive.collectionGap,false);
  assert.ok(names.every(file=>!fs.readFileSync(path.join(s.root(),'archive',account,file),'utf8').includes('Public title')));
});
test('more than 64 active sessions can evict cache entries without losing closed-panel archives',async t=>{
  const s=await hostSetup(t);
  for(let i=0;i<65;i++){const current=session(`private-${i}`);s.setRaw(usage());s.host().created(current);s.host().event(current,event(1,'turn/start',{turn:0}));s.setRaw(usage(1,0));s.host().event(current,event(2,'assistant/message',{turn:0,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}}));s.host().event(current,event(3,'turn/end',{turn:0,reason:{kind:'completed'}}));}
  const names=listing(s.root(),account);assert.equal(s.read('host').numericLogs.length,64);assert.equal(names.length,65);assert.equal(names.reduce((total,file)=>total+lastTotal(records(s.root(),account,file)),0),65);assert.equal(s.read('archive-status').archive.collectionGap,false);
});
test('same-segment model replacement archives an empty tombstone rather than double counting old attribution',async t=>{
  const s=await hostSetup(t),main=session();s.host().created(main);s.setRaw(usage(10,2));s.host().event(main,event(1,'assistant/attempt',{turn:0,step:0}));const prior=listing(s.root(),account)[0];assert.equal(lastTotal(records(s.root(),account,prior)),10);
  s.setRaw(usage(12,3));s.host().event(main,event(2,'assistant/message',{turn:0,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}}));const names=listing(s.root(),account);assert.equal(names.length,2);assert.equal(records(s.root(),account,prior).length,1);assert.equal(names.reduce((sum,file)=>sum+lastTotal(records(s.root(),account,file)),0),12);assert.equal(s.read('host').numericLogs.length,1);
});
test('counter reset records a sticky gap but does not erase the earlier durable segment',async t=>{
  const s=await hostSetup(t),main=session();s.host().created(main);s.setRaw(usage(10,2));s.host().event(main,event(1,'assistant/message',{turn:0,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}}));const before=listing(s.root(),account)[0];
  s.setRaw(usage(1,0));s.host().event(main,event(2,'assistant/message',{turn:1,step:0,message:{source:{provider:'openai-codex',model:'gpt-5'}}}));assert.equal(s.read('archive-status').archive.collectionGap,true);assert.equal(lastTotal(records(s.root(),account,before)),10);await s.restart();assert.equal(s.read('archive-status').archive.collectionGap,true);assert.equal(fs.existsSync(path.join(s.root(),'archive',account,before)),true);
});
