import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'shared/bridge-protocol.mjs'),target=path.join(root,'desktop/shared/bridge-protocol.mjs');
const bytes=fs.readFileSync(source);fs.mkdirSync(path.dirname(target),{recursive:true});
if(!fs.existsSync(target)||!fs.readFileSync(target).equals(bytes))fs.writeFileSync(target,bytes);
console.log(JSON.stringify({sharedProtocolSha256:createHash('sha256').update(bytes).digest('hex')}));
