import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import * as installation from '../src/install.mjs';
import {assertIndependentPath,assertCompanionProgram,assertCompanionData,readJson,inside} from '../src/core/storage.mjs';
import {runUpdate} from '../src/core/update-transaction.mjs';
import {cleanupFinishedUpdate,cleanupFinishedInstall} from '../src/core/update-cleanup.mjs';
import {recoverInstall} from '../src/core/install-recovery.mjs';
import {updateFiles} from '../src/core/update-files.mjs';
import {inspectJavaScriptPackage,safePackagePath} from '../src/core/archive.mjs';
import {capturePluginRegistration} from '../src/core/plugin-registration.mjs';
import {zipFixture,packageFiles} from './fixtures/zip-fixture.mjs';
import {fixturePackage,installedFixture,installSourceFixture} from './fixtures/independent-install.mjs';
const app=fileURLToPath(new URL('../',import.meta.url)),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-security-regression-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return root;}
function tree(root){const files={};function visit(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),relative=path.relative(root,file);const stat=fs.lstatSync(file);files[relative]=stat.isDirectory()?'directory':digest(fs.readFileSync(file));if(stat.isDirectory())visit(file);}}visit(root);return files;}
async function noEffects(operation){
 const mutations=[],originals=new Map(),kill=process.kill;let kills=0;
 for(const name of ['mkdirSync','writeFileSync','appendFileSync','copyFileSync','renameSync','rmSync','rmdirSync','unlinkSync']){const original=fs[name];originals.set(name,original);fs[name]=function(...args){mutations.push([name,String(args[0])]);return original.apply(this,args);};}
 process.kill=function(pid,signal){if(signal!==0){kills++;throw Error('security regression blocked a process kill attempt');}return kill.call(this,pid,signal);};
 try{await operation();}finally{for(const [name,original]of originals)fs[name]=original;process.kill=kill;}
 assert.equal(kills,0,'authorization failure must not try to kill any process');assert.deepEqual(mutations,[],'authorization failure must precede every write/lock/cleanup/rename');
}
function installFixture(base){
 const target=path.join(base,'program'),dataDir=path.join(base,'state'),source=path.join(base,'source');
 installedFixture(target,dataDir);const plan={target,dataDir,previous:{appDir:target,dataDir,architecture:'javascript-electron'},version:'1.3.6',shortcut:path.join(base,'startup.lnk'),marketplaceRoot:base,taskName:'isolated',sid:'fixture',task:{exists:false},integrity:{files:{}}};
 fs.mkdirSync(path.join(source,'native'),{recursive:true});fs.writeFileSync(path.join(source,'native/DSHDragon.Start.exe'),'fixture');plan.integrity.files['native/DSHDragon.Start.exe']=digest('fixture');installSourceFixture(source,plan);
 return {target,dataDir,source,plan};
}
for(const legacy of [false,true])test('AUD-1 install rejects '+(legacy?'original PowerShell':'unknown nonempty')+' personal data before all side effects',async t=>{
 const base=temporary(t),f=installFixture(base),foreign=path.join(base,legacy?'.gpt-niang':'foreign-personal');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'settings.json'),'private synthetic settings');f.plan.dataDir=foreign;
 const before=tree(base);let calls=0;await noEffects(async()=>assert.rejects(installation.install(f.plan,{fileSource:f.source,windows:()=>{calls++;},stop:async()=>{calls++;},verify:async()=>{calls++;}}),/目录|归属|绑定|身份/));assert.equal(calls,0);assert.deepEqual(tree(base),before);
});
for(const invalid of ['architecture','binding'])test('AUD-1 an owned data marker never authorizes a foreign '+invalid+' program target',async t=>{
 const base=temporary(t),f=installFixture(base);
 if(invalid==='architecture')json(path.join(f.target,'package.json'),{name:'dsh-gpt-companion',architecture:'powershell-wpf',version:'1.3.5'});
 else json(path.join(f.target,'installation.json'),{appDir:path.join(base,'foreign-app'),dataDir:f.dataDir,architecture:'javascript-electron'});
 const before=tree(base);let calls=0;
 await noEffects(async()=>assert.rejects(installation.install(f.plan,{fileSource:f.source,windows:()=>{calls++;},stop:async()=>{calls++;}}),/架构|身份|目标目录|独立版 JavaScript 安装目录/));assert.equal(calls,0);assert.deepEqual(tree(base),before);
});
for(const operation of ['recover','cleanup-update','cleanup-install','stage'])test('AUD-1 '+operation+' refuses original or ownerless foreign data without writes',async t=>{
 const base=temporary(t),f=installFixture(base),foreign=path.join(base,'foreign-data');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'personal.json'),'keep');
 if(operation.startsWith('cleanup'))json(path.join(foreign,operation==='cleanup-update'?'javascript-update-journal.json':'javascript-install-cleanup.json'),{schema:1,root:f.target,dataDir:foreign,source:path.join(foreign,'updates/token'),token:operation==='cleanup-install'?'00000000-0000-4000-8000-000000000000':'token',phase:'committed'});
 const before=tree(base);await noEffects(async()=>{
  if(operation==='recover')await assert.rejects(recoverInstall(foreign),/归属|绑定|身份/);
  else if(operation==='stage'){const bytes=zipFixture(packageFiles()),name='fixture.zip';await assert.rejects(updateFiles({kind:'stage',dataDir:foreign,version:'1.3.6',bytes,sums:Buffer.from(digest(bytes)+'  '+name),asset:{name,size:bytes.length,digest:'sha256:'+digest(bytes)}}),/归属|绑定|身份/);}
  else assert.throws(()=>operation==='cleanup-update'?cleanupFinishedUpdate(foreign,()=>false):cleanupFinishedInstall(foreign,()=>false),/归属|绑定|身份/);
 });assert.deepEqual(tree(base),before);
});
for(const badPart of ['root-name','root-architecture','root-binding','backup-name','backup-binding'])for(const recover of [false,true])test('AUD-2 '+badPart+' is refused before locks/rollback/kill/rename (recover='+recover+')',async t=>{
 const base=temporary(t),f=installFixture(base),token='identity-audit',source=path.join(f.dataDir,'updates',token),backup=f.target+'.rollback-'+token;fs.mkdirSync(source,{recursive:true});json(path.join(source,'package.json'),fixturePackage('1.3.6'));
 const expected=[{name:'package.json',hash:digest(fs.readFileSync(path.join(source,'package.json')))}];
 if(badPart.startsWith('backup'))installedFixture(backup,f.dataDir,{boundRoot:f.target});
 const invalid=badPart.startsWith('backup')?backup:f.target;
 if(badPart.endsWith('name'))json(path.join(invalid,'package.json'),{name:'gpt-niang-usage',architecture:'powershell-wpf',version:'1.3.5'});
 if(badPart==='root-architecture')json(path.join(invalid,'package.json'),{name:'dsh-gpt-companion',architecture:'powershell-wpf',version:'1.3.5'});
 if(badPart.endsWith('binding'))json(path.join(invalid,'installation.json'),{appDir:path.join(base,'unrelated'),dataDir:f.dataDir});
 const job={root:f.target,dataDir:f.dataDir,source,token,parentPid:2147483647,version:'1.3.6',fromVersion:'1.3.5',expected};const jobFile=path.join(base,'job.json');json(jobFile,job);json(path.join(f.dataDir,'javascript-update-journal.json'),{...job,phase:'starting',ownerPid:2147483647,childPid:process.pid,childStartedTicks:'1'});
 const before=tree(base);await noEffects(async()=>assert.rejects(runUpdate(jobFile,{recover}),/身份|绑定/));assert.deepEqual(tree(base),before);
});
test('AUD-2 rollback revalidates a backup changed after authorization before any restore rename',async t=>{
 const base=temporary(t),f=installFixture(base),token='changed-backup',source=path.join(f.dataDir,'updates',token),backup=f.target+'.rollback-'+token;
 fs.mkdirSync(source,{recursive:true});const candidate=Buffer.from(JSON.stringify(fixturePackage('1.3.6')));fs.writeFileSync(path.join(source,'package.json'),candidate);fs.writeFileSync(path.join(source,'verified-package.zip'),'verified-fixture');
 const jobFile=path.join(base,'job.json');json(jobFile,{root:f.target,dataDir:f.dataDir,source,token,parentPid:2147483647,version:'1.3.6',fromVersion:'1.3.5',hash:digest('verified-fixture'),expected:[{name:'package.json',hash:digest(candidate)}]});
 const rename=fs.renameSync;let corrupted=false,beforeRoot,beforeBackup;const restoreRenames=[];
 fs.renameSync=function(...args){if(corrupted&&[f.target,backup].includes(String(args[0])))restoreRenames.push(args);return rename.apply(this,args);};
 try{await assert.rejects(runUpdate(jobFile,{phaseHook:phase=>{if(phase==='starting'){json(path.join(backup,'package.json'),{name:'gpt-niang-usage',architecture:'powershell-wpf',version:'1.3.5'});beforeRoot=tree(f.target);beforeBackup=tree(backup);corrupted=true;throw Error('injected failure after backup identity changed');}}}),/身份|绑定/);}finally{fs.renameSync=rename;}
 assert.equal(corrupted,true);assert.deepEqual(restoreRenames,[]);assert.deepEqual(tree(f.target),beforeRoot);assert.deepEqual(tree(backup),beforeBackup);
});
for(const bad of ['name','architecture','version'])test('AUD-3 direct install rejects source '+bad+' before data claim or helper execution',async t=>{
 const base=temporary(t),f=installFixture(base),pkg=fixturePackage(f.plan.version);pkg[bad]=bad==='name'?'gpt-niang-usage':bad==='architecture'?'powershell-wpf':'0.0.1';json(path.join(f.source,'package.json'),pkg);
 const before=tree(base);let helpers=0;await noEffects(async()=>assert.rejects(installation.install(f.plan,{fileSource:f.source,windows:()=>{helpers++;},stop:async()=>{helpers++;}}),/候选程序身份|版本/));assert.equal(helpers,0);assert.deepEqual(tree(base),before);
});
for(const bad of ['source-name','source-architecture','source-hash'])test('AUD-3 actual preflight validates '+bad+' before whoami/native setup',t=>{
 const base=temporary(t),source=path.join(base,'source'),target=path.join(base,'target'),pkg=fixturePackage('1.3.6');fs.mkdirSync(source);if(bad==='source-name')pkg.name='gpt-niang-usage';if(bad==='source-architecture')pkg.architecture='powershell-wpf';json(path.join(source,'package.json'),pkg);fs.writeFileSync(path.join(source,'payload.txt'),'tampered');json(path.join(source,'integrity.json'),{files:{'payload.txt':digest('expected')}});
 const text=fs.readFileSync(path.join(app,'src/install.mjs'),'utf8'),start=text.indexOf('export function preflight()'),end=text.indexOf('export async function stopOwned',start);assert.ok(start>=0&&end>start);let calls=0;
 const context={args:[],process:{platform:'win32',env:{}},source,target,path,fs,readJson,inside,digest,safePackagePath,assertIndependentPath,assertCompanionData,assertDirectory:x=>x,validateTarget:installation.validateTarget,option:()=>null,applyCodexHomeArgument:()=>{},identity:()=>{calls++;return 'fixture';},setup:()=>{calls++;return {exists:false};}};
 vm.createContext(context);vm.runInContext(text.slice(start,end).replace('export function','function'),context);const before=tree(base);assert.throws(()=>context.preflight(),/源程序架构|校验失败/);assert.equal(calls,0);assert.deepEqual(tree(base),before);
});
for(const foreign of [false,true])test('AUD-4 uninstall uses selected custom CODEX_HOME and '+(foreign?'rejects foreign registration':'removes only its bound source'),t=>{
 const base=temporary(t),f=installFixture(base),home=path.join(base,'custom-codex'),ambient=path.join(base,'ambient-codex');fs.mkdirSync(home);fs.mkdirSync(ambient);fs.writeFileSync(path.join(home,'config.toml'),'# synthetic local configuration\n');fs.writeFileSync(path.join(ambient,'config.toml'),'# must stay untouched\n');
 const inheritedHome=process.env.CODEX_HOME;process.env.CODEX_HOME=ambient;t.after(()=>{if(inheritedHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=inheritedHome;});
 const plan={...f.plan,registerCodex:true,codexHome:home,codexPath:path.join(base,'explicit-fixture-cli.exe')};let removes=0;const calls=[];
 const execute=(_exe,args,options)=>{calls.push(args);assert.equal(options.env.CODEX_HOME,home);if(args[1]==='remove'){removes++;return {status:0,stdout:'{}'};}return {status:0,stdout:JSON.stringify(args[1]==='marketplace'?{marketplaces:[{name:'dsh-gpt-companion-local',root:base}]}:{installed:[{pluginId:'dsh-gpt-companion@dsh-gpt-companion-local',installed:true,enabled:true,version:'1.3.5',source:{path:foreign?path.join(base,'foreign-install'):f.target}}]})};};
 assert.equal(typeof installation.removeOwnedCodexPlugin,'function');const before=tree(base);
 if(foreign)assert.throws(()=>installation.removeOwnedCodexPlugin(plan,{execute,capture:capturePluginRegistration}),/其他安装/);else installation.removeOwnedCodexPlugin(plan,{execute,capture:capturePluginRegistration});
 assert.equal(removes,foreign?0:1);assert.ok(calls.some(args=>args[1]==='list'));assert.deepEqual(tree(base),before);
});
for(const required of ['native/DSHDragon.Input.dll','shared/bridge-protocol.mjs'])test('AUD-5 self-consistent ZIP missing '+required+' is rejected',()=>{
 const files=packageFiles();delete files[required];delete files['integrity.json'];files['integrity.json']=Buffer.from(JSON.stringify({version:1,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,digest(bytes)]))}));
 assert.throws(()=>inspectJavaScriptPackage(zipFixture(files),'1.3.6'),/缺少|required|完整/i);
});
test('AUD-5 complete independent ZIP still passes architecture and full manifest checks',()=>{const files=packageFiles();assert.equal(inspectJavaScriptPackage(zipFixture(files),'1.3.6').length,Object.keys(files).length);});
