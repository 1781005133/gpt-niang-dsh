// Watches the bridge's `attention` snapshot for newly pending questions.
//
// The bridge already guarantees the hard parts: one event per question call,
// no replay after a restart, no re-announcement when a question moves from open
// to continued, and no leakage of question text. This monitor only has to turn
// the ring's new entries into notifications, using the same epoch/seq fencing as
// the completion monitor so a reconnect or account switch never replays history.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeSnapshot } from './companion-bridge.mjs';
import { atomicJson } from './usage.mjs';

const EPOCH = /^[0-9a-f-]{36}$/i;

export class CompanionAttentionMonitor {
  constructor({ config = {}, stateFile = null, intervalMs = 1000, onNotification = () => {}, now = Date.now } = {}) {
    Object.assign(this, { config, stateFile, intervalMs, onNotification, now });
    this.cursor = null;
    this.timer = null;
    try {
      if (stateFile && fs.statSync(stateFile).size <= 4096) {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (EPOCH.test(saved.epoch) && EPOCH.test(saved.instanceId) &&
            Number.isSafeInteger(saved.seq) && saved.seq >= 0 &&
            this.now() - saved.at >= 0 && this.now() - saved.at < 300000) this.cursor = saved;
      }
    } catch {}
  }

  scan() {
    try {
      const { snapshot } = readBridgeSnapshot(this.config, 'attention', this.now());
      const old = this.cursor;
      const same = old && old.epoch === snapshot.epoch && old.instanceId === snapshot.instanceId;
      this.cursor = { epoch: snapshot.epoch, instanceId: snapshot.instanceId, seq: snapshot.seq, at: this.now() };
      if (same && Number.isSafeInteger(old.seq) && snapshot.seq > old.seq) {
        // Everything newer than the cursor is new; the bridge already deduped.
        for (const event of snapshot.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= old.seq || event.seq > snapshot.seq) continue;
          // A question created long ago is history, not something to announce now.
          if (event.createdAt > this.now() + 5000 || this.now() - event.createdAt > 300000) continue;
          this.onNotification({ type: 'attention', source: 'dsh', sessionId: event.sessionKey,
            questionId: event.questionKey, createdAt: event.createdAt });
        }
      }
      if (this.stateFile) atomicJson(this.stateFile, this.cursor);
    } catch {
      // A missing, expired or disconnected snapshot must not look like fresh
      // activity, and must not let a same-epoch file replay after a heartbeat gap.
      this.cursor = null;
      if (this.stateFile) { try { atomicJson(this.stateFile, { invalidatedAt: this.now() }); } catch {} }
    }
  }

  start() {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

function run() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); } catch {}
  const monitor = new CompanionAttentionMonitor({
    config,
    stateFile: process.argv[2] || null,
    onNotification: (event) => process.stdout.write(JSON.stringify(event) + '\n'),
  });
  monitor.start();
  process.stdin.resume();
  process.stdin.on('end', () => { monitor.stop(); process.exit(0); });
  process.on('SIGTERM', () => { monitor.stop(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
