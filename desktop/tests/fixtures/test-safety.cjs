'use strict';
// Inherited by Node/Electron subprocesses from the independent test runner.
// This is defense in depth: installer fixtures must still inject Windows effects.
const cp=require('node:child_process'),http=require('node:http'),https=require('node:https'),path=require('node:path'),os=require('node:os');
const {syncBuiltinESMExports}=require('node:module');
const blocked=what=>Object.assign(Error('Isolated companion tests forbid '+what),{code:'COMPANION_TEST_SIDE_EFFECT_BLOCKED'});
for(const protocol of [http,https])for(const name of ['request','get'])protocol[name]=()=>{throw blocked('real HTTP(S) requests; inject a synthetic release transport');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){
 const original=cp[name];cp[name]=function(command,args,...rest){
  const file=String(command),argv=Array.isArray(args)?args.map(String):[];
  if(/(?:^|[\\/])(?:schtasks|dsh)(?:\.exe|\.cmd)?$/i.test(file))throw blocked('system tasks or a real DSH process');
  if(/DSHDragon\.Setup\.exe$/i.test(file)&&argv.some(arg=>/^task-/i.test(arg))&&!path.resolve(file).startsWith(path.resolve(os.tmpdir())+path.sep))throw blocked('non-fixture Windows task operations');
  return original.call(this,command,args,...rest);
 };
}
syncBuiltinESMExports();
globalThis[Symbol.for('dsh-companion.test-safety')]=true;
