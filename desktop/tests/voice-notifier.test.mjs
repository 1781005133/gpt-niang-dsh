import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertCompanionData} from '../src/core/storage.mjs';
import {
  VoiceCache, VoiceSynth, isPlayableWav, loadVoiceLines,
  normalizeVoiceSettings, pickVoiceLine, voiceCacheKey,
} from '../runtime/voice-notifier.mjs';

const LIMIT = 8 * 1024 * 1024;
const TEST_DIRECTORY = path.resolve(fileURLToPath(new URL('.', import.meta.url)));

function wav(seconds = 0.1, rate = 16000, channels = 1) {
  const data = Math.floor(rate * seconds) * channels * 2;
  const bytes = Buffer.alloc(44 + data);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + data, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(data, 40);
  return bytes;
}

function chunk(name, body) {
  const bytes = Buffer.alloc(8 + body.length + body.length % 2);
  bytes.write(name); bytes.writeUInt32LE(body.length, 4); body.copy(bytes, 8);
  return bytes;
}

function riff(chunks) {
  const bytes = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), ...chunks]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(TEST_DIRECTORY, 'voice-notifier-'));
  t.after(() => {
    assert.equal(path.dirname(directory), TEST_DIRECTORY);
    assert.match(path.basename(directory), /^voice-notifier-/);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return directory;
}

function cacheFor(t) {
  const dataDir = tempDir(t);
  assertCompanionData(dataDir, {claim: true});
  return new VoiceCache(path.join(dataDir, 'voice-cache'));
}

function synthFor(t, options = {}) {
  const synth = new VoiceSynth({cache: cacheFor(t), settings: {enabled: true}, ...options});
  t.after(() => synth.dispose());
  return synth;
}

function linesFile(t, value = {schemaVersion: 1, lines: {needs_input: ['ask'], completed: ['done']}}) {
  const file = path.join(tempDir(t), 'lines.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function streamResponse(parts, {headers = {}, status = 200, onCancel = () => {}} = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < parts.length) controller.enqueue(parts[index++]);
      else controller.close();
    },
    cancel: onCancel,
  }), {headers, status});
}

test('settings expose public defaults, configurable model/revision and bounded timeout', () => {
  assert.deepEqual(normalizeVoiceSettings(), {
    enabled: false, endpoint: 'http://127.0.0.1:8020/v1/audio/speech',
    voice: 'myvoice', model: 'genie', revision: '', timeoutMs: 20000,
  });
  const settings = normalizeVoiceSettings({enabled: true, endpoint: 'http://localhost:9000/v1/audio/speech', voice: 'test_voice', model: 'local/model-v2', revision: 'voice-stamp-2', timeoutMs: 999999});
  assert.equal(settings.model, 'local/model-v2');
  assert.equal(settings.revision, 'voice-stamp-2');
  assert.equal(settings.timeoutMs, 60000);
  assert.ok(Object.isFrozen(settings));
  assert.equal(normalizeVoiceSettings({timeoutMs: 0}).timeoutMs, 1000);
  assert.equal(normalizeVoiceSettings({timeoutMs: 1000.9}).timeoutMs, 1000);
  for (const field of ['voice', 'model', 'revision']) {
    assert.throws(() => normalizeVoiceSettings({[field]: '../../not allowed'}), /Invalid voice/);
  }
  assert.throws(() => normalizeVoiceSettings({timeoutMs: NaN}), /timeoutMs/);
});

test('URL validation accepts only HTTP loopback and never substitutes an invalid supplied endpoint', () => {
  for (const endpoint of ['http://127.0.0.1:8020/v1/audio/speech', 'http://localhost/tts', 'http://[::1]:9000/tts']) {
    assert.equal(normalizeVoiceSettings({endpoint}).endpoint, endpoint);
  }
  const invalid = [
    '', null, 42, 'https://127.0.0.1/tts', 'file:///tmp/tts', 'ftp://localhost/tts', 'http:localhost/tts',
    'http://example.com/tts', 'http://127.0.0.1.example.com/tts', 'http://localhost.example/tts',
    'http://0.0.0.0/tts', 'http://[::]/tts', 'http://192.168.1.1/tts',
    'http://user:secret@localhost/tts', 'http://@localhost/tts', 'http://localhost:0/tts',
    'http://localhost:65536/tts', 'http://localhost/tts?key=x', 'http://localhost/tts?',
    'http://localhost/tts#fragment', 'http://localhost/tts#', ' http://localhost/tts',
    'http://local\nhost/tts', 'http://localhost\\example.com/tts',
  ];
  for (const endpoint of invalid) assert.throws(() => normalizeVoiceSettings({endpoint}), /Invalid voice endpoint/, String(endpoint));
});

test('cache identity changes with endpoint/model/voice/revision, not scheduling settings', () => {
  const settings = normalizeVoiceSettings({enabled: true});
  const key = voiceCacheKey('same phrase', settings);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, voiceCacheKey('same phrase', 'myvoice'), 'legacy string means default provider settings');
  for (const update of [{endpoint: 'http://localhost:8021/tts'}, {model: 'other'}, {voice: 'other_voice'}, {revision: 'voice-2026-02'}]) {
    assert.notEqual(key, voiceCacheKey('same phrase', {...settings, ...update}));
  }
  assert.notEqual(key, voiceCacheKey('different phrase', settings));
  assert.equal(key, voiceCacheKey('same phrase', {...settings, enabled: false, timeoutMs: 5000}));
});

test('line JSON uses strict versioned groups, preserves exact phrases and accepts shipped schema', (t) => {
  const file = linesFile(t, {schemaVersion: 1, notes: {purpose: 'Speech', kinds: {needs_input: 'Question'}, keepShort: 'Short'}, lines: {needs_input: [' ask exactly '], completed: ['done']}});
  assert.deepEqual(loadVoiceLines(file), {needs_input: [' ask exactly '], completed: ['done']});
  const shipped = loadVoiceLines(new URL('../assets/voice-lines.json', import.meta.url));
  assert.equal(shipped.needs_input.length + shipped.completed.length, 5);
});

test('invalid, missing, empty and over-budget line files fail explicitly rather than disabling silently', (t) => {
  const bad = [
    '// not JSON', null, [], {lines: {needs_input: ['a'], completed: ['b']}},
    {schemaVersion: 2, lines: {needs_input: ['a'], completed: ['b']}},
    {schemaVersion: 1, extra: true, lines: {needs_input: ['a'], completed: ['b']}},
    {schemaVersion: 1, lines: {needs_input: [], completed: ['b']}},
    {schemaVersion: 1, lines: {needs_input: ['a'], completed: ['b'], other: ['c']}},
    {schemaVersion: 1, lines: {needs_input: ['a'], completed: ['', 42]}},
    {schemaVersion: 1, lines: {needs_input: ['a'], completed: ['x'.repeat(201)]}},
    {schemaVersion: 1, lines: {needs_input: ['a\n'], completed: ['b']}},
    {schemaVersion: 1, lines: {needs_input: Array(33).fill('a'), completed: ['b']}},
    {schemaVersion: 1, notes: 'not an object', lines: {needs_input: ['a'], completed: ['b']}},
    {schemaVersion: 1, lines: {needs_input: Array(32).fill('a'.repeat(200)), completed: Array(32).fill('b'.repeat(200))}},
    ' '.repeat(32 * 1024 + 1),
  ];
  for (const value of bad) assert.throws(() => loadVoiceLines(linesFile(t, value)), /Cannot load voice lines/);
  assert.throws(() => loadVoiceLines(path.join(tempDir(t), 'missing.json')), /Cannot load voice lines/);
});

test('line loader rejects invalid UTF-8 rather than changing the configured phrase', (t) => {
  const file = linesFile(t);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('{"schemaVersion":1,"lines":{"needs_input":["'),
    Buffer.from([0xff]), Buffer.from('"],"completed":["done"]}}'),
  ]));
  assert.throws(() => loadVoiceLines(file), /Cannot load voice lines/);
});

test('stable phrase selection tolerates negative/fractional/nonfinite/unsafe counters', () => {
  const lines = {completed: ['a', 'b', 'c'], needs_input: ['q']};
  for (const [counter, expected] of [[0, 'a'], [3, 'a'], [4, 'b'], [-1, 'b'], [4.9, 'b'], [NaN, 'a'], [Infinity, 'a'], [-Infinity, 'a'], [Number.MAX_VALUE, 'a'], ['4', 'a']]) {
    assert.equal(pickVoiceLine(lines, 'completed', counter), expected);
  }
  assert.equal(pickVoiceLine(lines, 'unknown'), '');
  assert.equal(pickVoiceLine({completed: []}, 'completed'), '');
});

test('PCM16 WAV accepts approved rates, mono/stereo and non-fixed chunk layouts', () => {
  for (const rate of [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]) {
    for (const channels of [1, 2]) assert.ok(isPlayableWav(wav(0.1, rate, channels)));
  }
  const base = wav();
  const fmt = chunk('fmt ', base.subarray(20, 36));
  const data = chunk('data', base.subarray(44));
  assert.ok(isPlayableWav(riff([chunk('JUNK', Buffer.from([1, 2, 3])), fmt, chunk('LIST', Buffer.from('info')), data])));
  assert.ok(isPlayableWav(riff([data, fmt])));
  assert.ok(isPlayableWav(riff([chunk('fmt ', Buffer.concat([base.subarray(20, 36), Buffer.alloc(2)])), data])));
  assert.ok(isPlayableWav(wav(30, 48000, 2)));
});

test('WAV parser rejects malformed RIFF, chunks, formats, lengths and excessive duration/size', () => {
  const base = wav();
  const mutations = [[0, 0xd2, 1], [4, 999999, 4], [20, 3, 2], [22, 3, 2], [24, 96000, 4], [28, 1, 4], [32, 4, 2], [34, 24, 2], [40, 999999, 4], [40, 0, 4]];
  for (const [offset, value, size] of mutations) {
    const bytes = Buffer.from(base);
    bytes.writeUIntLE(value, offset, size);
    assert.equal(isPlayableWav(bytes), false, `field at ${offset}`);
  }
  const fmt = chunk('fmt ', base.subarray(20, 36));
  const data = chunk('data', base.subarray(44));
  const invalid = [
    Buffer.alloc(0), new Uint8Array(base), Buffer.from('not wave'), base.subarray(0, 40),
    Buffer.concat([base, Buffer.from([0])]), Buffer.alloc(LIMIT + 1), wav(30.001),
    riff([fmt]), riff([data]), riff([fmt, fmt, data]), riff([fmt, data, data]),
    riff([fmt, chunk('data', Buffer.from([1, 2, 3]))]),
    riff([chunk('fmt ', base.subarray(20, 34)), data]),
    riff([chunk('JUNK', Buffer.from([1])).subarray(0, 9)]),
    riff([fmt, Buffer.from([1, 2, 3])]),
  ];
  for (const bytes of invalid) assert.equal(isPlayableWav(bytes), false);
});

test('cache requires inherited independent owned data and fixed voice-cache child', (t) => {
  const unowned = tempDir(t);
  assert.throws(() => new VoiceCache(path.join(unowned, 'voice-cache')));
  fs.writeFileSync(path.join(unowned, 'unrelated.txt'), 'not ours');
  assert.throws(() => new VoiceCache(path.join(unowned, 'voice-cache')));
  const cache = cacheFor(t);
  assert.throws(() => new VoiceCache(path.join(cache.dataDir, 'other-cache')), /voice-cache child/);
  assert.throws(() => new VoiceCache(path.join(cache.dataDir, '.dsh', 'voice-cache')));
  assert.throws(() => new VoiceCache('relative-cache'));
  fs.writeFileSync(path.join(cache.dataDir, 'companion-data-owner.json'), '{}');
  assert.throws(() => cache.read(voiceCacheKey('x')), /归属标记/);
});

test('cache accepts only hex keys and valid bounded regular WAV files', (t) => {
  const cache = cacheFor(t), key = voiceCacheKey('hello');
  assert.equal(cache.read(key), null);
  cache.write(key, wav());
  assert.ok(isPlayableWav(cache.read(key)));
  assert.equal(cache.count(), 1);
  assert.throws(() => cache.write(voiceCacheKey('bad'), Buffer.from('nope')), /invalid WAV/);
  for (const invalid of ['../outside', 'a'.repeat(63), 'A'.repeat(64), 'x'.repeat(64), 'a'.repeat(64) + '.wav']) {
    assert.throws(() => cache.file(invalid), /Invalid voice cache key/);
    assert.throws(() => cache.read(invalid), /Invalid voice cache key/);
    assert.throws(() => cache.write(invalid, wav()), /Invalid voice cache key/);
  }
  fs.writeFileSync(cache.file(key), 'invalid');
  assert.equal(cache.read(key), null);
  fs.truncateSync(cache.file(key), LIMIT + 1);
  assert.equal(cache.read(key), null, 'oversized disk file rejected before allocation');
});

test('cache eviction bounds count and leaves unrelated files/directories untouched', (t) => {
  const cache = cacheFor(t);
  const initialKey = voiceCacheKey('initial');
  cache.write(initialKey, wav());
  fs.utimesSync(cache.file(initialKey), new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  const unrelated = path.join(cache.directory, 'unrelated.wav');
  const directory = cache.file(voiceCacheKey('directory'));
  fs.writeFileSync(unrelated, 'keep'); fs.mkdirSync(directory);
  for (let i = 0; i < 260; i++) cache.write(voiceCacheKey('line ' + i), wav());
  assert.equal(cache.count(), 256);
  assert.equal(cache.read(initialKey), null, 'oldest verified entry is evicted first');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.ok(fs.statSync(directory).isDirectory());
});

test('cache eviction bounds total bytes and removes oversized owned regular entries', (t) => {
  const cache = cacheFor(t);
  fs.mkdirSync(cache.directory);
  for (let i = 0; i < 9; i++) {
    const file = cache.file(voiceCacheKey('sparse-' + i));
    fs.writeFileSync(file, ''); fs.truncateSync(file, LIMIT);
  }
  cache.trim();
  assert.equal(cache.entries().reduce((sum, entry) => sum + entry.size, 0), 64 * 1024 * 1024);
  const giant = cache.file(voiceCacheKey('oversize'));
  fs.writeFileSync(giant, ''); fs.truncateSync(giant, LIMIT + 1);
  cache.trim();
  assert.equal(fs.existsSync(giant), false);
  assert.ok(cache.entries().reduce((sum, entry) => sum + entry.size, 0) <= 64 * 1024 * 1024);
});

test('cache reports retention failure rather than claiming bounds after failed safe eviction', (t) => {
  const cache = cacheFor(t);
  fs.mkdirSync(cache.directory);
  for (let i = 0; i < 257; i++) fs.writeFileSync(cache.file(voiceCacheKey('eviction-' + i)), wav());
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (path.dirname(file) === cache.directory) throw Error('simulated locked cache file');
    return unlink(file);
  });
  assert.throws(() => cache.trim(), /could not enforce retention bounds safely/);
  assert.equal(cache.count(), 257);
});

test('cache rejects excessive directory clutter without deleting unknown files', (t) => {
  const cache = cacheFor(t);
  fs.mkdirSync(cache.directory);
  for (let i = 0; i < 4097; i++) fs.writeFileSync(path.join(cache.directory, `foreign-${i}.tmp`), '');
  assert.throws(() => cache.trim(), /entry budget/);
  assert.equal(fs.readdirSync(cache.directory).length, 4097);
});

test('cache refuses hard links and never evicts them', (t) => {
  const cache = cacheFor(t);
  fs.mkdirSync(cache.directory);
  const external = path.join(cache.dataDir, 'outside.wav');
  const file = cache.file(voiceCacheKey('hard-link'));
  fs.writeFileSync(external, wav()); fs.linkSync(external, file);
  assert.equal(cache.read(voiceCacheKey('hard-link')), null);
  assert.throws(() => cache.write(voiceCacheKey('hard-link'), wav()), /regular/);
  cache.trim();
  assert.ok(fs.existsSync(file)); assert.ok(isPlayableWav(fs.readFileSync(external)));
});

test('cache rejects a directory junction/symlink and preserves its target', (t) => {
  const cache = cacheFor(t), external = path.join(cache.dataDir, 'not-cache');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep.txt'), 'keep');
  fs.symlinkSync(external, cache.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cache.write(voiceCacheKey('linked'), wav()), /链接/);
  assert.throws(() => cache.trim(), /链接/);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep');
});

test('cache rejects a leaf symlink without reading, replacing or deleting it', (t) => {
  const cache = cacheFor(t), external = path.join(cache.dataDir, 'external.wav');
  fs.mkdirSync(cache.directory); fs.writeFileSync(external, wav());
  const file = cache.file(voiceCacheKey('leaf-link'));
  try { fs.symlinkSync(external, file, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks require Windows privilege; junction and hard-link cases run separately'); return; } throw error; }
  assert.throws(() => cache.read(voiceCacheKey('leaf-link')), /链接/);
  assert.throws(() => cache.write(voiceCacheKey('leaf-link'), wav()), /链接/);
  cache.trim();
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.ok(isPlayableWav(fs.readFileSync(external)));
});

test('failed atomic writes clean only their exact exclusive temporary file', (t) => {
  const cache = cacheFor(t), key = voiceCacheKey('atomic');
  fs.mkdirSync(cache.directory);
  const unrelated = path.join(cache.directory, 'unrelated.tmp');
  fs.writeFileSync(unrelated, 'keep');
  t.mock.method(fs, 'renameSync', () => { throw Error('simulated rename failure'); });
  assert.throws(() => cache.write(key, wav()), /simulated rename failure/);
  assert.deepEqual(fs.readdirSync(cache.directory), ['unrelated.tmp']);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('atomic cleanup refuses to unlink a replaced temporary inode', (t) => {
  const cache = cacheFor(t), external = path.join(cache.dataDir, 'replacement.wav');
  fs.writeFileSync(external, wav());
  let planted;
  t.mock.method(fs, 'renameSync', (temporary) => {
    planted = temporary;
    assert.equal(path.dirname(temporary), cache.directory);
    assert.match(path.basename(temporary), /^[a-f0-9]{64}\.\d+\.[a-f0-9-]+\.tmp$/);
    fs.unlinkSync(temporary);
    fs.linkSync(external, temporary);
    throw Error('simulated replacement');
  });
  assert.throws(() => cache.write(voiceCacheKey('replace'), wav()), /simulated replacement/);
  assert.ok(fs.existsSync(planted), 'unverified planted file is not unlinked');
  assert.ok(isPlayableWav(fs.readFileSync(external)));
});

test('same-sentence synthesis coalesces and later requests use the validated cache', async (t) => {
  const gate = deferred(); let calls = 0;
  const synth = synthFor(t, {fetchImpl: () => { calls++; return gate.promise; }});
  const first = synth.prepare('same'), second = synth.prepare('same');
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve(wav());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.cached, false); assert.equal(b.cached, false);
  assert.equal((await synth.prepare('same')).cached, true);
  assert.equal(calls, 1); assert.equal(synth.pending.size, 0);
});

test('synchronous provider throws clear pending state and can be retried', async (t) => {
  let calls = 0;
  const synth = synthFor(t, {fetchImpl: () => { if (++calls === 1) throw Error('sync failure'); return wav(); }});
  await assert.rejects(synth.prepare('retry'), /sync failure/);
  assert.equal(synth.pending.size, 0);
  assert.equal((await synth.prepare('retry')).cached, false);
  assert.equal(calls, 2);
});

test('warmUp reports provider failures explicitly and validates complete line groups', async (t) => {
  const synth = synthFor(t, {fetchImpl: () => { throw Error('TTS HTTP 400'); }});
  const rows = await synth.warmUp({needs_input: ['ask'], completed: ['done']});
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => /TTS HTTP 400/.test(row.error)));
  assert.equal(synth.cache.count(), 0); assert.equal(synth.pending.size, 0);
  await assert.rejects(synth.warmUp({needs_input: [], completed: []}), /1-32 phrases/);
});

test('default provider posts only OpenAI-compatible model/voice/input/WAV to validated endpoint', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    calls++;
    assert.equal(endpoint, 'http://127.0.0.1:8020/v1/audio/speech');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {model: 'test-model', voice: 'test_voice', input: 'say this', response_format: 'wav'});
    assert.deepEqual(Object.keys(options.headers), ['content-type']);
    assert.ok(options.signal instanceof AbortSignal);
    const bytes = wav();
    const response = streamResponse([bytes.subarray(0, 10), bytes.subarray(10, 45), bytes.subarray(45)]);
    response.arrayBuffer = () => { throw Error('Unbounded body buffering is forbidden'); };
    return response;
  });
  const synth = synthFor(t, {settings: {model: 'test-model', voice: 'test_voice'}});
  assert.ok(isPlayableWav((await synth.prepare('say this')).bytes));
  assert.equal(calls, 1);
});

test('provider rejects redirects/HTTP failures, oversized length headers and invalid WAV without cache writes', async (t) => {
  const synth = synthFor(t);
  const responses = [
    () => streamResponse([], {status: 302, headers: {location: 'https://example.com/tts'}}),
    () => streamResponse([], {status: 500}),
    () => streamResponse([], {headers: {'content-length': String(LIMIT + 1)}}),
    () => streamResponse([], {headers: {'content-length': 'not-a-size'}}),
    () => streamResponse([Buffer.from('not WAV')]),
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (_endpoint, options) => { assert.equal(options.redirect, 'error'); return responses[index++](); });
  for (let i = 0; i < responses.length; i++) await assert.rejects(synth.prepare('failure-' + i), /HTTP|byte budget|invalid PCM/);
  assert.equal(synth.cache.count(), 0);
});

test('stream body enforces actual byte budget regardless of missing or lying content-length', async (t) => {
  const synth = synthFor(t); let cancelled = 0, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => streamResponse([Buffer.alloc(LIMIT), Buffer.alloc(1), Buffer.alloc(1)], {
    headers: calls++ ? {'content-length': '1'} : {}, onCancel: () => { cancelled++; },
  }));
  await assert.rejects(synth.prepare('no length'), /byte budget/);
  await assert.rejects(synth.prepare('lying length'), /byte budget/);
  assert.equal(cancelled, 2); assert.equal(synth.cache.count(), 0);
});

test('dispose aborts a blocked response reader and prevents subsequent synthesis', async (t) => {
  const started = deferred(), waiting = deferred(); let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start() { started.resolve(); },
    pull() { return waiting.promise; },
    cancel() { cancelled = true; waiting.resolve(); },
  })));
  const synth = synthFor(t);
  const task = synth.prepare('blocked');
  const rejection = assert.rejects(task, {name: 'AbortError'});
  await started.promise;
  // Let the provider attach the streaming-reader cancellation listener.
  await Promise.resolve(); await Promise.resolve();
  synth.dispose();
  await rejection;
  assert.ok(cancelled);
  await assert.rejects(synth.prepare('after dispose'), {name: 'AbortError'});
  assert.equal(synth.cache.count(), 0);
});

test('timeout abort rejects even a provider ignoring the AbortSignal and never caches its late result', async (t) => {
  const gate = deferred(); let signal;
  const synth = synthFor(t, {settings: {timeoutMs: 1000}, fetchImpl: (_settings, _text, supplied) => { signal = supplied; return gate.promise; }});
  await assert.rejects(synth.prepare('timeout'), /timed out/);
  assert.ok(signal.aborted); assert.equal(synth.pending.size, 0);
  gate.resolve(wav()); await Promise.resolve(); await Promise.resolve();
  assert.equal(synth.cache.count(), 0);
});

test('settings changes isolate all provider dimensions and reject stale ignored-abort results', async (t) => {
  const gate = deferred(); let calls = 0;
  const synth = synthFor(t, {fetchImpl: () => { calls++; return calls === 1 ? gate.promise : wav(); }});
  const oldKey = voiceCacheKey('same', synth.settings);
  const stale = synth.prepare('same');
  const rejected = assert.rejects(stale, {name: 'AbortError'});
  await Promise.resolve();
  synth.settings = {...synth.settings, model: 'new-model', revision: 'new-stamp'};
  await rejected;
  const fresh = await synth.prepare('same');
  assert.notEqual(fresh.key, oldKey);
  gate.resolve(wav()); await Promise.resolve(); await Promise.resolve();
  assert.equal(synth.cache.read(oldKey), null); assert.equal(synth.cache.count(), 1);
  for (const update of [{endpoint: 'http://localhost:9000/tts'}, {voice: 'new_voice'}, {revision: 'next-stamp'}]) {
    synth.setSettings({...synth.settings, ...update});
    assert.equal((await synth.prepare('same')).cached, false);
  }
  assert.equal(calls, 5);
});

test('cancel is reusable and stale cleanup cannot delete the new same-key pending entry', async (t) => {
  const gates = [deferred(), deferred()]; let calls = 0;
  const synth = synthFor(t, {fetchImpl: () => gates[calls++].promise});
  const first = synth.prepare('same');
  const rejected = assert.rejects(first, {name: 'AbortError'});
  await Promise.resolve();
  synth.cancel();
  const next = synth.prepare('same');
  await rejected;
  assert.equal(synth.pending.size, 1);
  gates[0].resolve(wav()); await Promise.resolve(); await Promise.resolve();
  assert.equal(synth.pending.size, 1);
  gates[1].resolve(wav()); await next;
  assert.equal(synth.pending.size, 0);
});

test('invalid new settings cancel old work and cannot silently continue with defaults', async (t) => {
  const gate = deferred();
  const synth = synthFor(t, {fetchImpl: () => gate.promise});
  const task = synth.prepare('stale');
  const rejected = assert.rejects(task, {name: 'AbortError'});
  await Promise.resolve();
  assert.throws(() => synth.setSettings({endpoint: 'https://example.com/tts'}), /Invalid voice endpoint/);
  await rejected;
  await assert.rejects(synth.prepare('new'), /Invalid voice settings/);
  gate.resolve(wav()); await Promise.resolve();
  assert.equal(synth.cache.count(), 0);
});

test('warmUp stops scheduling after dispose instead of invoking later providers', async (t) => {
  const gate = deferred(); let calls = 0;
  const synth = synthFor(t, {fetchImpl: () => { calls++; return gate.promise; }});
  const task = synth.warmUp({needs_input: ['ask', 'ask again'], completed: ['done']});
  await Promise.resolve();
  synth.dispose();
  const rows = await task;
  assert.equal(calls, 1); assert.equal(rows.length, 1); assert.match(rows[0].error, /disposed/);
  gate.resolve(wav());
});
