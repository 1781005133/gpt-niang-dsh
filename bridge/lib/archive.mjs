import fs from 'node:fs';
import path from 'node:path';
import {PRODUCER,SCHEMA_VERSION,MAX_LOG_BYTES,MAX_ARCHIVE_BYTES,MAX_ARCHIVE_FILES,MAX_ARCHIVE_STATE_BYTES,parseArchiveFileName,validateNumericLog,validateArchiveState,parseArchiveState} from './bridge-protocol.mjs';
import {assertNoLinks,atomicTextFile,readBoundedRegular} from './filesystem.mjs';
const accountId=value=>{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw Error('Invalid archive account');return value;};
const cleanState=key=>({schemaVersion:SCHEMA_VERSION,producer:PRODUCER,accountKey:key,pending:false,collectionGap:false,firstGapAt:null,lastErrorAt:null,errorCode:null});
// One incremental index per host. No recursive/all-library scan per sample.
export class NumericArchive {
  constructor({root,now=Date.now,maxBytes=MAX_ARCHIVE_BYTES,maxFiles=MAX_ARCHIVE_FILES,batchSize=128,maxPendingBytes=8*1024*1024,maxPendingFiles=128,writeFile=atomicTextFile,schedule=setImmediate,cancel=clearImmediate}={}) {
    this.root=path.join(path.resolve(root),'archive');this.now=now;this.maxBytes=maxBytes;this.maxFiles=maxFiles;this.batchSize=Math.max(1,Math.min(128,batchSize));this.maxPendingBytes=maxPendingBytes;this.maxPendingFiles=maxPendingFiles;this.writeFile=writeFile;this.schedule=schedule;this.cancel=cancel;
    this.index=new Map();this.counts=new Map();this.states=new Map();this.pending=new Map();this.pendingBytes=0;this.totalBytes=0;this.totalFiles=0;this.scanEntries=0;this.scanBatches=0;this.scanDone=false;this.scanError=false;this.ioUnavailable=new Set();this.closed=false;
    this.ready=new Promise(resolve=>{this.resolveReady=resolve;});
    try{this.mkdir(this.root);this.rootDir=fs.opendirSync(this.root);this.scanStep();}catch{this.finishScan(false);}
  }
  mkdir(dir){assertNoLinks(dir);fs.mkdirSync(dir,{recursive:true,mode:0o700});assertNoLinks(dir);}
  accountDir(key){return path.join(this.root,accountId(key));}
  persist(state){
    try{const dir=this.accountDir(state.accountKey);this.mkdir(dir);this.writeFile(path.join(dir,'.collection-state.json'),JSON.stringify(validateArchiveState(state)),MAX_ARCHIVE_STATE_BYTES);return true;}
    catch{this.ioUnavailable.add(state.accountKey);return false;}
  }
  state(key){
    accountId(key);if(this.states.has(key))return this.states.get(key);
    let value=cleanState(key),dirty=false;
    try{const text=readBoundedRegular(path.join(this.accountDir(key),'.collection-state.json'),MAX_ARCHIVE_STATE_BYTES);if(text!==null){value=parseArchiveState(text);if(value.accountKey!==key)throw Error('Wrong archive state');if(value.pending){value={...value,pending:false,collectionGap:true,firstGapAt:value.firstGapAt??this.now(),lastErrorAt:this.now(),errorCode:'UNCLEAN_PENDING'};dirty=true;}}}
    catch{value={...value,collectionGap:true,firstGapAt:this.now(),lastErrorAt:this.now(),errorCode:'STATE_INVALID'};dirty=true;}
    this.states.set(key,value);if(dirty)this.persist(value);return value;
  }
  markGap(key,code){const state=this.state(key);if(state.collectionGap&&state.errorCode===code&&this.now()-state.lastErrorAt<5000)return;Object.assign(state,{collectionGap:true,firstGapAt:state.firstGapAt??this.now(),lastErrorAt:this.now(),errorCode:code});this.persist(state);}
  count(key,file,bytes){
    const name=`${key}/${file}`,prior=this.index.get(name),group=this.counts.get(key)??{files:0,bytes:0};
    if(prior===undefined){this.totalFiles++;group.files++;}this.totalBytes+=bytes-(prior??0);group.bytes+=bytes-(prior??0);this.index.set(name,bytes);this.counts.set(key,group);
  }
  later(fn){if(this.closed||this.handle)return;this.handle=this.schedule(()=>{this.handle=null;if(!this.closed)fn.call(this);});}
  scanStep(){
    if(this.closed||this.scanDone)return;this.scanBatches++;
    try{
      for(let i=0;i<this.batchSize;i++){
        if(++this.scanEntries>MAX_ARCHIVE_FILES*2+1024)throw Error('Archive index limit');
        if(this.accountStream){
          const entry=this.accountStream.readSync();if(!entry){this.accountStream.closeSync();this.accountStream=null;continue;}
          const target=assertNoLinks(path.join(this.accountDir(this.scanAccount),entry.name)),info=fs.lstatSync(target);
          if(!info.isFile())throw Error('Unsafe archive entry');
          if(entry.name==='.collection-state.json'){if(info.size>MAX_ARCHIVE_STATE_BYTES)throw Error('Archive state too large');continue;}
          parseArchiveFileName(entry.name);if(info.size>MAX_LOG_BYTES)throw Error('Archive log too large');this.count(this.scanAccount,entry.name,info.size);
        }else{
          const entry=this.rootDir.readSync();if(!entry){this.rootDir.closeSync();this.rootDir=null;this.finishScan(true);return;}
          accountId(entry.name);const dir=assertNoLinks(this.accountDir(entry.name));if(!fs.lstatSync(dir).isDirectory())throw Error('Unsafe archive account');this.scanAccount=entry.name;this.accountStream=fs.opendirSync(dir);
        }
      }
      this.later(this.scanStep);
    }catch{this.finishScan(false);}
  }
  finishScan(ok){
    this.scanDone=true;this.scanError=!ok;
    for(const name of ['rootDir','accountStream'])if(this[name]){try{this[name].closeSync();}catch{}this[name]=null;}
    if(this.pending.size)this.later(this.flushStep);else this.resolveReady?.(ok);
  }
  commit(key,file,text){
    if(this.closed)return false;
    if(this.scanError){this.markGap(key,'INDEX_FAILED');return false;}
    const bytes=Buffer.byteLength(text),old=this.index.get(`${key}/${file}`),newBytes=this.totalBytes-(old??0)+bytes,newFiles=this.totalFiles+(old===undefined?1:0);
    if(newBytes>this.maxBytes && newBytes>this.totalBytes || newFiles>this.maxFiles && old===undefined){this.markGap(key,'BUDGET_EXCEEDED');return false;}
    try{const dir=this.accountDir(key);this.mkdir(dir);this.writeFile(path.join(dir,file),text,MAX_LOG_BYTES);this.count(key,file,bytes);this.ioUnavailable.delete(key);return true;}
    catch{this.ioUnavailable.add(key);this.markGap(key,'STORAGE_ERROR');return false;}
  }
  write(key,file,text){
    if(this.closed)return false;
    accountId(key);const parsed=parseArchiveFileName(file);validateNumericLog(text,{epoch:parsed.originEpoch,sessionKey:parsed.logId});
    const name=`${key}/${file}`;
    if(!this.scanDone || this.pending.has(name)){
      const previous=this.pending.get(name),bytes=Buffer.byteLength(text),nextBytes=this.pendingBytes-(previous?.bytes??0)+bytes;
      if(nextBytes>this.maxPendingBytes || !previous && this.pending.size>=this.maxPendingFiles){
        // Never flush an older queued canonical version over a rejected newer one.
        if(previous){this.pending.delete(name);this.pendingBytes-=previous.bytes;}this.markGap(key,'QUEUE_FULL');return false;
      }
      const state=this.state(key);state.pending=true;if(!this.persist(state))this.markGap(key,'STATE_WRITE_FAILED');
      this.pending.set(name,{key,file,text,bytes});this.pendingBytes=nextBytes;
      if(this.scanDone)this.later(this.flushStep);return true;
    }
    return this.commit(key,file,text);
  }
  flushStep(){
    const touched=new Set();let count=0;
    for(const [name,item]of this.pending){if(count++>=16)break;this.pending.delete(name);this.pendingBytes-=item.bytes;touched.add(item.key);this.commit(item.key,item.file,item.text);}
    for(const key of touched)if(![...this.pending.values()].some(item=>item.key===key)){const state=this.state(key);state.pending=false;this.persist(state);}
    if(this.pending.size)this.later(this.flushStep);else this.resolveReady?.(!this.scanError);
  }
  status(key){
    if(key===null)return {accountKey:null,available:false,initializing:!this.scanDone,pendingFiles:0,collectionGap:false,firstGapAt:null,lastErrorAt:null,errorCode:null,totalFiles:0,totalBytes:0};
    if(this.scanError)this.markGap(key,'INDEX_FAILED');const state=this.state(key),count=this.counts.get(key)??{files:0,bytes:0};
    return {accountKey:key,available:this.scanDone&&!this.scanError&&!this.ioUnavailable.has(key),initializing:!this.scanDone,pendingFiles:[...this.pending.values()].filter(item=>item.key===key).length,collectionGap:state.collectionGap,firstGapAt:state.firstGapAt,lastErrorAt:state.lastErrorAt,errorCode:state.errorCode,totalFiles:count.files,totalBytes:count.bytes};
  }
  dispose(){
    if(this.closed)return;
    for(const key of new Set([...this.pending.values()].map(item=>item.key)))this.markGap(key,'UNCLEAN_PENDING');
    this.closed=true;if(this.handle)this.cancel(this.handle);for(const name of ['rootDir','accountStream'])if(this[name]){try{this[name].closeSync();}catch{}this[name]=null;}this.resolveReady?.(false);
  }
}
