// Manual, non-installing diagnostic for the same verified Electron runtime.
// No registry, startup task, host/plugin/profile mutation, network or credentials.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(project,'audit'),{recursive:true});
const directory=fs.mkdtempSync(path.join(project,'audit','manual-gui-'));
const profile=path.join(directory,'profile'),crashes=path.join(directory,'crashes');
fs.mkdirSync(profile);fs.mkdirSync(crashes);
const env={...process.env};
for(const key of Object.keys(env))if(/^(?:OPENAI|ANTHROPIC|DEEPSEEK|DSH_|CODEX_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(key)||/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH|COOKIE)/i.test(key))delete env[key];
env.ELECTRON_ENABLE_STACK_DUMPING='1';env.COMPANION_SMOKE_PROFILE=profile;
const exe=path.join(project,'desktop/node_modules/electron/dist/electron.exe');
const stdioDiagnostic=process.argv.includes('--tool-stdio-test');
const args=[...(stdioDiagnostic?['--no-stdio-init']:[]),'--user-data-dir='+profile,'--crash-dumps-dir='+crashes,path.join(project,'desktop/tests/fixtures/electron-smoke.cjs'),'--companion-smoke-profile='+profile];
console.log('This only tests a hidden local Electron window. No installation or security changes.');
const child=spawn(exe,args,{cwd:project,env,windowsHide:false,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});
const timeout=setTimeout(()=>{if(child.exitCode===null)child.kill();},20000);
const outcome=await new Promise(resolve=>{child.once('error',error=>resolve({code:1,error:error.message}));child.once('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timeout);
const passed=outcome.code===0&&stdout.includes('"phase":"renderer-loaded"');
const events=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const systemErrorCodes=[...new Set(events.filter(event=>event.phase==='child-process-gone'&&event.reason==='launch-failed'&&Number.isInteger(event.systemErrorCode)).map(event=>event.systemErrorCode))];
const report={at:new Date().toISOString(),manual:true,passed,...outcome,stdout,stderr,systemErrorCodes,stdioDiagnostic,sandboxDisabled:false,installationPerformed:false};
const file=path.join(directory,'result.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log('\nGUI test: '+(passed?'PASS':'FAILED')+'; exit='+outcome.code);if(systemErrorCodes.length)console.log('Windows launch error(s): '+systemErrorCodes.join(', '));console.log('Report: '+file);
process.exitCode=passed?0:1;
