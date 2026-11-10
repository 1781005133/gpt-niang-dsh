const {resolveSmokeProfile}=require('./smoke-options.cjs');
const profile=resolveSmokeProfile();
console.log(JSON.stringify({phase:'javascript-entry',profile,electron:process.versions.electron,node:process.versions.node}));
const {app,BrowserWindow}=require('electron');
require('./gui-electron-safety.cjs')();
app.on('child-process-gone',(_event,details)=>require('node:fs').writeSync(1,JSON.stringify({phase:'child-process-gone',type:details.type,reason:details.reason,exitCode:details.exitCode,systemErrorCode:details.systemErrorCode})+'\n'));
app.setPath('userData',profile);
const timer=setTimeout(()=>{console.error('Electron smoke deadline before ready/load');app.exit(2);},15000);
app.whenReady().then(async()=>{
 let window;
 try{
  console.log(JSON.stringify({phase:'app-ready'}));
   const own=app.getAppMetrics().find(metric=>metric.pid===process.pid);
   require('node:fs').writeSync(1,JSON.stringify({phase:'broker-context',integrityLevel:own?.integrityLevel,sandboxed:own?.sandboxed})+'\n');
  window=new BrowserWindow({show:false,width:120,height:80,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'"><title>Isolated companion smoke</title><p>local fixture</p>');
  const title=window.getTitle();if(title!=='Isolated companion smoke')throw Error('unexpected title '+title);
  console.log(JSON.stringify({phase:'renderer-loaded',title,sandbox:true,visible:window.isVisible(),electron:process.versions.electron}));
 }catch(error){console.error(error.stack);process.exitCode=1;}
 finally{clearTimeout(timer);window?.destroy();app.exit(process.exitCode??0);}
}).catch(error=>{clearTimeout(timer);console.error(error.stack);app.exit(1);});
