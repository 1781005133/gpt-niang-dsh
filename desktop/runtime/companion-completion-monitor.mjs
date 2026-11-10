import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeSnapshot } from './companion-bridge.mjs';
import { atomicJson } from './usage.mjs';

export class CompanionCompletionMonitor {
  constructor({ config = {}, stateFile = null, intervalMs = 1000, onNotification = () => {}, now = Date.now } = {}) {
    Object.assign(this, { config, stateFile, intervalMs, onNotification, now });
    this.cursor = null; this.timer = null;
    try {
      if (stateFile && fs.statSync(stateFile).size <= 4096) {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (/^[0-9a-f-]{36}$/i.test(saved.epoch) && /^[0-9a-f-]{36}$/i.test(saved.instanceId) &&
            Number.isSafeInteger(saved.seq) && saved.seq >= 0 && this.now() - saved.at >= 0 && this.now() - saved.at < 300000) this.cursor = saved;
      }
    } catch {}
  }
  scan() {
    try {
      const { snapshot } = readBridgeSnapshot(this.config, 'completion', this.now()), old = this.cursor;
      const same = old && old.epoch === snapshot.epoch && old.instanceId === snapshot.instanceId;
      this.cursor = { epoch: snapshot.epoch, instanceId: snapshot.instanceId, seq: snapshot.seq, at: this.now() };
      // New producer/account epochs are baselined, never replayed. A sequence
      // regression also establishes a baseline rather than re-emitting history.
      const event = snapshot.completion;
      if (same && snapshot.seq > old.seq && event && event.seq > old.seq &&
          event.completedAt <= this.now() + 5000 && this.now() - event.completedAt <= 300000) {
        this.onNotification({ type: 'completion', source: 'dsh', sessionId: event.sessionKey,
          turnId: String(event.turn), endedAt: event.completedAt });
      }
      if (this.stateFile) atomicJson(this.stateFile, this.cursor);
    } catch {
      // Fence notification history through disconnects, including same-epoch
      // files reappearing after a heartbeat expiry.
      this.cursor = null;
      if (this.stateFile) { try { atomicJson(this.stateFile, { invalidatedAt: this.now() }); } catch {} }
    }
  }
  start() { if (this.timer) return; this.scan(); this.timer = setInterval(() => this.scan(), this.intervalMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; }
}
function run() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); } catch {}
  const monitor = new CompanionCompletionMonitor({ config, stateFile: process.argv[2] || null,
    onNotification: event => process.stdout.write(JSON.stringify(event) + '\n') });
  monitor.start(); process.stdin.resume();
  process.stdin.on('end', () => { monitor.stop(); process.exit(0); });
  process.on('SIGTERM', () => { monitor.stop(); process.exit(0); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
