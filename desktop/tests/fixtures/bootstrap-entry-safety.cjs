'use strict';
require('./gui-safety.cjs');
if(process.versions.electron&&process.env.ELECTRON_RUN_AS_NODE!=='1')process.once('loaded',()=>{
 if(process.type!=='browser'||!require('node:worker_threads').isMainThread)return;
 const fs=require('node:fs'),path=require('node:path');
 try{
  const {app,BrowserWindow}=require('electron');
  if(!app||BrowserWindow.getAllWindows().length!==0)throw Error('Bootstrap guard must precede all application windows');
  require('./gui-electron-safety.cjs')();
  if(!globalThis[Symbol.for('companion.gui-electron-safety')])throw Error('Electron policy installation was not confirmed');
  fs.writeFileSync(path.join(process.env.COMPANION_GUI_RUN_ROOT,'bootstrap-loaded-'+process.pid+'.json'),JSON.stringify({pid:process.pid,processType:process.type,appAvailable:true,windowCount:0,beforeAnyWindow:true,guardInstalled:true,versionAtLoaded:app.getVersion(),note:'Version is not asserted before default_app loads the real application package.'},null,2));
 }catch(error){fs.writeSync(2,'Bootstrap safety failed: '+error.stack+'\n');process.exit(11);}
});
