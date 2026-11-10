# Local notification speech

The desktop can pre-synthesize short **completed** and **needs_input** notifications through an existing local TTS service. Notification playback should use a validated cache hit immediately, not wait for synthesis. This feature does not start a server, add a listener port, install a provider, execute commands, or read credentials. Enabling/configuring it and deciding which events to play are desktop integration responsibilities.

## Protocol and settings

`normalizeVoiceSettings({enabled, endpoint, voice, model, revision, timeoutMs})` returns a frozen settings object:

| Field | Public default | Contract |
| --- | --- | --- |
| `enabled` | `false` | Enabled only for literal `true`; the caller controls event/warm-up scheduling. |
| `endpoint` | `http://127.0.0.1:8020/v1/audio/speech` | Parsed/canonicalized by `URL`; HTTP only, with hostname `127.0.0.1`, `localhost`, or `[::1]`. Credentials (including empty user-info), query, fragment, whitespace, backslashes, port 0, invalid ports, remote hosts and other protocols are rejected. |
| `voice` | `myvoice` | 1–80 ASCII letters, digits, underscores or hyphens. |
| `model` | `genie` | 1–100 ASCII letters/digits or `._/-`, starting with a letter/digit. |
| `revision` | empty string | Up to 128 ASCII letters/digits or `._-`. Use a unique, non-secret voice/model artifact stamp. |
| `timeoutMs` | `20000` | Finite numeric values are truncated/clamped to 1,000–60,000 ms. |

An omitted endpoint selects the default. A supplied invalid endpoint is an **explicit error**, never a silent fallback. Invalid supplied identifiers/timeouts also fail explicitly. Keep personal cloned-voice names and private phrases in local configuration, not public tracked files. When replacing weights behind an unchanged endpoint/model/voice, change `revision`; the runtime cannot identify an unannounced server-side artifact replacement.

Synthesis uses one `POST` with `content-type: application/json; charset=utf-8`:

```json
{"model":"genie","voice":"myvoice","input":"A configured phrase","response_format":"wav"}
```

The only provider extension point is this OpenAI-compatible HTTP speech protocol plus configurable model/endpoint/voice/revision, **not arbitrary executable providers**. There is no authorization header or credential discovery. Fetch uses `redirect: 'error'` so a loopback redirect cannot forward phrases to another host. Non-2xx responses fail. A missing or dishonest content-length does not bypass the limit: the response is read as a stream with an actual **8 MiB** ceiling, checked before copying every chunk. Allocation is bounded independently of the number of network fragments. Timeout/cancellation aborts the fetch and cancels the reader.

Only complete little-endian RIFF/WAVE is accepted. Validation walks the chunk table with length/odd-padding checks, permitting ancillary chunks rather than assuming data starts at byte 44. Exactly one `fmt ` and one nonempty `data` chunk are required. Audio must be PCM format 1, 16-bit mono/stereo, at 8,000 / 11,025 / 12,000 / 16,000 / 22,050 / 24,000 / 32,000 / 44,100 / 48,000 Hz, with consistent frame alignment/byte rate and duration **at most 30 seconds**. Duplicate, truncated, unsupported and oversized payloads never reach the cache/player.

## Runtime API and lifecycle

- `voiceCacheKey(text, settings)` hashes a versioned tuple of canonical endpoint, model, voice, revision and exact text with SHA-256. Changing any provider/voice identity produces a different cache key; enabled/timeout changes do not. The legacy `voiceCacheKey(text, voiceString)` form means the default endpoint/model/revision only. Integration must pass the **whole settings object**.
- `new VoiceCache(absoluteDirectory, {dataDir}?)` uses the exact `voice-cache` child of an independently owned data directory. `dataDir` defaults to the parent directory. Installation/integration must already have claimed that data directory with the inherited storage ownership helper; the cache never adopts or claims an unowned folder.
- `cache.read(key)` returns validated WAV bytes or `null` for missing/invalid audio. Invalid keys or unsafe ownership/path configurations throw. `cache.write(key, bytes)` validates before writing; `cache.trim()` enforces bounds; `cache.count()` counts verified regular cache entries.
- `new VoiceSynth({cache, settings, fetchImpl?})` snapshots normalized, frozen settings. `prepare(text)` returns `{key, bytes, cached}`. Concurrent same-key requests share one provider request. Provider failures, synchronous throws, invalid audio and timeouts reject without poisoning the pending map. `fetchImpl` is an in-process test seam, not a configured provider command.
- `warmUp({needs_input, completed})` validates both nonempty phrase groups, synthesizes serially, and returns per-phrase `{kind, text, cached}` or `{kind, text, error}` results. It stops scheduling when cancelled/reconfigured/disposed.
- `cancel()` aborts current work and permits later requests. `setSettings(value)` (or assigning `synth.settings`) first cancels old work and invalidates its generation, then validates the replacement. An invalid replacement leaves no usable configuration. `dispose()` permanently rejects future synthesis and aborts all current work. Dispose the previous instance before replacing it or disabling notifications.

Cancellation rejects promptly even if an injected provider ignores the signal. Late results from aborted/reconfigured/disposed instances cannot write cache entries. Cleanup from a stale request cannot delete a newer same-key pending entry. Integrations must also discard stale warm-up/playback callbacks when replacing their holder.

## Phrase files

The shipped phrase file is [voice-lines.json](../desktop/assets/voice-lines.json). This change does not rewrite its existing five phrases. The loader preserves each phrase exactly; it does not add names, greetings, translations, punctuation or trim configured text.

`loadVoiceLines(file)` requires a regular bounded UTF-8 JSON file with `schemaVersion: 1`, exactly the two `lines` groups `needs_input` and `completed`, and optional structured `notes` (`purpose`, `kinds`, `keepShort`). Unknown schema fields/groups, missing/unparseable files and empty groups are explicit errors, not silently empty output. Each group contains 1–32 nonblank strings, each at most 200 UTF-16 code units without control characters; combined phrase text is at most 8,000 code units and the file at most 32 KiB. Notes strings are at most 1,000 code units each.

`pickVoiceLine(lines, kind, counter)` rotates deterministically; negative counters retain stable absolute-index behavior. Fractional counters truncate, while nonfinite/non-numeric/unsafe counters safely select index zero. Unknown/empty groups return an empty string.

## Storage safety

The cache inherits independent-path/data-ownership checks and rejects linked directory ancestors. Only lowercase 64-hex `.wav` names are cache entries. Reads/eviction require regular, single-link files, checked by `lstat`, no-follow open where supported, and descriptor identity comparison. Reads check file size before allocation. Directory enumeration is bounded to 4,096 total entries; excessive foreign clutter is an explicit error.

Writes use exclusive random, mode-0600 temporary files in the same checked cache directory, flush then rename atomically, and verify existing targets instead of replacing links. Failure cleanup can remove only that write's exact checked temporary inode. Eviction verifies each exact path/identity again and never unlinks unknown names, links, directories, or hard links. Cache retention is at most **256 entries / 64 MiB** after successful trimming. If safe eviction cannot establish those bounds, trimming fails explicitly rather than claiming success. Foreign/unverified entries are left untouched rather than deleted to make space. As with the inherited storage helper, the owned data directory must not be writable by an untrusted concurrent process; these checks are not a replacement for OS account/ACL isolation.

## Isolated verification

From the project root, run Node 24:

```text
node --test desktop/tests/voice-notifier.test.mjs
```

The suite injects mocked fetch/providers and temporary, project-local independently claimed data directories (removed after each test). It does not call a real TTS service, open a listener, play audio, deploy or push changes. It covers provider identity invalidation, strict URLs/schema, PCM chunk parsing, streaming byte limits, ownership/links, eviction/atomic cleanup, cancellation/timeouts and stale/synchronously failing requests. The leaf-file symlink case reports a skip if Windows does not grant file-symlink privilege; directory-junction and hard-link cases run separately.
