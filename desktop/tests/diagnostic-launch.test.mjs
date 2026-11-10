import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{resolveSmokeProfile}=require('./fixtures/smoke-options.cjs');
test('smoke profile is explicit and cannot be replaced by retained Electron native flags',()=>{
 const profile=path.resolve('audit/private smoke/profile');
 const argv=['electron.exe','--user-data-dir=C:\\native-user-data','--crash-dumps-dir=C:\\native-crashes','fixture.cjs','--companion-smoke-profile='+profile];
 assert.equal(resolveSmokeProfile({env:{},argv}),profile);
 assert.equal(resolveSmokeProfile({env:{COMPANION_SMOKE_PROFILE:profile},argv:argv.slice(0,-1)}),profile);
});
test('missing or flag-shaped smoke profile fails before app.setPath',()=>{
 assert.throws(()=>resolveSmokeProfile({env:{},argv:['electron.exe','fixture.cjs','--crash-dumps-dir=C:\\bad']}),/explicit absolute/);
 assert.throws(()=>resolveSmokeProfile({env:{COMPANION_SMOKE_PROFILE:'--crash-dumps-dir=C:\\bad'},argv:[]}),/explicit absolute/);
});
test('launch failure instrumentation retains native Windows code without dumping arbitrary details',()=>{
 const handlers=new Map(),writes=[];
 const app={on:(name,fn)=>handlers.set(name,fn),setPath:()=>{},whenReady:()=>({then:()=>({catch:()=>{}})})};
 const code=fs.readFileSync(new URL('./fixtures/electron-smoke.cjs',import.meta.url),'utf8');
 const stub=id=>{
  if(id==='electron')return {app,BrowserWindow:class{}};
  if(id==='./smoke-options.cjs')return {resolveSmokeProfile:()=>path.resolve('audit/private profile')};
  // The fixture installs its GUI policy before any window; this test only
  // exercises the launch-failure logger, so the installer is a no-op here.
  if(id==='./gui-electron-safety.cjs')return ()=>{};
  if(id==='node:fs')return {writeSync:(_fd,text)=>writes.push(JSON.parse(text))};
  throw Error('Unexpected module: '+id);
 };
 vm.runInNewContext(code,{require:stub,process:{pid:1,versions:{}},console:{log:()=>{}},setTimeout:()=>0,clearTimeout:()=>{}});
 handlers.get('child-process-gone')(null,{type:'GPU',reason:'launch-failed',exitCode:18,systemErrorCode:5,secret:'must not be logged'});
 assert.deepEqual(writes,[{phase:'child-process-gone',type:'GPU',reason:'launch-failed',exitCode:18,systemErrorCode:5}]);
});
test('manual wrapper is ASCII-only and waits before printing the redirected result',()=>{
 const bytes=fs.readFileSync(new URL('../../诊断图形启动.cmd',import.meta.url)),text=bytes.toString('ascii');
 assert([...bytes].every(byte=>byte<128));assert.match(text,/start "" \/wait \/b/);assert.match(text,/>"%log%" 2>&1/);assert.match(text,/GUI RESULT: PASS/);assert.match(text,/GUI RESULT: FAILED/);
});
