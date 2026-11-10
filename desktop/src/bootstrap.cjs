const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{app}=require('electron');
const root=path.resolve(__dirname,'..');
let config={};
try{config=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
const dataOption=process.argv.indexOf('--data-dir');
const same=(a,b)=>typeof a==='string'&&(process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b));
const installed=config.architecture==='javascript-electron'&&same(config.appDir,root)&&!process.argv.includes('--candidate');
const candidate=process.argv.includes('--candidate')||config.candidate===true||(Object.keys(config).length>0&&!installed);
const directory=path.resolve((dataOption>=0&&process.argv[dataOption+1])||((config.candidate===true||installed)&&config.dataDir)||(candidate?path.resolve(root,'..','candidate','state'):path.join(os.homedir(),'.dsh-gpt-companion','state')));
const file=path.join(directory,'startup.log');
let dataAuthorized=false;
const log=value=>{if(!dataAuthorized)return;try{fs.appendFileSync(file,new Date().toISOString()+' '+String(value)+'\n');}catch{}};
process.on('uncaughtException',error=>{log(error.stack);app.exit(1);});
process.on('unhandledRejection',error=>{log(error?.stack??error);app.exit(1);});
process.on('exit',code=>log('exit '+code));
(async()=>{
  const {assertCompanionData}=await import('./core/storage.mjs');
  // Never create startup.log inside an unknown/original state directory first.
  assertCompanionData(directory,{programRoot:root,claim:true});
  dataAuthorized=true;
  log('bootstrap '+process.pid+' '+JSON.stringify(process.argv));
  await import('./main.mjs');
})().catch(error=>{log(error.stack);console.error(error.message);app.exit(1);});
