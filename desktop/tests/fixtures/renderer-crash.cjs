const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
require('./gui-electron-safety.cjs')();
const root=path.resolve(__dirname,'../..'),data=process.argv[2],observe=process.env.COMPANION_RENDERER_OBSERVE==='1';
app.setAppPath(root);process.argv=[process.execPath,__filename,'--candidate','--preview','--data-dir',data];
const started=Date.now(),state={observe,startedAt:new Date(started).toISOString(),target:null,apiBefore:null,apiReturned:null,appGone:null,wcGone:null,beforeQuit:null,legacyTotalExceeded:false,phases:[]};
const record=()=>{state.legacyTotalExceeded=state.legacyTotalExceeded||Date.now()-started>12000;fs.writeFileSync(path.join(data,'renderer-lifecycle.json'),JSON.stringify(state,null,2));};
const phase=(name,details={})=>{const value={fixture:'renderer-crash',phase:name,elapsedMs:Date.now()-started,...details};state.phases.push(value);record();console.error(JSON.stringify(value));};
const fail=error=>{console.error(error.stack??error);app.exit(7);};process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
const deadline=started+(observe?25000:12000),timeout=setTimeout(()=>fail(Error(observe?'renderer observation envelope expired':'renderer crash was not handled')),observe?25000:12000);
const legacyTimer=observe?setTimeout(()=>{state.legacyTotalExceeded=true;phase('legacy-total-12s-exceeded');},12000):null;
app.on('before-quit',()=>{state.beforeQuit=Date.now()-started;phase('before-quit');clearTimeout(timeout);clearTimeout(legacyTimer);});
app.on('browser-window-created',(_event,window)=>{phase('window-created',{windowId:window.id,webContentsId:window.webContents.id,url:window.webContents.getURL()});window.webContents.on('did-finish-load',()=>phase('window-loaded',{windowId:window.id,webContentsId:window.webContents.id,url:window.webContents.getURL()}));window.webContents.on('render-process-gone',(_event,details)=>{if(state.target?.webContentsId===window.webContents.id){state.wcGone={elapsedMs:Date.now()-started,reason:details.reason};phase('wc-render-process-gone',state.wcGone);}});});
app.on('render-process-gone',(_event,contents,details)=>{if(state.target?.webContentsId===contents.id){state.appGone={elapsedMs:Date.now()-started,webContentsId:contents.id,reason:details.reason,exitCode:details.exitCode};phase('app-render-process-gone',state.appGone);}});
process.on('exit',code=>{phase('process-exit',{code});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function verification(window){let timer;try{return await Promise.race([window.webContents.executeJavaScript('Boolean(window.widgetVerification?.().ok)'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('widgetVerification executeJavaScript did not complete within the fixture deadline')),Math.max(1,Math.min(1250,deadline-Date.now())));})]);}finally{clearTimeout(timer);}}
void(async()=>{
 phase('import-start');await import(require('node:url').pathToFileURL(path.join(root,'src/main.mjs')));phase('import-done');let reportedWindow=false,lastVerification,lastRuntime;
 for(let n=0;n<200;n++){
  const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html'));
  if(window&&!reportedWindow){reportedWindow=true;phase('window-found',{url:window.webContents.getURL(),windowId:window.id,webContentsId:window.webContents.id});phase('widgetVerification-request');}
  const ready=window?await verification(window):false;if(ready!==lastVerification){phase('widgetVerification',{ready});lastVerification=ready;}
  const marker=path.join(data,'runtime.json'),runtimeReady=fs.existsSync(marker)&&JSON.parse(fs.readFileSync(marker)).rendererReady===true;
  if(runtimeReady!==lastRuntime){phase('runtime.json.rendererReady',{ready:runtimeReady,exists:fs.existsSync(marker)});lastRuntime=runtimeReady;}
  if(window&&ready&&runtimeReady){
   fs.writeFileSync(path.join(data,'crash-requested.json'),JSON.stringify({pid:process.pid,loadedImage:true,rendererReady:true}));
   const contents=window.webContents,osPid=contents.getOSProcessId(),metric=app.getAppMetrics().find(item=>item.pid===osPid);
   state.target={windowId:window.id,webContentsId:window.webContents.id,osPid,metric:metric?{pid:metric.pid,type:metric.type,creationTime:metric.creationTime,integrityLevel:metric.integrityLevel,sandboxed:metric.sandboxed}:null};
   state.apiBefore=Date.now()-started;phase('crash-api-before',{...state.target,legacy12sRemainingMs:12000-state.apiBefore});contents.forcefullyCrashRenderer();
   state.apiReturned=Date.now()-started;phase('crash-api-returned',{nativeElapsedMs:state.apiReturned-state.apiBefore,windowDestroyed:window.isDestroyed(),webContentsDestroyed:contents.isDestroyed(),osPidAfter:contents.isDestroyed()?null:contents.getOSProcessId()});return;
  }
  await pause(30);
 }
 throw Error('renderer did not become ready');
})().catch(fail);
