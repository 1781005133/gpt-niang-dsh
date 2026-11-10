import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionAttentionMonitor } from '../runtime/companion-attention-monitor.mjs';

const EPOCH = '11111111-2222-3333-4444-555555555555';
const hash = (n) => String(n).padStart(64, 'a');

// Builds the exact snapshot shape the bridge publishes for `attention`.
function attention({ epoch = EPOCH, instanceId = EPOCH, seq = 0, events = [], pending = [], at = Date.now(), hostActive = true } = {}) {
  return {
    schemaVersion: 1, producer: 'dsh-gpt-companion-bridge', instanceId, epoch, revision: 1,
    lastSeenAt: at, expiresAt: at + 20000, hostActive, seq, events, pending,
  };
}

function site(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state', 'dsh-gpt-companion', 'desktop');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = Date.now();
  const write = (snapshot) => {
    fs.writeFileSync(path.join(stateDir, 'host.json'), JSON.stringify({
      schemaVersion: 1, producer: 'dsh-gpt-companion-bridge', instanceId: snapshot.instanceId,
      epoch: snapshot.epoch, revision: snapshot.revision, lastSeenAt: snapshot.lastSeenAt,
      expiresAt: snapshot.expiresAt, hostActive: snapshot.hostActive,
      profile: 'desktop', connected: true, accountKey: 'b'.repeat(64), numericLogs: [],
    }));
    fs.writeFileSync(path.join(stateDir, 'attention.json'), JSON.stringify({
      ...snapshot, lastSeenAt: now, expiresAt: now + 20000,
    }));
  };
  const monitor = (extra = {}) => new CompanionAttentionMonitor({
    config: { bridgeRoot: stateDir }, now: () => now, ...extra,
  });
  return {root, stateDir, write, monitor, now};
}

test('a new pending question is announced once and not repeated', (t) => {
  const s = site(t), heard = [];
  s.write(attention());
  const m = s.monitor({ onNotification: (e) => heard.push(e) });
  m.scan();
  assert.deepEqual(heard, [], 'the first scan only establishes a baseline');
  s.write(attention({ seq: 1, events: [{ seq: 1, sessionKey: hash(1), questionKey: hash(2), createdAt: s.now }],
    pending: [{ sessionKey: hash(1), questionKey: hash(2) }] }));
  m.scan();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].type, 'attention');
  assert.equal(heard[0].questionId, hash(2));
  m.scan(); m.scan();
  assert.equal(heard.length, 1, 'the same question must not be announced again');
});

test('two new questions in one batch produce two notifications in order', (t) => {
  const s = site(t), heard = [];
  s.write(attention());
  const m = s.monitor({ onNotification: (e) => heard.push(e.questionId) });
  m.scan();
  s.write(attention({ seq: 2, events: [
    { seq: 1, sessionKey: hash(1), questionKey: hash(11), createdAt: s.now },
    { seq: 2, sessionKey: hash(1), questionKey: hash(12), createdAt: s.now },
  ] }));
  m.scan();
  assert.deepEqual(heard, [hash(11), hash(12)]);
});

test('a reconnect or restart never replays questions already announced', (t) => {
  const s = site(t), heard = [];
  const stateFile = path.join(s.root, 'attention-state.json');
  s.write(attention());
  const first = s.monitor({ stateFile, onNotification: (e) => heard.push(e.questionId) });
  first.scan();
  s.write(attention({ seq: 1, events: [{ seq: 1, sessionKey: hash(1), questionKey: hash(3), createdAt: s.now }] }));
  first.scan();
  assert.equal(heard.length, 1);
  // Same epoch, same instance: the persisted cursor suppresses the replay.
  const again = s.monitor({ stateFile, onNotification: (e) => heard.push(e.questionId) });
  again.scan();
  assert.equal(heard.length, 1);
});

test('a new producer epoch is baselined instead of replaying old questions', (t) => {
  const s = site(t), heard = [];
  s.write(attention({ epoch: '11111111-1111-1111-1111-111111111111', instanceId: '11111111-1111-1111-1111-111111111111' }));
  const m = s.monitor({ onNotification: (e) => heard.push(e) });
  m.scan();
  // A restarted producer republishes its ring; it is history, not news.
  s.write(attention({ epoch: '99999999-8888-7777-6666-555555555555', instanceId: '99999999-8888-7777-6666-555555555555',
    seq: 5, events: [{ seq: 5, sessionKey: hash(1), questionKey: hash(4), createdAt: s.now }] }));
  m.scan();
  assert.deepEqual(heard, []);
});

test('a disconnected or stale snapshot announces nothing and clears the cursor', (t) => {
  const s = site(t), heard = [];
  s.write(attention());
  const m = s.monitor({ onNotification: (e) => heard.push(e) });
  m.scan();
  // Write the snapshot first, then the disconnected host: the helper rewrites
  // host.json, so the order decides which state this scan actually observes.
  s.write(attention({ seq: 9, events: [{ seq: 9, sessionKey: hash(1), questionKey: hash(5), createdAt: s.now }] }));
  fs.writeFileSync(path.join(s.stateDir, 'host.json'), JSON.stringify({
    schemaVersion: 1, producer: 'dsh-gpt-companion-bridge', instanceId: EPOCH, epoch: EPOCH,
    revision: 2, lastSeenAt: s.now, expiresAt: s.now + 20000, hostActive: true,
    profile: 'desktop', connected: false, accountKey: null, numericLogs: [],
  }));
  m.scan();
  assert.deepEqual(heard, [], 'a disconnected bridge is not fresh activity');
  assert.equal(m.cursor, null);
});

test('a question created long ago is history and is not spoken now', (t) => {
  const s = site(t), heard = [];
  s.write(attention());
  const m = s.monitor({ onNotification: (e) => heard.push(e) });
  m.scan();
  s.write(attention({ seq: 1, events: [{ seq: 1, sessionKey: hash(1), questionKey: hash(6), createdAt: s.now - 3600000 }] }));
  m.scan();
  assert.deepEqual(heard, []);
});

test('a missing snapshot file is a silent read error, not a crash', (t) => {
  const s = site(t), heard = [];
  const m = s.monitor({ onNotification: (e) => heard.push(e) });
  assert.doesNotThrow(() => m.scan());
  assert.deepEqual(heard, []);
  assert.equal(m.cursor, null);
});

test('start and stop are idempotent and leave no interval behind', (t) => {
  const s = site(t);
  s.write(attention());
  const m = s.monitor({ intervalMs: 60000 });
  m.start(); m.start();
  m.stop(); m.stop();
  assert.equal(m.timer, null);
});
