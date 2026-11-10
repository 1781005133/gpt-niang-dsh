import fs from 'node:fs';
import { UsageLedger } from './usage-ledger.mjs';
import { estimateCost } from './usage-pricing.mjs';
import { newUsageState, acceptUsageRecord } from '../../runtime/session-usage.mjs';
import { assertIndependentPath } from './storage.mjs';

const sumUsage = rows => {
  if (!rows.length) return null;
  const value = rows.reduce((sum, row) => {
    for (const key of ['input', 'cached', 'cacheWrite', 'output', 'reasoning']) sum[key] += row[key] ?? 0;
    sum.total = sum.input + sum.output; return sum;
  }, { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
  return Object.values(value).every(Number.isSafeInteger) ? value : null;
};
const combined = values => { const unique = [...new Set(values)]; return unique.length === 1 ? unique[0] : unique.length ? 'multiple' : 'unknown'; };
const columns = 'SUM(e.input) input,SUM(e.cached) cached,SUM(e.cache_write) cacheWrite,SUM(e.output) output,SUM(e.reasoning) reasoning';

// Opt-in projection ledger: ingest bounded canonical shards atomically, including
// retractions. The original Codex ledger/parser and cost arithmetic are retained.
export class DshUsageLedger extends UsageLedger {
  constructor(options) {
    assertIndependentPath(options.dataDir);
    super(options);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dsh_threads(home TEXT NOT NULL,id TEXT NOT NULL,session_key TEXT NOT NULL,digest TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(home,id));
      CREATE INDEX IF NOT EXISTS dsh_threads_session ON dsh_threads(home,session_key);
      CREATE TABLE IF NOT EXISTS dsh_origins(home TEXT NOT NULL,id TEXT NOT NULL,origin_epoch TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(home,id));
      CREATE TABLE IF NOT EXISTS dsh_rounds(home TEXT NOT NULL,id TEXT NOT NULL,thread TEXT NOT NULL,origin_epoch TEXT NOT NULL,turn_id TEXT NOT NULL,at INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,input INTEGER NOT NULL,cached INTEGER NOT NULL,cache_write INTEGER NOT NULL,output INTEGER NOT NULL,reasoning INTEGER NOT NULL,PRIMARY KEY(home,id));
      CREATE INDEX IF NOT EXISTS dsh_round_thread ON dsh_rounds(home,thread,origin_epoch,turn_id);`);
    this.currentIds = new Set(); this.liveSessions = new Map(); this.epoch = null;
  }
  synchronize(mirror) {
    const find = this.db.prepare('SELECT m.digest,o.version FROM dsh_threads m LEFT JOIN dsh_origins o ON m.home=o.home AND m.id=o.id WHERE m.home=? AND m.id=?');
    const save = this.db.prepare('INSERT INTO dsh_threads VALUES(?,?,?,?,?) ON CONFLICT(home,id) DO UPDATE SET session_key=excluded.session_key,digest=excluded.digest,title=CASE WHEN excluded.title!=\'\' THEN excluded.title ELSE dsh_threads.title END');
    const origin = this.db.prepare('INSERT INTO dsh_origins VALUES(?,?,?,1) ON CONFLICT(home,id) DO UPDATE SET origin_epoch=excluded.origin_epoch,version=1');
    const round = this.db.prepare('INSERT OR IGNORE INTO dsh_rounds VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const titles = new Map(mirror.sessions.map(session => [session.sessionKey, session.title]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const source of mirror.sources) {
        const previous = find.get(this.scope, source.id), epoch = source.originEpoch ?? mirror.epoch;
        if (previous?.digest !== source.digest || previous?.version !== 1) {
          this.db.prepare('DELETE FROM events WHERE home=? AND thread=?').run(this.scope, source.id);
          this.db.prepare('DELETE FROM files WHERE home=? AND id=?').run(this.scope, source.id);
          this.db.prepare('DELETE FROM dsh_rounds WHERE home=? AND thread=?').run(this.scope, source.id);
          // Only validated numeric mirror sources reach this API. Their records
          // are bounded by the bridge protocol, not arbitrary raw log files.
          const records = source.records ?? fs.readFileSync(source.file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
          const state = newUsageState(source.id, records[0]?.payload);
          for (const record of records) {
            const event = acceptUsageRecord(state, record);
            if (!event) continue;
            this.add.run(this.scope, event.id, event.thread, event.provider, event.model, event.day, event.input, event.cached, event.cacheWrite, event.output, event.reasoning);
            round.run(this.scope, event.id, event.thread, epoch, String(state.turnId ?? '').split(':').at(-1), event.at,
              event.provider, event.model, event.input, event.cached, event.cacheWrite, event.output, event.reasoning);
          }
          const size = fs.statSync(source.file).size;
          this.save.run(this.scope, source.id, source.file, 'canonical-numeric', size, '', JSON.stringify(state), state.at || records[0]?.timestamp || 0);
        }
        save.run(this.scope, source.id, source.sessionKey, source.digest, titles.get(source.sessionKey) || '');
        origin.run(this.scope, source.id, epoch);
      }
      const update = this.db.prepare('UPDATE dsh_threads SET title=? WHERE home=? AND session_key=?');
      for (const [id, title] of titles) update.run(title, this.scope, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.epoch = mirror.epoch; this.history = mirror.history;
    this.currentIds = new Set(mirror.activeIds ?? mirror.sources.map(source => source.id));
    this.liveSessions = new Map(mirror.sessions.map(session => [session.sessionKey, session]));
  }
  // synchronized sources are already complete bounded transactions. Do not call
  // inherited recursive discovery over a growing archive mirror on every tick.
  scan() { this.pendingBytes = 0; }
  snapshot({ rules = [], selectedId = '', provider = '*' } = {}) {
    const snapshot = super.snapshot({ rules, provider }), filter = provider === '*' ? '' : "AND json_extract(f.state,'$.provider')=?";
    const args = [this.scope, ...(provider === '*' ? [] : [provider])];
    const rows = this.db.prepare(`WITH candidates AS (
      SELECT m.session_key,MAX(f.updated) newest FROM files f JOIN dsh_threads m ON f.home=m.home AND f.id=m.id
      WHERE f.home=? AND json_extract(f.state,'$.subagent')!=1 ${filter}
        AND EXISTS(SELECT 1 FROM events e WHERE e.home=f.home AND e.thread=f.id)
      GROUP BY m.session_key ORDER BY newest DESC LIMIT 200)
      SELECT f.state,m.session_key,m.title,COALESCE(o.origin_epoch,'') origin_epoch FROM files f
      JOIN dsh_threads m ON f.home=m.home AND f.id=m.id JOIN candidates c ON c.session_key=m.session_key
      LEFT JOIN dsh_origins o ON f.home=o.home AND f.id=o.id WHERE f.home=? ${filter}
        AND json_extract(f.state,'$.subagent')!=1 AND EXISTS(SELECT 1 FROM events e WHERE e.home=f.home AND e.thread=f.id)
      ORDER BY f.updated DESC`).all(...args, ...args);
    const groups = new Map();
    for (const row of rows) {
      let state; try { state = JSON.parse(row.state); } catch { continue; }
      let group = groups.get(row.session_key);
      if (!group) { group = { id: row.session_key, title: row.title || 'DSH 会话', shards: [] }; groups.set(row.session_key, group); }
      group.shards.push({ ...state, originEpoch: row.origin_epoch });
    }
    const accountRows = (id, roundEpoch = null, turn = null) => {
      const table = roundEpoch === null ? 'events' : 'dsh_rounds';
      return this.db.prepare(`SELECT e.provider,e.model,${columns} FROM ${table} e JOIN dsh_threads m ON e.home=m.home AND e.thread=m.id
        WHERE e.home=? AND m.session_key=? ${provider === '*' ? '' : 'AND e.provider=?'} ${roundEpoch === null ? '' : 'AND e.origin_epoch=? AND e.turn_id=?'} GROUP BY e.provider,e.model`)
        .all(this.scope, id, ...(provider === '*' ? [] : [provider]), ...(roundEpoch === null ? [] : [roundEpoch, turn]));
    };
    const details = [...groups.values()].map(group => {
      const counted = accountRows(group.id), live = this.liveSessions.get(group.id);
      const latest = this.db.prepare(`SELECT r.origin_epoch,r.turn_id,MAX(r.at) at FROM dsh_rounds r JOIN dsh_threads m ON r.home=m.home AND r.thread=m.id
        WHERE r.home=? AND m.session_key=? ${provider === '*' ? '' : 'AND r.provider=?'} GROUP BY r.origin_epoch,r.turn_id ORDER BY at DESC,CAST(r.turn_id AS INTEGER) DESC LIMIT 1`)
        .get(this.scope, group.id, ...(provider === '*' ? [] : [provider]));
      const recent = latest ? accountRows(group.id, latest.origin_epoch, latest.turn_id) : [];
      return { id: group.id, title: group.title, at: Math.max(...group.shards.map(state => state.at || 0)),
        provider: combined(counted.map(row => row.provider)), model: combined(counted.map(row => row.model)),
        total: sumUsage(counted), turnUsage: sumUsage(recent), turnCost: estimateCost(recent, rules),
        phase: live ? live.active ? 'running' : 'idle' : 'unknown',
        missingBaseline: group.shards.some(state => state.missingBaseline), counterReset: group.shards.some(state => state.counterReset),
        subagent: false, cost: estimateCost(counted, rules) };
    }).sort((a, b) => b.at - a.at).slice(0, 200);
    const selected = details.find(thread => thread.id === selectedId) ?? details[0] ?? null;
    return { ...snapshot, selectedId: selected?.id ?? '',
      sourceFiles: this.db.prepare('SELECT COUNT(*) count FROM files WHERE home=?').get(this.scope).count,
      threads: details.map(({ turnUsage, turnCost, cost, missingBaseline, counterReset, subagent, ...thread }) => thread), selected };
  }
}
