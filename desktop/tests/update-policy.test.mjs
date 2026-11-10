import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createUpdatePolicy,DEFAULT_UPDATE_POLICY,RELEASE_API,allowedUrl,download,selectRelease} from '../src/core/update-network.mjs';
import {Updater} from '../src/core/updater.mjs';
const policy=createUpdatePolicy('fixture-owner/independent-companion-test');
test('the default independent feed is explicitly empty and cannot make a network request',async()=>{
 assert.deepEqual(DEFAULT_UPDATE_POLICY,{repository:null,api:null,releasePath:null});assert.equal(RELEASE_API,null);
 let requests=0;
 for(const url of [policy.api,'https://github.com/T7moris/GPT-Niang/releases/download/v1.4.0/anything.zip']){
  assert.throws(()=>allowedUrl(url),/尚未配置/);
  await assert.rejects(download(url,{request:()=>{requests++;assert.fail('unconfigured feed must not request');}}),/尚未配置/);
 }
 assert.equal(requests,0);
});
test('unconfigured manual and automatic updater checks report unavailable without fetching or staging',async t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-companion-no-feed-'));
 t.after(()=>{assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});});
 let requests=0;const updater=new Updater({root:path.join(dataDir,'app'),dataDir,version:'0.1.0-beta.1',candidate:true,fetchBytes:async()=>{requests++;assert.fail('must not fetch');}});
 await updater.check('manual');assert.equal(updater.state.status,'unconfigured');assert.match(updater.state.message,/不会下载原版/);
 updater.state.nextCheckAt=0;await updater.check('automatic');assert.equal(updater.state.status,'unconfigured');assert.equal(requests,0);
 assert.equal(fs.existsSync(path.join(dataDir,'updates')),false);
});
test('explicit synthetic feed permits only its repository and rejects upstream identity',()=>{
 assert.throws(()=>createUpdatePolicy('T7moris/GPT-Niang'));assert.throws(()=>createUpdatePolicy('t7Moris/gpt-niang'));
 for(const repository of ['',null,'../repo','owner/repo/extra','https://github.com/owner/repo'])assert.throws(()=>createUpdatePolicy(repository));
 assert.equal(allowedUrl(policy.api,{api:true,policy}).href,policy.api);
 assert.throws(()=>allowedUrl('https://api.github.com/repos/T7moris/GPT-Niang/releases/latest',{api:true,policy}));
 assert.throws(()=>allowedUrl('https://github.com/T7moris/GPT-Niang/releases/download/v1.4.0/file.zip',{policy}));
 const version='0.1.0',names=[`dsh-gpt-companion-widget-v${version}-windows-js.zip`,'SHA256SUMS.txt'];
 const release={tag_name:'v'+version,assets:names.map(name=>({name,browser_download_url:`https://github.com/${policy.repository}/releases/download/v${version}/${name}`}))};
 assert.equal(selectRelease(release,'0.1.0-beta.1',{policy}).zip.name,names[0]);
 assert.throws(()=>selectRelease(release,'0.1.0-beta.1'),/尚未配置/);
});
