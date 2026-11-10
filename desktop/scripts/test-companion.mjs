import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

// Run with the bundled Node documented in AGENTS.md, never via an installed DSH.
const desktop=fileURLToPath(new URL('../',import.meta.url)),project=path.dirname(path.resolve(desktop));
const args=process.argv.slice(2),value=key=>args.find(arg=>arg.startsWith(key+'='))?.slice(key.length+1);
const suite=value('--suite')??'full';
if(!['core','integration','non-electron','electron','full'].includes(suite))throw Error('Use --suite=core|integration|non-electron|electron|full');
const electronFiles=new Set(['electron-health.test.mjs','functional-main.test.mjs','installation-renderer-health.test.mjs','mouse-activation.test.mjs','music-drag.test.mjs','native-noop.test.mjs','panel-display.test.mjs','panel-functional.test.mjs','panel-interaction.test.mjs','widget-interaction.test.mjs','native-audit.test.mjs']);
const excluded={'legacy-bridge.test.mjs':'Not applicable: independent fork never upgrades original PowerShell GPT-Niang; migration/ bridge is intentionally absent. Source retained for audit.'};
const core=new Set([
 'audio-import.test.mjs','audio-preservation.test.mjs','build-config.test.mjs','core-parity.test.mjs','functional-lifecycle.test.mjs',
 'headless-state-audit.test.mjs','interaction-optimizations.test.mjs','io-worker.test.mjs','menu-scene-sync.test.mjs',
 'migration-regressions.test.mjs','prerelease-version.test.mjs','renderer-dependencies.test.mjs','runtime-package.test.mjs',
 'setup-target.test.mjs','shape-lifecycle.test.mjs','update-cleanup.test.mjs','update-policy.test.mjs','update.test.mjs',
 'update-concurrency.test.mjs','update-preparation-failure.test.mjs','usage-ledger.test.mjs'
]);
const all=fs.readdirSync(path.join(desktop,'tests')).filter(name=>name.endsWith('.test.mjs')).sort();
const requested=value('--files')?.split(',');
if(requested?.some(name=>!all.includes(name)))throw Error('Every --files entry must name an existing top-level test file');
const files=all.filter(name=>!excluded[name]&&(!requested||requested.includes(name))&&(suite==='full'||(suite==='core'?core.has(name):suite==='integration'?!core.has(name):suite==='electron'?electronFiles.has(name):!electronFiles.has(name))));
if(!files.length)throw Error('No tests selected');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-companion-test-run-'));
const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-'),audit=path.join(project,'audit');
fs.mkdirSync(audit,{recursive:true});
const log=path.join(audit,`test-migration-${stamp}-${suite}.log`),report=log.replace(/\.log$/,'.json');
const env={...process.env};
for(const key of Object.keys(env))if(/^(?:OPENAI|ANTHROPIC|DEEPSEEK)/i.test(key)||/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH|COOKIE)/i.test(key)||/^(?:DSH_|CODEX_|GPT_NIANG_|ELECTRON_|NODE_OPTIONS$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|HOMEDRIVE$|HOMEPATH$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key))delete env[key];
const cli=process.env.CODEX_CLI_PATH;
if(cli){if(!path.isAbsolute(cli)||!fs.statSync(cli).isFile())throw Error('CODEX_CLI_PATH must explicitly identify an existing executable');env.CODEX_CLI_PATH=cli;}
for(const [key,name] of Object.entries({USERPROFILE:'profile',HOME:'profile',APPDATA:'appdata',LOCALAPPDATA:'localappdata',CODEX_HOME:'codex-home',DSH_HOME:'dsh-home'})){
 env[key]=path.join(temp,name);fs.mkdirSync(env[key],{recursive:true});
}
env.HOMEDRIVE=path.parse(env.USERPROFILE).root.replace(/[\\/]$/,'');env.HOMEPATH=env.USERPROFILE.slice(env.HOMEDRIVE.length);
env.DSH_PROFILE='isolated-companion-tests';env.GPT_NIANG_CODEX_APP=path.join(temp,'absent.app');
env.GPT_NIANG_LEGACY_ROOT=path.resolve(desktop,process.env.GPT_NIANG_LEGACY_ROOT??'../vendor/source/GPT-Niang-1.4.0-beta.3/gpt-niang-usage');
env.NODE_OPTIONS=`--require=${JSON.stringify(path.join(desktop,'tests/fixtures/test-safety.cjs'))}`;
const invocation=['--test','--test-concurrency=1','--test-timeout=120000','--test-reporter=tap',...files.map(name=>'tests/'+name)];
const metadata={suite,startedAt:new Date().toISOString(),node:process.execPath,nodeVersion:process.version,files,excluded,temporaryRoot:temp,legacyRoot:env.GPT_NIANG_LEGACY_ROOT,explicitCodexCli:cli??null,diagnosticElectron:process.env.COMPANION_TEST_ELECTRON??null,network:'HTTP(S) blocked in Node/Electron; all update transports must be injected',systemEffects:'Windows installer calls mocked; real CLI local plugins use temporary CODEX_HOME only'};
fs.writeFileSync(log,JSON.stringify(metadata,null,2)+'\n\n');
console.log(`Running ${files.length} ${suite} test files. Log: ${log}`);
// The explicit headless audit runs with its stricter process-launch guard. It
// cannot share that preload with process/Electron integration files.
const headless=files.includes('headless-state-audit.test.mjs');
const groups=[...(headless?[[...invocation.slice(0,4),'--import',new URL('../tests/fixtures/headless-guard.mjs',import.meta.url).href,'tests/headless-state-audit.test.mjs']]:[]),...(files.some(name=>name!=='headless-state-audit.test.mjs')?[invocation.filter(arg=>arg!=='tests/headless-state-audit.test.mjs')]:[])];
const fd=fs.openSync(log,'a');let exitCode=0,signal=null,error=null;
try{
 for(const group of groups){
  const child=spawn(process.execPath,group,{cwd:desktop,env,windowsHide:true,stdio:['ignore',fd,fd]});
  const result=await new Promise(resolve=>{child.once('error',cause=>resolve({exitCode:1,signal:null,error:cause.message}));child.once('close',(code,stopped)=>resolve({exitCode:code??1,signal:stopped,error:null}));});
  if(result.exitCode)exitCode=result.exitCode;signal??=result.signal;error??=result.error;
 }
}finally{fs.closeSync(fd);}
const output=fs.readFileSync(log,'utf8');
const counts=Object.fromEntries(['tests','suites','pass','fail','cancelled','skipped','todo'].map(key=>[key,[...output.matchAll(new RegExp('^# '+key+' (\\d+)$','gm'))].reduce((total,match)=>total+Number(match[1]),0)]));
const failures=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
let cleanupError=null;
try{if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('dsh-companion-test-run-'))throw Error('Unsafe cleanup path');fs.rmSync(temp,{recursive:true,force:true,maxRetries:20,retryDelay:100});}catch(cause){cleanupError=cause.message;exitCode=1;}
const result={...metadata,finishedAt:new Date().toISOString(),exitCode,signal,error,counts,failures,cleanupError,log};
fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({exitCode,counts,failures,cleanupError,log,report},null,2));
process.exitCode=exitCode;
