import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestRefresh } from '../runtime/refresh-client.mjs';
import { resolveBridgeRoot, readBridgeQuota, readBridgeSnapshot, readBridgeNumericLogs } from '../runtime/companion-bridge.mjs';
import { normalizeHostSource, readUsageSource } from '../runtime/host-source.mjs';
import { CompanionCompletionMonitor } from '../runtime/companion-completion-monitor.mjs';
import { syncCompanionLedgerSource } from '../runtime/companion-ledger-source.mjs';
import { UsageService } from '../src/core/usage-service.mjs';
import { DshUsageLedger } from '../src/core/dsh-usage-ledger.mjs';
import { formatQuota } from '../src/core/quota.mjs';
import { mergeUsageSnapshot } from '../runtime/refresh-queue.mjs';
import { localDay, newUsageState } from '../runtime/session-usage.mjs';
import { PRODUCER, unknownQuota, MAX_SNAPSHOT_BYTES } from '../shared/bridge-protocol.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-runtime-'));
  t.after(async () => { for (const dispose of f.disposers) await dispose(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const root = path.join(directory, 'bridge'), config = { bridgeRoot: root }, now = Date.now();
  fs.mkdirSync(path.join(root, 'numeric-logs', 'sessions'), { recursive: true });
  const f = { directory, root, config, now, epoch: randomUUID(), instanceId: randomUUID(), key: 'a'.repeat(64), account: 'b'.repeat(64), seq: 0, logs: [], disposers: [] };
  f.envelope = (ttl = 20000) => ({ schemaVersion: 1, producer: PRODUCER, instanceId: f.instanceId, epoch: f.epoch, revision: 1, lastSeenAt: f.now, expiresAt: f.now + ttl, hostActive: true });
  f.status = () => ({ ok: true, queryOk: true, source: 'dsh', observedAt: f.now, accountKey: f.account, plan: 'plus', planLabel: 'Plus', planKnown: true, planSource: 'rateLimits', authType: 'oauth', windows: [{ label: '5 小时', minutes: 300, used: 17, remaining: 83, resetsAt: Math.floor(f.now / 1000) + 3600 }] });
  f.write = (name, value) => fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value));
  f.host = () => ({ ...f.envelope(), profile: 'desktop', connected: true, accountKey: f.account, numericLogs: f.logs });
  f.completion = () => ({ ...f.envelope(), seq: f.seq, sessions: [{ sessionKey: f.key, title: 'DSH 会话 1', active: true, updatedAt: f.now, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 } }], completion: f.seq ? { seq: f.seq, sessionKey: f.key, turn: f.seq, completedAt: f.now } : null });
  f.publish = () => { f.write('host', f.host()); f.write('quota', { ...f.envelope(90000), status: f.status() }); f.write('completion', f.completion()); };
  f.numeric = (input = 100, output = 20, { logId = f.key, sessionKey = f.key, provider = 'unknown', model = 'unknown', source = 'dsh', append = false } = {}) => {
    const total = { input_tokens: input, output_tokens: output, cached_input_tokens: 30, cache_write_input_tokens: 10, reasoning_output_tokens: 0 };
    const records = [
      { timestamp: f.now - 1000, type: 'session_meta', payload: { id: logId, session_key: sessionKey, origin: PRODUCER, epoch: f.epoch, model_provider: provider, source } },
      { timestamp: f.now - 900, type: 'turn_context', payload: { model, model_provider: provider, turn_id: '1' } },
      { timestamp: f.now - 800, type: 'event_msg', payload: { type: 'task_started', turn_id: '1' } },
      { timestamp: f.now - 700, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: total } } },
      { timestamp: f.now - 600, type: 'event_msg', payload: { type: 'task_complete', turn_id: '1' } },
    ];
    const file = f.epoch + '-' + logId + '.jsonl', text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(root, 'numeric-logs', 'sessions', file), text);
    const entry = { file, bytes: Buffer.byteLength(text), sessionKey };
    f.logs = append ? [...f.logs.filter(log => log.file !== file), entry] : [entry]; return records;
  };
  f.publish(); return f;
}

test('DSH is default and root/profile resolution never falls back to Codex or accepts traversal', async t => {
  const f = fixture(t);
  assert.equal(normalizeHostSource(), 'dsh'); assert.equal(normalizeHostSource('bad'), 'dsh'); assert.equal(normalizeHostSource('codex'), 'codex');
  assert.equal(resolveBridgeRoot({ dshHome: f.directory }, { DSH_PROFILE: 'isolated' }), path.join(f.directory, 'state', 'dsh-gpt-companion', 'isolated'));
  assert.throws(() => resolveBridgeRoot({ dshHome: f.directory, dshProfile: '../auth' }));
  assert.throws(() => resolveBridgeRoot({ bridgeRoot: 'relative' }));
  const quota = await readUsageSource(f.config, { spawnProcess: () => { throw Error('must not launch'); } });
  assert.equal(quota.source, 'dsh'); assert.equal(quota.windows[0].remaining, 83);
});

test('successful normalized quotas preserve percentages; missing, expired, unlogged-in and error states stay unknown', t => {
  const f = fixture(t), good = readBridgeQuota(f.config, f.now);
  assert.equal(good.ok, true); assert.equal(good.windows[0].used, 17);
  const unknown = q => {
    assert.equal(q.ok, false); assert.equal(q.queryOk, false); assert.deepEqual(q.windows, []); assert.equal(q.clearPrevious, true);
    assert.ok(formatQuota(q).rows.every(row => row.leftText === '—'));
  };
  unknown(readBridgeQuota(f.config, f.now + 20001));
  f.write('host', { ...f.host(), connected: false, accountKey: null, numericLogs: [] }); unknown(readBridgeQuota(f.config, f.now));
  f.publish(); f.write('quota', { ...f.envelope(90000), status: unknownQuota('AUTH_REQUIRED', f.now) }); unknown(readBridgeQuota(f.config, f.now));
  f.write('quota', { ...f.envelope(90000), status: { ...f.status(), windows: [{ ...good.windows[0], resetsAt: Math.floor(f.now / 1000) }] } }); unknown(readBridgeQuota(f.config, f.now));
  f.write('quota', { ...f.envelope(90000), status: { ...f.status(), error: 'upstream secret raw error' } }); unknown(readBridgeQuota(f.config, f.now));
  fs.unlinkSync(path.join(f.root, 'host.json')); unknown(readBridgeQuota(f.config, f.now));
});

test('account/epoch mismatches and malformed or oversized snapshots cannot reuse previous successful quota', t => {
  const f = fixture(t), previous = readBridgeQuota(f.config, f.now);
  f.write('quota', { ...f.envelope(90000), status: { ...f.status(), accountKey: 'c'.repeat(64) } });
  let next = readBridgeQuota(f.config, f.now);
  assert.equal(next.errorCode, 'ACCOUNT_CHANGED'); assert.equal(mergeUsageSnapshot(previous, next).ok, false);
  f.write('quota', { ...f.envelope(90000), epoch: randomUUID(), status: f.status() }); assert.equal(readBridgeQuota(f.config, f.now).ok, false);
  f.publish(); fs.writeFileSync(path.join(f.root, 'quota.json'), ' '.repeat(MAX_SNAPSHOT_BYTES + 1)); assert.equal(readBridgeQuota(f.config, f.now).ok, false);
  f.publish(); f.write('host', { ...f.host(), credentials: 'not-accepted' }); assert.equal(readBridgeQuota(f.config, f.now).ok, false);
  assert.equal(mergeUsageSnapshot({ ...previous, source: 'official' }, { ...previous, ok: false, queryOk: false, clearPrevious: false }).ok, false);
});

test('symlink/reparse directory redirection is rejected without reading its snapshots', t => {
  const f = fixture(t), link = path.join(f.directory, 'redirect');
  fs.symlinkSync(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readBridgeQuota({ bridgeRoot: link }, f.now).ok, false);
  assert.throws(() => readBridgeSnapshot({ bridgeRoot: link }, 'completion', f.now));
});

test('only listed bounded numeric logs are canonicalized; extra files, bodies, DBs, and traversal are not inputs', t => {
  const f = fixture(t); f.numeric(); f.publish();
  fs.writeFileSync(path.join(f.root, 'auth.json'), 'DO_NOT_READ_CREDENTIALS');
  fs.writeFileSync(path.join(f.root, 'state_5.sqlite'), 'DO_NOT_READ_DATABASE');
  fs.writeFileSync(path.join(f.root, 'numeric-logs', 'sessions', 'not-listed.jsonl'), 'PRIVATE_CONVERSATION');
  const result = readBridgeNumericLogs(f.config, f.now);
  assert.equal(result.logs.length, 1); assert.equal(result.logs[0].records[0].payload.origin, PRODUCER);
  const mirror = syncCompanionLedgerSource(path.join(f.directory, 'state'), f.config, f.now);
  assert.equal(fs.readdirSync(path.join(mirror.home, 'sessions')).length, 1);
  const mirrorText = fs.readFileSync(path.join(mirror.home, 'sessions', f.logs[0].file), 'utf8');
  assert.ok(!/PRIVATE|CREDENTIALS|DATABASE/.test(mirrorText));
  const contaminated = result.logs[0].records; contaminated[1].payload.prompt = 'PRIVATE_CONVERSATION';
  const text = contaminated.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(f.root, 'numeric-logs', 'sessions', f.logs[0].file), text); f.logs[0].bytes = Buffer.byteLength(text); f.publish();
  assert.throws(() => readBridgeNumericLogs(f.config, f.now));
  f.write('host', { ...f.host(), numericLogs: [{ file: '../auth.json', bytes: 10 }] }); assert.throws(() => readBridgeNumericLogs(f.config, f.now));
});

test('completion monitor baselines epochs, deduplicates sequence and fences disconnect and restart history', t => {
  const f = fixture(t), events = [], stateFile = path.join(f.directory, 'cursor.json');
  f.seq = 5; f.publish();
  const monitor = new CompanionCompletionMonitor({ config: f.config, stateFile, now: () => f.now, onNotification: e => events.push(e) });
  monitor.scan(); assert.equal(events.length, 0);
  f.seq = 6; f.publish(); monitor.scan(); monitor.scan(); assert.equal(events.length, 1); assert.equal(events[0].turnId, '6');
  const resumed = new CompanionCompletionMonitor({ config: f.config, stateFile, now: () => f.now, onNotification: e => events.push(e) });
  resumed.scan(); assert.equal(events.length, 1);
  f.seq = 7; f.publish(); resumed.scan(); assert.equal(events.length, 2);
  f.epoch = randomUUID(); f.seq = 1; f.publish(); resumed.scan(); assert.equal(events.length, 2);
  f.seq = 2; f.publish(); resumed.scan(); assert.equal(events.length, 3);
  f.now += 25000; resumed.scan(); f.publish(); resumed.scan(); assert.equal(events.length, 3);
  f.seq = 3; f.publish(); resumed.scan(); assert.equal(events.length, 4);
  assert.ok(events.every(event => event.source === 'dsh' && event.type === 'completion'));
});

test('numeric mirror feeds inherited ledger and uses epoch scopes without inferring quota or prices', t => {
  const f = fixture(t); f.numeric(); f.publish(); const dataDir = path.join(f.directory, 'state');
  const mirror = syncCompanionLedgerSource(dataDir, f.config, f.now), ledger = new DshUsageLedger({ dataDir, codexHome: mirror.home });
  f.disposers.push(() => ledger.close()); ledger.synchronize(mirror); ledger.scan(); ledger.scan();
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.all.input, 100); assert.equal(snapshot.all.output, 20); assert.equal(snapshot.all.cached, 30); assert.equal(snapshot.all.cacheWrite, 10);
  assert.deepEqual(snapshot.all.cost.amounts, []); assert.equal(snapshot.all.cost.unpricedTokens, 120);
  f.epoch = randomUUID(); f.logs = []; f.publish();
  assert.equal(syncCompanionLedgerSource(dataDir, f.config, f.now).home, mirror.home);
  f.account = 'd'.repeat(64); f.publish();
  assert.notEqual(syncCompanionLedgerSource(dataDir, f.config, f.now).home, mirror.home);
});

test('real model shards aggregate into one session, corrections replace charges, and reconnect/eviction retain history', t => {
  const f = fixture(t), dataDir = path.join(f.directory, 'durable');
  f.numeric(100, 20, { provider: 'openai-codex', model: 'gpt-5' });
  f.numeric(200, 40, { logId: 'e'.repeat(64), provider: 'relay', model: 'model-2', append: true }); f.publish();
  let mirror = syncCompanionLedgerSource(dataDir, f.config, f.now);
  let ledger = new DshUsageLedger({ dataDir, codexHome: mirror.home }); f.disposers.push(() => ledger.close());
  const refresh = () => { mirror = syncCompanionLedgerSource(dataDir, f.config, f.now); ledger.synchronize(mirror); ledger.scan(); return ledger.snapshot(); };
  let view = refresh(); assert.equal(view.all.input, 300); assert.equal(view.threads.length, 1); assert.equal(view.selected.id, f.key); assert.equal(view.selected.total.input, 300); assert.equal(view.selected.model, 'multiple');
  assert.deepEqual(new Set(view.providers), new Set(['openai-codex', 'relay']));
  // A corrected same-shard timeline must revoke its old 200-token charge.
  f.numeric(150, 30, { logId: 'e'.repeat(64), provider: 'relay', model: 'model-2', append: true }); f.publish();
  view = refresh(); assert.equal(view.all.input, 250); assert.equal(view.selected.total.input, 250); assert.equal(refresh().all.input, 250);
  const filtered = ledger.snapshot({ provider: 'relay' }); assert.equal(filtered.selected.total.input, 150); assert.equal(filtered.all.input, 150);
  // Eviction removes mirror files but not accounted history or session metadata.
  f.logs = []; f.publish(); view = refresh(); assert.equal(view.all.input, 250); assert.equal(view.threads.length, 1);
  ledger.close(); ledger = new DshUsageLedger({ dataDir, codexHome: mirror.home });
  view = refresh(); assert.equal(view.all.input, 250);
  // New epoch exports a new baseline delta, not a replacement of old history.
  f.epoch = randomUUID(); f.numeric(80, 10, { provider: 'openai-codex', model: 'gpt-5' }); f.publish();
  view = refresh(); assert.equal(view.all.input, 330); assert.equal(view.selected.total.input, 330); assert.equal(view.threads.length, 1);
  const priced = ledger.snapshot({ rules: [ { provider: 'openai-codex', model: 'gpt-5', currency: 'USD', input: '1', cached: '1', cacheWrite: '1', output: '1' } ] });
  assert.equal(priced.selected.cost.unpricedTokens, 180); assert.equal(priced.selected.cost.amounts.length, 1);
});

test('subagent numeric costs are included without inventing a main-session card', t => {
  const f = fixture(t), dataDir = path.join(f.directory, 'subagent-state');
  f.numeric(); f.numeric(70, 5, { logId: 'f'.repeat(64), sessionKey: 'e'.repeat(64), source: 'subagent', append: true }); f.publish();
  const mirror = syncCompanionLedgerSource(dataDir, f.config, f.now), ledger = new DshUsageLedger({ dataDir, codexHome: mirror.home });
  f.disposers.push(() => ledger.close()); ledger.synchronize(mirror); ledger.scan();
  const view = ledger.snapshot(); assert.equal(view.all.input, 170); assert.equal(view.threads.length, 1); assert.equal(view.selected.total.input, 100);
});

test('only the latest 200 main sessions are public selection candidates while all and today retain every event', t => {
  const f = fixture(t), dataDir = path.join(f.directory, 'bounded-view');
  const mirror = syncCompanionLedgerSource(dataDir, f.config, f.now), ledger = new DshUsageLedger({ dataDir, codexHome: mirror.home });
  f.disposers.push(() => ledger.close());
  const remember = ledger.db.prepare('INSERT INTO dsh_threads VALUES(?,?,?,?,?)'), ids = [];
  ledger.db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < 205; index++) {
      const id = index.toString(16).padStart(64, '0'); ids.push(id);
      const state = { ...newUsageState(id, { model_provider: 'relay' }), model: 'model-1', at: f.now + index,
        total: { input: 10, cached: 0, cacheWrite: 0, output: 2, reasoning: 0, total: 12 } };
      remember.run(ledger.scope, id, id, 'fixture-digest', 'DSH 会话 ' + index);
      ledger.save.run(ledger.scope, id, path.join(mirror.home, 'sessions', id + '.jsonl'), 'fixture', 0, '', JSON.stringify(state), state.at);
      ledger.add.run(ledger.scope, 'event-' + id, id, 'relay', 'model-1', localDay(f.now), 10, 0, 0, 2, 0);
    }
    ledger.db.exec('COMMIT');
  } catch (error) { ledger.db.exec('ROLLBACK'); throw error; }
  const view = ledger.snapshot({ selectedId: ids[0] });
  assert.equal(view.threads.length, 200); assert.equal(view.threads[0].id, ids[204]); assert.equal(view.threads.at(-1).id, ids[5]);
  assert.ok(!view.threads.some(thread => thread.id === ids[0]));
  assert.equal(view.selectedId, ids[204]); assert.equal(view.selected.id, ids[204]);
  assert.equal(ledger.snapshot({ selectedId: ids[5] }).selected.id, ids[5]);
  assert.equal(view.all.input, 2050); assert.equal(view.all.output, 410); assert.equal(view.today.input, 2050); assert.equal(view.today.output, 410);
});

async function closeService(service) {
  const worker = service.worker; if (!worker) return;
  const exited = once(worker, 'exit'); service.close(); worker.ref(); await exited;
}
test('usage worker reads DSH numeric exports, clears data after account failure, and retains manual Codex selection', async t => {
  const f = fixture(t); f.numeric(); f.publish();
  const service = new UsageService({ dataDir: path.join(f.directory, 'worker-state'), hostSource: 'dsh', ...f.config });
  f.disposers.push(() => closeService(service));
  const initial = await service.request('refresh');
  assert.equal(initial.source, 'dsh'); assert.equal(initial.snapshot.all.input, 100); assert.equal(initial.snapshot.threads[0].title, 'DSH 会话 1');
  f.write('host', { ...f.host(), connected: false, accountKey: null, numericLogs: [] });
  await assert.rejects(service.request('refresh'), /DSH/); assert.equal(service.value.snapshot, null);
  const codex = path.join(f.directory, 'selected-codex'); fs.mkdirSync(path.join(codex, 'sessions'), { recursive: true });
  const selected = await service.request('save', { codexHome: codex, rules: [] }); assert.equal(selected.source, 'codex'); assert.equal(selected.snapshot.home, codex);
  f.publish(); const restored = await service.request('save', { codexHome: null, rules: [] }); assert.equal(restored.source, 'dsh'); assert.equal(restored.snapshot.all.input, 100);
  await closeService(service);
});

test('actual quota worker defaults to DSH without a Codex executable and invalidates disconnected snapshots', async t => {
  const f = fixture(t), dataDir = path.join(f.directory, 'watch-state'), configPath = path.join(f.directory, 'installation.json');
  fs.mkdirSync(dataDir); const config = { dataDir, ...f.config }; fs.writeFileSync(configPath, JSON.stringify(config));
  let child;
  const startWorker = () => { if (!child) child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/watch.mjs', import.meta.url)), configPath, '0'], { windowsHide: true, stdio: 'ignore' }); };
  f.disposers.push(async () => { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const options = { startWorker, timeoutMs: 5000, pollMs: 20 };
  const good = await requestRefresh(config, configPath, options); assert.equal(good.source, 'dsh'); assert.equal(good.windows[0].remaining, 83);
  f.write('host', { ...f.host(), connected: false, accountKey: null, numericLogs: [] });
  const offline = await requestRefresh(config, configPath, options); assert.equal(offline.ok, false); assert.deepEqual(offline.windows, []); assert.equal(offline.clearPrevious, true);
});

test('main preserves upstream features while using independent identity and host APIs', () => {
  const source = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  for (const token of ['DSHGPTCompanion', '.dsh-gpt-companion', 'DSHDragon.Native.exe', 'native.isHost(', 'native.findHost(', 'native.activateHost(', "name==='host-source'", 'config.hostSource', 'readBridgeQuota(config)', 'companion-completion-monitor.mjs', 'new AudioStore(', 'new Characters(', 'setMusic(', 'taskCompletionBubble', 'UsageService', '选择 Codex 数据目录']) assert.ok(source.includes(token), token);
  assert.ok(!/GPTNiang|baseline-1\.3\.5/.test(source));
  const worker = fs.readFileSync(new URL('../runtime/worker-state.mjs', import.meta.url), 'utf8'); assert.ok(!worker.includes('gpt-niang-usage-')); assert.ok(worker.includes('dsh-gpt-companion-'));
});
