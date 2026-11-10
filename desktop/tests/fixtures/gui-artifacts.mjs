import fs from 'node:fs';import path from 'node:path';import {BrowserWindow} from 'electron';
export async function captureGuiEvidence(window,name){
 const directory=process.env.COMPANION_GUI_ARTIFACT_DIR;if(!directory)return;
 const root=process.env.COMPANION_GUI_TEST_ROOT,relative=root&&path.relative(path.resolve(root),path.resolve(directory));
 if(!root||!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('GUI evidence must stay inside the explicitly authorized test root');
 if(!BrowserWindow.getAllWindows().includes(window)||window.isDestroyed())throw Error('Only a live window owned by this fixture may be captured');
 const url=window.webContents.getURL();if(!/^(?:file:|data:)/.test(url))throw Error('GUI evidence must use local fixture content');
 await window.webContents.executeJavaScript('document.fonts.ready.then(()=>Promise.allSettled(Array.from(document.images,image=>image.decode()))).then(()=>new Promise(resolve=>setTimeout(resolve,240)))');
 const image=await window.webContents.capturePage();if(image.isEmpty())throw Error('Own-window screenshot is empty: '+name);
 fs.mkdirSync(directory,{recursive:true});const base=String(name).replace(/[^a-zA-Z0-9._-]/g,'_');
 fs.writeFileSync(path.join(directory,base+'.png'),image.toPNG());
 fs.writeFileSync(path.join(directory,base+'.json'),JSON.stringify({name,at:new Date().toISOString(),pid:process.pid,url,title:window.getTitle(),visible:window.isVisible(),bounds:window.getBounds(),image:image.getSize(),webPreferences:{sandbox:window.webContents.getLastWebPreferences().sandbox,contextIsolation:window.webContents.getLastWebPreferences().contextIsolation,nodeIntegration:window.webContents.getLastWebPreferences().nodeIntegration}},null,2));
}
