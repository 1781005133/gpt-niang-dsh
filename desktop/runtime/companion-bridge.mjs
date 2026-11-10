import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MAX_SNAPSHOT_BYTES, MAX_LOG_BYTES, QUOTA_TTL_MS, MAX_CONTROL_BYTES,
  parseSnapshot, isSnapshotFresh, snapshotsMatch, validateNumericLog, unknownQuota, parseDesktopControl,
} from '../shared/bridge-protocol.mjs';

export function resolveBridgeRoot(config = {}, env = process.env) {
  const profile = config.dshProfile ?? env.DSH_PROFILE ?? 'desktop';
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw Error('Invalid bridge profile');
  if (config.bridgeRoot != null) {
    if (typeof config.bridgeRoot !== 'string' || !path.isAbsolute(config.bridgeRoot)) throw Error('Invalid bridge root');
    return path.resolve(config.bridgeRoot);
  }
  const home = config.dshHome ?? env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.resolve(home, 'state', 'dsh-gpt-companion', profile);
}

// Only exact protocol filenames may reach this primitive. Ancestors, files and
// the descriptor are checked: no recursive discovery, credential files or DBs.
function readBounded(root, relative, limit) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw Error('Invalid bridge path');
  for (let current = file;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw Error('Redirected bridge path');
    if (current === file ? !stat.isFile() : !stat.isDirectory()) throw Error('Invalid bridge file');
    if (path.dirname(current) === current) break;
  }
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw Error('Invalid bridge size');
    const bytes = Buffer.alloc(stat.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw Error('Bridge file changed');
    return bytes.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function readHost(root, now, requireConnected = true) {
  const host = parseSnapshot(readBounded(root, 'host.json', MAX_SNAPSHOT_BYTES), 'host');
  if (!isSnapshotFresh(host, now) || requireConnected && !host.connected) throw Error('Disconnected bridge');
  return host;
}
// Consumer controls may advertise visibility before the client/account connects.
// This does not relax account checks for quota/completion/numeric data.
export function readBridgeHost(config = {}, now = Date.now()) {
  return readHost(resolveBridgeRoot(config), now, false);
}
export function readDesktopControl(config = {}) {
  return parseDesktopControl(readBounded(resolveBridgeRoot(config), 'desktop-control.json', MAX_CONTROL_BYTES));
}
function sameHost(before, after) {
  return snapshotsMatch(before, after) && before.revision === after.revision && before.accountKey === after.accountKey;
}
export function readBridgeSnapshot(config = {}, kind = 'quota', now = Date.now()) {
  if (!['quota', 'completion', 'control-status', 'archive-status'].includes(kind)) throw Error('Invalid snapshot kind');
  const connected = kind !== 'control-status';
  const root = resolveBridgeRoot(config), host = readHost(root, now, connected);
  const snapshot = parseSnapshot(readBounded(root, kind + '.json', MAX_SNAPSHOT_BYTES), kind);
  if (!isSnapshotFresh(snapshot, now) || !snapshotsMatch(host, snapshot)) throw Error('Stale bridge snapshot');
  if (!sameHost(host, readHost(root, now, connected))) throw Error('Bridge account changed');
  return { root, host, snapshot };
}
export function readBridgeQuota(config = {}, now = Date.now()) {
  try {
    const { host, snapshot } = readBridgeSnapshot(config, 'quota', now), status = snapshot.status;
    if (!status.ok || !status.queryOk) return { ...status, ok: false, queryOk: false, windows: [], clearPrevious: true };
    if (!host.accountKey || host.accountKey !== status.accountKey) return { ...unknownQuota('ACCOUNT_CHANGED', now), clearPrevious: true };
    if (!Number.isFinite(status.observedAt) || now - status.observedAt > QUOTA_TTL_MS || status.observedAt > now + 5000 ||
        status.windows.some(w => w.resetsAt != null && w.resetsAt * 1000 <= now)) {
      return { ...unknownQuota('STALE', now), clearPrevious: true };
    }
    return { ...status, clearPrevious: true };
  } catch { return { ...unknownQuota('UNAVAILABLE', now), clearPrevious: true }; }
}

// Every exported log must appear in the current host's bounded allow-list.
// Return canonical numeric-only records; never copy raw JSONL into app state.
export function readBridgeNumericLogs(config = {}, now = Date.now()) {
  const { root, host, snapshot } = readBridgeSnapshot(config, 'completion', now);
  const logs = host.numericLogs.map(entry => {
    const match = /^([0-9a-f-]{36})-([0-9a-f]{64})\.jsonl$/i.exec(entry.file);
    if (!match || match[1] !== host.epoch) throw Error('Invalid log name');
    const text = readBounded(root, path.join('numeric-logs', 'sessions', entry.file), MAX_LOG_BYTES);
    if (Buffer.byteLength(text) !== entry.bytes) throw Error('Bridge log changed');
    const records = validateNumericLog(text, { epoch: host.epoch, sessionKey: match[2] });
    if (records[0].payload.session_key !== entry.sessionKey) throw Error('Mismatched log session');
    return { file: entry.file, sessionKey: entry.sessionKey, originEpoch: host.epoch, logId: match[2], records };
  });
  if (!sameHost(host, readHost(root, now))) throw Error('Bridge epoch changed');
  return { host, completion: snapshot, logs };
}
