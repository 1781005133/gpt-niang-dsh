import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {validateProfile, MAX_SNAPSHOT_BYTES, MAX_LOG_BYTES, MAX_CONTROL_BYTES, parseDesktopControl} from './bridge-protocol.mjs';
export function resolveBridgeRoot({dshHome,profile,env=process.env,home=os.homedir()}={}) {
  const selected=validateProfile(profile ?? env.DSH_PROFILE ?? 'desktop');
  let selectedHome=dshHome ?? (typeof env.DSH_HOME==='string' && env.DSH_HOME.trim() ? env.DSH_HOME : path.join(home,'.dsh'));
  if(typeof selectedHome!=='string' || !selectedHome.trim()) throw Error('Invalid DSH home');
  if(selectedHome==='~') selectedHome=home;
  else if(selectedHome.startsWith('~/') || selectedHome.startsWith('~\\')) selectedHome=path.join(home,selectedHome.slice(2));
  const root=path.resolve(selectedHome);
  return {root:path.join(root,'state','dsh-gpt-companion',selected),profile:selected};
}
export function assertNoLinks(target) {
  const absolute=path.resolve(target); let current=absolute;
  while(true) {
    try { const s=fs.lstatSync(current); if(s.isSymbolicLink() || current !== absolute && !s.isDirectory()) throw Error('Unsafe bridge path'); }
    catch(e) { if(e.code !== 'ENOENT') throw e; }
    const parent=path.dirname(current); if(parent === current) break; current=parent;
  }
  return absolute;
}
export function readBoundedRegular(target,maxBytes) {
  target=assertNoLinks(target);let fd;try {
    const before=fs.lstatSync(target);if(!before.isFile() || before.size>maxBytes)throw Error('Unsafe bounded file');
    fd=fs.openSync(target,'r');const live=fs.fstatSync(fd);if(!live.isFile() || live.size>maxBytes)throw Error('Unsafe bounded file');
    const buffer=Buffer.alloc(maxBytes+1),bytes=fs.readSync(fd,buffer,0,buffer.length,0);if(bytes>maxBytes)throw Error('Bounded file too large');
    return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes));
  }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function atomicTextFile(target,text,maxBytes) {
  target=assertNoLinks(target);if(typeof text!=='string' || Buffer.byteLength(text)>maxBytes)throw Error('Bridge file too large');
  try{if(!fs.lstatSync(target).isFile())throw Error('Unsafe bridge file');}catch(error){if(error.code!=='ENOENT')throw error;}
  const temp=assertNoLinks(path.join(path.dirname(target),`.gpt-companion-${randomUUID()}.tmp`));let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;assertNoLinks(target);fs.renameSync(temp,target);}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return Buffer.byteLength(text);
}
export function createSnapshotFiles(root) {
  root=assertNoLinks(root);
  fs.mkdirSync(root,{recursive:true,mode:0o700}); assertNoLinks(root);
  const logs=path.join(root,'numeric-logs','sessions'); assertNoLinks(logs); fs.mkdirSync(logs,{recursive:true,mode:0o700}); assertNoLinks(logs);
  const fileFor=(name,isLog=false) => {
    if(!(isLog ? /^[0-9a-f-]{36}-[0-9a-f]{64}\.jsonl$/ : /^(host|quota|completion|attention|control-status|archive-status)\.json$/).test(name)) throw Error('Unsafe bridge filename');
    return assertNoLinks(path.join(isLog ? logs : root,name));
  };
  const removeLog=name => { const target=fileFor(name,true); try { if(!fs.lstatSync(target).isFile()) throw Error('Unsafe bridge file'); fs.unlinkSync(target); } catch(e) { if(e.code !== 'ENOENT') throw e; } };
  return {
    root,
    readControl() {
      const target=assertNoLinks(path.join(root,'desktop-control.json'));let fd;
      try {
        const info=fs.lstatSync(target);if(!info.isFile() || info.size>MAX_CONTROL_BYTES)throw Error('Unsafe consumer control');
        fd=fs.openSync(target,'r');const live=fs.fstatSync(fd);if(!live.isFile() || live.size>MAX_CONTROL_BYTES)throw Error('Unsafe consumer control');
        const buffer=Buffer.alloc(MAX_CONTROL_BYTES+1),bytes=fs.readSync(fd,buffer,0,buffer.length,0);if(bytes>MAX_CONTROL_BYTES)throw Error('Consumer control too large');
        return parseDesktopControl(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes)));
      } catch(error) { if(error.code==='ENOENT')return null;throw error; } finally {if(fd!==undefined)fs.closeSync(fd);}
    },
    write(name,value,isLog=false) {
      const target=fileFor(name,isLog), text=typeof value === 'string' ? value : JSON.stringify(value);
      if(Buffer.byteLength(text) > (isLog ? MAX_LOG_BYTES : MAX_SNAPSHOT_BYTES)) throw Error('Bridge file too large');
      try { if(!fs.lstatSync(target).isFile()) throw Error('Unsafe bridge file'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      const temp=assertNoLinks(path.join(path.dirname(target),`.gpt-companion-${randomUUID()}.tmp`)); let fd;
      try {
        fd=fs.openSync(temp,'wx',0o600); fs.writeFileSync(fd,text,'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
        assertNoLinks(target); fs.renameSync(temp,target);
      } finally { if(fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch(e) { if(e.code !== 'ENOENT') throw e; } }
      return Buffer.byteLength(text);
    },
    clearLogs() {
      assertNoLinks(logs);
      for(const entry of fs.readdirSync(logs,{withFileTypes:true})) {
        if(/^[0-9a-f-]{36}-[0-9a-f]{64}\.jsonl$/.test(entry.name)) removeLog(entry.name);
      }
    },
    removeLog,
  };
}
