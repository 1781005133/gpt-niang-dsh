import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {install} from '../src/install.mjs';
import {installSourceFixture} from './fixtures/independent-install.mjs';
for(const registration of [undefined,false,'true',1,null])test('DSH install registerCodex='+JSON.stringify(registration)+' never invokes Codex or edits an unrelated local marketplace',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-companion-install-default-'));
 t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const target=path.join(root,'program'),source=path.join(root,'source'),dataDir=path.join(root,'state'),marketplaceRoot=path.join(root,'unrelated-market');
 fs.mkdirSync(path.join(source,'native'),{recursive:true});fs.mkdirSync(dataDir);
 fs.writeFileSync(path.join(source,'native/DSHDragon.Start.exe'),'fixture-launcher');fs.writeFileSync(path.join(source,'integrity.json'),'{}');
 const market=path.join(marketplaceRoot,'.agents/plugins/marketplace.json');fs.mkdirSync(path.dirname(market),{recursive:true});
 const original=Buffer.from('{"name":"unrelated-user-market","plugins":[{"name":"leave-me","source":"./original"}]}\n');fs.writeFileSync(market,original);fs.writeFileSync(market+'.bak','keep-original-backup');
 const plan={target,dataDir,marketplaceRoot,shortcut:path.join(root,'startup.lnk'),previous:{},version:'0.1.0-beta.1',taskName:'isolated-fixture',sid:'fixture',task:{exists:false},integrity:{files:{'native/DSHDragon.Start.exe':createHash('sha256').update('fixture-launcher').digest('hex')}},...(registration===undefined?{}:{registerCodex:registration})};
 installSourceFixture(source,plan);
 const result=await install(plan,{fileSource:source,windows:()=>({exists:false}),stop:async()=>{},verify:async()=>{},capturePlugin:()=>assert.fail('default DSH install must not capture Codex registration'),execute:()=>assert.fail('default DSH install must not execute Codex')});
 assert.equal(result.ok,true);assert.deepEqual(fs.readFileSync(market),original);assert.equal(fs.readFileSync(market+'.bak','utf8'),'keep-original-backup');
 const installed=JSON.parse(fs.readFileSync(path.join(target,'installation.json')));assert.equal(installed.registerCodex,false);assert.equal(installed.hostSource,'dsh');
});
