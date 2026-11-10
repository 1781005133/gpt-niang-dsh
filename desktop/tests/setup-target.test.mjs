import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {resolveSetupTarget} from '../src/core/setup-target.mjs';
import {stableInstallPaths} from '../src/core/install-paths.mjs';
const env={USERPROFILE:path.resolve('fixture-profile'),LOCALAPPDATA:path.resolve('fixture-local')};
const defaults=stableInstallPaths(env),target=defaults.target,dataDir=path.resolve('fixture-personal');
const options=(config={appDir:target,dataDir},pkg={name:'dsh-gpt-companion',architecture:'javascript-electron'})=>({env,exists:()=>true,read:file=>file.endsWith('package.json')?pkg:config,execute:()=>assert.fail('setup target must never query Codex')});
test('fresh independent setup uses stable local directories without querying Codex',()=>{
 const first=resolveSetupTarget({...options(),exists:()=>false});
 assert.deepEqual(first,{...defaults,existing:false});assert.notEqual(first.target,first.dataDir);
 assert.deepEqual(resolveSetupTarget({...options(),exists:()=>false,env:{...env,LOCALAPPDATA:path.resolve('redirected-msix'),CODEX_HOME:path.resolve('unrelated-codex')}}),first);
});
test('existing independent JavaScript installation retains its verified personal directory',()=>{
 assert.deepEqual(resolveSetupTarget(options()),{target,dataDir,existing:true});
 assert.deepEqual(resolveSetupTarget(options({appDir:target.toUpperCase(),dataDir,version:'0.1.0-beta.1'})),{target,dataDir,existing:true});
});
test('foreign, legacy, missing or conflicting installation identity is rejected',()=>{
 for(const pkg of [null,{name:'gpt-niang-usage',architecture:'javascript-electron'},{name:'dsh-gpt-companion'},{name:'dsh-gpt-companion',architecture:'powershell-wpf'}])assert.throws(()=>resolveSetupTarget(options(undefined,pkg)),/身份不匹配/);
 for(const config of [null,{}, {appDir:path.resolve('other'),dataDir},{appDir:target,dataDir:'relative'}])assert.throws(()=>resolveSetupTarget(options(config)),/身份不匹配/);
});
test('setup never discovers or reuses a registered original installation',()=>{
 const original=path.resolve('original-gpt-niang');let reads=0;
 const result=resolveSetupTarget({env:{...env,CODEX_HOME:original},exists:file=>{assert.equal(file,target);return false;},read:()=>{reads++;assert.fail('fresh setup must not inspect Codex registration');},execute:()=>assert.fail('must not launch Codex')});
 assert.equal(reads,0);assert.equal(result.target,target);assert.notEqual(result.target,original);
});
