# dsh-gpt-companion-bridge

Version **0.1.0-beta.1** — separate DSH bundle for **GPT龙娘 · DSH独立版**. This package does not replace the original companion or Codex subscription plugin.

## What it does

- Uses a standard DSH browser client and the existing authenticated Connection RPC to read public Codex subscription status/usage.
- Projects only normalized quota, sanitized public title/session metadata, a live completion cursor and bounded numeric-only per-model ledger exports into `<DSH_HOME>/state/dsh-gpt-companion/<DSH_PROFILE or desktop>`.
- Desktop reads only snapshots and writes one fixed bounded owner-fenced consumer-control file. No desktop DSH HTTP calls, browser cookie/token, credential file or copied conversation logs are needed.
- Performs genuine manual force refresh with host/client ACKs (not an old-file reread), 60s visible polling and immediate refresh on resuming visibility. Hidden consumers make no new quota query; public identity-only checks every30s preserve account-scoped numeric history. Manual clicks coalesce and are limited to one force attempt per10s.
- Invalidates prior account active snapshots on reported switch/failure, lease expiration, host restart and disposal; account-isolated numeric archives are retained for later catch-up. Expired/missing data is unknown, not fresh quota.
- Uses official cumulative tokenUsage projections, per-step retry/replacement conservation and real verified model metadata. Unverifiable model metadata is explicitly unknown/unpriced. Fork/inherited baseline counters are excluded.

## Build and isolated checks

Runtime engine range: Node `^22.19.0 || >=24.0.0` (same floor as the official subscription plugin). Isolated tests were run with bundled Node **24.21.0** and pnpm **11.28.5**; Node22 compatibility has not been execution-tested here. The optional Connection peer is pinned to the actual tested host SDK **0.2.1-rc.5**, not an untested newer SDK. There are **no build dependencies or install step** and no host upgrade is requested.

```text
node scripts/build.mjs
node --test tests/*.test.mjs
pnpm pack --pack-destination artifacts
```

The generated `lib/index.mjs` is the ESM host entry, `lib/client.js` is a standard `window.__ModuleLoader__.load` browser entry, and `lib/bridge-protocol.mjs` is a packaged copy of the canonical shared schema. Manifest exports, optional DSH Connection peer and `cordis.patch.yml` form a standard DSH bundle package. The dependency-free build intentionally rejects unsupported new module syntax rather than emitting a broken client.

For optional real SDK conformance checks set **DSH_BRIDGE_TEST_SDK_ROOT** to an existing DSH package root. Tests load its public request schema and stage the package import in a project-local fixture; they do not read credentials, run DSH or open a listener. All filesystem integration tests write only project-local test fixtures.

## Runtime requirements and safety

DSH Connection and its already-authenticated loopback web page must be active. The separately installed `dsh-codex-subscription` must expose public status and usage endpoints, with an active public account id. Official sessionProjections/tokenUsage/title services are used if available; unavailable usage remains unknown. Owned-desktop shell forwarding without Origin is supported only after DSH's existing owner admission and with a strict actual loopback Host; no authentication bypass or cookie copy is introduced. Present Origin remains strict same-origin, and malformed Host/cross-site/foreign-origin requests are rejected. Remotely hosted browser clients remain unsupported.

Only one client lease is active. Browser closure, disconnect or timer suspension can delay notification; the lease/source TTL is90s, host heartbeat TTL20s. Identifiable account changes in another plugin are detected by the next public-status check (normally30s;18s request timeout), not by an undocumented synchronous hook. Usage queries bracket identity before/after. Desktop controls heartbeat every5s with15s TTL (20s maximum); no valid consumer means hidden. A genuine authenticated client polls controls every5s, and a running manual claim without a completion times out after30s. Expired quota alone is unknown without clearing a still-verified ledger account; identity failure/change still invalidates the old account. The fingerprint hashes public slot id plus public email when available, never raw credentials. It relies on public status semantics; indistinguishable same-slot replacements cannot be independently identified. A same-user malicious process with filesystem rights is outside this boundary. Windows ACLs are inherited from the user's DSH_HOME; POSIX owner-only modes are requested where supported.

Per-model exports are atomic **rewrites**, not append-only raw logs. Consumers must validate the strict contract, associate shards back to the real hashed session, and replace prior shard records transactionally on correction. They must bound all reads and use only the host allow-list. Telemetry retention is bounded (64 sessions/log shards and120 settlements per segment); opaque shard ids rotate without overwriting previously imported segments, and live epoch totals carry earlier segment counts. Capacity/reset/missing-projection failures become unknown rather than invented usage. Durable numeric archives additionally preserve canonical shards at `archive/<verifiedAccountKey>/<originEpoch>-<logId>.jsonl`, independent of active rotation and panel visibility, so readers can flat-budget catch up after closing the panel or reconnecting the same account. Model corrections emit empty canonical tombstones to retract old attribution, not double-charge it. Default numeric archive budget is512MiB/65536 files with no silent eviction; budget/storage/projection/dirty-startup failures persist a sticky collection gap in the independent archive-status snapshot. Startup indexing yields in128-entry batches; pending work is bounded, signalled and coalesced. This is observed numeric history since verified collection began, not a claim to all pre-existing/unobserved DSH history. Consumers preserve already-imported account-scoped history and must display syncing/gap status rather than imply completeness. No claim is made that all upstream desktop features or real DSH integration have been verified.

The full field and lifecycle contract is included as [the bridge contract](lib/BRIDGE-CONTRACT.md), copied at build time from the project's canonical contract. It includes account isolation, reader race checks, units, model metadata and test limitations.

**Nothing here installs, starts or reconfigures DSH. Deployment, package installation, real login/quota/UI testing and any startup registration require separate explicit user approval.**
