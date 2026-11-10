import fs from 'node:fs';
import path from 'node:path';

export const DSH_EXECUTABLE_NAME = 'DeepSeek Harness.exe';
export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh-desktop';
export const DSH_APP_ID = 'com.deepseek.dsh';

// Only an explicit local path can narrow discovery. Never infer an Electron host
// from its window title, process basename alone, bridge data, or a remote peer.
export function configuredDshPaths({dshExecutablePaths, env=process.env}={}) {
  const configured = dshExecutablePaths ?? (env.DSH_COMPANION_DSH_EXE === undefined
    ? null : [env.DSH_COMPANION_DSH_EXE]);
  if (configured === null) return null;
  const values = Array.isArray(configured) ? configured : [configured];
  return values.filter(value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)
    && path.win32.isAbsolute(value) && !/[\0\r\n]/.test(value))
    .map(value => path.win32.normalize(value).toLowerCase());
}

export function isCodexProcessImage(image) {
  return typeof image === 'string' && /\\(?:Codex|ChatGPT)\.exe$/i.test(image)
    && (/\\OpenAI\.Codex_/i.test(image) || /\\OpenAI\\Codex\\/i.test(image));
}

export function isDshProcessImage(image, {allowedPaths=null, filesystem=fs}={}) {
  // Refuse UNC/device paths: inspecting a local window must not trigger SMB
  // authentication or fetch an identity manifest from a remote filesystem.
  if (typeof image !== 'string' || !/^[a-z]:[\\/]/i.test(image)
    || !path.win32.isAbsolute(image) || /[\0\r\n]/.test(image)) return false;
  const candidate = path.win32.normalize(image);
  if (path.win32.basename(candidate).toLowerCase() !== DSH_EXECUTABLE_NAME.toLowerCase()) return false;
  if (allowedPaths !== null && !allowedPaths.includes(candidate.toLowerCase())) return false;
  try {
    // Get the actual local executable, not an environment variable, wildcard, or
    // symlink to an unrelated Electron. Its adjacent bundled app must have both
    // independent DSH identities. Read only this bounded public package manifest.
    const actual = filesystem.realpathSync(candidate);
    if (path.win32.normalize(actual).toLowerCase() !== candidate.toLowerCase()) return false;
    if (!filesystem.statSync(actual).isFile()) return false;
    const manifest = path.win32.join(path.win32.dirname(actual), 'resources', 'app', 'package.json');
    const stat = filesystem.statSync(manifest);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 65536) return false;
    const bytes = filesystem.readFileSync(manifest);
    if (bytes.length > 65536) return false;
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    return value?.name === DSH_PACKAGE_NAME && value?.dshDesktopAppId === DSH_APP_ID;
  } catch {
    return false;
  }
}

export function hostSource(value='dsh') {
  // Reject unknown modes instead of silently finding a different application's
  // window. A persisted setting error must not focus an unintended host.
  return value === 'dsh' || value === 'codex' ? value : null;
}
