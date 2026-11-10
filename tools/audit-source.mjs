import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),base=path.join(project,'vendor/source/GPT-Niang-1.4.0-beta.3/windows-js'),fork=path.join(project,'desktop');
// The upstream reference source is intentionally not redistributed. Extract the
// same upstream release into vendor/source/ first (see docs/TEST-MIGRATION.md).
if(!fs.existsSync(base)){console.error('Upstream reference source not found: '+base+'\nExtract GPT-Niang v1.4.0-beta.3 there to run this audit. See docs/TEST-MIGRATION.md.');process.exit(2);}
const roots=['src','runtime','ui','native','assets','scripts','shared','.codex-plugin'];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function list(root,dir){if(!fs.existsSync(path.join(root,dir)))return [];return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(entry=>{const name=dir+'/'+entry.name;if(entry.isSymbolicLink())throw Error('Unexpected source link');return entry.isDirectory()?list(root,name):entry.isFile()?[name]:[];});}
const names=new Set([...roots.flatMap(dir=>list(base,dir)),...roots.flatMap(dir=>list(fork,dir)),...['package.json','package-lock.json','.mcp.json','README.md','LICENSE']]);
const added=[],removed=[],changed=[],unchanged=[];
for(const name of [...names].sort()){const a=path.join(base,name),b=path.join(fork,name);if(!fs.existsSync(a))added.push(name);else if(!fs.existsSync(b))removed.push(name);else if(hash(a)!==hash(b))changed.push(name);else unchanged.push(name);}
const result={upstreamCommit:'285cb464ebc700be640ecc6a7be4ca3a05ba5371',createdAt:new Date().toISOString(),added,removed,changed,unchanged,unchangedFeatures:{quotes:unchanged.includes('assets/quotes.json'),layouts:unchanged.includes('assets/quote-layouts.json'),musicAlgorithm:unchanged.includes('ui/music-motion.mjs'),characterPicture:unchanged.includes('assets/gpt-dragon-niang-bust.png'),license:unchanged.includes('LICENSE')}};
fs.writeFileSync(path.join(project,'audit/source-diff-summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({added:added.length,removed:removed.length,changed:changed.length,unchanged:unchanged.length,baselineFeatures:result.unchangedFeatures}));
