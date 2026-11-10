import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {guiEnvironment} from '../src/core/storage.mjs';
import {installationHealthy} from '../src/core/installation-health.mjs';
import {ownDataFixture} from './fixtures/independent-install.mjs';
test('a live GUI cannot pass installation health before its renderer confirms readiness',()=>{
 const root=path.resolve('health-fixture'),electronPath=path.join(root,'electron.exe'),now=Date.now();
 const runtime={pid:17,widget:1,appDir:root,architecture:'javascript-electron',version:'1.3.6',processStartedTicks:'17',at:now};
 const options={root,electronPath,version:'1.3.6',now,inspect:()=>({pid:17,path:electronPath,startedTicks:'17',startedAt:now})};
 assert.equal(installationHealthy({...options,runtime}),false);
 assert.equal(installationHealthy({...options,runtime:{...runtime,rendererReady:false}}),false);
 assert.equal(installationHealthy({...options,runtime:{...runtime,rendererReady:true}}),true);
});
const observeRenderer=process.env.COMPANION_RENDERER_OBSERVE==='1';
test('the real widget exits cleanly after its loaded renderer crashes',{skip:process.platform!=='win32',timeout:observeRenderer?31000:18000},async t=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),data=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-renderer-crash-'));
 t.after(()=>{assert.equal(path.dirname(data),path.resolve(os.tmpdir()));fs.rmSync(data,{recursive:true,force:true});});
 ownDataFixture(data);
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({layoutVersion:2,followHost:false,soundOn:false,desktopTopmost:false}));
 const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'tests/fixtures/renderer-crash.cjs'),data],{windowsHide:true,env:guiEnvironment(),stdio:'pipe'});let errors='';child.stderr.on('data',bytes=>errors+=bytes);
 const timer=setTimeout(()=>child.kill(),observeRenderer?28000:15000);
 let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{
  clearTimeout(timer);
  const finalState={code,signal:child.signalCode};for(const name of ['renderer-lifecycle.json','runtime.json','renderer-errors.log'])if(fs.existsSync(path.join(data,name)))finalState[name]=name.endsWith('.json')?JSON.parse(fs.readFileSync(path.join(data,name),'utf8')):fs.readFileSync(path.join(data,name),'utf8');
  if(process.env.COMPANION_GUI_ARTIFACT_DIR)fs.writeFileSync(path.join(process.env.COMPANION_GUI_ARTIFACT_DIR,'renderer-final-state.json'),JSON.stringify(finalState,null,2));
 }
 assert.equal(code,0,errors);
 assert.equal(JSON.parse(fs.readFileSync(path.join(data,'crash-requested.json'))).rendererReady,true);
 const lifecycle=JSON.parse(fs.readFileSync(path.join(data,'renderer-lifecycle.json'),'utf8'));
 assert.ok(lifecycle.target.osPid>0,'a real owned renderer must be targeted');
 assert.equal(lifecycle.appGone?.webContentsId,lifecycle.target.webContentsId,'the actual target renderer must emit gone');
 assert.match(lifecycle.appGone.reason,/^(?:crashed|killed)$/);
 assert.notEqual(lifecycle.beforeQuit,null,'main must run its normal quit cleanup');
 // Electron v45 documents either killed or crashed for forcefullyCrashRenderer.
 // https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md#L1346-L1357
 assert.match(fs.readFileSync(path.join(data,'renderer-errors.log'),'utf8'),/Renderer exited: (?:crashed|killed)/);
 if(observeRenderer)assert.equal(JSON.parse(fs.readFileSync(path.join(data,'renderer-lifecycle.json'),'utf8')).legacyTotalExceeded,false,'Observation envelope is not a pass of the original global 12-second contract');
});
test('a sandboxed widget self-crash reaches the real product handler without force API',{skip:process.platform!=='win32',timeout:24000},async t=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),data=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-renderer-self-crash-'));ownDataFixture(data);
 t.after(()=>{assert.equal(path.dirname(data),path.resolve(os.tmpdir()));fs.rmSync(data,{recursive:true,force:true});});
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({layoutVersion:2,followHost:false,soundOn:false,desktopTopmost:false}));
 const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'tests/fixtures/renderer-self-crash.cjs'),data],{windowsHide:true,env:guiEnvironment(),stdio:'pipe'});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
 const timer=setTimeout(()=>child.kill(),21000);let result;
 try{result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}finally{clearTimeout(timer);if(process.env.COMPANION_GUI_ARTIFACT_DIR){const snapshot={result,stderr};for(const name of ['renderer-self-lifecycle.json','runtime.json','renderer-errors.log'])if(fs.existsSync(path.join(data,name)))snapshot[name]=name.endsWith('.json')?JSON.parse(fs.readFileSync(path.join(data,name),'utf8')):fs.readFileSync(path.join(data,name),'utf8');fs.writeFileSync(path.join(process.env.COMPANION_GUI_ARTIFACT_DIR,'renderer-self-final-state.json'),JSON.stringify(snapshot,null,2));}}
 assert.equal(result.code,0,stderr);assert.equal(result.signal,null);
 const state=JSON.parse(fs.readFileSync(path.join(data,'renderer-self-lifecycle.json'),'utf8'));
 assert.ok(state.registered&&state.armed&&state.target);assert.equal(state.runtimeReady,true);assert.ok(state.image.width>0&&state.image.height>0);assert.equal(state.sent,1);assert.equal(state.triggerAcknowledged,true);
 assert.deepEqual({sandbox:state.target.preferences.sandbox,contextIsolation:state.target.preferences.contextIsolation,nodeIntegration:state.target.preferences.nodeIntegration},{sandbox:true,contextIsolation:true,nodeIntegration:false});
 assert.equal(state.appGone.webContentsId,state.target.webContentsId);assert.match(state.appGone.reason,/^(?:crashed|killed)$/);assert.match(state.wcGone.reason,/^(?:crashed|killed)$/);assert.notEqual(state.beforeQuit,null);assert.equal(state.exit,0);
 assert.match(fs.readFileSync(path.join(data,'renderer-errors.log'),'utf8'),/Renderer exited: (?:crashed|killed)/);
});
test('real package bootstrap single verify preserves package version and role image',{skip:process.platform!=='win32',timeout:20000},async t=>{
 const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),data=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-bootstrap-single-'));ownDataFixture(data);
 assert.equal(root,path.resolve(process.env.COMPANION_GUI_TEST_ROOT??''),'real entry test requires the explicitly authorized ordinary root');
 assert.match(process.env.NODE_OPTIONS??'',/bootstrap-entry-safety\.cjs/,'bootstrap Node/loaded guards must be installed before launching');
 t.after(()=>{assert.equal(path.dirname(data),path.resolve(os.tmpdir()));fs.rmSync(data,{recursive:true,force:true});});
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({layoutVersion:2,followHost:true,soundOn:false,taskCompletionBubble:false}));
 const args=[root,'--candidate','--bench','--hidden-test','--verify','--data-dir',data];
 const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),args,{windowsHide:true,env:guiEnvironment(),stdio:'pipe'});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
 const timer=setTimeout(()=>child.kill(),15000);let result;
 try{result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}finally{clearTimeout(timer);if(process.env.COMPANION_GUI_ARTIFACT_DIR){const snapshot={result,stderr,args};for(const name of ['verification.json','runtime.json','startup.log','candidate-errors.log','renderer-errors.log'])if(fs.existsSync(path.join(data,name)))snapshot[name]=name.endsWith('.json')?JSON.parse(fs.readFileSync(path.join(data,name),'utf8')):fs.readFileSync(path.join(data,name),'utf8');fs.writeFileSync(path.join(process.env.COMPANION_GUI_ARTIFACT_DIR,'bootstrap-final-state.json'),JSON.stringify(snapshot,null,2));if(fs.existsSync(path.join(data,'verification.png')))fs.copyFileSync(path.join(data,'verification.png'),path.join(process.env.COMPANION_GUI_ARTIFACT_DIR,'bootstrap-widget.png'));}}
 assert.equal(result.code,0,stderr);assert.equal(result.signal,null);
 const verification=JSON.parse(fs.readFileSync(path.join(data,'verification.json'),'utf8')),runtime=JSON.parse(fs.readFileSync(path.join(data,'runtime.json'),'utf8'));
 // Compare against the built package instead of a hardcoded version so a
 // version bump cannot silently turn this assertion into a stale constant.
 const expectedVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
 assert.match(expectedVersion,/^\d+\.\d+\.\d+-beta\.\d+$/,'unexpected package version');
 assert.equal(verification.ok,true,JSON.stringify(verification));assert.ok(verification.image.width>0&&verification.image.height>0);assert.deepEqual(verification.panels,[],'only single verify, never verify-suite');assert.equal(runtime.version,expectedVersion);assert.equal(runtime.rendererReady,true);assert.equal(runtime.music.enabled,false);
 const policy=JSON.parse(fs.readFileSync(path.join(process.env.COMPANION_GUI_RUN_ROOT,'bootstrap-loaded-'+child.pid+'.json'),'utf8'));assert.equal(policy.guardInstalled,true);assert.equal(policy.beforeAnyWindow,true);assert.equal(policy.windowCount,0);
 const png=fs.readFileSync(path.join(data,'verification.png'));assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.readUInt32BE(16)>0&&png.readUInt32BE(20)>0);
});
