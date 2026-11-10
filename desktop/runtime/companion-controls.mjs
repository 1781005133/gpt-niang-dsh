import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DESKTOP_PRODUCER, validateDesktopControl, isDesktopControlFresh } from '../shared/bridge-protocol.mjs';
import { resolveBridgeRoot, readBridgeHost, readDesktopControl, readBridgeSnapshot, readBridgeQuota } from './companion-bridge.mjs';

const failure = code => Object.assign(Error(code), { code });
const scopeOf = host => host.instanceId + ':' + host.epoch;
const messages = {
  queued: '刷新已排队，等待已认证 DSH 客户端…', running: '正在通过 DSH 刷新订阅额度…',
  succeeded: '订阅额度已刷新 · 已确认新的来源观测', failed: '额度刷新未完成，请重试。',
  offline: 'DSH 桥接未连接，未把旧快照视为刷新成功。', timedout: '额度刷新超时，未把旧快照视为刷新成功。',
  'rate-limited': '刷新请求已合并，等待限速间隔…',
};

// The only desktop->bridge mutation is this one fixed, bounded atomic control
// frame. Host/account snapshots, ACKs and numeric exports remain read-only.
export function writeDesktopControl(config, value, now = Date.now()) {
  const frame = validateDesktopControl(value), root = resolveBridgeRoot(config), host = readBridgeHost(config, now);
  if (!isDesktopControlFresh(frame, host, now)) throw failure('HOST_CHANGED');
  const inspectOwner = () => {
    let previous;
    try { previous = readDesktopControl(config); } catch (error) { if (error.code !== 'ENOENT') throw failure('INVALID_CONTROL_FILE'); }
    if (previous && isDesktopControlFresh(previous, host, now) && previous.active && previous.instanceId !== frame.instanceId) throw failure('CONSUMER_BUSY');
    if (previous?.instanceId === frame.instanceId && previous.seq >= frame.seq) throw failure('REPLAY');
  };
  inspectOwner();
  const text = JSON.stringify(frame), file = path.join(root, 'desktop-control.json'), temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    const currentHost = readBridgeHost(config, now);
    if (scopeOf(currentHost) !== scopeOf(host)) throw failure('HOST_CHANGED');
    inspectOwner();
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return frame;
}

export class CompanionControls {
  constructor({ config = {}, instanceId = randomUUID(), now = Date.now, heartbeatMs = 5000, ttlMs = 15000,
    requestTimeoutMs = 45000, setRepeater = setInterval, clearRepeater = clearInterval, onChange = () => {} } = {}) {
    if (heartbeatMs < 1000 || ttlMs <= heartbeatMs || ttlMs > 20000) throw failure('INVALID_TIMING');
    Object.assign(this, { config, instanceId, now, heartbeatMs, ttlMs, requestTimeoutMs, setRepeater, clearRepeater, onChange });
    this.seq = 0; this.refreshSeq = 0; this.lastWrite = -Infinity; this.scope = null; this.ready = false;
    this.handshake = 'release'; this.handshakeRevision = null;
    this.visible = false; this.started = false; this.timer = null; this.pending = null;
    this.value = { state: 'idle', errorCode: null, refreshSeq: 0, pending: false, updatedAt: now() };
  }
  update(state, errorCode = null, extra = {}) {
    const value = { ...this.value, state, errorCode, refreshSeq: this.refreshSeq, pending: Boolean(this.pending), ...extra };
    if (JSON.stringify({ ...value, updatedAt: 0 }) === JSON.stringify({ ...this.value, updatedAt: 0 })) return;
    this.value = { ...value, updatedAt: this.now() }; this.onChange(this.value);
  }
  get notice() {
    if (this.value.state === 'idle' || !this.value.pending && this.now() - this.value.updatedAt > 8000) return null;
    if (this.value.errorCode === 'CONSUMER_BUSY') return '另一实例正在控制此 DSH 配置，未发送刷新请求。';
    if (this.value.errorCode === 'HOST_CHANGED') return 'DSH 宿主或账号已切换，旧刷新已取消，请重试。';
    if (this.value.state === 'queued' && !this.visible) return '刷新已排队，显示挂件后查询。';
    return messages[this.value.state] ?? null;
  }
  start(visible = false) {
    this.visible = visible === true;
    if (this.started) { this.tick(true); return; }
    this.started = true; this.scope = null; this.ready = false; this.lastWrite = -Infinity;
    this.tick(true); this.timer = this.setRepeater(() => this.tick(), 1000); this.timer?.unref?.();
  }
  setVisible(visible) {
    const changed = this.visible !== (visible === true); this.visible = visible === true;
    if (this.started && changed) this.tick(true);
  }
  requestRefresh() {
    if (!this.started) return Promise.reject(failure('CONTROLS_STOPPED'));
    // During the new-host inactive-first handshake, clicks stay only in memory.
    // The published refresh counter is not advanced until ownership is proven.
    const status = readBridgeQuota(this.config, this.now());
    if (this.pending) {
      this.pending.baseline = Math.max(this.pending.baseline, status.ok ? status.observedAt : 0);
      this.pending.deadline = this.now() + this.requestTimeoutMs;
      if (this.ready) this.pending.refreshSeq = ++this.refreshSeq;
      this.update('queued'); this.tick(true); return this.pending?.promise ?? this.lastPromise;
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); this.lastPromise = promise;
    this.pending = { promise, resolve, reject, baseline: status.ok ? status.observedAt : 0, deadline: this.now() + this.requestTimeoutMs,
      requestedAt: this.now(), refreshSeq: this.ready ? ++this.refreshSeq : null, scope: this.scope };
    this.update('queued'); this.tick(true); return promise;
  }
  finish(state, errorCode, quota = null) {
    const pending = this.pending; this.pending = null; this.update(state, errorCode);
    if (!pending) return;
    if (state === 'succeeded') pending.resolve(quota);
    else pending.reject(failure(errorCode ?? 'REFRESH_FAILED'));
  }
  frame(host, active = this.handshake !== 'release') {
    return { schemaVersion: 1, producer: DESKTOP_PRODUCER, instanceId: this.instanceId, hostInstanceId: host.instanceId,
      epoch: host.epoch, seq: ++this.seq, issuedAt: this.now(), expiresAt: this.now() + this.ttlMs,
      active, visible: active && this.visible, refreshSeq: this.refreshSeq };
  }
  tick(force = false) {
    if (!this.started) return;
    if (this.pending && this.now() >= this.pending.deadline) {
      this.finish('timedout', 'TIMED_OUT'); this.ready = false; this.handshake = 'release'; this.handshakeRevision = null; this.lastWrite = -Infinity;
    }
    try {
      const host = readBridgeHost(this.config, this.now()), scope = scopeOf(host);
      if (scope !== this.scope) {
        if (this.scope !== null && this.pending) this.finish('failed', 'HOST_CHANGED');
        this.scope = scope; this.ready = false; this.handshake = 'release'; this.handshakeRevision = null; this.lastWrite = -Infinity;
      }
      if (force || this.now() - this.lastWrite >= this.heartbeatMs) {
        writeDesktopControl(this.config, this.frame(host), this.now()); this.lastWrite = this.now();
        if (this.handshake === 'release' && this.handshakeRevision === null) this.handshakeRevision = readBridgeHost(this.config, this.now()).revision;
      }
      let ack;
      try { ack = readBridgeSnapshot(this.config, 'control-status', this.now()).snapshot; } catch { return; }
      if (scopeOf(ack) !== this.scope || ack.control.consumerInstanceId !== this.instanceId) return;
      const control = ack.control;
      if (!this.ready) {
        // A host can expose active:false merely because the previous epoch's
        // frame mismatched. Require a host publication AFTER our inactive write,
        // not that pre-existing ACK. Two publications fence the at-most-one
        // synchronous host publish already in flight at the rename boundary.
        if (control.refreshSeq !== this.refreshSeq || control.active !== false || ack.revision < this.handshakeRevision + 2) return;
        this.ready = true; this.handshake = null; this.handshakeRevision = null;
        if (this.pending?.refreshSeq === null) {
          this.pending.refreshSeq = ++this.refreshSeq; this.pending.scope = this.scope; this.update('queued');
        }
        writeDesktopControl(this.config, this.frame(host, true), this.now()); this.lastWrite = this.now();
        return;
      }
      const pending = this.pending;
      if (!pending || pending.refreshSeq !== control.refreshSeq || pending.scope !== this.scope) return;
      if (['failed', 'timedout'].includes(control.state)) { this.finish(control.state, control.errorCode ?? 'REFRESH_FAILED'); return; }
      if (control.state === 'succeeded') {
        const quota = readBridgeQuota(this.config, this.now());
        if (quota.ok && quota.queryOk && quota.observedAt === control.observedAt && quota.observedAt > pending.baseline && quota.observedAt >= control.startedAt) this.finish('succeeded', null, quota);
        else this.update('running', 'WAITING_FOR_NEW_OBSERVATION');
      } else if (['queued', 'running', 'rate-limited', 'offline'].includes(control.state)) {
        this.update(control.state, control.errorCode, { retryAt: control.retryAt });
      }
    } catch (error) {
      if (error.code === 'CONSUMER_BUSY') this.finish('offline', error.code);
      else if (this.pending || !['timedout', 'failed', 'succeeded'].includes(this.value.state)) this.update('offline', error.code === 'INVALID_CONTROL_FILE' ? error.code : 'BRIDGE_UNAVAILABLE');
    }
  }
  stop() {
    if (!this.started) return;
    this.started = false; this.clearRepeater(this.timer); this.timer = null;
    try {
      const host = readBridgeHost(this.config, this.now()), current = readDesktopControl(this.config);
      if (scopeOf(host) === this.scope && current.instanceId === this.instanceId && current.hostInstanceId === host.instanceId && current.epoch === host.epoch) {
        this.seq = Math.max(this.seq, current.seq); writeDesktopControl(this.config, this.frame(host, false), this.now());
      }
    } catch {} // Missing/replaced/other-owner files are not ours to touch.
    if (this.pending) this.finish('failed', 'CONTROLS_STOPPED');
    this.ready = false; this.scope = null; this.update('idle');
  }
  dispose() { this.stop(); }
}
