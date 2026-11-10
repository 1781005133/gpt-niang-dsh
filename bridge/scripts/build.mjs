import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'lib'); fs.mkdirSync(out,{recursive:true});
const protocol=fs.readFileSync(path.join(root,'../shared/bridge-protocol.mjs'),'utf8');
fs.writeFileSync(path.join(out,'bridge-protocol.mjs'),protocol);
fs.writeFileSync(path.join(out,'BRIDGE-CONTRACT.md'),fs.readFileSync(path.join(root,'../docs/BRIDGE-CONTRACT.md'),'utf8'));
for(const name of ['index','host','filesystem','transport','usage-accounting','controls','client-core','archive']) {
  const source=fs.readFileSync(path.join(root,'src',`${name}.mjs`),'utf8').replaceAll("'../../shared/bridge-protocol.mjs'","'./bridge-protocol.mjs'");
  fs.writeFileSync(path.join(out,`${name}.mjs`),source);
}
// Dependency-free deterministic ESM flattening for these local browser modules.
// Fail closed if the module graph grows beyond this intentionally small set.
const flatten=source=>{
  source=source.replace(/^import\s+[^;]+;\s*$/gm,'').replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/gm,'');
  if(/^\s*(?:import|export)\s/m.test(source)) throw Error('Unsupported browser module syntax');
  return source;
};
const sources=[protocol,fs.readFileSync(path.join(root,'src/client-core.mjs'),'utf8'),fs.readFileSync(path.join(root,'src/client.mjs'),'utf8')];
const client=`// Generated from canonical sources by scripts/build.mjs.\nwindow.__ModuleLoader__.load({id:'dsh-gpt-companion-bridge',factory:(require)=>{\n'use strict';\nconst module={exports:{}};const exports=module.exports;\n${sources.map(flatten).join('\n')}\nexports.apply=apply;exports.inject=inject;return module.exports;\n}});\n`;
fs.writeFileSync(path.join(out,'client.js'),client);
console.log('Built self-contained host ESM, shared contract and standard DSH browser loader entry.');
