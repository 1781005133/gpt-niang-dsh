import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const newest=names=>names.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
export function resolveMsvcToolchain({sdkVersion=null,env=process.env,execute=execFileSync}={}) {
  const programs=env['ProgramFiles(x86)']??'C:\\Program Files (x86)';
  const vswhere=path.join(programs,'Microsoft Visual Studio','Installer','vswhere.exe');
  if(!fs.existsSync(vswhere))throw Error('MSVC Build Tools are required to compile the native input helper');
  const vs=env.DSH_COMPANION_VISUAL_STUDIO_ROOT??execute(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8',windowsHide:true}).trim();
  if(!path.isAbsolute(vs)||!fs.statSync(vs).isDirectory())throw Error('Invalid Visual Studio installation path');
  const versions=path.join(vs,'VC','Tools','MSVC');
  const vcVersion=newest(fs.readdirSync(versions).filter(v=>/^\d+\.\d+\.\d+$/.test(v)&&fs.existsSync(path.join(versions,v,'bin','Hostx64','x64','cl.exe'))))[0];
  if(!vcVersion)throw Error('MSVC x64 compiler is not available');
  const vc=path.join(versions,vcVersion),kits=path.join(programs,'Windows Kits','10');
  const requested=sdkVersion??env.DSH_COMPANION_WINDOWS_SDK_VERSION;
  if(requested&&!/^\d+\.\d+\.\d+\.\d+$/.test(requested))throw Error('Invalid Windows SDK version');
  const candidates=requested?[requested]:newest(fs.readdirSync(path.join(kits,'Include')).filter(v=>/^\d+\.\d+\.\d+\.\d+$/.test(v)));
  const sdk=candidates.find(v=>fs.existsSync(path.join(kits,'Include',v,'um','Windows.h'))&&fs.existsSync(path.join(kits,'Lib',v,'um','x64','User32.Lib'))&&fs.existsSync(path.join(kits,'Lib',v,'ucrt','x64','ucrt.lib')));
  if(!sdk)throw Error('A complete Windows 10/11 x64 SDK is required (or explicitly supply a verified --native-input DLL)');
  const bin=path.join(vc,'bin','Hostx64','x64');
  return {compiler:path.join(bin,'cl.exe'),sdkVersion:sdk,vcVersion,env:{...env,
    INCLUDE:[path.join(vc,'include'),...['ucrt','shared','um','winrt'].map(v=>path.join(kits,'Include',sdk,v))].join(';'),
    LIB:[path.join(vc,'lib','x64'),...['ucrt','um'].map(v=>path.join(kits,'Lib',sdk,v,'x64'))].join(';'),
    PATH:bin+';'+(env.PATH??env.Path??'')
  }};
}
export function compileNative(root,output=path.join(root,'native'),{inputDll=null,sdkVersion=null}={}) {
  if(process.platform!=='win32')throw Error('Native helpers must be built on Windows');
  fs.mkdirSync(output,{recursive:true});
  const framework=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319'),compiler=path.join(framework,'csc.exe'),wpf=path.join(framework,'WPF');
  const compile=(name,args,files)=>execFileSync(compiler,['/nologo','/optimize+','/out:'+path.join(output,name),...args,...files.map(file=>path.join(root,'native',file))],{windowsHide:true,stdio:'inherit'});
  compile('DSHDragon.Native.exe',['/target:exe','/reference:System.Web.Extensions.dll','/reference:System.Xaml.dll',...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll','PresentationCore.dll'].map(file=>'/reference:'+path.join(wpf,file))],['Bridge.cs','music-audio.cs']);
  compile('DSHDragon.Setup.exe',['/target:exe','/r:Microsoft.CSharp.dll','/r:System.Web.Extensions.dll'],['Setup.cs']);
  compile('DSHDragon.Start.exe',['/target:winexe','/reference:System.Web.Extensions.dll'],['Start.cs']);
  if(inputDll){if(path.resolve(inputDll)!==path.resolve(output,'DSHDragon.Input.dll'))fs.copyFileSync(inputDll,path.join(output,'DSHDragon.Input.dll'));return {input:'verified-supplied'};}
  const tools=resolveMsvcToolchain({sdkVersion});
  execFileSync(tools.compiler,['/nologo','/LD','/O2','/MT','/EHsc',path.join(root,'native','mouse-activation.cpp'),'/link','/OUT:'+path.join(output,'DSHDragon.Input.dll'),'comctl32.lib','user32.lib'],{cwd:output,env:tools.env,windowsHide:true,stdio:'inherit'});
  // Only exact compiler scratch files inside the checked build output are removed.
  for(const suffix of ['obj','lib','exp','pdb'])for(const base of ['mouse-activation','DSHDragon.Input']){const file=path.join(output,base+'.'+suffix);if(path.dirname(path.resolve(file))!==path.resolve(output))throw Error('Unsafe compiler scratch path');if(fs.existsSync(file))fs.unlinkSync(file);}
  return {input:'compiled',sdkVersion:tools.sdkVersion,vcVersion:tools.vcVersion};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  const result=compileNative(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),undefined,{inputDll:option('--native-input'),sdkVersion:option('--sdk-version')});
  console.log(JSON.stringify({ok:true,...result}));
}
