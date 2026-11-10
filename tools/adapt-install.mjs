// Targeted changes in Lead-owned installation files only.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../desktop');
function change(file, pairs){const name=path.join(root,file);let text=fs.readFileSync(name,'utf8');for(const [old,replacement]of pairs){if(!text.includes(old))throw Error('Missing expected installer text: '+old.slice(0,90));text=text.replace(old,replacement);}fs.writeFileSync(name,text);}
change('src/install.mjs',[
 ['    codexPath = resolveInstallCli(previous?.codexPath),','    codexPath = (()=>{try{return resolveInstallCli(previous?.codexPath);}catch{return "";}})(),'],
 ['  if (!codexPath || !fs.existsSync(codexPath))','  const registerCodex=args.includes("--codex-plugin") || previous?.registerCodex===true;\n  if (registerCodex && (!codexPath || !fs.existsSync(codexPath)))'],
 ['    codexPath,\n    codexHome:','    codexPath,\n    registerCodex,\n    hostSource:previous?.hostSource??"dsh",\n    codexHome:'],
 ['      codexPath: plan.codexPath,','      codexPath: plan.codexPath,\n      registerCodex:plan.registerCodex===true,\n      hostSource:plan.hostSource??"dsh",'],
 ['    const pluginSnapshot=capturePlugin(plan,{execute});','    const pluginSnapshot=plan.registerCodex===true?capturePlugin(plan,{execute}):null;'],
 ['    const plugins = (priorMarket?.plugins ?? []).filter(','    if(plan.registerCodex===true){\n    const plugins = (priorMarket?.plugins ?? []).filter('],
 ['    for (const name of [\n      "supervisor-stop.flag",','    } // Optional independent Codex registration; never required for DSH.\n    for (const name of [\n      "supervisor-stop.flag",'],
 ['    if (args.includes("--uninstall")) {','    if (args.includes("--uninstall") && plan.registerCodex===true) {']
]);
change('src/core/settings.mjs',[
 ['  layoutVersion: 2,','  layoutVersion: 2,\n  hostSource: "dsh",'],
 ['  const enumValue = value =>','  if(["dsh","codex"].includes(saved.hostSource))s.hostSource=saved.hostSource;\n  const enumValue = value =>']
]);
change('ui/menu.mjs',[
 ['  el("strong", "GPT 娘", header);','  el("strong", "GPT 龙娘 · DSH独立版", header);\n  const hostName=state.settings.hostSource==="codex"?"Codex":"DSH";'],
 ['state.settings.followHost ? "跟随 Codex" : "桌面模式"','state.settings.followHost ? "跟随 "+hostName : "桌面模式"'],
 ['  radio(\n    "仅在 Codex 窗口内",','  for(const [value,label]of [["dsh","DSH GPT订阅"],["codex","Codex客户端"]])\n    radio(label,(state.settings.hostSource??"dsh")===value,()=>command("host-source",value),position);\n  el("hr",undefined,position);\n  radio(\n    "仅在 "+hostName+" 窗口内",'],
 ['button("退出 GPT 娘",','button("退出独立龙娘",']
]);
change('src/supervisor.mjs',[
 ['    const hosts = native.hosts(),','    const hostSettings=readJson(path.join(dataDir,"settings.json"));\n    const source=hostSettings?.hostSource??config.hostSource??"dsh";\n    const hosts = native.hosts(source),']
]);
console.log('Independent installation and host selection adapted.');
