import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { CompanionControls, writeDesktopControl } from '../runtime/companion-controls.mjs';
import { Scene } from '../src/core/scene.mjs';
import { showCompanionRefreshFeedback } from '../runtime/companion-refresh-feedback.mjs';
import { readBridgeHost, readBridgeQuota, readBridgeSnapshot, readDesktopControl } from '../runtime/companion-bridge.mjs';
import { assertCompanionData, assertIndependentPath } from '../src/core/storage.mjs';
import { requestRefresh, readPendingRequests, completeRequests, cleanRefreshResults } from '../runtime/refresh-client.mjs';
import { acquireWorkerLock } from '../runtime/worker-state.mjs';
import { createBridgeHost } from '../../bridge/src/host.mjs';
import { createBridgeClient } from '../../bridge/src/client-core.mjs';
import { validateDesktopControl } from '../shared/bridge-protocol.mjs';

async function setup(t, { visible = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-controls-'));
  let clock = Date.now(), host, client, usageHook = null, identity = 'synthetic-account';
  const calls = [], controllers = [], generation = randomUUID();
  const noRepeater = () => ({ unref() {} });
  const source = () => ({ ok: true, value: { fetchedAt: clock, planType: 'plus', rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 18000, usedPercent: 27, resetsAt: Math.floor(clock / 1000) + 3600 }] }] } });
  const makeHost = () => createBridgeHost({ dshHome: directory, now: () => clock, setRepeater: noRepeater, clearRepeater() {} });
  const makeClient = () => createBridgeClient({
    connection: { isLoopback: true, generation: { getSnapshot: () => generation, subscribe: () => () => {} }, rpc: { call: async (channel, method, payload, signal) => {
      assert.equal(channel, '/api'); signal?.throwIfAborted(); calls.push({ method, payload, at: clock });
      if (method === 'gpt-companion/lease') return payload.action === 'acquire' ? host.acquire() : host.release(payload.leaseId);
      if (method === 'gpt-companion/control') return host.control(payload);
      if (method === 'gpt-companion/projection') return host.project(payload);
      if (method === 'codex-subscription/status') return { ok: true, value: { authenticated: Boolean(identity), provider: 'openai-codex', accounts: identity ? [{ id: identity, active: true }] : [] } };
      if (method === 'codex-subscription/usage') return usageHook ? usageHook(payload, signal) : source();
      throw Error('Unexpected mock RPC');
    } } }, now: () => clock, setTimer: () => 1, clearTimer() {},
  });
  host = makeHost(); client = makeClient(); await client.start();
  const config = { bridgeRoot: host.root };
  const createController = options => { const controller = new CompanionControls({ config, now: () => clock, setRepeater: noRepeater, clearRepeater() {}, ...options }); controllers.push(controller); return controller; };
  const controller = createController(); controller.start(visible);
  t.after(async () => {
    for (const item of controllers) item.dispose();
    await client.dispose(); host.dispose();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  const pump = async () => { for (let step = 0; step < 2; step++) { host.heartbeat(); controller.tick(); await client.start(); host.heartbeat(); controller.tick(); } };
  return { directory, config, controller, createController, calls, source, pump, now: () => clock,
    advance(ms) { clock += ms; }, host: () => host, client: () => client,
    usage: () => calls.filter(call => call.method === 'codex-subscription/usage'),
    force: () => calls.filter(call => call.method === 'codex-subscription/usage' && call.payload.force === true),
    setUsageHook(fn) { usageHook = fn; }, setIdentity(value) { identity = value; },
    async restart() { await client.dispose(); host.dispose(); host = makeHost(); client = makeClient(); await client.start(); },
  };
}

// Both ends use real file/protocol code; only DSH admission and official RPC
// responses are isolated mocks. These tests do not launch a real DSH process.
test('first-frame click waits for inactive owner ACK then executes authenticated force exactly once', async t => {
  const s = await setup(t); const initial = readDesktopControl(s.config);
  assert.equal(initial.active, false); assert.equal(initial.visible, false); assert.equal(initial.refreshSeq, 0);
  const pending = s.controller.requestRefresh(); assert.equal(s.controller.refreshSeq, 0); assert.equal(readDesktopControl(s.config).refreshSeq, 0);
  s.advance(1); await s.pump();
  const quota = await pending; assert.equal(quota.ok, true); assert.equal(s.force().length, 1); assert.deepEqual(s.force()[0].payload, { force: true });
  assert.equal(s.controller.value.state, 'succeeded'); assert.equal(s.controller.refreshSeq, 1); assert.ok(s.controller.notice.includes('新的来源观测'));
  await s.pump(); assert.equal(s.force().length, 1);
});

test('DSH menu manual refresh opens a quota scene with queued notice while Codex and auto actions keep their scene', async t => {
  const s = await setup(t), scene = new Scene({ settings: {}, quote: () => 'kept quote', now: s.now });
  const unchanged = scene.snapshot();
  assert.equal(showCompanionRefreshFeedback(scene, { hostSource: 'codex', manual: true }), false); assert.deepEqual(scene.snapshot(), unchanged);
  assert.equal(showCompanionRefreshFeedback(scene, { hostSource: 'dsh', manual: false }), false); assert.deepEqual(scene.snapshot(), unchanged);
  scene.on('refresh', () => { showCompanionRefreshFeedback(scene, { hostSource: 'dsh', manual: true }); });
  scene.refreshFromMenu(); const pending = s.controller.requestRefresh();
  assert.equal(scene.collapsed, false); assert.equal(scene.mode, 'quota'); assert.ok(s.controller.notice.includes('排队')); assert.equal(s.controller.value.pending, true);
  s.advance(1); await s.pump(); await pending; assert.equal(s.controller.value.state, 'succeeded'); assert.equal(scene.mode, 'quota');
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.ok(main.includes('showCompanionRefreshFeedback(scene, { hostSource: config.hostSource, manual });'));
});

test('inactive owner handshake fences a possible in-flight old publication with two newer revisions', async t => {
  const s = await setup(t), first = readDesktopControl(s.config), baseline = s.controller.handshakeRevision;
  assert.throws(() => writeDesktopControl(s.config, first, s.now()), { code: 'REPLAY' });
  s.host().heartbeat(); assert.equal(readBridgeSnapshot(s.config, 'control-status', s.now()).snapshot.revision, baseline + 1);
  s.controller.tick(); assert.equal(s.controller.ready, false); assert.equal(readDesktopControl(s.config).active, false);
  s.host().heartbeat(); s.controller.tick(); assert.equal(s.controller.ready, true); assert.equal(readDesktopControl(s.config).active, true);
});

test('visible resumes immediately and polls at 60 seconds; hidden keeps identity but never queries quota', async t => {
  const s = await setup(t); await s.pump(); assert.equal(s.controller.ready, true); assert.equal(s.usage().length, 1);
  const before = readBridgeHost(s.config, s.now());
  s.advance(30000); await s.pump(); assert.equal(s.usage().length, 1);
  s.advance(30000); await s.pump(); assert.equal(s.usage().length, 2);
  s.controller.setVisible(false); await s.pump(); const count = s.usage().length;
  for (let step = 0; step < 4; step++) { s.advance(30000); await s.pump(); }
  assert.equal(s.usage().length, count); assert.equal(readBridgeQuota(s.config, s.now()).ok, false);
  assert.equal(readBridgeHost(s.config, s.now()).accountKey, before.accountKey); assert.equal(readBridgeHost(s.config, s.now()).epoch, before.epoch);
  assert.ok(s.calls.filter(call => call.method === 'codex-subscription/status').length >= 6);
  s.controller.setVisible(true); s.advance(1); await s.pump(); assert.equal(s.usage().length, count + 1);
});

test('hidden explicit refresh remains visibly queued and is merged/rate-limited after show', async t => {
  const s = await setup(t, { visible: false }); await s.pump();
  const first = s.controller.requestRefresh(); assert.equal(s.controller.value.state, 'queued'); assert.ok(s.controller.notice.includes('显示挂件'));
  s.advance(1); await s.pump(); assert.equal(s.usage().length, 0);
  s.controller.setVisible(true); await s.pump(); await first; assert.equal(s.force().length, 1);
  s.advance(1000); const second = s.controller.requestRefresh(); await s.pump(); assert.equal(s.controller.value.state, 'rate-limited');
  const merged = s.controller.requestRefresh(); assert.equal(second, merged); assert.equal(s.controller.refreshSeq, 3);
  s.advance(10000); await s.pump(); await merged; assert.equal(s.force().length, 2); assert.equal(s.controller.value.state, 'succeeded');
});

test('same-millisecond old source cannot masquerade as a new refresh and local timeout retracts its intent', async t => {
  const s = await setup(t); await s.pump(); const baseline = readBridgeQuota(s.config, s.now()).observedAt;
  const pending = s.controller.requestRefresh(), rejected = assert.rejects(pending, { code: 'TIMED_OUT' });
  await s.pump(); assert.equal(s.controller.value.state, 'running'); assert.equal(s.controller.value.errorCode, 'WAITING_FOR_NEW_OBSERVATION');
  assert.equal(readBridgeQuota(s.config, s.now()).observedAt, baseline);
  s.advance(45001); s.host().heartbeat(); s.controller.tick(); await rejected; assert.equal(s.controller.value.state, 'timedout');
  assert.equal(readDesktopControl(s.config).active, false); await s.pump();
  const count = s.force().length; s.advance(10000); await s.pump(); assert.equal(s.force().length, count);
});

test('epoch/account change cancels old scope requests, consumes old counters, and new clicks still work', async t => {
  const s = await setup(t, { visible: false }); await s.pump();
  const old = s.controller.requestRefresh(), cancelled = assert.rejects(old, { code: 'HOST_CHANGED' }); await s.pump();
  const oldScope = readBridgeHost(s.config, s.now()).epoch, counter = s.controller.refreshSeq;
  s.setIdentity('different-synthetic-account'); s.advance(30001); await s.client().refresh(); s.controller.tick(); await cancelled;
  assert.notEqual(readBridgeHost(s.config, s.now()).epoch, oldScope); assert.equal(readDesktopControl(s.config).active, false);
  await s.pump(); assert.equal(s.controller.refreshSeq, counter); assert.equal(s.force().length, 0);
  s.controller.setVisible(true); s.advance(1); const next = s.controller.requestRefresh(); await s.pump(); await next;
  assert.equal(s.controller.refreshSeq, counter + 1); assert.equal(s.force().length, 1);
});

test('host restart handshakes historical refresh counter without replay and rejects old ACK scope', async t => {
  const s = await setup(t); await s.pump(); s.advance(1); const first = s.controller.requestRefresh(); await s.pump(); await first;
  const oldAck = readBridgeSnapshot(s.config, 'control-status', s.now()).snapshot, forceCount = s.force().length;
  await s.restart(); s.controller.tick(); assert.equal(readDesktopControl(s.config).active, false);
  fs.writeFileSync(path.join(s.config.bridgeRoot, 'control-status.json'), JSON.stringify(oldAck)); s.controller.tick(); assert.equal(s.controller.ready, false);
  await s.pump(); assert.equal(s.controller.ready, true); assert.equal(s.force().length, forceCount);
  s.advance(10001); const next = s.controller.requestRefresh(); await s.pump(); await next; assert.equal(s.force().length, forceCount + 1);
});

test('failed official query stays failed, while another consumer cannot overwrite or dispose an active owner', async t => {
  const s = await setup(t); await s.pump(); s.advance(1);
  s.setUsageHook(() => ({ ok: false })); const failed = s.controller.requestRefresh(), rejected = assert.rejects(failed); await s.pump(); await rejected;
  assert.equal(s.controller.value.state, 'failed'); assert.equal(readBridgeQuota(s.config, s.now()).ok, false);
  const file = path.join(s.config.bridgeRoot, 'desktop-control.json'), before = fs.readFileSync(file, 'utf8');
  const other = s.createController(); other.start(true); assert.equal(other.value.errorCode, 'CONSUMER_BUSY');
  assert.equal(fs.readFileSync(file, 'utf8'), before); other.dispose(); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('fixed writer rejects unsafe/oversized controls and symlink roots without touching host snapshots or outside files', async t => {
  const s = await setup(t); await s.pump();
  const host = readBridgeHost(s.config, s.now()), frame = validateDesktopControl({ ...readDesktopControl(s.config), seq: s.controller.seq + 1 });
  const file = path.join(s.config.bridgeRoot, 'desktop-control.json'); fs.writeFileSync(file, ' '.repeat(4097));
  assert.throws(() => writeDesktopControl(s.config, frame, s.now()), { code: 'INVALID_CONTROL_FILE' });
  fs.unlinkSync(file); const target = path.join(s.directory, 'protected'); fs.mkdirSync(target); fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeDesktopControl(s.config, frame, s.now()), { code: 'INVALID_CONTROL_FILE' }); assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(file); const link = path.join(s.directory, 'redirect'); fs.symlinkSync(s.config.bridgeRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeDesktopControl({ bridgeRoot: link }, frame, s.now()));
  assert.equal(readBridgeHost(s.config, s.now()).instanceId, host.instanceId);
});

test('dispose writes only own inactive control and leaves host/quota/completion bytes unchanged', async t => {
  const s = await setup(t); await s.pump();
  const before = new Map(['host', 'quota', 'completion', 'control-status'].map(name => [name, fs.readFileSync(path.join(s.config.bridgeRoot, name + '.json'), 'utf8')]));
  s.controller.dispose(); const frame = readDesktopControl(s.config); assert.equal(frame.active, false); assert.equal(frame.visible, false);
  for (const [name, bytes] of before) assert.equal(fs.readFileSync(path.join(s.config.bridgeRoot, name + '.json'), 'utf8'), bytes);
});

test('headless refresh, lock and queue cleanup reject unknown nonempty roots before any write or spawn', async t => {
  const s = await setup(t), unbound = path.join(s.directory, 'unbound-state');
  fs.mkdirSync(unbound); fs.writeFileSync(path.join(unbound, 'sentinel.txt'), 'unchanged');
  let spawned = false;
  await assert.rejects(requestRefresh({ dataDir: unbound }, 'unused-config', { startWorker() { spawned = true; } }), /归属|标记/);
  await assert.rejects(acquireWorkerLock(unbound), /归属|标记/);
  assert.throws(() => readPendingRequests(unbound), /归属|标记/); assert.throws(() => cleanRefreshResults(unbound), /归属|标记/);
  assert.throws(() => completeRequests(unbound, [], {}), /归属|标记/);
  assert.equal(spawned, false); assert.deepEqual(fs.readdirSync(unbound), ['sentinel.txt']);
  const owned = path.join(s.directory, 'owned-state'); assertCompanionData(owned, { claim: true });
  const id = randomUUID(), outside = path.join(s.directory, 'outside-request.json'); fs.writeFileSync(outside, 'unchanged');
  completeRequests(owned, [{ id, file: outside }], { ok: false }); assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
  const redirected = path.join(owned, 'refresh-requests'); fs.symlinkSync(unbound, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readPendingRequests(owned), /链接/); assert.deepEqual(fs.readdirSync(unbound), ['sentinel.txt']);
});

test('data ownership is checked before main writes and quota worker rejects original-like roots without side effects', async t => {
  const s = await setup(t), fakeOriginal = path.join(s.directory, '.gpt-niang', 'state');
  fs.mkdirSync(fakeOriginal, { recursive: true }); fs.writeFileSync(path.join(fakeOriginal, 'sentinel.txt'), 'unchanged');
  assert.throws(() => assertIndependentPath(fakeOriginal)); assert.throws(() => assertCompanionData(fakeOriginal, { claim: true }));
  const unbound = path.join(s.directory, 'unbound'); fs.mkdirSync(unbound); fs.writeFileSync(path.join(unbound, 'settings.json'), '{}');
  assert.throws(() => assertCompanionData(unbound, { claim: true })); assert.equal(fs.existsSync(path.join(unbound, 'companion-data-owner.json')), false);
  const configuration = path.join(s.directory, 'bad-worker.json'); fs.writeFileSync(configuration, JSON.stringify({ dataDir: fakeOriginal }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/watch.mjs', import.meta.url)), configuration, '0'], { stdio: 'ignore', windowsHide: true });
  const [code] = await once(child, 'exit'); assert.notEqual(code, 0); assert.deepEqual(fs.readdirSync(fakeOriginal), ['sentinel.txt']);
  const source = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('assertCompanionData(dataDir,') < source.indexOf('fs.mkdirSync(dataDir,'));
  for (const token of ['configureControls();', 'controls?.setVisible(value)', 'controls?.dispose()', 'refresh({ manual: true })', 'controls.requestRefresh()', 'quotaSnapshot()', 'refreshControl:']) assert.ok(source.includes(token), token);
});
