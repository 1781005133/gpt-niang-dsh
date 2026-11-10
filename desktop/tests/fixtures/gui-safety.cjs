'use strict';
require('./test-safety.cjs');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net');
const {syncBuiltinESMExports}=require('node:module');
const root=process.env.COMPANION_GUI_TEST_ROOT,run=process.env.COMPANION_GUI_RUN_ROOT;
if(!root||!run)throw Error('GUI safety requires an explicitly authorized root/run');
const within=(base,file)=>{const relative=path.relative(path.resolve(base),path.resolve(file));return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
if(!within(root,run))throw Error('GUI run must remain inside its authorized root');
const blocked=message=>{try{fs.appendFileSync(path.join(run,'blocked-operations.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,message})+'\n');}catch{}return Object.assign(Error(message),{code:'COMPANION_GUI_OPERATION_BLOCKED'});};
const electron=path.resolve(root,'node_modules/electron/dist/electron.exe').toLowerCase();let childSequence=0;
const processLogs=path.join(run,'process-logs');fs.mkdirSync(processLogs,{recursive:true});
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){
 const original=cp[name];cp[name]=function(command,args,...rest){
  const file=String(command),argv=Array.isArray(args)?args.map(String):[];
  if(argv.some(arg=>/^--(?:no-sandbox|disable-setuid-sandbox|disable-web-security)(?:=|$)/i.test(arg)))throw blocked('GUI tests must not disable renderer sandbox/security');
  if(/^(?:codex|schtasks|dsh|DeepSeek Harness)(?:\.exe|\.cmd)?$/i.test(path.basename(file)))throw blocked('GUI tests must not launch Codex, system tasks or a real DSH');
  if(/DSHDragon\.(?:Start|Setup)\.exe$/i.test(file)){
   if(!file.toLowerCase().endsWith('dshdragon.setup.exe')||!['shortcut-write','shortcut-info'].includes(argv[0])||!within(root,argv[1]??''))throw blocked('GUI tests must not install/start/register tasks; only private shortcut I/O is authorized');
  }
  const full=path.resolve(file),isElectron=full.toLowerCase()===electron,isNative=full.toLowerCase()===path.resolve(root,'native/DSHDragon.Native.exe').toLowerCase();
  const isCompiler=/[\\/]Microsoft\.NET[\\/]Framework64[\\/]v4\.0\.30319[\\/]csc\.exe$/i.test(full);
  const isSetup=full.toLowerCase()===path.resolve(root,'native/DSHDragon.Setup.exe').toLowerCase(),isMissingFixture=within(root,full)&&!fs.existsSync(full);
  if(!isElectron&&!isNative&&!isCompiler&&!isSetup&&!isMissingFixture)throw blocked('Unexpected executable outside the approved Electron/native test set: '+file);
  if(isCompiler&&(!argv.some(arg=>arg.startsWith('/out:')&&within(root,arg.slice(5)))||argv.some(arg=>/\.cs$/i.test(arg)&&!within(root,arg))))throw blocked('Fake-helper compiler input/output must remain inside the authorized root');
  if(isElectron&&Array.isArray(args)){
   const options=rest[0]&&typeof rest[0]==='object'?rest[0]:{};
   const env=options.env??process.env;
   if(env.ELECTRON_RUN_AS_NODE!=='1'&&!argv.some(arg=>/^--user-data-dir(?:=|$)/i.test(arg))){
    const parent=path.join(run,'electron-profiles');fs.mkdirSync(parent,{recursive:true});const profile=fs.mkdtempSync(path.join(parent,'profile-'));
    args=['--user-data-dir='+profile,'--crash-dumps-dir='+path.join(profile,'crashes'),...args];
   }
  }
  const child=original.call(this,command,args,...rest);
  const logBase=path.join(processLogs,process.pid+'-'+(++childSequence)+'-'+(child?.pid??'sync'));
  const information={command:file,args,at:new Date().toISOString(),parentPid:process.pid,pid:child?.pid??null};
  if(child?.once){
   child.stdout?.on('data',bytes=>fs.appendFileSync(logBase+'.stdout.log',bytes));child.stderr?.on('data',bytes=>fs.appendFileSync(logBase+'.stderr.log',bytes));
   child.once('close',(code,signal)=>fs.writeFileSync(logBase+'.json',JSON.stringify({...information,code,signal},null,2)));
  }else{
   if(child?.stdout)fs.writeFileSync(logBase+'.stdout.log',child.stdout);if(child?.stderr)fs.writeFileSync(logBase+'.stderr.log',child.stderr);
   fs.writeFileSync(logBase+'.json',JSON.stringify({...information,code:child?.status,signal:child?.signal,error:child?.error?.message},null,2));
  }
  if(isNative&&child?.stdin?.write){const write=child.stdin.write.bind(child.stdin);child.stdin.write=function(chunk,...other){for(const line of String(chunk).split(/\r?\n/)){if(!line.trim())continue;let value;try{value=JSON.parse(line);}catch{throw blocked('Unknown native input is forbidden during GUI audit');}if(value.op==='start')throw blocked('Real native music/audio capture is forbidden');}return write(chunk,...other);};}
  return child;
 };
}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0],pipe=typeof first==='string'?first:first?.path;if(typeof pipe!=='string'||(!pipe.startsWith('\\\\.\\pipe\\dsh-gpt-companion-')&&!within(root,pipe)))throw blocked('Real TCP/socket connections are forbidden in GUI tests');return connect.apply(this,args);};
const fetch=globalThis.fetch;if(fetch)globalThis.fetch=function(resource,...args){const url=typeof resource==='string'?resource:resource?.url;if(/^https?:|^wss?:/i.test(String(url)))throw blocked('Real fetch/network reads are forbidden');return fetch.call(this,resource,...args);};
syncBuiltinESMExports();
// Electron app/session are unavailable during NODE_OPTIONS pre-execution.
// Each audited GUI entry invokes gui-electron-safety.cjs before its first window.
