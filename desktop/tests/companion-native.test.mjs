import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {configuredDshPaths,isDshProcessImage,isCodexProcessImage,hostSource} from '../src/windows/host-identity.mjs';
import {activateHostWindow,activateCodexWindow} from '../src/windows/window-policy.mjs';
import {WindowsBridge} from '../src/windows/bridge.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const image='D:\\DSH\\DeepSeek Harness.exe';
const manifest={name:'@deepseek-ai/dsh-desktop',dshDesktopAppId:'com.deepseek.dsh'};
function mockFs(value=manifest,options={}) {
  return {realpathSync:()=>options.actual??image,statSync:name=>({isFile:()=>options.isFile!==false,size:options.size??120}),readFileSync:()=>Buffer.from(typeof value==='string'?value:JSON.stringify(value))};
}

test('DSH identity requires an exact executable and bounded adjacent DSH package identity',()=>{
  assert.equal(isDshProcessImage(image,{filesystem:mockFs()}),true);
  for(const other of ['C:\\Electron\\electron.exe','C:\\Other\\DeepSeek Harness.exe','DeepSeek Harness.exe',image+'.bak','D:\\DSH\\Codex.exe','D:\\DSH\\DeepSeek Harness.exe\n'])
    assert.equal(isDshProcessImage(other,{filesystem:mockFs()}),false,other);
  for(const value of [{name:'electron',dshDesktopAppId:'com.deepseek.dsh'},{name:'@deepseek-ai/dsh-desktop',dshDesktopAppId:'other'},'{bad json'])
    assert.equal(isDshProcessImage(image,{filesystem:mockFs(value)}),false);
  for(const options of [{size:0},{size:65537},{isFile:false},{actual:'C:\\Electron\\electron.exe'}])
    assert.equal(isDshProcessImage(image,{filesystem:mockFs(manifest,options)}),false);
  assert.equal(isDshProcessImage(image,{filesystem:mockFs(' '.repeat(65537))}),false);
  assert.equal(isDshProcessImage(image,{filesystem:{realpathSync(){throw Error('denied');}}}),false);
  let reads=0;
  const remoteFs={realpathSync(){reads++;throw Error('must not touch network');}};
  for(const value of ['\\\\server\\share\\DeepSeek Harness.exe','\\\\?\\D:\\DSH\\DeepSeek Harness.exe','\\DSH\\DeepSeek Harness.exe'])
    assert.equal(isDshProcessImage(value,{filesystem:remoteFs}),false);
  assert.equal(reads,0);
});

test('explicit DSH paths narrow discovery and invalid configured paths fail closed',()=>{
  assert.equal(configuredDshPaths({env:{}}),null);
  const allowed=configuredDshPaths({env:{DSH_COMPANION_DSH_EXE:image}});
  assert.deepEqual(allowed,[image.toLowerCase()]);
  assert.equal(isDshProcessImage(image,{allowedPaths:allowed,filesystem:mockFs()}),true);
  assert.equal(isDshProcessImage(image,{allowedPaths:[],filesystem:mockFs()}),false);
  for(const value of ['', 'electron.exe','D:\\DSH\\DeepSeek Harness.exe\r\n'])
    assert.deepEqual(configuredDshPaths({env:{DSH_COMPANION_DSH_EXE:value}}),[]);
  assert.deepEqual(configuredDshPaths({dshExecutablePaths:[image],env:{DSH_COMPANION_DSH_EXE:'invalid'}}),allowed);
  assert.equal(hostSource(),'dsh');assert.equal(hostSource('codex'),'codex');assert.equal(hostSource('electron'),null);
});

test('Codex remains optional and cannot classify a generic Electron or DSH process',()=>{
  assert.equal(isCodexProcessImage('C:\\Apps\\OpenAI\\Codex\\Codex.exe'),true);
  assert.equal(isCodexProcessImage('C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\ChatGPT.exe'),true);
  for(const value of [image,'C:\\Electron\\electron.exe','C:\\Other\\Codex.exe','C:\\OpenAI\\Codex\\electron.exe'])
    assert.equal(isCodexProcessImage(value),false);
});

function windowProbe() {
  let now=0,opened=0,closed=0,classified=0;
  const windows=new Map([
    [1,{pid:101,image,title:'Conversation — DeepSeek Harness',style:0x14c70000,ex:0x200100}],
    [2,{pid:102,image:'C:\\Other\\electron.exe'}],
    [3,{pid:103,image:'C:\\Apps\\OpenAI\\Codex\\Codex.exe',ex:0x40000}],
  ]);
  const get=h=>windows.get(Number(h));
  const u={
    enum:cb=>{for(const h of windows.keys())if(!cb(h))break;},
    long:(h,index)=>{const w=get(h);return index===-20?w?.ex??0x200100:index===-8?w?.owner??0:w?.style??0x14c70000;},
    cls:h=>get(h)?.cls??'Chrome_WidgetWin_1',session:(pid,out)=>out[0]=[...windows.values()].find(w=>w.pid===pid)?.session??1,
    open:(_access,_inherit,pid)=>{opened++;return pid;},
    image:(pid,_flags,b,size)=>{const w=[...windows.values()].find(w=>w.pid===pid);if(!w||w.denied)return false;b.write(w.image,'utf16le');size[0]=w.image.length;return true;},
    close:()=>closed++,
  };
  const source=fs.readFileSync(path.join(root,'src/windows/native.mjs'),'utf8');
  const start=source.indexOf('  hosts('),end=source.indexOf('  move(',start);assert.ok(start>0&&end>start);
  const context={process:{pid:999999},Date:{now:()=>now},Buffer,u,readText:(fn,h)=>fn(h),hostSource,isCodexProcessImage,
    isDshProcessImage:(value,{allowedPaths})=>{classified++;return value===image&&(allowedPaths===null||allowedPaths.includes(image.toLowerCase()));}};
  vm.runInNewContext(`globalThis.Probe=class {constructor(){this.session=1;this.processCache=new Map();this.dshExecutablePaths=null;}valid(h){return !!globalThis.windows.get(Number(h));}pid(h){return globalThis.windows.get(Number(h))?.pid??0;}title(h){return globalThis.windows.get(Number(h))?.title??'window';}foreground(){return 1;}visible(h){return this.valid(h)&&!globalThis.windows.get(Number(h)).hidden;}identity(h){return {handle:h,pid:this.pid(h)};}${source.slice(start,end)}}`,Object.assign(context,{windows}));
  return {native:new context.Probe(),windows,setNow:value=>now=value,counts:()=>({opened,closed,classified})};
}

test('NativeWindows defaults to exact DSH host, retaining Codex and separate source caches',()=>{
  const {native,windows,counts}=windowProbe();
  assert.equal(native.findDsh(),1);assert.equal(native.findHost(),1);assert.equal(native.isHost(1),true);
  assert.equal(native.isCodex(1),false);assert.equal(native.isDsh(2),false);assert.equal(native.isDsh(3),false);
  assert.equal(native.findCodex(),3);assert.equal(native.findHost('codex'),3);
  assert.deepEqual(Array.from(native.hosts(),h=>h.handle),[1]);assert.deepEqual(Array.from(native.hosts('codex'),h=>h.handle),[3]);
  assert.equal(native.findHost('electron'),0);assert.equal(native.isHost(1,'unknown'),false);
  // A recycled PID must be queried again, not inherit the old DSH truth value.
  windows.get(1).image='C:\\Other\\electron.exe';assert.equal(native.isDsh(1),false);
  assert.equal(counts().opened,counts().closed);
});

test('DSH rejects owned dialogs, child/tool/no-activate windows and other sessions without APPWINDOW dependency',()=>{
  const {native,windows}=windowProbe(),original={...windows.get(1)};
  assert.equal(native.isDsh(1),true); // Real DSH ex=0x200100, not Codex's 0x40000.
  for(const patch of [{owner:5},{style:0x40010000},{ex:0x80},{ex:0x8000000},{style:0},{title:''},{cls:'Chrome_WidgetWin_0'},{session:2},{pid:999999}]){
    windows.set(1,{...original,...patch});assert.equal(native.isDsh(1),false,JSON.stringify(patch));
  }
  windows.set(1,{...original,denied:true});assert.equal(native.isDsh(1),false);
});

test('native path cache is bounded, expires, and always closes queried process handles',()=>{
  const {native,windows,setNow,counts}=windowProbe();
  assert.equal(native.isDsh(1),true);assert.equal(native.isDsh(1),true);
  assert.equal(counts().classified,1);assert.equal(counts().opened,2);
  for(let id=4;id<400;id++){windows.set(id,{pid:1000+id,image:`D:\\other${id}\\DeepSeek Harness.exe`});native.isDsh(id);}
  assert.ok(native.processCache.size<=256);
  setNow(3000);native.isDsh(1);assert.equal(native.processCache.size,1);
  setNow(-1);native.isDsh(1);assert.equal(native.processCache.size,1);
  assert.equal(counts().opened,counts().closed);
});

test('only explicit activation restores/focuses the selected verified host source',()=>{
  const calls=[],native={isHost:(h,s)=>s==='dsh'?h===1:h===2,findHost:s=>s==='dsh'?1:2,hosts:()=>[],minimized:()=>true,
    restoreWindow:(h,s)=>calls.push(['restore',h,s]),foregroundWindow:(h,s)=>{calls.push(['activate',h,s]);return true;}};
  assert.equal(activateHostWindow(native,2),true);assert.deepEqual(calls,[['restore',1,'dsh'],['activate',1,'dsh']]);calls.length=0;
  assert.equal(activateHostWindow(native,1,'codex'),true);assert.deepEqual(calls,[['restore',2,'codex'],['activate',2,'codex']]);calls.length=0;
  assert.equal(activateHostWindow(native,1,'electron'),false);assert.deepEqual(calls,[]);
  const codex={...native,isCodex:h=>h===2,findCodex:()=>2};assert.equal(activateCodexWindow(codex,1),true);
});

test('independent native names are used without changing retained DPI, coverage, or loopback APIs',()=>{
  const native=fs.readFileSync(path.join(root,'src/windows/native.mjs'),'utf8');
  for(const signature of ['  dpi(h)','  above(h, host','  fullyCovered(host)','  noActivate(h)'])assert.ok(native.includes(signature),signature);
  for(const filename of ['Start.cs','Setup.cs','Bridge.cs','music-audio.cs']){
    const source=fs.readFileSync(path.join(root,'native',filename),'utf8');assert.doesNotMatch(source,/GPTNiang|GPT Niang|gpt-niang|\.gpt-niang/);
  }
  assert.match(fs.readFileSync(path.join(root,'native/Start.cs'),'utf8'),/PackageName="dsh-gpt-companion"/);
  assert.match(fs.readFileSync(path.join(root,'native/music-audio.cs'),'utf8'),/system-playback/);
  assert.match(fs.readFileSync(path.join(root,'src/windows/bridge.mjs'),'utf8'),/DSHDragon\.Native\.exe/);
  assert.match(fs.readFileSync(path.join(root,'src/windows/mouse-activation.mjs'),'utf8'),/DSHDragon\.Input\.dll/);
});

function temporary(t) {
  const parent=path.join(root,'native');
  const dir=fs.mkdtempSync(path.join(parent,'.companion-native-test-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(parent));fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('isolated DSHDragon native mock bounds slow UIA probes across host changes',{skip:process.platform!=='win32',timeout:20000},async t=>{
  const dir=temporary(t),output=path.join(dir,'native');fs.mkdirSync(output);
  const source=fs.readFileSync(path.join(root,'native/Bridge.cs'),'utf8');
  const boundary=source.indexOf(' static bool Ready(IntPtr handle)');assert.ok(boundary>0);
  const fake=source.slice(0,boundary)+' static int active;static bool Ready(IntPtr handle){int n=Interlocked.Increment(ref active);Console.Error.WriteLine("ACTIVE="+n);Thread.Sleep(200);Interlocked.Decrement(ref active);return true;}\n}\n}\n';
  const file=path.join(output,'Bridge.cs');fs.writeFileSync(file,fake);
  const framework=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319'),wpf=path.join(framework,'WPF');
  execFileSync(path.join(framework,'csc.exe'),['/nologo','/target:exe','/optimize+','/out:'+path.join(output,'DSHDragon.Native.exe'),'/r:System.Web.Extensions.dll','/r:System.Xaml.dll',...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll','PresentationCore.dll'].map(name=>'/r:'+path.join(wpf,name)),file,path.join(root,'native/music-audio.cs')],{windowsHide:true});
  const bridge=new WindowsBridge(dir),active=[];
  bridge.child.stderr.on('data',bytes=>{for(const match of String(bytes).matchAll(/ACTIVE=(\d+)/g))active.push(+match[1]);});
  try {
    assert.equal(await bridge.probe(1),false);for(let n=0;n<10;n++)assert.equal(await bridge.probe(2),false);
    await pause(300);assert.equal(await bridge.probe(2),false);await pause(300);assert.equal(await bridge.probe(2),true);
    assert.ok(active.length>=2);assert.equal(Math.max(...active),1);
  } finally {
    const exited=new Promise(resolve=>bridge.child.once('exit',resolve));bridge.close();await exited;
  }
});

test('launcher source and binary identity enforce independent packages without executing the launcher',{skip:process.platform!=='win32',timeout:10000},t=>{
  const dir=temporary(t),valid=path.join(dir,'valid'),original=path.join(dir,'original'),wrong=path.join(dir,'wrong');
  for(const [target,value] of [[valid,{name:'dsh-gpt-companion',architecture:'javascript-electron'}],[original,{name:'gpt-niang-usage',architecture:'javascript-electron'}],[wrong,{name:'dsh-gpt-companion',architecture:'other'}]]){
    fs.mkdirSync(target);fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(value));
  }
  const source=path.join(dir,'IdentityAudit.cs'),exe=path.join(dir,'IdentityAudit.exe');
  fs.writeFileSync(source,`using System;using System.Reflection;using System.Web.Script.Serialization;
public static class IdentityAudit {
 static bool Accept(MethodInfo method,string root){try{method.Invoke(null,new object[]{root,new JavaScriptSerializer()});return true;}catch(TargetInvocationException){return false;}}
 public static int Main(string[] args){if(AssemblyName.GetAssemblyName(args[0]).Name!="DSHDragon.Start")return 1;var type=typeof(DSHGPTCompanion.DSHDragonStart);var method=type.GetMethod("ValidateApp",BindingFlags.NonPublic|BindingFlags.Static);if(!Accept(method,args[1])||Accept(method,args[2])||Accept(method,args[3]))return 2;Console.WriteLine("identity-ok");return 0;}
}`);
  const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  // Compile the owned source into an audit entry point; never execute the
  // launcher or relax Windows/.NET remote-assembly loading security policy.
  execFileSync(compiler,['/nologo','/target:exe','/main:IdentityAudit','/out:'+exe,'/r:System.Web.Extensions.dll',source,path.join(root,'native/Start.cs')],{windowsHide:true});
  assert.equal(execFileSync(exe,[path.join(root,'native/DSHDragon.Start.exe'),valid,original,wrong],{windowsHide:true,encoding:'utf8'}).trim(),'identity-ok');
});

test('fresh independent native worker accepts stop/probe without starting audio capture',{skip:process.platform!=='win32',timeout:10000},async()=>{
  for(const name of ['DSHDragon.Native.exe','DSHDragon.Setup.exe','DSHDragon.Start.exe','DSHDragon.Input.dll'])
    assert.ok(fs.statSync(path.join(root,'native',name)).size>0,name);
  const bridge=new WindowsBridge(root);
  try {assert.equal(await bridge.probe(0),false);bridge.capture(false);assert.equal(bridge.audio,null);}
  finally {const exited=new Promise(resolve=>bridge.child.once('exit',resolve));bridge.close();await exited;}
  const {MouseActivation}=await import('../src/windows/mouse-activation.mjs');
  const mouse=new MouseActivation();assert.equal(mouse.attach(0),false);assert.equal(mouse.detach(0),true);assert.equal(mouse.close(),true);
});
