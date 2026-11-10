import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createSnapshotFiles,resolveBridgeRoot,assertNoLinks} from '../src/filesystem.mjs';
import {MAX_SNAPSHOT_BYTES,MAX_LOG_BYTES} from '../../shared/bridge-protocol.mjs';
import {fixture,otherId,key} from './helpers.mjs';
test('single profile fixed root with no caller-supplied paths',t=>{
  const dir=fixture(t);assert.deepEqual(resolveBridgeRoot({dshHome:dir,env:{}}),{root:path.join(dir,'state','dsh-gpt-companion','desktop'),profile:'desktop'});
  assert.throws(()=>resolveBridgeRoot({dshHome:dir,profile:'../original'}));
  const files=createSnapshotFiles(path.join(dir,'bridge'));for(const name of ['../outside','C:\\outside','auth.json','quota.json/../../outside']) assert.throws(()=>files.write(name,{}));
  assert.equal(fs.existsSync(path.join(dir,'outside')),false);
});
test('bounded regular files use atomic rename and leave no temp files',t=>{
  const dir=fixture(t),root=path.join(dir,'bridge'),files=createSnapshotFiles(root);
  const one='{"status":"first"}',two='{"status":"second"}';files.write('quota.json',one);assert.equal(fs.readFileSync(path.join(root,'quota.json'),'utf8'),one);files.write('quota.json',two);assert.equal(fs.readFileSync(path.join(root,'quota.json'),'utf8'),two);
  assert.equal(fs.readdirSync(root).some(f=>f.endsWith('.tmp')),false);
  assert.throws(()=>files.write('quota.json','x'.repeat(MAX_SNAPSHOT_BYTES+1)));
  const log=`${otherId}-${key}.jsonl`;assert.throws(()=>files.write(log,'x'.repeat(MAX_LOG_BYTES+1),true));files.write(log,'123',true);files.clearLogs();assert.equal(fs.existsSync(path.join(root,'numeric-logs','sessions',log)),false);
});
test('fixed consumer control reads are bounded regular files and cannot pick another filename',t=>{
  const root=path.join(fixture(t),'bridge'),files=createSnapshotFiles(root),control=path.join(root,'desktop-control.json');assert.equal(files.readControl(),null);
  fs.writeFileSync(control,'x'.repeat(4097));assert.throws(()=>files.readControl());fs.unlinkSync(control);fs.mkdirSync(control);assert.throws(()=>files.readControl());
  assert.throws(()=>files.write('desktop-control.json',{})); // only the desktop owns this writer, host never writes it
});
test('symlink/junction roots and redirected snapshot/log paths are refused',t=>{
  const dir=fixture(t),outside=path.join(dir,'outside');fs.mkdirSync(outside);const link=path.join(dir,'redirect');
  fs.symlinkSync(outside,link,'junction');assert.throws(()=>createSnapshotFiles(path.join(link,'bridge')));assert.throws(()=>assertNoLinks(link));
  const root=path.join(dir,'bridge'),files=createSnapshotFiles(root);fs.mkdirSync(path.join(root,'host.json'));assert.throws(()=>files.write('host.json',{}));
  const log=`${otherId}-${key}.jsonl`;fs.symlinkSync(outside,path.join(root,'numeric-logs','sessions',log),'junction');assert.throws(()=>files.clearLogs());assert.equal(fs.existsSync(outside),true);
});
