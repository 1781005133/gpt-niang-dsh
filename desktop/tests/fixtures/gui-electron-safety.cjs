'use strict';
module.exports=function installGuiElectronSafety(){
 const root=process.env.COMPANION_GUI_TEST_ROOT,run=process.env.COMPANION_GUI_RUN_ROOT;if(!root||!run)return;
 if(globalThis[Symbol.for('companion.gui-electron-safety')])return;
 // Chromium startup switches remain active in app.commandLine, but are not
 // positional fixture root/data arguments (Electron 45 keeps some in argv).
 process.argv=process.argv.filter(value=>!/^--(?:user-data-dir|crash-dumps-dir)=/.test(value));
 const {app,session,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
 if(!app||!session)throw Error('GUI fixture policy must run after Electron initializes its app API');
 if(BrowserWindow.getAllWindows().length)throw Error('GUI fixture policy must be installed before any window is created');
 globalThis[Symbol.for('companion.gui-electron-safety')]=true;
 app.on('web-contents-created',(_event,contents)=>{contents.setAudioMuted(true);});
 app.whenReady().then(()=>{
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,callback)=>callback({cancel:true}));
  fs.writeFileSync(path.join(run,'gui-policy-'+process.pid+'.json'),JSON.stringify({pid:process.pid,mediaPermissions:false,network:false,audioMuted:true,installedBeforeAnyWindow:true,sandboxDisabled:false},null,2));
 });
};
