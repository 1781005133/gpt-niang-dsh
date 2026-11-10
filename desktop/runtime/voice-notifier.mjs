// Voice notifications for completion / user-question events.
//
// Design constraints this module honours:
// - Genie-TTS synthesis measured at ~1.5-5 s, far too slow to run when the
//   event fires. Audio is therefore produced ahead of time and cached by text.
// - Only WAV bytes are read back from the cache. The cache is bounded and every
//   file is validated before use, because it lives outside the app directory.
// - The TTS endpoint is user-configurable so a different engine or voice can be
//   dropped in later without touching this file.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8020/v1/audio/speech';
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_FILES = 256;
const MAX_LINE_LENGTH = 200;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export function normalizeVoiceSettings(settings = {}) {
  const endpoint = typeof settings.endpoint === 'string' && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1]):\d{1,5}\//.test(settings.endpoint)
    ? settings.endpoint
    : DEFAULT_ENDPOINT;
  return {
    enabled: settings.enabled === true,
    endpoint,
    voice: typeof settings.voice === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(settings.voice) ? settings.voice : 'myvoice',
    timeoutMs: Number.isFinite(settings.timeoutMs) ? Math.min(Math.max(settings.timeoutMs, 1000), 60000) : 20000,
  };
}

export function loadVoiceLines(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {needs_input: [], completed: []};
  }
  const clean = (list) => Array.isArray(list)
    ? list.filter((line) => typeof line === 'string' && line.trim() && line.length <= MAX_LINE_LENGTH).map((line) => line.trim())
    : [];
  return {
    needs_input: clean(parsed?.lines?.needs_input),
    completed: clean(parsed?.lines?.completed),
  };
}

// Deterministic choice: the same event kind and revision always resolve to the
// same line, so a cached file is reused instead of synthesizing a new sentence
// on every turn. Rotation across lines still happens as the counter advances.
export function pickVoiceLine(lines, kind, counter = 0) {
  const list = lines?.[kind];
  if (!Array.isArray(list) || !list.length) return '';
  const index = Math.abs(Math.trunc(counter)) % list.length;
  return list[index];
}

export function voiceCacheKey(text, voice) {
  return createHash('sha256').update(`${voice}\u0000${text}`).digest('hex');
}

// WAV sanity check: RIFF/WAVE header and a plausible length. Rejects truncated
// downloads and any non-WAV payload rather than feeding it to the player.
export function isPlayableWav(bytes) {
  if (!bytes || bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) return false;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return false;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return false;
  const declared = bytes.readUInt32LE(4);
  return declared + 8 <= bytes.length;
}

export class VoiceCache {
  constructor(directory) {
    this.directory = directory;
  }

  file(key) {
    return path.join(this.directory, key + '.wav');
  }

  read(key) {
    try {
      const bytes = fs.readFileSync(this.file(key));
      return isPlayableWav(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }

  write(key, bytes) {
    if (!isPlayableWav(bytes)) throw Error('TTS returned an invalid WAV');
    fs.mkdirSync(this.directory, {recursive: true});
    const target = this.file(key);
    const temporary = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
    this.trim();
  }

  // Oldest-first eviction, bounded by both count and total bytes.
  trim() {
    let entries;
    try {
      entries = fs.readdirSync(this.directory)
        .filter((name) => name.endsWith('.wav'))
        .map((name) => {
          const file = path.join(this.directory, name);
          try { const stat = fs.statSync(file); return {file, size: stat.size, at: stat.mtimeMs}; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => a.at - b.at);
    } catch {
      return;
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (total <= MAX_CACHE_BYTES && count <= MAX_CACHE_FILES) break;
      try { fs.unlinkSync(entry.file); total -= entry.size; count--; } catch {}
    }
  }
}

async function postSpeech(settings, text, signal) {
  const body = JSON.stringify({
    model: 'genie',
    voice: settings.voice,
    input: text,
    response_format: 'wav',
  });
  const response = await fetch(settings.endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json; charset=utf-8'},
    body,
    signal,
  });
  if (!response.ok) throw Error('TTS HTTP ' + response.status);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!isPlayableWav(buffer)) throw Error('TTS returned a non-WAV or truncated payload');
  return buffer;
}

// Synthesize one sentence if it is not cached yet, then return cached bytes.
// Concurrent callers for the same text share a single request.
export class VoiceSynth {
  constructor({cache, settings, fetchImpl = postSpeech} = {}) {
    Object.assign(this, {cache, settings, fetchImpl});
    this.pending = new Map();
  }

  async prepare(text) {
    const key = voiceCacheKey(text, this.settings.voice);
    const hit = this.cache.read(key);
    if (hit) return {key, bytes: hit, cached: true};
    if (this.pending.has(key)) return this.pending.get(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    timer.unref?.();
    const task = (async () => {
      try {
        const bytes = await this.fetchImpl(this.settings, text, controller.signal);
        this.cache.write(key, bytes);
        return {key, bytes, cached: false};
      } finally {
        clearTimeout(timer);
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  // Warm the cache for every configured line without blocking the caller.
  async warmUp(lines) {
    const result = [];
    for (const kind of Object.keys(lines)) {
      for (const line of lines[kind]) {
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
