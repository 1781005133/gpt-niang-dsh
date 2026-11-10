import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readBridgeNumericLogs, readBridgeHost } from './companion-bridge.mjs';
import { snapshotsMatch } from '../shared/bridge-protocol.mjs';
import { assertCompanionData } from '../src/core/storage.mjs';

// Only canonical numeric records enter this private mirror. The inherited
// Codex reader never receives a DSH/bridge directory or conversation database.
export function syncCompanionLedgerSource(dataDir, config = {}, now = Date.now(), { archiveReader = null } = {}) {
  assertCompanionData(dataDir, { claim: true });
  try {
    const { host, completion, logs: active } = readBridgeNumericLogs(config, now);
    if (!host.accountKey) throw Error('Unverified DSH account');
    const archive = archiveReader?.scan(config, now) ?? { logs: [], history: null };
    const merged = new Map(archive.logs.map(log => [log.file, log]));
    for (const log of active) merged.set(log.file, log); // Live canonical data wins a pending archive rewrite.
    const home = path.resolve(dataDir, 'dsh-numeric-source', host.accountKey), sessions = path.join(home, 'sessions');
    const hash = value => createHash('sha256').update(value).digest('hex'), sources = [];
    const checkAncestors = () => {
      for (let current = sessions;; current = path.dirname(current)) {
        try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('Redirected local numeric mirror'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (path.dirname(current) === current) break;
      }
    };
    checkAncestors(); fs.mkdirSync(sessions, { recursive: true }); checkAncestors();
    for (const log of merged.values()) {
      const originEpoch = log.originEpoch ?? host.epoch, id = hash(originEpoch + ':' + log.logId);
      const records = log.records.map(record => {
        const payload = { ...record.payload };
        if (record.type === 'session_meta') payload.id = id;
        if (typeof payload.turn_id === 'string') payload.turn_id = id + ':' + payload.turn_id;
        return { ...record, payload };
      });
      const file = path.join(sessions, log.file), text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
      sources.push({ id, originEpoch, sessionKey: log.sessionKey, digest: hash(text), file, records });
      try {
        if (fs.lstatSync(file).isSymbolicLink()) throw Error('Redirected mirror file');
        if (fs.readFileSync(file, 'utf8') === text) continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporary = file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, text, { flag: 'wx' }); fs.renameSync(temporary, file); }
      finally { try { fs.unlinkSync(temporary); } catch {} }
    }
    const after = readBridgeHost(config, now);
    if (!after.connected || !snapshotsMatch(host, after) || after.accountKey !== host.accountKey || after.revision !== host.revision) throw Error('Bridge changed during numeric import');
    return { home, accountKey: host.accountKey, epoch: host.epoch, instanceId: host.instanceId, sessions: completion.sessions, sources,
      activeIds: active.map(log => hash(host.epoch + ':' + log.logId)), history: archive.history };
  } catch (error) { archiveReader?.reset(); throw error; }
}
