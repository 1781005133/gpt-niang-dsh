import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createBridgeHost } from '../../bridge/src/host.mjs';
import { CompanionArchiveReader } from '../runtime/companion-archive.mjs';
import { syncCompanionLedgerSource } from '../runtime/companion-ledger-source.mjs';
import { readBridgeHost, readBridgeSnapshot } from '../runtime/companion-bridge.mjs';
import { DshUsageLedger } from '../src/core/dsh-usage-ledger.mjs';
import { UsageService } from '../src/core/usage-service.mjs';
import { MAX_LOG_BYTES, PRODUCER, parseArchiveFileName } from '../shared/bridge-protocol.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = (input = 0, output = 0, read = 0, write = 0) => ({ uncachedInputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write });
const price = (provider, model, input = '1') => ({ provider, model, currency: 'USD', input, cached: input, cacheWrite: input, output: input });
const prices = [price('openai-codex', 'gpt-5'), price('relay', 'model-2', '2')];

async function fixture(t, { archiveOptions = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-archive-')), account = 'a'.repeat(64), disposers = [];
  let clock = Date.now(), host, lease, projectionSeq, currentAccount = account;
  const usage = new Map();
  const session = (id, subagent = false) => ({ id, header: { version: 4, ...(subagent ? { origin: 'subagent' } : {}) }, firstLiveSeq: 0 });
  const status = () => ({ ok: true, queryOk: true, source: 'dsh', observedAt: clock, accountKey: currentAccount, plan: 'plus', planLabel: 'Plus', planKnown: true, planSource: 'rateLimits', authType: 'oauth', windows: [{ label: '5 小时', minutes: 300, used: 30, remaining: 70, resetsAt: Math.floor(clock / 1000) + 3600 }] });
  const make = async () => {
    host = createBridgeHost({ dshHome: directory, now: () => clock, archiveOptions, setRepeater: () => ({ unref() {} }), clearRepeater() {},
      readProjection: s => ({ values: { tokenUsage: usage.get(s.id) ?? raw(), title: { title: 'DSH public session' } } }) });
    lease = host.acquire().value.leaseId; projectionSeq = 0;
    assert.equal(host.project({ leaseId: lease, seq: ++projectionSeq, status: status() }).ok, true);
    await host.archive.ready; host.heartbeat();
  };
  await make();
  const config = { bridgeRoot: host.root };
  t.after(async () => { for (const dispose of disposers) await dispose(); host.dispose(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const emit = (s, seq, type, data) => { clock++; host.event(s, { seq, time: clock, type, data }); };
  const importer = (options = {}, stateName = 'desktop-state') => {
    const dataDir = path.join(directory, stateName), reader = new CompanionArchiveReader({ rescanMs: 0, timeBudgetMs: 100, ...options }); let ledger = null;
    disposers.push(() => { reader.close(); ledger?.close(); });
    const tick = () => {
      const mirror = syncCompanionLedgerSource(dataDir, config, clock, { archiveReader: reader });
      if (ledger?.home !== mirror.home) { ledger?.close(); ledger = new DshUsageLedger({ dataDir: path.join(dataDir, 'db', mirror.accountKey), codexHome: mirror.home }); }
      ledger.synchronize(mirror); ledger.scan(); return { mirror, snapshot: ledger.snapshot({ rules: prices }), ledger };
    };
    const drain = () => { let value; for (let pass = 0; pass < 1000; pass++) { value = tick(); if (!value.mirror.history.pending) return value; } throw Error('Archive failed to finish its bounded scan'); };
    return { tick, drain, reader, close() { reader.close(); ledger?.close(); ledger = null; }, ledger: () => ledger };
  };
  return { directory, config, account, disposers, session, usage, emit, importer, now: () => clock, host: () => host,
    async flush() { await host.archive.ready; host.heartbeat(); },
    async restart() { host.dispose(); clock++; await make(); },
    switchAccount(key) { currentAccount = key; clock++; host.project({ leaseId: lease, seq: ++projectionSeq, status: status() }); host.heartbeat(); },
    advance(ms) { clock += ms; host.project({ leaseId: lease, seq: ++projectionSeq, status: status() }); },
  };
}
function assertViews(snapshot, input, output, cost, recentInput = input, recentOutput = output) {
  assert.equal(snapshot.threads.length, 1); assert.equal(snapshot.selected.total.input, input); assert.equal(snapshot.selected.total.output, output);
  assert.equal(snapshot.selected.turnUsage.input, recentInput); assert.equal(snapshot.selected.turnUsage.output, recentOutput);
  assert.equal(snapshot.all.input, input); assert.equal(snapshot.today.input, input); assert.equal(snapshot.all.output, output); assert.equal(snapshot.today.output, output);
  assert.deepEqual(snapshot.selected.cost, snapshot.all.cost); assert.deepEqual(snapshot.today.cost, snapshot.all.cost);
  assert.equal(snapshot.all.cost.unpricedTokens, 0); assert.equal(snapshot.all.cost.amounts[0].amount, cost);
}

test('closed-panel 121-settlement same-turn rotation imports once across active/archive and every view excludes carry', async t => {
  const f = await fixture(t), main = f.session('same-turn-segments'); f.host().created(main); f.emit(main, 1, 'turn/start', { turn: 7 });
  for (let step = 0; step < 121; step++) { f.usage.set(main.id, raw(step + 1, step + 1)); f.emit(main, step + 2, 'assistant/message', { turn: 7, step, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); }
  await f.flush();
  assert.equal(readBridgeHost(f.config, f.now()).numericLogs.length, 1);
  assert.equal(readBridgeSnapshot(f.config, 'archive-status', f.now()).snapshot.archive.totalFiles, 2);
  const importer = f.importer({ entryBudget: 1 }); let first = importer.tick(); assert.equal(first.mirror.history.pending, true);
  const view = importer.drain(); assertViews(view.snapshot, 121, 121, '0.000242'); assert.equal(view.snapshot.selected.turnCost.amounts[0].amount, '0.000242');
  assert.equal(view.snapshot.selected.phase, 'running'); assert.equal(view.snapshot.sourceFiles, 2);
  assertViews(importer.drain().snapshot, 121, 121, '0.000242');
  importer.close(); const recovered = f.importer({}, 'desktop-state').drain(); assertViews(recovered.snapshot, 121, 121, '0.000242');
});

test('host/epoch restart returns archives, excludes a new inherited official baseline and keeps recent-turn values exact', async t => {
  const f = await fixture(t), main = f.session('restart-main'); f.host().created(main);
  f.usage.set(main.id, raw(10, 2)); f.emit(main, 1, 'assistant/message', { turn: 9, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush();
  const before = f.importer(); assertViews(before.drain().snapshot, 10, 2, '0.000012'); before.close();
  await f.restart(); const oldArchive = f.importer({}, 'after-restart'); assertViews(oldArchive.drain().snapshot, 10, 2, '0.000012');
  f.usage.set(main.id, raw(1000, 500)); f.host().created(main); // official baseline is inherited, not fresh spending
  f.usage.set(main.id, raw(1005, 502)); f.emit(main, 1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush();
  const view = oldArchive.drain().snapshot; assertViews(view, 15, 4, '0.000019', 5, 2); assert.equal(view.selected.turnCost.amounts[0].amount, '0.000007');
  assert.equal(view.sourceFiles, 2); assertViews(oldArchive.drain().snapshot, 15, 4, '0.000019', 5, 2);
});

test('unknown-to-known canonical tombstone retracts tokens, fees and labels in main/recent/all/today views', async t => {
  const f = await fixture(t), main = f.session('corrected-route'); f.host().created(main);
  f.usage.set(main.id, raw(10, 2)); f.emit(main, 1, 'assistant/attempt', { turn: 0, step: 0 }); await f.flush();
  const importer = f.importer(), initial = importer.drain().snapshot; assert.equal(initial.selected.model, 'unknown'); assert.equal(initial.all.cost.unpricedTokens, 12);
  f.usage.set(main.id, raw(12, 3)); f.emit(main, 2, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush();
  const corrected = importer.drain().snapshot; assertViews(corrected, 12, 3, '0.000015'); assert.deepEqual(corrected.providers, ['openai-codex']); assert.equal(corrected.selected.model, 'gpt-5'); assert.equal(corrected.selected.provider, 'openai-codex');
  f.usage.set(main.id, raw(20, 5)); f.emit(main, 3, 'assistant/message', { turn: 0, step: 1, message: { source: { provider: 'relay', model: 'model-2' } } }); await f.flush();
  const multi = importer.drain(); assertViews(multi.snapshot, 20, 5, '0.000035'); assert.equal(multi.snapshot.selected.model, 'multiple');
  const relay = multi.ledger.snapshot({ provider: 'relay', rules: prices }); assert.equal(relay.selected.total.input, 8); assert.equal(relay.all.input, 8); assert.equal(relay.selected.turnUsage.input, 8); assert.equal(relay.all.cost.amounts[0].amount, '0.000020');
});

test('65 closed-panel sessions survive active eviction and the reader visits only a bounded flat batch', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 65; index++) { const main = f.session('evicted-' + index); f.host().created(main); f.usage.set(main.id, raw(1, 0)); f.emit(main, 1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); }
  await f.flush(); const importer = f.importer({ entryBudget: 8 }); let rounds = 0, value;
  do { value = importer.tick(); rounds++; assert.ok(value.mirror.history.batchEntries <= 8); assert.ok(value.mirror.history.batchBytes <= 1024 * 1024); } while (value.mirror.history.pending && rounds < 100);
  assert.ok(rounds > 1); assert.equal(value.snapshot.all.input, 65); assert.equal(value.snapshot.today.input, 65); assert.equal(value.snapshot.threads.length, 65); assert.equal(value.snapshot.sourceFiles, 65);
  assert.equal(value.snapshot.all.cost.amounts[0].amount, '0.000065'); assert.equal(value.mirror.history.gap, false);
});

test('account isolation never reads old-account archives and account failure prevents any import', async t => {
  const f = await fixture(t), main = f.session('private-account-a'); f.host().created(main); f.usage.set(main.id, raw(5, 1)); f.emit(main, 1, 'assistant/message', { turn: 1, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush();
  const importer = f.importer(); assertViews(importer.drain().snapshot, 5, 1, '0.000006');
  f.switchAccount('b'.repeat(64)); const other = importer.drain(); assert.equal(other.snapshot.all.input, 0); assert.equal(other.snapshot.threads.length, 0); assert.equal(other.mirror.accountKey, 'b'.repeat(64)); assert.equal(other.mirror.history.gap, false);
  f.switchAccount(f.account); assertViews(importer.drain().snapshot, 5, 1, '0.000006');
  f.host().invalidate('NO_ACCOUNT'); assert.throws(() => importer.tick(), /Disconnected|account/);
});

test('canonical inherited counters are not billed or displayed as fresh tokens, even in the first shard baseline', async t => {
  const f = await fixture(t), host = readBridgeHost(f.config, f.now()), logId = hash('inherited-route'), sessionKey = hash('inherited-session');
  const usage = input => ({ input_tokens: input, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 });
  const records = [
    { timestamp: f.now(), type: 'session_meta', payload: { id: logId, session_key: sessionKey, origin: PRODUCER, epoch: host.epoch, model_provider: 'openai-codex', source: 'dsh' } },
    { timestamp: f.now(), type: 'turn_context', payload: { model_provider: 'openai-codex', model: 'gpt-5', turn_id: '3' } },
    { timestamp: f.now(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(120), last_token_usage: usage(0) } } },
    { timestamp: f.now() + 1, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(121), last_token_usage: usage(1) } } },
  ];
  const name = host.epoch + '-' + logId + '.jsonl'; f.host().archive.write(f.account, name, records.map(record => JSON.stringify(record)).join('\n') + '\n'); await f.flush();
  const view = f.importer().drain().snapshot; assertViews(view, 1, 0, '0.000001'); assert.equal(view.selected.missingBaseline, true);
});

test('byte/time budgets report pending, canonical rewrites are revisited and invalid entries are never recursively opened', async t => {
  for (const options of [{ entryBudget: 0 }, { entryBudget: 129 }, { byteBudget: MAX_LOG_BYTES - 1 }, { byteBudget: NaN }, { timeBudgetMs: NaN }, { rescanMs: -1 }]) assert.throws(() => new CompanionArchiveReader(options), /BUDGET/);
  const f = await fixture(t), main = f.session('bounded-update'); f.host().created(main); f.usage.set(main.id, raw(3, 1)); f.emit(main, 1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush();
  let counter = 0; const importer = f.importer({ entryBudget: 128, timeBudgetMs: 20, monotonic: () => { counter += 10; return counter; } });
  const first = importer.tick(); assert.ok(first.mirror.history.batchEntries <= 1); assert.equal(first.mirror.history.pending, true); assertViews(importer.drain().snapshot, 3, 1, '0.000004');
  f.usage.set(main.id, raw(7, 2)); f.emit(main, 2, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush(); assertViews(importer.drain().snapshot, 7, 2, '0.000009');
  const accountDir = path.join(f.config.bridgeRoot, 'archive', f.account); fs.mkdirSync(path.join(accountDir, 'raw-conversations')); fs.writeFileSync(path.join(accountDir, 'raw-conversations', 'auth.json'), 'NEVER_READ');
  const result = importer.drain(); assert.equal(result.mirror.history.gap, true); assert.ok(result.mirror.history.message.includes('缺口')); assert.equal(result.snapshot.all.input, 7);
});

test('numeric byte budgets pause before a second large file and never silently truncate its import', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const main = f.session('byte-' + index); f.host().created(main); f.usage.set(main.id, raw(1, 0)); f.emit(main, 1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } });
  }
  const names = fs.readdirSync(path.join(f.config.bridgeRoot, 'archive', f.account)).filter(name => name.endsWith('.jsonl'));
  for (const name of names) {
    const file = path.join(f.config.bridgeRoot, 'archive', f.account, name), text = fs.readFileSync(file, 'utf8');
    // JSON whitespace is legal; canonical mirror serialization strips it. It
    // lets this test exercise the real byte bound without adding private fields.
    const padded = text.replace('\n', ' '.repeat(180000) + '\n'); assert.ok(Buffer.byteLength(padded) < MAX_LOG_BYTES);
    assert.equal(f.host().archive.write(f.account, name, padded), true);
  }
  await f.flush(); const importer = f.importer({ byteBudget: MAX_LOG_BYTES });
  const first = importer.tick(); assert.ok(first.mirror.history.batchBytes <= MAX_LOG_BYTES); assert.equal(first.mirror.history.pending, true);
  const complete = importer.drain(); assert.equal(complete.snapshot.all.input, 2); assert.equal(complete.snapshot.today.input, 2); assert.equal(complete.snapshot.all.cost.amounts[0].amount, '0.000002');
  assert.equal(complete.mirror.history.gap, false);
});

test('archived subagent costs join the total but never become a main card or contaminate parent recent-turn values', async t => {
  const f = await fixture(t), main = f.session('parent'), child = f.session('child', true);
  f.host().created(main); f.usage.set(main.id, raw(2, 1)); f.emit(main, 1, 'assistant/message', { turn: 1, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } });
  f.host().created(child); f.usage.set(child.id, raw(3, 1)); f.emit(child, 1, 'assistant/message', { turn: 1, step: 0, message: { source: { provider: 'relay', model: 'model-2' } } }); await f.flush(); await f.restart();
  const view = f.importer().drain().snapshot; assert.equal(view.threads.length, 1); assert.equal(view.selected.id, hash(main.id)); assert.equal(view.selected.total.input, 2); assert.equal(view.selected.turnUsage.input, 2);
  assert.equal(view.all.input, 5); assert.equal(view.today.input, 5); assert.equal(view.all.output, 2); assert.equal(view.selected.cost.amounts[0].amount, '0.000003'); assert.equal(view.all.cost.amounts[0].amount, '0.000011');
});

test('oversized/symlink archives and sticky collection failures remain explicit gaps, not fake complete totals', async t => {
  const f = await fixture(t, { archiveOptions: { maxFiles: 1 } }), main = f.session('limit-a'); f.host().created(main); f.usage.set(main.id, raw(2, 0)); f.emit(main, 1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } });
  const second = f.session('limit-b'); f.host().created(second); f.usage.set(second.id, raw(3, 0)); f.emit(second, 1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush();
  const importer = f.importer(), result = importer.drain(); assert.equal(result.mirror.history.gap, true); assert.equal(result.mirror.history.errorCode, 'BUDGET_EXCEEDED'); assert.equal(result.snapshot.all.input, 5);
  const dir = path.join(f.config.bridgeRoot, 'archive', f.account), bad = readBridgeHost(f.config, f.now()).epoch + '-' + hash('oversized') + '.jsonl'; fs.writeFileSync(path.join(dir, bad), ' '.repeat(MAX_LOG_BYTES + 1));
  assert.equal(importer.drain().mirror.history.gap, true);
  const linked = readBridgeHost(f.config, f.now()).epoch + '-' + hash('linked') + '.jsonl', outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'untouched'), 'original'); fs.symlinkSync(outside, path.join(dir, linked), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(importer.drain().mirror.history.gap, true); assert.deepEqual(fs.readdirSync(outside), ['untouched']);
  const moved = dir + '-saved'; assert.ok(path.isAbsolute(dir) && dir.startsWith(f.config.bridgeRoot + path.sep));
  fs.renameSync(dir, moved); fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
  const redirected = importer.drain(); assert.equal(redirected.mirror.history.gap, true); assert.equal(redirected.snapshot.all.input, 5); assert.deepEqual(fs.readdirSync(outside), ['untouched']);
});

test('usage worker backfills archives on panel open, exposes history status and clears old account data on failure', async t => {
  const f = await fixture(t), main = f.session('worker-closed'); f.host().created(main); f.usage.set(main.id, raw(8, 2)); f.emit(main, 1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'openai-codex', model: 'gpt-5' } } }); await f.flush(); await f.restart();
  const service = new UsageService({ dataDir: path.join(f.directory, 'worker-state'), hostSource: 'dsh', ...f.config });
  const close = async () => { const worker = service.worker; if (!worker) return; const exited = once(worker, 'exit'); service.close(); worker.ref(); await exited; }; f.disposers.push(close);
  let value; for (let step = 0; step < 20; step++) { value = await service.request('refresh'); if (!value.snapshot.history.pending) break; }
  assert.equal(value.snapshot.all.input, 8); assert.equal(value.snapshot.selected.total.input, 8); assert.ok(value.snapshot.sourceLabel.includes('启用桥接后已观测')); assert.equal(value.snapshot.history.gap, false);
  await service.request('save', { codexHome: null, rules: prices });
  f.host().invalidate('NO_ACCOUNT'); await assert.rejects(service.request('refresh')); assert.equal(service.value.snapshot, null); await close();
});
