// Public, synthetic independent-install identity for positive transaction tests.
// Never call these helpers on a legacy/original or real user installation.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
function temporaryOnly(directory){const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(directory));if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||path.resolve(directory).split(/[\\/]+/).some(part=>['.gpt-niang','.dsh','gptniangusage','dsh-whale-widget'].includes(part.toLowerCase())))throw Error('Positive identity fixtures may only create synthetic independent paths below os.tmpdir()');}
export const fixturePackage=(version='1.3.5',extra={})=>({...extra,name:'dsh-gpt-companion',architecture:'javascript-electron',version});
const json=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
export function ownDataFixture(dataDir){
 temporaryOnly(dataDir);
 json(path.join(dataDir,'companion-data-owner.json'),{schema:1,appId:'DSHGPTCompanion',dataDir:path.resolve(dataDir)});
}
export function ownedTemporary(prefix){const directory=fs.mkdtempSync(prefix);ownDataFixture(directory);return directory;}
export function installedFixture(root,dataDir,{version='1.3.5',boundRoot=root,config={},codeRoot=null}={}){
 temporaryOnly(root);temporaryOnly(dataDir);temporaryOnly(boundRoot);
 if(codeRoot){
  for(const name of ['src','runtime','shared'])if(fs.existsSync(path.join(codeRoot,name)))fs.cpSync(path.join(codeRoot,name),path.join(root,name),{recursive:true});
  for(const name of ['node_modules/koffi',`node_modules/@koromix/koffi-${process.platform}-${process.arch}`])if(fs.existsSync(path.join(codeRoot,name)))fs.cpSync(path.join(codeRoot,name),path.join(root,name),{recursive:true});
 }
 json(path.join(root,'package.json'),fixturePackage(version));
 json(path.join(root,'installation.json'),{...config,appDir:path.resolve(boundRoot),dataDir:path.resolve(dataDir),architecture:'javascript-electron',version});
 ownDataFixture(dataDir);
 return {root,dataDir};
}
export function copyRuntimeGuardFixture(codeRoot,root){
 temporaryOnly(root);const destination=path.join(root,'src/core/storage.mjs');fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(codeRoot,'src/core/storage.mjs'),destination);
}
export function installSourceFixture(source,plan){
 temporaryOnly(source);
 const bytes=Buffer.from(JSON.stringify(fixturePackage(plan.version)));
 fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'package.json'),bytes);
 plan.integrity.files['package.json']=createHash('sha256').update(bytes).digest('hex');
 json(path.join(source,'integrity.json'),plan.integrity);
 return plan;
}
