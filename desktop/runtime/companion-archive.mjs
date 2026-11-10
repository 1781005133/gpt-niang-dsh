import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MAX_LOG_BYTES, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, MAX_ARCHIVE_STATE_BYTES,
  parseArchiveFileName, parseArchiveState, validateNumericLog, snapshotsMatch } from '../shared/bridge-protocol.mjs';
import { readBridgeSnapshot, readBridgeHost } from './companion-bridge.mjs';

function directorySafe(directory) {
  for (let current = directory;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('UNSAFE_ARCHIVE_DIRECTORY');
    if (current === path.dirname(current)) break;
  }
}
function regular(file, limit) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1n || stat.size <= 0n || stat.size > BigInt(limit)) throw Error('INVALID_ARCHIVE_FILE');
  return stat;
}
function readRegular(file, limit) {
  const stat = regular(file, limit), fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw Error('ARCHIVE_CHANGED');
    const bytes = Buffer.alloc(Number(stat.size) + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (BigInt(count) !== stat.size) throw Error('ARCHIVE_CHANGED');
    return bytes.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}
const signature = stat => [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, stat.size].join(':');
export function archiveHistoryMessage(history) {
  const base = '启用桥接后已观测记录（非平台完整账单）';
  return base + (history.gap ? ' · 历史采集/读取有缺口，累计可能不完整。' : '') +
    (history.pending ? ' · 正在按预算补读数值历史，累计仍在更新…' : '');
}

// One current verified account, one flat directory and a bounded cursor. Never
// recursively discover a DSH tree, open raw chat DBs, or retain record bodies in
// an unbounded memory cache. The cache stores only signatures+numeric digests.
export class CompanionArchiveReader {
  constructor({ entryBudget = 128, byteBudget = 1024 * 1024, timeBudgetMs = 20, rescanMs = 5000, monotonic = () => performance.now() } = {}) {
    if (!Number.isInteger(entryBudget) || entryBudget < 1 || entryBudget > 128 || !Number.isInteger(byteBudget) || byteBudget < MAX_LOG_BYTES || byteBudget > 8 * 1024 * 1024 || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || timeBudgetMs > 100 || !Number.isFinite(rescanMs) || rescanMs < 0) throw Error('INVALID_ARCHIVE_BUDGET');
    Object.assign(this, { entryBudget, byteBudget, timeBudgetMs, rescanMs, monotonic });
    this.cache = new Map(); this.accountKey = null; this.dir = null; this.next = null; this.completedAt = -Infinity;
    this.visited = 0; this.passBytes = 0; this.passEntries = 0; this.errorCode = null;
  }
  close() { try { this.dir?.closeSync(); } catch {} this.dir = null; this.next = null; }
  reset() { this.close(); this.cache.clear(); this.accountKey = null; this.completedAt = -Infinity; this.errorCode = null; }
  scan(config = {}, now = Date.now()) {
    let context;
    try { context = readBridgeSnapshot(config, 'archive-status', now); }
    catch { this.close(); return { logs: [], history: { pending: false, gap: true, errorCode: 'ARCHIVE_UNAVAILABLE', message: archiveHistoryMessage({ gap: true, pending: false }) } }; }
    const { host, root, snapshot } = context, archive = snapshot.archive;
    if (!host.connected || !host.accountKey || archive.accountKey !== host.accountKey) { this.reset(); throw Error('UNVERIFIED_ARCHIVE_ACCOUNT'); }
    if (this.accountKey !== host.accountKey) { this.reset(); this.accountKey = host.accountKey; }
    const directory = path.join(root, 'archive', host.accountKey), logs = [], updates = [];
    let readBytes = 0, entries = 0, state = null;
    const started = this.monotonic();
    try {
      let emptyMissing = false;
      try { directorySafe(directory); }
      catch (error) {
        if (error.code !== 'ENOENT' || archive.totalFiles !== 0 || this.cache.size !== 0) throw error;
        directorySafe(path.dirname(directory)); emptyMissing = true;
      }
      if (!emptyMissing) {
        try { state = parseArchiveState(readRegular(path.join(directory, '.collection-state.json'), MAX_ARCHIVE_STATE_BYTES)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (state && state.accountKey !== host.accountKey) throw Error('ARCHIVE_STATE_ACCOUNT_MISMATCH');
      }
      if (emptyMissing) { this.close(); this.completedAt = now; this.errorCode = null; }
      if (!emptyMissing && !this.dir && (now - this.completedAt >= this.rescanMs || archive.totalFiles > this.cache.size)) {
        this.dir = fs.opendirSync(directory); this.visited = 0; this.passBytes = 0; this.passEntries = 0; this.errorCode = null;
      }
      while (this.dir && entries < this.entryBudget && this.monotonic() - started < this.timeBudgetMs) {
        const entry = this.next ?? this.dir.readSync(); this.next = null;
        if (!entry) {
          this.close(); this.completedAt = now;
          if (!archive.initializing && !archive.pendingFiles && this.visited < archive.totalFiles) this.errorCode = 'ARCHIVE_COUNT_MISMATCH';
          break;
        }
        entries++;
        if (++this.passEntries > MAX_ARCHIVE_FILES + 128) { this.errorCode = 'ARCHIVE_READ_LIMIT'; this.close(); this.completedAt = now; break; }
        if (entry.name === '.collection-state.json' || entry.name.endsWith('.tmp')) continue;
        let parsed;
        try { parsed = parseArchiveFileName(entry.name); } catch { this.errorCode = 'UNEXPECTED_ARCHIVE_ENTRY'; continue; }
        try {
          const file = path.join(directory, entry.name), stat = regular(file, MAX_LOG_BYTES), bytes = Number(stat.size);
          if (this.visited >= MAX_ARCHIVE_FILES || this.passBytes + bytes > MAX_ARCHIVE_BYTES) { this.errorCode = 'ARCHIVE_READ_LIMIT'; this.close(); this.completedAt = now; break; }
          const stamp = signature(stat), prior = this.cache.get(entry.name);
          if (prior?.signature !== stamp && readBytes + bytes > this.byteBudget) { this.next = entry; this.passEntries--; break; }
          this.visited++; this.passBytes += bytes;
          if (prior?.signature === stamp) continue;
          const text = readRegular(file, MAX_LOG_BYTES); readBytes += Buffer.byteLength(text);
          const records = validateNumericLog(text, { epoch: parsed.originEpoch, sessionKey: parsed.logId });
          const digest = createHash('sha256').update(text).digest('hex');
          // An equal-content atomic rewrite is still revisited and signature-
          // cached, but does not need another accounting transaction.
          if (prior?.digest !== digest) logs.push({ file: entry.name, ...parsed, sessionKey: records[0].payload.session_key, records });
          updates.push([entry.name, { signature: stamp, digest }]);
        } catch { this.errorCode = 'INVALID_ARCHIVE_FILE'; }
      }
    } catch { this.errorCode = 'ARCHIVE_IO_UNAVAILABLE'; this.close(); }
    const after = readBridgeHost(config, now);
    if (!after.connected || after.accountKey !== host.accountKey || !snapshotsMatch(host, after) || after.revision !== host.revision) { this.reset(); throw Error('ARCHIVE_ACCOUNT_CHANGED'); }
    for (const [name, value] of updates) { if (this.cache.size < MAX_ARCHIVE_FILES || this.cache.has(name)) this.cache.set(name, value); else this.errorCode = 'ARCHIVE_READ_LIMIT'; }
    const pending = Boolean(this.dir || this.next || archive.initializing || archive.pendingFiles || state?.pending);
    const errorCode = this.errorCode ?? archive.errorCode ?? state?.errorCode ?? (!archive.available ? 'ARCHIVE_UNAVAILABLE' : null);
    const history = { accountKey: host.accountKey, pending, gap: Boolean(errorCode || archive.collectionGap || state?.collectionGap),
      errorCode, visited: this.visited, retainedFiles: archive.totalFiles, retainedBytes: archive.totalBytes,
      batchEntries: entries, batchBytes: readBytes, initializing: archive.initializing, pendingFiles: archive.pendingFiles };
    history.message = archiveHistoryMessage(history);
    return { logs, history };
  }
}
