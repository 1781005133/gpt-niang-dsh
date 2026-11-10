// Test-only session preload. The driver fills these three immutable values.
(()=>{
 const {ipcRenderer}=require('electron');
 const exactUrl=__SELF_CRASH_URL__,nonce=__SELF_CRASH_NONCE__,channel=__SELF_CRASH_CHANNEL__;
 if(window.top!==window||location.href!==exactUrl)return;
 const capabilities={nonce,url:location.href,mainFrame:window.top===window,sandboxed:process.sandboxed===true,contextIsolated:process.contextIsolated===true,hasCrash:typeof process.crash==='function'};
 if(!capabilities.sandboxed||!capabilities.contextIsolated||!capabilities.hasCrash){ipcRenderer.send(channel+':unsupported',capabilities);return;}
 let spent=false;
 const trigger=(_event,value)=>{
  if(spent||value?.nonce!==nonce||location.href!==exactUrl||window.top!==window)return;
  spent=true;ipcRenderer.removeListener(channel+':trigger',trigger);
  const accepted=ipcRenderer.sendSync(channel+':triggered',{nonce,url:location.href});
  if(accepted?.ok===true)process.crash();
 };
 ipcRenderer.on(channel+':trigger',trigger);
 ipcRenderer.send(channel+':armed',capabilities);
})();
