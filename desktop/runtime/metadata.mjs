import fs from 'node:fs';

// The independent application version is not the upstream Codex plugin identity.
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
export const pluginVersion = manifest.version;
