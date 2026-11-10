import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const official=path.join(project,'vendor/electron45-official'),target=path.join(project,'desktop/node_modules/electron/dist');
// The official Electron archive is not redistributed. Download the pinned
// win32-x64 v45.0.0 release and extract it to vendor/electron45-official.
if(!fs.existsSync(official)){console.error('Official Electron reference not found: '+official+'\nExtract electron-v45.0.0-win32-x64.zip there to run this audit.');process.exit(2);}
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function list(root,dir=''){const result=[];for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const relative=dir?dir+'/'+entry.name:entry.name;if(entry.isSymbolicLink())throw Error('Unexpected runtime link');if(entry.isDirectory())result.push(...list(root,relative));else if(entry.isFile())result.push(relative);}return result;}
const missing=[],different=[],same=[];for(const name of list(official)){const source=path.join(official,name),dest=path.join(target,name);if(!fs.existsSync(dest))missing.push({name,sha256:hash(source),bytes:fs.statSync(source).size});else if(hash(source)!==hash(dest))different.push({name,official:hash(source),original:hash(dest)});else same.push(name);}
const result={officialZipSha256:'ae53887a23bb640369c93dbd38c408a2af5c0deb86f2fa76c6c244cb444b7f47',sameFiles:same.length,missing,different};
fs.writeFileSync(path.join(project,'audit/electron45-runtime-comparison.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
