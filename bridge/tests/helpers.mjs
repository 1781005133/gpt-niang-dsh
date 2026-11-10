import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCHEMA_VERSION,PRODUCER} from '../../shared/bridge-protocol.mjs';
export const bridgeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const at=1_800_000_000_000;
export const id='11111111-1111-4111-8111-111111111111';
export const otherId='22222222-2222-4222-8222-222222222222';
export const account='a'.repeat(64);
export const key='b'.repeat(64);
export const envelope=(ttl=20000)=>({schemaVersion:SCHEMA_VERSION,producer:PRODUCER,instanceId:id,epoch:otherId,revision:1,lastSeenAt:at,expiresAt:at+ttl,hostActive:true});
export const status=(accountKey=account)=>({ok:true,queryOk:true,source:'dsh',observedAt:at,accountKey,plan:'plus',planLabel:'Plus',planKnown:true,planSource:'rateLimits',authType:'oauth',windows:[{label:'5 小时',minutes:300,used:31,remaining:69,resetsAt:Math.floor(at/1000)+100}]});
export function fixture(t) {
  const parent=path.join(bridgeRoot,'.test-tmp'); fs.mkdirSync(parent,{recursive:true}); const dir=fs.mkdtempSync(path.join(parent,'case-'));
  t.after(()=>{const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(parent)+path.sep))throw Error('Unsafe test cleanup');fs.rmSync(resolved,{recursive:true,force:true});}); return dir;
}
export function memoryFiles() {
  const snapshots=new Map(),logs=new Map();
  return {snapshots,logs,controlFrame:null,readControl(){return this.controlFrame;},clearLogs(){logs.clear();},removeLog(name){logs.delete(name);},write(name,value,isLog=false){const text=typeof value==='string'?value:JSON.stringify(value);(isLog?logs:snapshots).set(name,text);return Buffer.byteLength(text);}};
}
export const readMemory=(files,name)=>JSON.parse(files.snapshots.get(name));
export const noRepeater=()=>({unref(){}});
export const usage=(input=0,output=0,read=0,write=0)=>({uncachedInputTokens:input,outputTokens:output,cacheReadTokens:read,cacheWriteTokens:write});
export const session=(id='session-private',header={})=>({id,header:{version:4,...header},firstLiveSeq:0});
export const event=(seq,type,data={},time=at)=>({seq,type,data,time});
