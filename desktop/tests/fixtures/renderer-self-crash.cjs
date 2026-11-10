const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{randomUUID,createHash}=require('node:crypto');
require('./gui-electron-safety.cjs')();
const root=path.resolve(__dirname,'../..'),data=path.resolve(process.argv[2]),exactUrl=pathToFileURL(path.join(root,'ui/index.html')).href;
const nonce=randomUUID(),channel='companion-test:self-crash:'+nonce,started=Date.now();
const originalPreload=path.join(root,'src/preload.cjs'),originalPreloadHash=createHash('sha256').update(fs.readFileSync(originalPreload)).digest('hex');
const state={startedAt:new Date(started).toISOString(),exactUrl,nonceHash:createHash('sha256').update(nonce).digest('hex'),budgets:{startupMs:6000,goneMs:10000,quitAfterGoneMs:2000},registered:null,armed:null,image:null,runtimeReady:false,target:null,sent:0,triggerAcknowledged:false,appGone:null,wcGone:null,beforeQuit:null,exit:null,phases:[]};
const persist=()=>fs.writeFileSync(path.join(data,'renderer-self-lifecycle.json'),JSON.stringify(state,null,2));
const phase=(name,details={})=>{const value={phase:name,elapsedMs:Date.now()-started,...details};state.phases.push(value);persist();console.error(JSON.stringify(value));};
let startupTimer,goneTimer,quitTimer,armedSender=null;
const fail=error=>{state.failure=error.stack??String(error);phase('failure',{error:state.failure});app.exit(9);};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
startupTimer=setTimeout(()=>fail(Error('self-crash startup did not become ready within 6000ms')),6000);
app.on('before-quit',()=>{state.beforeQuit=Date.now()-started;phase('before-quit');clearTimeout(startupTimer);clearTimeout(goneTimer);clearTimeout(quitTimer);});
process.on('exit',code=>{state.exit=code;phase('process-exit',{code});});
function trusted(event,value){return value?.nonce===nonce&&value.url===exactUrl&&event.sender.getURL()===exactUrl&&event.senderFrame===event.sender.mainFrame&&event.senderFrame?.url===exactUrl&&!!BrowserWindow.fromWebContents(event.sender);}
ipcMain.on(channel+':unsupported',(event,value)=>{if(trusted(event,value))fail(Error('sandbox preload does not expose the documented process.crash capabilities'));});
ipcMain.on(channel+':armed',(event,value)=>{if(!trusted(event,value)||value.mainFrame!==true||value.sandboxed!==true||value.contextIsolated!==true||value.hasCrash!==true)return;armedSender=event.sender;state.armed={webContentsId:event.sender.id,mainFrame:true,sandboxed:true,contextIsolated:true,hasCrash:true};phase('preload-armed',state.armed);});
ipcMain.on(channel+':triggered',(event,value)=>{const accepted=trusted(event,value)&&state.sent===1&&state.target?.webContentsId===event.sender.id&&!state.triggerAcknowledged;event.returnValue={ok:accepted};if(accepted){state.triggerAcknowledged=true;phase('self-crash-trigger-ack');}});
app.on('browser-window-created',(_event,window)=>{const contents=window.webContents;contents.on('render-process-gone',(_event,details)=>{if(state.target?.webContentsId===contents.id){state.wcGone={reason:details.reason,elapsedMs:Date.now()-started};phase('wc-render-process-gone',state.wcGone);}});});
app.on('render-process-gone',(_event,contents,details)=>{if(state.target?.webContentsId!==contents.id)return;state.appGone={webContentsId:contents.id,reason:details.reason,elapsedMs:Date.now()-started,exitCode:details.exitCode};phase('app-render-process-gone',state.appGone);clearTimeout(goneTimer);quitTimer=setTimeout(()=>fail(Error('main did not complete normal quit after the actual renderer gone event')),2000);});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function imageReady(window){let timer;try{return await Promise.race([window.webContents.executeJavaScript('window.widgetVerification?.()'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('bounded renderer verification timed out')),Math.max(1,Math.min(1000,started+6000-Date.now())));})]);}finally{clearTimeout(timer);}}
void(async()=>{
 await app.whenReady();
 if(typeof session.defaultSession.registerPreloadScript!=='function')throw Error('Electron does not support the public frame preload registration API');
 const template=fs.readFileSync(path.join(__dirname,'renderer-self-crash-preload.cjs'),'utf8'),generated=template.replace('__SELF_CRASH_URL__',JSON.stringify(exactUrl)).replace('__SELF_CRASH_NONCE__',JSON.stringify(nonce)).replace('__SELF_CRASH_CHANNEL__',JSON.stringify(channel));
 const preload=path.join(data,'self-crash-preload-'+nonce+'.cjs');fs.writeFileSync(preload,generated);
 const id=session.defaultSession.registerPreloadScript({type:'frame',filePath:preload});if(typeof id!=='string')throw Error('registerPreloadScript did not return its documented string ID');
 state.registered={id,filePath:preload,sha256:createHash('sha256').update(generated).digest('hex')};phase('preload-registered',state.registered);
 app.setAppPath(root);process.argv=[process.execPath,__filename,'--candidate','--preview','--data-dir',data];phase('import-start');await import(pathToFileURL(path.join(root,'src/main.mjs')));phase('import-done');
 while(Date.now()-started<6000){
  const windows=BrowserWindow.getAllWindows().filter(window=>window.webContents.getURL()===exactUrl);
  if(windows.length===1){const window=windows[0],contents=window.webContents,verification=await imageReady(window),runtimeFile=path.join(data,'runtime.json'),runtime=fs.existsSync(runtimeFile)?JSON.parse(fs.readFileSync(runtimeFile)):null;
   if(verification?.ok===true&&verification.image?.width>0&&verification.image?.height>0&&runtime?.rendererReady===true&&armedSender===contents&&state.armed?.webContentsId===contents.id){
    const preferences=contents.getLastWebPreferences();
    if(preferences.sandbox!==true||preferences.contextIsolation!==true||preferences.nodeIntegration!==false||createHash('sha256').update(fs.readFileSync(originalPreload)).digest('hex')!==originalPreloadHash)throw Error('Original product preload or required isolation preferences were changed');
    state.image=verification.image;state.runtimeReady=true;state.target={windowId:window.id,webContentsId:contents.id,osPid:contents.getOSProcessId(),preferences:{sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration,originalPreloadPath:originalPreload,originalPreloadSha256:originalPreloadHash,originalPreloadBridgeVerified:true}};
    phase('strict-ready',state.target);clearTimeout(startupTimer);state.sent=1;phase('nonce-trigger-sent');goneTimer=setTimeout(()=>fail(Error('self-crash produced no real renderer gone event')),10000);contents.send(channel+':trigger',{nonce});return;
   }
  }
  await pause(25);
 }
 throw Error('self-crash startup did not become ready');
})().catch(fail);
