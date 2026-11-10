// Local, pre-synthesized notification speech. No listener, credentials or executable providers.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {assertCompanionData, assertIndependentPath, inside} from '../src/core/storage.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8020/v1/audio/speech';
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_FILES = 256;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_LINE_LENGTH = 200;
const MAX_LINES_BYTES = 32 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const KEY = /^[a-f0-9]{64}$/;
const AUDIO_FILE = /^([a-f0-9]{64})\.wav$/;
const RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
const KINDS = ['needs_input', 'completed'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, fallback, name, pattern) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !pattern.test(value)) throw Error(`Invalid voice ${name}`);
  return value;
}

export function normalizeVoiceSettings(settings = {}) {
  if (!object(settings)) throw Error('Invalid voice settings');
  const endpoint = settings.endpoint === undefined ? DEFAULT_ENDPOINT : settings.endpoint;
  let url;
  try {
    if (typeof endpoint !== 'string' || !/^http:\/\//i.test(endpoint) || /[\s\\\u0000-\u001f\u007f?#]/u.test(endpoint)) throw Error();
    url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || /^http:\/\/[^/]*@/i.test(endpoint)
      || url.port === '0') throw Error();
  } catch {
    throw Error('Invalid voice endpoint: expected an HTTP loopback URL without credentials, query, fragment or port 0');
  }
  const timeout = settings.timeoutMs;
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout))) throw Error('Invalid voice timeoutMs');
  return Object.freeze({
    enabled: settings.enabled === true,
    endpoint: url.href,
    voice: identifier(settings.voice, 'myvoice', 'voice', /^[A-Za-z0-9_-]{1,80}$/),
    model: identifier(settings.model, 'genie', 'model', /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/),
    revision: identifier(settings.revision, '', 'revision', /^[A-Za-z0-9._-]{0,128}$/),
    timeoutMs: timeout === undefined ? 20000 : Math.trunc(Math.min(Math.max(timeout, 1000), 60000)),
  });
}

// Open a regular, single-link file without following a leaf symlink, and compare
// identities across open. Ancestors must separately pass the inherited path checks.
function openRegular(file, flags = fs.constants.O_RDONLY) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('Voice file must be a regular, unlinked file');
  const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) throw Error('Voice file changed during open');
    return {fd, stat};
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readBounded(file, maximum) {
  const {fd, stat} = openRegular(file);
  try {
    if (stat.size < 1 || stat.size > maximum) throw Error('Voice file exceeds its size budget');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('Voice file was truncated');
      offset += count;
    }
    if (fs.fstatSync(fd).size !== stat.size) throw Error('Voice file changed during read');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function validateLines(lines) {
  if (!object(lines) || Object.keys(lines).length !== 2 || !KINDS.every((kind) => Object.hasOwn(lines, kind))) throw Error('Voice lines require needs_input and completed groups');
  let characters = 0;
  for (const kind of KINDS) {
    const list = lines[kind];
    if (!Array.isArray(list) || list.length < 1 || list.length > 32) throw Error(`Voice lines ${kind} must contain 1-32 phrases`);
    for (const text of list) {
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_LINE_LENGTH || /[\u0000-\u001f\u007f]/u.test(text)) throw Error(`Invalid voice phrase in ${kind}`);
      characters += text.length;
    }
  }
  if (characters > 8000) throw Error('Voice lines exceed the character budget');
  return lines;
}

export function loadVoiceLines(file) {
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true}).decode(readBounded(file, MAX_LINES_BYTES));
    const parsed = JSON.parse(decoded.replace(/^\uFEFF/, ''));
    if (!object(parsed) || parsed.schemaVersion !== 1 || Object.keys(parsed).some((key) => !['schemaVersion', 'notes', 'lines'].includes(key))) throw Error('Expected voice lines schemaVersion 1');
    if (parsed.notes !== undefined) {
      if (!object(parsed.notes) || Object.keys(parsed.notes).some((key) => !['purpose', 'kinds', 'keepShort'].includes(key))) throw Error('Invalid voice lines notes');
      for (const key of ['purpose', 'keepShort']) {
        if (parsed.notes[key] !== undefined && (typeof parsed.notes[key] !== 'string' || parsed.notes[key].length > 1000)) throw Error('Invalid voice lines notes');
      }
      if (parsed.notes.kinds !== undefined && (!object(parsed.notes.kinds) || Object.entries(parsed.notes.kinds).some(([key, value]) => !KINDS.includes(key) || typeof value !== 'string' || value.length > 1000))) throw Error('Invalid voice lines kind notes');
    }
    const lines = validateLines(parsed.lines);
    // Preserve each configured phrase exactly: do not insert greetings or trim it.
    return {needs_input: [...lines.needs_input], completed: [...lines.completed]};
  } catch (error) {
    throw Error(`Cannot load voice lines: ${error.message}`, {cause: error});
  }
}

export function pickVoiceLine(lines, kind, counter = 0) {
  if (!KINDS.includes(kind)) return '';
  const list = lines?.[kind];
  if (!Array.isArray(list) || !list.length) return '';
  const safe = typeof counter === 'number' && Number.isSafeInteger(Math.trunc(counter)) ? Math.abs(Math.trunc(counter)) : 0;
  return typeof list[safe % list.length] === 'string' ? list[safe % list.length] : '';
}

// Legacy voice-string callers use default endpoint/model/revision. New callers
// must pass the whole settings object so each provider/voice revision is isolated.
export function voiceCacheKey(text, settings = {}) {
  const normalized = normalizeVoiceSettings(typeof settings === 'string' ? {voice: settings} : settings);
  return createHash('sha256').update(JSON.stringify(['voice-wav-v2', normalized.endpoint, normalized.model, normalized.voice, normalized.revision, text])).digest('hex');
}

// Parse the RIFF chunk table (including odd-byte padding), not a fixed 44-byte
// layout. Only bounded PCM16 mono/stereo speech is ever passed to the player.
export function isPlayableWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) return false;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let format = null, dataSize = null, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const kind = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (end > bytes.length || end + (size % 2) > bytes.length) return false;
    if (kind === 'fmt ') {
      if (format || (size !== 16 && size !== 18)) return false;
      if (size === 18 && bytes.readUInt16LE(start + 16) !== 0) return false;
      const encoding = bytes.readUInt16LE(start), channels = bytes.readUInt16LE(start + 2);
      const rate = bytes.readUInt32LE(start + 4), byteRate = bytes.readUInt32LE(start + 8);
      const align = bytes.readUInt16LE(start + 12), bits = bytes.readUInt16LE(start + 14);
      if (encoding !== 1 || ![1, 2].includes(channels) || bits !== 16 || !RATES.has(rate) || align !== channels * 2 || byteRate !== rate * align) return false;
      format = {rate, align};
    } else if (kind === 'data') {
      if (dataSize !== null || size === 0) return false;
      dataSize = size;
    }
    offset = end + (size % 2);
  }
  return !!format && dataSize !== null && dataSize % format.align === 0 && dataSize / format.align / format.rate <= 30;
}

export class VoiceCache {
  constructor(directory, {dataDir = path.dirname(directory)} = {}) {
    this.directory = assertIndependentPath(directory);
    this.dataDir = assertIndependentPath(dataDir);
    if (this.directory !== inside(this.dataDir, 'voice-cache')) throw Error('Voice cache must be the owned data directory voice-cache child');
    this.check();
  }

  check() {
    // Merely pointing at an empty folder is not proof of data ownership. Never
    // claim it here; installation/main must first use assertCompanionData(claim).
    const marker = inside(this.dataDir, 'companion-data-owner.json');
    const {fd, stat} = openRegular(marker);
    fs.closeSync(fd);
    if (stat.size > 4096) throw Error('Invalid voice data ownership marker');
    assertCompanionData(this.dataDir);
    assertIndependentPath(this.directory);
    try { if (!fs.lstatSync(this.directory).isDirectory()) throw Error('Voice cache is not a directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  file(key) {
    if (typeof key !== 'string' || !KEY.test(key)) throw Error('Invalid voice cache key');
    this.check();
    return inside(this.directory, `${key}.wav`);
  }

  read(key) {
    const file = this.file(key);
    try {
      const bytes = readBounded(file, MAX_AUDIO_BYTES);
      return isPlayableWav(bytes) ? bytes : null;
    } catch { return null; }
  }

  write(key, bytes) {
    if (!isPlayableWav(bytes)) throw Error('TTS returned an invalid WAV');
    const target = this.file(key);
    fs.mkdirSync(this.directory, {recursive: true});
    this.check();
    // Reject existing links/non-files instead of replacing them with rename.
    this.checkTarget(target);
    const temporary = inside(this.directory, `${key}.${process.pid}.${randomUUID()}.tmp`);
    let created = null, fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      created = fs.fstatSync(fd);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      this.check();
      this.checkTarget(target);
      this.checkExactFile(temporary, created);
      fs.renameSync(temporary, target);
      created = null;
      this.trim();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      // Clean only this call's exclusive temporary file, never a glob or an
      // unverified replacement planted at the same pathname.
      if (created) {
        try { this.check(); this.checkExactFile(temporary, created); fs.unlinkSync(temporary); } catch {}
      }
    }
  }

  checkTarget(file) {
    try { const {fd} = openRegular(file); fs.closeSync(fd); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  checkExactFile(file, expected) {
    if (path.dirname(file) !== this.directory) throw Error('Voice file escaped cache');
    const {fd, stat} = openRegular(file);
    fs.closeSync(fd);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw Error('Voice file changed before cleanup');
  }

  entries() {
    this.check();
    let directory;
    try { directory = fs.opendirSync(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = [];
    let scanned = 0;
    try {
      for (let entry; (entry = directory.readSync());) {
        if (++scanned > MAX_DIRECTORY_ENTRIES) throw Error('Voice cache directory exceeds entry budget');
        if (!AUDIO_FILE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
        const file = inside(this.directory, entry.name);
        try {
          const {fd, stat} = openRegular(file); fs.closeSync(fd);
          entries.push({file, size: stat.size, at: stat.mtimeMs, dev: stat.dev, ino: stat.ino});
        } catch {}
      }
    } finally { directory.closeSync(); }
    return entries;
  }

  count() { return this.entries().length; }

  trim() {
    const entries = this.entries().sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
    let total = entries.reduce((sum, entry) => sum + entry.size, 0), count = entries.length;
    let oversized = entries.filter((entry) => entry.size > MAX_AUDIO_BYTES).length;
    for (const entry of entries) {
      if (total <= MAX_CACHE_BYTES && count <= MAX_CACHE_FILES && entry.size <= MAX_AUDIO_BYTES) continue;
      this.check();
      try {
        this.checkExactFile(entry.file, entry);
        fs.unlinkSync(entry.file);
        total -= entry.size; count--;
        if (entry.size > MAX_AUDIO_BYTES) oversized--;
      } catch {}
    }
    if (total > MAX_CACHE_BYTES || count > MAX_CACHE_FILES || oversized > 0) throw Error('Voice cache could not enforce retention bounds safely');
  }
}

async function postSpeech(settings, text, signal) {
  const response = await fetch(settings.endpoint, {
    method: 'POST', redirect: 'error',
    headers: {'content-type': 'application/json; charset=utf-8'},
    body: JSON.stringify({model: settings.model, voice: settings.voice, input: text, response_format: 'wav'}),
    signal,
  });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw Error('TTS HTTP ' + response.status); }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_AUDIO_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw Error('TTS response exceeds audio byte budget');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw Error('TTS response has no streaming body');
  const reader = response.body.getReader();
  // Fixed hard allocation bound, independent of declared length or number of
  // network fragments (millions of tiny chunks must not grow an object array).
  const output = Buffer.allocUnsafe(MAX_AUDIO_BYTES);
  let total = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, {once: true});
  try {
    while (true) {
      signal.throwIfAborted();
      const {done, value} = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_AUDIO_BYTES - total) throw Error('TTS response exceeds audio byte budget');
      output.set(value, total);
      total += value.byteLength;
    }
    const bytes = Buffer.from(output.subarray(0, total));
    if (!isPlayableWav(bytes)) throw Error('TTS returned a non-WAV or invalid PCM payload');
    complete = true;
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function abortError(message) { return new DOMException(message, 'AbortError'); }

export class VoiceSynth {
  constructor({cache, settings, fetchImpl = postSpeech} = {}) {
    this.cache = cache;
    this.fetchImpl = fetchImpl;
    this.pending = new Map();
    this.controllers = new Set();
    this.generation = 0;
    this.disposed = false;
    this._settings = normalizeVoiceSettings(settings);
  }

  get settings() { return this._settings; }
  set settings(value) { this.setSettings(value); }

  setSettings(value) {
    this.cancel('Voice settings changed');
    // Invalidate old requests even when the new configuration is invalid.
    this._settings = null;
    this._settings = normalizeVoiceSettings(value);
    return this._settings;
  }

  cancel(message = 'Voice synthesis cancelled') {
    this.generation++;
    for (const controller of this.controllers) controller.abort(abortError(message));
    this.controllers.clear();
    this.pending.clear();
  }

  dispose() {
    this.disposed = true;
    this.cancel('Voice synthesizer disposed');
  }

  async prepare(text) {
    if (this.disposed) throw abortError('Voice synthesizer disposed');
    if (!this.settings) throw Error('Invalid voice settings');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_LINE_LENGTH || /[\u0000-\u001f\u007f]/u.test(text)) throw Error('Invalid voice phrase');
    const settings = this.settings, generation = this.generation;
    const key = voiceCacheKey(text, settings);
    const hit = this.cache.read(key);
    if (hit) return {key, bytes: hit, cached: true};
    if (this.pending.has(key)) return this.pending.get(key);
    const controller = new AbortController();
    this.controllers.add(controller);
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason || abortError('Voice synthesis cancelled'));
    controller.signal.addEventListener('abort', onAbort, {once: true});
    const timer = setTimeout(() => controller.abort(abortError('Voice synthesis timed out')), settings.timeoutMs);
    // Defer provider invocation until the pending entry exists: a synchronous
    // throw must not leave a rejected promise stranded in the pending map.
    const provider = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.fetchImpl(settings, text, controller.signal);
    });
    const task = (async () => {
      try {
        const bytes = await Promise.race([provider, aborted]);
        controller.signal.throwIfAborted();
        if (this.disposed || generation !== this.generation) throw abortError('Stale voice synthesis');
        if (!isPlayableWav(bytes)) throw Error('TTS returned an invalid WAV');
        this.cache.write(key, bytes);
        return {key, bytes, cached: false};
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        this.controllers.delete(controller);
        if (this.pending.get(key) === task) this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  async warmUp(lines) {
    validateLines(lines);
    const result = [], generation = this.generation;
    for (const kind of KINDS) {
      for (const line of lines[kind]) {
        if (this.disposed || generation !== this.generation) return result;
        try {
          const prepared = await this.prepare(line);
          result.push({kind, text: line, cached: prepared.cached});
        } catch (error) {
          result.push({kind, text: line, error: error.message});
        }
      }
    }
    return result;
  }
}
