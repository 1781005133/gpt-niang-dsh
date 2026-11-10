import fs from 'node:fs';
import path from 'node:path';
import {readJson,samePath,assertIndependentPath,assertCompanionData} from './storage.mjs';
import {stableInstallPaths} from './install-paths.mjs';

// Never discover/reuse original GPT-Niang paths or query its Codex registration.
export function resolveSetupTarget({env=process.env,read=readJson,exists=fs.existsSync}={}) {
  const defaults=stableInstallPaths(env);
  assertIndependentPath(defaults.target);
  assertIndependentPath(defaults.dataDir);
  if(!exists(defaults.target))return {...defaults,existing:false};
  const pkg=read(path.join(defaults.target,'package.json'));
  const config=read(path.join(defaults.target,'installation.json'));
  if(pkg?.name!=='dsh-gpt-companion'||pkg.architecture!=='javascript-electron'||
      !samePath(config?.appDir,defaults.target)||!path.isAbsolute(config?.dataDir??''))
    throw Error('独立龙娘安装目录身份不匹配，已停止；原版与个人设置未改变。');
  assertCompanionData(config.dataDir,{programRoot:defaults.target});
  return {target:defaults.target,dataDir:path.resolve(config.dataDir),existing:true};
}
