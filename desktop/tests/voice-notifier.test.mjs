import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VoiceCache,
  VoiceSynth,
  isPlayableWav,
  loadVoiceLines,
  normalizeVoiceSettings,
  pickVoiceLine,
  voiceCacheKey,
} from '../runtime/voice-notifier.mjs';

function wav(seconds = 0.1, rate = 16000) {
  const samples = Math.floor(rate * seconds);
  const data = samples * 2;
  const bytes = Buffer.alloc(44 + data);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + data, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data, 40);
  return bytes;
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-notifier-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, {recursive: true, force: true}); });
  return directory;
}

test('voice settings accept only a loopback endpoint and a safe voice name', () => {
  assert.equal(normalizeVoiceSettings({}).enabled, false);
  assert.equal(normalizeVoiceSettings({enabled: true}).endpoint, 'http://127.0.0.1:8020/v1/audio/speech');
  // A remote host would ship text off the machine, so it must not be accepted.
  const remote = normalizeVoiceSettings({endpoint: 'https://example.com/tts'});
  assert.equal(remote.endpoint, 'http://127.0.0.1:8020/v1/audio/speech');
  assert.equal(normalizeVoiceSettings({endpoint: 'http://localhost:9000/v1/audio/speech'}).endpoint, 'http://localhost:9000/v1/audio/speech');
  assert.equal(normalizeVoiceSettings({voice: '../../etc/passwd'}).voice, 'myvoice');
  assert.equal(normalizeVoiceSettings({voice: 'koharu6_cb'}).voice, 'koharu6_cb');
  assert.equal(normalizeVoiceSettings({timeoutMs: 999999}).timeoutMs, 60000);
});

test('voice lines are read from JSON and reject junk entries', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'lines.json');
  fs.writeFileSync(file, JSON.stringify({lines: {completed: ['ok', '', 42, 'x'.repeat(500)], needs_input: ['ask']}}));
  const lines = loadVoiceLines(file);
  assert.deepEqual(lines.completed, ['ok']);
  assert.deepEqual(lines.needs_input, ['ask']);
  // Missing or unparsable files degrade to empty groups, never throw.
  assert.deepEqual(loadVoiceLines(path.join(dir, 'missing.json')), {needs_input: [], completed: []});
  fs.writeFileSync(file, '// not json');
  assert.deepEqual(loadVoiceLines(file).completed, []);
});

test('line selection is stable per counter so cache entries are reused', () => {
  const lines = {completed: ['a', 'b', 'c'], needs_input: ['q']};
  assert.equal(pickVoiceLine(lines, 'completed', 0), 'a');
  assert.equal(pickVoiceLine(lines, 'completed', 3), 'a');
  assert.equal(pickVoiceLine(lines, 'completed', 4), 'b');
  // Math.abs(-1 % 3) is 1, so a negative counter still maps to a valid index
  // instead of reading past the end of the array.
  assert.equal(pickVoiceLine(lines, 'completed', -1), 'b');
  assert.equal(pickVoiceLine(lines, 'unknown', 0), '');
  assert.equal(pickVoiceLine({completed: []}, 'completed', 0), '');
});

test('non-WAV and truncated payloads are rejected before they reach the player', () => {
  assert.equal(isPlayableWav(wav()), true);
  assert.equal(isPlayableWav(Buffer.from('not a wav file at all, just text...')), false);
  const truncated = wav().subarray(0, 40);
  assert.equal(isPlayableWav(truncated), false);
  const lying = wav();
  lying.writeUInt32LE(999999, 4); // declares more bytes than it carries
  assert.equal(isPlayableWav(lying), false);
  assert.equal(isPlayableWav(Buffer.alloc(0)), false);
});

test('cache stores valid audio, refuses junk, and evicts oldest entries', (t) => {
  const dir = path.join(tempDir(t), 'cache');
  const cache = new VoiceCache(dir);
  const key = voiceCacheKey('hello', 'myvoice');
  assert.equal(cache.read(key), null);
  cache.write(key, wav());
  assert.ok(cache.read(key));
  assert.throws(() => cache.write(voiceCacheKey('bad', 'myvoice'), Buffer.from('nope')));
  // Bounded growth: writing many entries must not keep them all.
  for (let i = 0; i < 300; i++) cache.write(voiceCacheKey('line ' + i, 'myvoice'), wav());
  assert.ok(fs.readdirSync(dir).filter((n) => n.endsWith('.wav')).length <= 256);
});

test('synthesis happens once per sentence and concurrent callers share it', async (t) => {
  const dir = path.join(tempDir(t), 'cache');
  const cache = new VoiceCache(dir);
  let calls = 0;
  const synth = new VoiceSynth({
    cache,
    settings: normalizeVoiceSettings({enabled: true}),
    fetchImpl: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return wav(); },
  });
  const [first, second] = await Promise.all([synth.prepare('同一句'), synth.prepare('同一句')]);
  assert.equal(calls, 1, 'concurrent requests for one sentence must coalesce');
  assert.equal(first.cached, false);
  assert.equal(second.cached, false);
  const third = await synth.prepare('同一句');
  assert.equal(calls, 1, 'a cached sentence must not hit the service again');
  assert.equal(third.cached, true);
  assert.ok(isPlayableWav(third.bytes));
});

test('a failing TTS response is reported and leaves no cache entry', async (t) => {
  const dir = path.join(tempDir(t), 'cache');
  const cache = new VoiceCache(dir);
  const synth = new VoiceSynth({
    cache,
    settings: normalizeVoiceSettings({enabled: true}),
    fetchImpl: async () => { throw Error('TTS HTTP 400'); },
  });
  await assert.rejects(() => synth.prepare('失败'), /TTS HTTP 400/);
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.wav')).length : 0, 0);
  const warm = await synth.warmUp({completed: ['失败'], needs_input: []});
  assert.equal(warm.length, 1);
  assert.match(warm[0].error, /TTS HTTP 400/);
});
