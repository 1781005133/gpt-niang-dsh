import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {guiEnvironment} from '../src/core/storage.mjs';
const desktop=fileURLToPath(new URL('../',import.meta.url)),electron=process.env.COMPANION_TEST_ELECTRON??path.join(desktop,'node_modules/electron/dist/electron.exe');
async function run(t,args,env){
 const child=spawn(electron,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';
 child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);t.after(()=>{if(child.exitCode===null)child.kill();});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return {code,output,error};
}
test('bundled Electron 45 runs its Node interpreter without loading a host application',{skip:process.platform!=='win32',timeout:20000},async t=>{
 const result=await run(t,['-p','JSON.stringify(process.versions)'],{...process.env,ELECTRON_RUN_AS_NODE:'1'});
 assert.equal(result.code,0,JSON.stringify(result));const versions=JSON.parse(result.output.trim());assert.equal(versions.electron,'45.0.0');
});
const modes=process.env.COMPANION_ELECTRON_DIAGNOSTIC==='user-data'?['explicit-user-data']:['default','disable-gpu','clean-node-options','minimal-environment'];
for(const mode of modes)test('bundled Electron starts an isolated sandboxed renderer '+mode,{skip:process.platform!=='win32',timeout:22000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-companion-electron-health-'));t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 let env=guiEnvironment();if(mode==='clean-node-options')delete env.NODE_OPTIONS;
 if(mode==='minimal-environment')env=Object.fromEntries(Object.entries(env).filter(([key])=>/^(?:SystemRoot|WINDIR|SystemDrive|ComSpec|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|NUMBER_OF_PROCESSORS|PROCESSOR_.*)$/i.test(key)));
 env.ELECTRON_ENABLE_LOGGING='1';env.ELECTRON_ENABLE_STACK_DUMPING='1';const nativeLog=path.join(directory,'electron-native.log');
 const privateProfile=path.join(directory,'profile'),crashes=path.join(directory,'crash-dumps');
 env.COMPANION_SMOKE_PROFILE=privateProfile;
 fs.mkdirSync(privateProfile);fs.mkdirSync(crashes);
 const result=await run(t,[...(mode==='disable-gpu'?['--disable-gpu']:[]),...(mode==='explicit-user-data'?['--user-data-dir='+privateProfile,'--crash-dumps-dir='+crashes]:[]),'--enable-logging=file','--log-file='+nativeLog,path.join(desktop,'tests/fixtures/electron-smoke.cjs'),'--companion-smoke-profile='+privateProfile],env);
 result.nativeLog=fs.existsSync(nativeLog)?fs.readFileSync(nativeLog,'utf8').slice(-20000):'(not created)';
 assert.equal(result.code,0,JSON.stringify(result));assert.match(result.output,/"phase":"renderer-loaded"/);assert.match(result.output,/"visible":false/);assert.match(result.output,/"sandbox":true/);
});
