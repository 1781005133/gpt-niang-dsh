// Build a self-contained gift ZIP: program folder + bridge + docs + checksums.
// Reuses the product's own ZIP writer and validator so the inner package
// stays byte-identical in structure to the release ZIP.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
const project=path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)),'..');
const {crc32}=await import(new URL('../desktop/src/core/archive.mjs',import.meta.url));
const version=process.argv[2];
if(!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version??''))throw Error('Usage: build-gift-zip.mjs <version>, e.g. 0.1.0-beta.2');
const stage=path.join(project,'dist','gift-'+version);
const outDir=path.join(project,'dist','gift-package');
fs.mkdirSync(outDir,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
 if(entry.isSymbolicLink())throw Error('gift stage contains a link: '+entry.name);
 const file=path.join(dir,entry.name);return entry.isDirectory()?walk(file):entry.isFile()?[file]:[];
});
const rootName='GPT龙娘-桌宠-'+version;
const files=walk(stage).map(file=>({name:rootName+'/'+path.relative(stage,file).split(path.sep).join('/'),bytes:fs.readFileSync(file)}));
if(!files.some(f=>f.name.endsWith('/使用说明.md')))throw Error('missing user guide');
if(!files.some(f=>f.name.endsWith('/dsh-gpt-companion/package.json')))throw Error('missing program manifest');
for(const file of files)if(/(?:^|\/)(?:installation\.json|settings\.json|auth\.json|runtime\.json|presence\.json|status\.json|startup\.log|companion-data-owner\.json|electron-profile|numeric-logs)(?:\/|$)/i.test(file.name)||/\.bak$/i.test(file.name))throw Error('private state in gift: '+file.name);
const zip=path.join(outDir,`${rootName}.zip`),fd=fs.openSync(zip,'wx'),central=[];let offset=0;
try{
 for(const file of files){
  const packed=deflateRawSync(file.bytes,{level:6}),raw=Buffer.from(file.name,'utf8'),crc=crc32(file.bytes),local=Buffer.alloc(30),directory=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(file.bytes.length,22);local.writeUInt16LE(raw.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt16LE(0x21,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(packed.length,20);directory.writeUInt32LE(file.bytes.length,24);directory.writeUInt16LE(raw.length,28);directory.writeUInt32LE(offset,42);
  fs.writeSync(fd,local);fs.writeSync(fd,raw);fs.writeSync(fd,packed);central.push(directory,raw);offset+=local.length+raw.length+packed.length;
 }
 const table=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);fs.writeSync(fd,table);fs.writeSync(fd,end);
}finally{fs.closeSync(fd);}
const bytes=fs.readFileSync(zip);
// The nested program must still be complete: every manifest entry present in
// the archive bytes with the exact recorded hash.
const programPrefix=rootName+'/dsh-gpt-companion/';
const manifest=JSON.parse(fs.readFileSync(path.join(stage,'dsh-gpt-companion','integrity.json'),'utf8'));
const byName=new Map(files.map(file=>[file.name,file.bytes]));
const missing=[],mismatched=[];
for(const [name,expected] of Object.entries(manifest.files)){
 const entry=byName.get(programPrefix+name);
 if(!entry){missing.push(name);continue;}
 if(hash(entry)!==expected)mismatched.push(name);
}
if(missing.length||mismatched.length)throw Error('nested program incomplete: '+JSON.stringify({missing:missing.slice(0,5),mismatched:mismatched.slice(0,5)}));
const sum=hash(bytes);
fs.writeFileSync(path.join(outDir,rootName+'.zip.sha256.txt'),`${sum}  ${rootName}.zip\n`);
const summary={zip:path.basename(zip),bytes:bytes.length,megabytes:Number((bytes.length/1024/1024).toFixed(1)),sha256:sum,entries:files.length,programFiles:files.filter(f=>f.name.includes('/dsh-gpt-companion/')).length,privateStateIncluded:false};
fs.writeFileSync(path.join(outDir,'gift-verification-'+version+'.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
