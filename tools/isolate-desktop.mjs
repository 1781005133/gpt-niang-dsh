// One-time, allow-scoped fork identity transform. Never run against installed code.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(project,'desktop');
if(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).name!=='gpt-niang-usage')throw Error('One-time migration already applied; never rewrite an independent source tree.');
const replacements=[['gpt-niang-usage','dsh-gpt-companion'],['gpt-niang-local','dsh-gpt-companion-local'],['.gpt-niang','.dsh-gpt-companion'],['GPTNiangUsage','DSHGPTCompanion'],['GPTNiang.','DSHDragon.'],['GPT Niang Usage','DSH GPT Companion']];
const owned=['src/core','ui','scripts','tests','.codex-plugin'];
const excludes=new Set(['src/core/usage-service.mjs']);
const files=['package.json','package-lock.json','.mcp.json','src/bootstrap.cjs','src/preload.cjs','src/install.mjs','src/setup-entry.mjs','src/start.mjs','src/supervisor.mjs','src/install-recovery.mjs','src/legacy-migration-agent.mjs','src/update-agent.mjs','src/io-worker.mjs','src/update-io-worker.mjs'];
function collect(dir){for(const ent of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const name=dir+'/'+ent.name;if(ent.isSymbolicLink())throw Error('Unexpected link');if(ent.isDirectory())collect(name);else if(/\.(mjs|cjs|js|json|html|css|yml)$/.test(name)&&!name.split('/').at(-1).startsWith('companion-'))files.push(name);}}
for(const dir of owned)collect(dir);
const changed=[];
for(const name of files){if(excludes.has(name))continue;const file=path.join(root,name);if(!fs.existsSync(file))continue;const old=fs.readFileSync(file,'utf8');let text=old;for(const [a,b]of replacements)text=text.replaceAll(a,b);if(text!==old){fs.writeFileSync(file,text);changed.push(name);}}
const pkgFile=path.join(root,'package.json');const pkg=JSON.parse(fs.readFileSync(pkgFile));pkg.version='0.1.0-beta.1';pkg.description='GPT龙娘 · DSH独立版（Windows x64）';fs.writeFileSync(pkgFile,JSON.stringify(pkg,null,2)+'\n');
const lockFile=path.join(root,'package-lock.json');const lock=JSON.parse(fs.readFileSync(lockFile));lock.version=pkg.version;if(lock.packages?.['']){lock.packages[''].name=pkg.name;lock.packages[''].version=pkg.version;}fs.writeFileSync(lockFile,JSON.stringify(lock,null,2)+'\n');
fs.writeFileSync(path.join(project,'audit','identity-transform.json'),JSON.stringify({allowScopes:owned,excluded:[...excludes],changed},null,2)+'\n');console.log(JSON.stringify({changed:changed.length,package:pkg.name,version:pkg.version}));
