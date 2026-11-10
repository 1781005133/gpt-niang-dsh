import { readUsage, resolveCodexExecutable } from './usage.mjs';
import { readBridgeQuota } from './companion-bridge.mjs';

// An unknown/missing source must never silently opt in to the original CLI.
export const normalizeHostSource = value => value === 'codex' ? 'codex' : 'dsh';
export function readUsageSource(config = {}, options = {}) {
  return normalizeHostSource(config.hostSource) === 'codex'
    ? readUsage(resolveCodexExecutable(config.codexPath), options)
    : Promise.resolve(readBridgeQuota(config));
}
