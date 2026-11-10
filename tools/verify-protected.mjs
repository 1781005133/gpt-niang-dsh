import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baselineFile=path.join(root,'audit/protected-files.json');
// audit/ holds this machine's baseline of the user's pre-existing installs and
// is not redistributed. This check is only meaningful on that machine.
if(!fs.existsSync(baselineFile)){console.error('Local protection baseline not found: '+baselineFile+'\nThis check compares against the pre-task state of an existing local installation and does not run in a fresh clone.');process.exit(2);}
const baseline=JSON.parse(fs.readFileSync(baselineFile,'utf8').replace(/^\uFEFF/,''));
const results=baseline.map(item=>{try{const actual=createHash('sha256').update(fs.readFileSync(item.Path)).digest('hex').toUpperCase();return {path:item.Path,unchanged:actual===item.Hash,expected:item.Hash,actual};}catch(error){return {path:item.Path,unchanged:false,error:error.code};}});
const result={checkedAt:new Date().toISOString(),ok:results.every(r=>r.unchanged),files:results};
fs.writeFileSync(path.join(root,'audit/protected-files-verification.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ok:result.ok,checked:results.length,changed:results.filter(r=>!r.unchanged).map(r=>r.path)}));
if(!result.ok)process.exitCode=1;
