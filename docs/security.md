# Security contract — management half (1.2.1 → 1.4.0)

This note records what the MCP server management half (`lib/management.js`, `client.js`)
promises, and the raw evidence behind it. It is written from the code and from a real,
isolated DSH boot; anything not verified is marked as such.

The disclosure half (`index.js`) exposes no network surface. Its trust boundary is
described in `README.md` → Limitations (hiding is view + dispatch, not a permission
boundary). 1.3.0 adds one read of the running MCP client's status cell; it opens no new
surface and no write path (§3.1). 1.4.0 adds no route, permission or write either: its only
change is a browser-side guard that disables Stop/Restart while a row may still be spawning
(§8, R1).

## 1. What listens

Three exact routes on the host's own web listener, registered only when the management
half is active:

| Route | Methods | Purpose |
|---|---|---|
| `GET/HEAD /dsh-mcp-hub/state` | `GET`, `HEAD` only | Server inventory |
| `POST /dsh-mcp-hub/toggle` | `POST` only | Start/stop one server (`enabled`); answers inventory + result |
| `POST /dsh-mcp-hub/restart` | `POST` only | Stop then start one server; answers inventory + result |

The management half is injected with `['pluginManager', 'profileContext', 'webServer',
'loader', 'connection']` (`index.js`), so a host that lacks the Host `connection` service
registers neither the two management tools nor the three routes, and a headless profile
registers neither tools nor routes. The routes have no authentication of their own: they
borrow the Host's.

## 2. Request pipeline (in order)

Every handler runs the same sequence, and each step answers before any state is read:

1. **Host admission** — `rejectUntrusted` calls
   `connection.requestRejection(req)` (`dsh-client-connection`), whose verdict is the
   platform's Host/Origin fence plus browser authentication:
   `401` unauthenticated, `403` foreign `Host` / cross-site `Origin` / disposed carrier.
   A fence that throws is treated as forbidden (fail closed). The response body is
   `{ ok: false, error: "unauthorized" | "forbidden" }` — no inventory, no hint. If the
   service (or its `requestRejection`) is absent — an HMR recomposition can leave the
   routes mounted for a moment — the answer is `503
   {"ok":false,"error":"management routes require the Host connection service"}`; nothing
   is read, queued or written.
2. **Method** — `requireMethod`: `405` with an `Allow` header (`state` → `GET, HEAD`;
   the POST routes → `POST`).
3. **Content type** — `checkJsonContentType`, POST routes only: the media type must be
   `application/json` — case-insensitive, parameters such as `; charset=utf-8` ignored.
   A missing header is refused exactly like a different type: `415`. An HTML form or a
   cross-site `fetch` cannot declare JSON without a preflight, so the media type is part
   of the admission gate in front of the mutation path.
4. **Body** — `readJsonBody` (max 64 KiB, `413`; drained so the client receives the
   status instead of a reset; a client that disconnects mid-body rejects with an
   `AbortError` on `close`/`aborted`, so the handler cannot stay pending forever) then,
   in order:
   `validateBodyObject` (JSON object, not array/primitive), `validateAddressing`
   (`entryId`/`id`/`server`, when present, must be non-empty strings; at least one must
   be present), `validateEnabled` (`enabled` must be a real boolean — `"true"`, `null`,
   `1` and missing are all `400`). All failures are `400` and happen **before** any row
   lookup or queue entry.
5. **Operation** — serialized in one process-wide queue. The addressed row is resolved
   from live state inside the task; 16 waiting operations maximum (`429` beyond that).
   Each manager call is bounded by the earlier of a per-call 5 s budget and the operation
   deadline, and the 30 s operation budget starts when the task reaches the head of the
   queue (not when it joined it). A stalled inventory/phase read (`listPlugins`) answers
   `504`; a stalled enable write (`setPluginEnabled`) surfaces as `500` carrying the
   manager diagnostic. A phase wait times out at 30 s with `500` and the observed state.
   The request's `close`/`aborted` events abort the wait. A `restart` that is interrupted
   — by an abort or by a non-abort stop failure such as the 30 s phase timeout — restores
   the saved pre-restart preference (the abort path on a fresh, non-aborted signal) and
   reports `rollback`; an already-disabled restart performs no rollback write.

JSON answers always carry `content-type: application/json; charset=utf-8`,
`cache-control: no-store` and an explicit `content-length`. Error payloads add
`candidates` (ambiguity), `application`, `code`, `observed` and `rollback` when known.
A parse error never repeats request bytes, because a caller could put a secret there.

## 3. Addressing and redaction

- `entryId` → `id` → `server` (name, row id or entry id) precedence, every comparison
  exact. A case-insensitive server-name match is accepted only when it lands on exactly
  one row; ambiguity is `400` with the candidates instead of a guess.
- Module identity is `@deepseek-ai/dsh-mcp-client` or a subpath of it — never a prefix
  match, so `…-client-extra` is not treated as an MCP server.
- `targetSummary` never carries a credential: stdio rows print the executable basename
  plus up to four flag **names** (`--token=SECRET` → `--token`; a value attached to a
  short option such as `-pSECRET` is omitted entirely, not shortened), and a URL that
  cannot be parsed becomes `(invalid URL)`; a valid URL prints only `.host` (topology,
  not a secret).

### 3.1 Live status read (1.3.0)

Every server row (state route, model list) may additionally carry its live connection status,
read from the **running** `@deepseek-ai/dsh-mcp-client` instance through the Loader entry that
row really imported:
`entry.moduleNamespace.connectionStatusOf(entry.fiber?.ctx?.fiber ?? entry.fiber).current()`.
It is read-only:

- no route, method, header or approval change — the pipeline in §2 is unchanged, and the read
  never writes a patch, never calls `setPluginEnabled`, and never subscribes (`onChange` is not
  called: the client returns a disposer and there is no host-owned place for the plugin to keep
  it, so per-request subscription would leak);
- the copied data is **whitelisted**: `state`, `reason`, `lastError`, `toolCount`, `connectedAt`,
  `attempt`, `maxAttempts`, `nextRetryAtMs`; `lastError` is collapsed to one line and its segment
  is clipped to 120 chars in `statusDetail` (the whole detail is also bounded by the
  `failed: <reason>` / `reconnecting …` prefix — observed max ≈177 chars in total), numbers must
  be finite, and a value that is not an object with a non-empty string `state` is dropped
  entirely, so a status cell cannot smuggle fields into the payload; `lastError` is rendered only
  from primitive values, so a hand-built object cannot throw the detail builder;
- the plugin adds **no credential or argument material** of its own: `lastError` is the MCP
  client's own error line, surfaced to the authenticated panel/model as the client wrote it
  (the plugin does not expand `${credential:…}` templates or echo argv), and `targetSummary`'s
  redaction above is unchanged;
- the seam is not a documented plugin contract: it is guarded by
  `typeof moduleNamespace.connectionStatusOf === 'function'` and `try/catch`, and any failure
  falls back to the 1.2.1 inference. A failed read can never be reported as "connected", so
  breaking the seam cannot forge a status — it can only degrade to the older, less specific
  answer. `scripts/probe-live-status.mjs` fails loudly when a DSH release moves it.

## 4. File writes

A home-patch row is toggled by writing `~/.dsh/cordis.patch.yml`
(`profileContext.home` + `cordis.patch.yml`). The write is a transaction
(`lib/patch.js`):

- edit on the YAML AST (`yaml`), preserving comments, CRLF style and insert groups;
  a platform-valid leading BOM is stripped for the AST and re-emitted on write, so a
  BOM-prefixed file is togglable and keeps its byte prefix;
- re-parse and verify the composition before writing: top-level entries and every
  insert group unchanged, and the target id's effective `disabled` equal to the
  requested value, otherwise throw and leave the bytes untouched;
- rows that exist only inside an `insert` group get a verified top-level
  `- id: … / disabled: …` override;
- write to an exclusive (`wx`) random-suffix sibling, `chmod` to the exact target mode,
  then `rename` over the real path (`realpathSync`; a symlinked dotfile stays a symlink,
  a dangling symlink is refused);
- mode is the existing file's, or `0600` for a new one; the pre-write copy is a `0600`
  `.mcp-hub.bak` and a failure to write it aborts the change;
- compare-and-swap against the text read in the same attempt (3 attempts, then throw).
  There is **no cross-process lock**: a concurrent `plugin_manager` (pnpm) write is
  detected and retried, not coordinated.

A profile/bundle row is changed through `pluginManager.setPluginEnabled`, never by this
write path; after a manager refusal nothing is written to a patch (`application`
outcomes are exhaustive, `failed`/`cancelled` throw with the manager's diagnostic).

## 5. Approval

`mcp_server` start/stop/restart returns `{ kind: 'ask', reason, displayReason }` from a
`tools/pre-execute` handler, so every model-initiated mutation goes through the platform
approval pipeline (`plugin_manager` follows the same pattern). `reason` is the audited
plain string; `displayReason` is the `{ en, zh }` locale record the platform contract
declares, so a consumer reading `.en` finds text. `mcp_servers` and all
browser routes are not gated: a human clicking the panel is the consent. If the host has
no approval service, the platform denies the ask rather than running it (verified in the
unpacked runtime: `dsh-tools/lib/pipeline.js` → `serviceAsk` returns an approval denial
when `ctx.get('approval')` is absent).

## 6. Verified status matrix

Probe: a throw-away `DSH_HOME` (temp dir), a `test` profile with this worktree's package
installed, `dsh --profile test --port 0 --no-open`, a real session cookie minted from the
launch token, and raw `node:http` requests so `Host` is actually sent (`fetch` silently
drops a custom `Host`). The only mutation attempted is against a non-existent server, so
nothing was start/stoppable.

| Probe | Result (measured on 1.2.1; 1.3.0 changes no admission code) |
|---|---|
| `GET /state`, no cookie | `401` `{"ok":false,"error":"unauthorized"}` |
| `GET /state`, `Host: evil.example`, no cookie | `403` `forbidden` |
| `GET /state`, `Host: evil.example`, valid cookie | `403` `forbidden` |
| `GET /state`, `Origin: https://evil.example` + `Sec-Fetch-Site: cross-site`, valid cookie | `403` `forbidden` |
| `POST /toggle`, no cookie | `401` `unauthorized` |
| `POST /toggle`, valid cookie, `content-type: text/plain` | `415` `content-type must be application/json` |
| `POST /toggle`, valid cookie, JSON body, no `content-type` header | `415` `content-type must be application/json` |
| `POST /toggle`, valid cookie, `Application/JSON; charset=utf-8` | `404` `unknown MCP server "no-such"` — media type accepted, body reached addressing |
| `GET /toggle`, valid cookie | `405`, `Allow: POST` |
| `POST /toggle`, valid cookie, `{server:"x"}` (no `enabled`) | `400` `enabled must be a boolean (received undefined)` |
| `POST /toggle`, valid cookie, `{server:"x",enabled:"true"}` | `400` `enabled must be a boolean (received string)` |
| `POST /toggle`, valid cookie, `{server:"no-such",enabled:false}` | `404` `unknown MCP server "no-such"` |
| `GET /state`, valid cookie | `200` `{"ok":true,"now":…,"servers":[]}` |
| `DELETE /state`, valid cookie | `405`, `Allow: GET, HEAD` |

These match the unit-level contract in `test/management.test.mjs` (rejected admission,
`401` preservation, fail-closed fence, `415` for a declared and for a missing content type,
`405` + `Allow`, strict `enabled`, `413`, `429`, `404`/candidate handling). One case is
covered by the suite but not by this raw probe: an absent or incapable `connection` service
is `503` (`test/management.test.mjs` ›
`all three routes fail closed with 503 when the connection service is absent`; the mount
gate itself is `test/core.test.mjs` › `management admission requires the Host connection service`).

Reproduce with ephemeral state only: point `DSH_HOME` at a `mkdtemp` directory, boot with
`--port 0`, mint the cookie with one `GET /?token=…`, and remove the directory afterwards.
`scripts/live-boot.mjs` automates exactly this and is the release gate; §7 records its expected matrix.

## 7. Verification gates

These three scripts are release gates now; CI runs none of them (`npm test` is CI's gate).

### 7.1 Real boot — `node scripts/live-boot.mjs` (default `--expect fixed`)

It creates a throw-away `DSH_HOME`, installs this package into a `test` profile, boots
`dsh --profile test --port 0 --no-open`, mints the browser cookie from the launch token,
drives the routes with `node:http` (so an explicit `Host` really reaches the server),
snapshots both patch layers before and after, and requires every probe to match.

| Probe | Accepted | Observed (HTTP matrix measured on 1.2.1, re-confirmed by the 1.3.0 gate; the live rows exist from 1.3.0) |
|---|---|---|
| `state-unauthenticated` | `401` or `403`, JSON refusal | `401` (no authenticated peer) |
| `state-bad-host` | `403`, JSON refusal | `403` |
| `toggle-text-plain` | `415` | `415` |
| `toggle-get-method` | `405`, `Allow: POST` | `405` |
| `toggle-missing-enabled` | `400` | `400` |
| `toggle-enabled-string` | `400` | `400` |
| `toggle-no-content-type` | `415` | `415` |
| `state-wrong-method` (`POST /state`) | `405`, `Allow: GET, HEAD` | `405` |
| `state-authenticated` | `200` | `200` |
| `state-live-broken` (row `mcp-probe-broken`) | — (`skip`: 1.2.0 rows carry no `live` field) | `status: error`, `live.state: failed`, `statusDetail` contains `ENOENT`, row `fiberPhase: active` |
| `state-live-connected` (row `mcp-probe-ok`) | — (`skip`) | `status: running`, `live.state: connected`, `live.toolCount: 2`, `statusDetail: null` |

`state-unauthenticated` accepts either status because the platform may reject the request at
the Host/Origin fence (`403`) or, once the Host is accepted, for the missing authenticated
peer (`401`); both are the platform's verdict and the plugin passes them through. The gate
also requires the two patch layers to be byte-identical afterwards — every rejected probe
changed nothing — and it asserts the JSON refusal shape (`{ok:false,error}`) instead of a
body-less reset. The gate is a **rejection matrix**: it never performs a valid
authenticated toggle, so it proves the admission/validation boundary rather than the
write path; a valid toggle against the fake environment is covered by
`scripts/repro-review.mjs` probe C, and the audit's own live valid-toggle probe confirmed
the home-patch write path separately. The 1.3.0 boot also declares two real MCP loader rows —
`mcp-probe-broken` (a command that cannot spawn) and `mcp-probe-ok` (a minimal stdio MCP server
written into the temp home, exposing two tools) — waits until both rows publish a settled live
state (≈70 ms; `live rows settled: yes`) and asserts `state-live-broken` / `state-live-connected`
as in the table above; the broken row is `fiberPhase: active` while its live state is `failed`,
which is exactly why inference alone would have said "idle". On this tree the gate is
`PASS (11/11)`. `--expect baseline` documents the 1.2.0 matrix and only matches a v1.2.0
checkout; it reports the two live probes as `skip`. A skip is printed and counted separately:
a run that needed one exits 0 where CI/fallback require it, but its verdict is not the
authoritative gate — the fallback prints `PASS (9/11, 2 skipped — fallback/no runtime: skips
are not evidence)` and `--json` carries `skipsNotEvidence` / `authority`. Without the
unpacked runtime the script falls back to an in-process HTTP server behind a stub fence and
reports `mode: fallback-http`, `platformAuthority: false`; the live probes are skipped there too
(no real Loader row) — the handler contract, not the platform wiring.

### 7.2 Repro gate — `node scripts/repro-review.mjs` (default `--expect fixed`)

It replays the six reviewed defect families and exits 0 only when none reproduces (exit 1
with `REGRESSION: <families>` otherwise); where a family can observe the repaired outcome
(management admission, control queue, rendered panel message, search recall, schema fitting)
it requires that outcome too. Its management family drives the real handlers with a
**stub** connection fence that mirrors the platform (untrusted `Host` → `403`, no cookie →
`401`) — `scripts/live-boot.mjs` remains the real-platform authority. Without the DSH
runtime the YAML family reports `skip` (the platform insert/override rule cannot be stubbed
honestly) and the gate still exits 0 when nothing reproduces; the verdict counts it separately
(`(5/6 evaluated, 1 skipped — skips are not evidence)` in both the reproduced line and the
PASS line) and `--json` carries `skipsNotEvidence` / `authority`, so a skipped run is not the
six-family gate. `--expect baseline` is the historical 1.2.0 mode and passes only on a v1.2.0
checkout.

The `repro-review` and `live-boot` gates were checked against the `v1.2.0` tag in both
directions: on `v1.2.0` the baseline modes pass and the fixed modes fail, and on this release
the reverse.

### 7.3 Capability gate — `node scripts/probe-live-status.mjs`

The live-status read depends on an undocumented Loader shape. This gate asserts the capability
itself, without the HTTP stack, against a real Cordis `Context`, the real Loader and the
installed `@deepseek-ai/dsh-mcp-client` (two rows in a `mkdtemp` home: a broken command and a
minimal stdio MCP server exposing two tools):

| Assertion | What must hold |
|---|---|
| A | `typeof entry.moduleNamespace.connectionStatusOf === 'function'` on every MCP row, and the plugin's `liveStatusOf()` reads both rows |
| B | The broken row ends `failed` with `ENOENT` in `lastError`, presented as `status: error` with the spawn text in `statusDetail` |
| C | The real row ends `connected` with `toolCount >= 2`, presented as `status: running` with no detail |
| D | `collectServerRows` creates no `onChange` subscription (public `onChange` instrumented before the read; the client's private observer set checked when readable) |

It exits 0 only when all eight assertions pass. A failed run prints the verdict and exits 1
through its own code, never 143: cleanup quiesces the rows (bounded) before disposing, leaves a
row that is still mid-spawn undisposed, reaps the server children it created (pid files plus a
bounded command-line scan), removes the temp home, and records an in-process `SIGTERM` instead of
letting it decide the exit. `--json` adds `exitCode`, `cleanup` and `signals`; the hidden
`PROBE_LIVE_FORCE_FAIL=1` knob exercises that negative path without editing an assertion
(observed: exit 1, temp home removed, no leak). Without the DSH runtime it prints `SKIP: runtime
unavailable` (plus the missing packages) and exits 0, so a runtime-less checkout stays green —
`--json` marks `skipped: true`, `authority: false`, and the printed line says the skip is not
evidence. The script exists so a DSH release that moves the seam fails loudly instead of quietly
degrading to the inference.

### 7.4 Fixture note

The real-runtime smoke fixture that previously lacked a Host `connection` service is fixed in
`02fe061`: `mountPlugin()` now provides it (and `mountPlugin({ connection: false })` models a
host without it). With the runtime present `npm test` is 199 tests, 196 pass / 3 skip /
0 fail (the three optional real-catalog cases skip unless `MCP_REVIEW_CATALOG` points at a
local copy of the review catalog, which makes it 199 pass / 0 skip), and without the runtime
(`DSH_RUNTIME=/nonexistent`, what CI has) it is 199 tests, 178 pass / 21 skip / 0 fail. The
1.3.0 live-status and 1.4.0 hazard cases run in every posture: their fixtures need no DSH
runtime.

### 7.5 Independent 1.2.1 audits (2026-11-19)

Two adversarial audits of this candidate (`audit-security.md`, `audit-core-docs.md`) shaped
the final code:

- The **security audit** verdict was **ship-with-notes**: no authentication bypass (fence
  verdicts `401`/`403`/`503`, admission strictly before method/content-type/body), no path,
  method or header bypass, no way to make the plugin write an invalid patch, no
  credential/argv/invalid-URL leak, and no injection sink in the client. Its F1–F4 and
  F6–F8 were fixed in this release; F5 (no cross-process lock, visible `PATCH_STALE` under
  more than two concurrent writers) remains the one documented residual, and F9 was a doc
  nit.
- The **core audit** verdict at review time was **do-not-ship** because of its F1: the
  `mcp_call` nested-event logging left an orphan tool message and made the next DeepSeek
  request fail with `INVALID_REQUEST`. That logging is removed (no session events; the
  audit line is in the result), the real-`dsh-session` regression now locks the history
  invariant, and the audit's doc/limitation findings (F2/F3/F6/F8) are reflected in this
  document and the README. F4 is partially addressed (one real `Session` test; the
  Agent/SystemPrompt seams are still stubbed) and F7 is recorded as the live-boot gate's
  coverage boundary in §7.1.

Final postures on this tree: `npm test` 199 tests — 196 pass / 3 skip / 0 fail locally,
199 pass / 0 skip with `MCP_REVIEW_CATALOG`, 178 pass / 21 skip / 0 fail under
`DSH_RUNTIME=/nonexistent` (the CI posture); `node scripts/repro-review.mjs` PASS — no
reviewed defect reproduces (6/6 evaluated); `node scripts/live-boot.mjs` PASS `(11/11)` (real
boot, including `state-live-broken` / `state-live-connected`, live rows settled in ≈70 ms);
`node scripts/probe-live-status.mjs` PASS (8/8 assertions, `live-status-seam`).

## 8. Residual risks / deferred

- No cross-process file lock (see §4): compare-and-swap with three attempts only. This is
  the one documented audit residual (security audit F5): with more than two concurrent
  writers (e.g. two DSH windows on one home) an edit can exhaust its attempts and fail as a
  visible `PATCH_STALE` `500`; the file is never corrupted and the loss is never silent.
- The fence comes from the Host `connection` service, and the management half only
  activates while that service exists. A recomposition can leave the routes mounted for a
  moment without the service; they then answer `503` and change nothing.
- `mcp_servers` does not report hidden/leaked catalog counts (deferred P2-4); a mask that
  failed to install is visible only as a warning line in the plugin log.
- Live status depends on an undocumented seam. Where the Host does not expose
  `Entry.moduleNamespace.connectionStatusOf` (or the read throws), the row falls back to the
  1.2.1 inference and can again read "connected, no tools" while its server is in a failed
  reconnect state (a recorded `diagnostic` does surface as `error`). This is a fidelity
  residual, not a security one: the read adds no write path and cannot forge "connected".
- R1 (upstream, pre-existing, found by the 1.3 review): `@modelcontextprotocol/client`'s
  `StdioClientTransport._dispose()` can call `proc.kill("SIGTERM")` on a transport whose spawn
  has not completed; a `ChildProcess` with no pid forwards that to pid 0, the caller's process
  group. The capability gate quiesces before disposing (and records rather than dies by a
  signal). 1.4.0 adds a panel-side start-safety valve: while a row's Host status is `starting`
  and its live cell is not `closed` — i.e. `connecting`, `reconnecting`, `waiting-credentials`,
  or no live cell at all — the panel disables **Stop** and **Restart**, states the reason in
  each control's `title` / `aria-label`, and the disabled control's handler does not POST. A
  live `closed` cell is excluded because it proves the transport already settled (the escape
  hatch), and the guard never disables the Start action of a `stopped` row. This mitigates the
  **user-driven** case only: the disposal path itself is unchanged and platform-owned, so a
  loader-driven reload/uninstall, a programmatic toggle (`mcp_server` is not guarded) or the
  Host's own disposal can still reach it. The signal delivery is observed through the gate's
  failure path; the end-to-end DSH shutdown is **unverified**. It is identical in 1.2.1 and not
  introduced by this plugin. An upstream report is drafted in the 2026-11-19 review workspace
  (path not published) and is **not filed**; no fix is claimed. Treat it as a known hazard until
  the SDK is fixed.
- Deletion of `.mcp-hub.bak`/temporary files is not managed: the backup is rewritten in
  place, and a crash mid-rename can leave a random-suffix temporary (never a truncated
  target, because the rename is atomic).

## 9. Independent 1.3 review (`audit-1.3-live-status.md`)

Commit audited: `f523da1200bc3e7069fc62f97b584284c39069b6` (`main`); verdict
**ship-with-notes**. The reviewer read the final code and the vendored runtime, ran every gate,
and used throwaway probes (real Loader in a temp dir, fake-browser rendering, route fuzzing,
install-spec resolution). Its gate numbers at that commit: `npm test` 187 / 184 pass / 3 skip;
with `MCP_REVIEW_CATALOG` 187 / 0; `DSH_RUNTIME=/nonexistent` 166 / 21; `repro-review`
`0/6` PASS; `live-boot` `PASS (11/11)` with the live rows settled in 66 ms; `probe-live-status`
8 assertions PASS; a pinned-sha `npm pack` resolved to 1.3.0, while `#v1.3.0` did not (F1).

| Finding | Severity | Status in this tree |
|---|---|---|
| F1 — the documented `#v1.3.0` install spec did not resolve; the CHANGELOG said the tag was already published | High (release step, not code) | Operational: the tag must exist before the install spec is announced; the release notes record the pinned commit. No sha is claimed in the repo. |
| F2 — capability gate failed by SIGTERM (143) in cleanup instead of its own exit, leaking the temp home | Medium | Fixed: cleanup quiesces rows before disposing, leaves mid-spawn rows undisposed, reaps the server children, removes the temp home and exits 1 through its own code; `PROBE_LIVE_FORCE_FAIL=1` is the negative self-test. |
| F3 — a live cell outranked a failed fiber, so a failed re-apply read `starting — closed` | Low | Fixed: `liveStatusView` returns null on `fiberPhase === 'failed'`, so the inference reports `error` with its diagnostic; test `F3: a failed fiber outranks a stale live cell`. |
| F4 — "a skip is never a pass" contradicted the gates printing PASS / exit 0 while skipping assertions | Low (wording/semantics) | Fixed: verdicts print and count skips separately; `--json` carries `skipsNotEvidence` / `authority`. |
| F5 — a hand-built non-string `lastError` with a throwing `toString` could throw the exported detail builder | Info | Fixed: `lastErrorSegment` renders primitives only (objects/arrays/symbols dropped); test `F5: a hand-built non-string lastError cannot make the detail throw`. |
| F6 — the panel could add a live-derived failure detail to a row the Host reports as `stopped` | Info | Fixed: the client's live fallback is gated on `starting`/`error`/`running`/`idle`; a Host `statusDetail` still renders on any status; tests `a stopped or stopping row does not inherit a stale live failure detail`, `a stopped row still shows the statusDetail the Host sent`. |
| F7 — `package-lock.json` still recorded 1.2.0 | Info | Non-issue: the lock is untracked and gitignored; it is not in the tarball and `npm test` does not read it. |
| F8 — "120 in `statusDetail`" described the `lastError` segment, not the whole line | Info | Fixed in the docs: the `lastError` segment is clipped to 120 chars and the whole one-line detail is bounded by the reason prefix too (observed max ≈177). |
| R1 — upstream SDK `StdioClientTransport._dispose()` can signal the caller's process group when disposing mid-spawn | High impact, pre-existing | Documented residual (§8); 1.4.0 mitigates the user-driven panel case only — the gate quiesces, the disposal itself is platform-owned, other callers still reach it, end-to-end app impact unverified, identical in 1.2.1. |
