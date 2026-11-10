import fs from "node:fs";
export function guiEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE",
    ),
  );
}
import path from "node:path";
export function samePath(a, b) {
  if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) return false;
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
export function resolveNodeHost(root, configured, fallback = process.execPath) {
  const bundled = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  for (const file of [configured, bundled, fallback]) {
    if (typeof file !== 'string' || !file) continue;
    try { if (fs.statSync(file).isFile()) return path.resolve(file); } catch {}
  }
  throw Error('没有找到可用的运行环境，请重新运行安装检查。');
}
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}
export function writeJson(file, value, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary =
    file +
    "." +
    process.pid +
    "." +
    Math.random().toString(16).slice(2) +
    ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
    if (backup && fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}
// Independent program/data ownership must be proved before cleanup, locking or recovery.
export const COMPANION_APP_ID = 'DSHGPTCompanion';
export function assertIndependentPath(directory) {
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('独立目录必须是绝对路径');
  const absolute=path.resolve(directory);
  if(absolute===path.dirname(absolute)||/^(?:\\\\|\\\\\?\\|\\\\\.\\)/.test(absolute)||absolute.split(/[\\/]+/).some(part=>['.gpt-niang','.dsh','gptniangusage','dsh-whale-widget'].includes(part.toLowerCase())))throw Error('拒绝使用原版或DSH宿主的数据目录');
  for(let current=absolute;;current=path.dirname(current)) {
    try{if(fs.lstatSync(current).isSymbolicLink())throw Error('独立目录不能使用文件链接');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.dirname(current)===current)break;
  }
  return absolute;
}
export function assertCompanionProgram(directory,{boundRoot=directory,dataDir,version}={}) {
  const absolute=assertIndependentPath(directory);assertIndependentPath(boundRoot);
  const pkg=readJson(inside(absolute,'package.json')),binding=readJson(inside(absolute,'installation.json'));
  if(pkg?.name!=='dsh-gpt-companion'||pkg.architecture!=='javascript-electron'||!samePath(binding?.appDir,boundRoot)||(dataDir&&!samePath(binding?.dataDir,dataDir))||(version&&pkg.version!==version))throw Error('独立程序身份或安装绑定不匹配');
  return {pkg,binding};
}
export function assertCompanionData(dataDir,{programRoot=null,boundRoot=programRoot,claim=false}={}) {
  const directory=assertIndependentPath(dataDir),marker=path.join(directory,'companion-data-owner.json');
  const existing=fs.existsSync(directory);
  if(existing&&!fs.statSync(directory).isDirectory())throw Error('独立个人数据目录无效');
  if(fs.existsSync(marker)&&fs.lstatSync(marker).isSymbolicLink())throw Error('个人数据归属标记不能是文件链接');
  const owner=readJson(marker);
  const owned=owner?.schema===1&&owner.appId===COMPANION_APP_ID&&samePath(owner.dataDir,directory);
  if(fs.existsSync(marker)&&!owned)throw Error('个人数据目录归属标记无效或属于其他安装');
  if(existing&&fs.readdirSync(directory).length&&!owned) {
    // A program config pointing here is not proof that these existing user files
    // belong to this fork. Never adopt an unmarked non-empty directory.
    throw Error('现有非空个人数据目录缺少独立版归属标记，拒绝接管');
  }
  if(claim&&!owned)writeJson(marker,{schema:1,appId:COMPANION_APP_ID,dataDir:directory},{backup:false});
  return directory;
}
export function inside(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw new Error("文件路径必须位于数据目录中。");
  const base = path.resolve(root),
    file = path.resolve(base, relative);
  if (!file.toLowerCase().startsWith(base.toLowerCase() + path.sep))
    throw new Error("文件路径超出了数据目录。");
  for (let p = file; p.length >= base.length; p = path.dirname(p)) {
    try {
      if (fs.lstatSync(p).isSymbolicLink())
        throw new Error("文件目录不能使用文件链接。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (p === base) break;
  }
  return file;
}
