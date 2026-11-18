# Security contract — management half (1.2.1 → 1.3.0)

This note records what the MCP server management half (`lib/management.js`, `client.js`)
promises, and the raw evidence behind it. It is written from the code and from a real,
isolated DSH boot; anything not verified is marked as such.

The disclosure half (`index.js`) exposes no network surface. Its trust boundary is
described in `README.md` → Limitations (hiding is view + dispatch, not a permission
boundary). 1.3.0 adds one read of the running MCP client's status cell; it opens no new
surface and no write path (§3.1).

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
  `attempt`, `maxAttempts`, `nextRetryAtMs`; text is collapsed to one line and bounded (240
  chars in the payload, 120 in `statusDetail`), numbers must be finite, and a value that is not
  an object with a non-empty string `state` is dropped entirely, so a status cell cannot smuggle
  fields into the payload;
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

These scripts are release gates now; CI runs none of them (`npm test` is CI's gate).

### 7.1 Real boot — `node scripts/live-boot.mjs` (default `--expect fixed`)

It creates a throw-away `DSH_HOME`, installs this package into a `test` profile, boots
`dsh --profile test --port 0 --no-open`, mints the browser cookie from the launch token,
drives the routes with `node:http` (so an explicit `Host` really reaches the server),
snapshots both patch layers before and after, and requires every probe to match.

| Probe | Accepted | Observed (1.2.1; re-confirmed by the 1.3.0 `live-boot` gate) |
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

`state-unauthenticated` accepts either status because the platform may reject the request at
the Host/Origin fence (`403`) or, once the Host is accepted, for the missing authenticated
peer (`401`); both are the platform's verdict and the plugin passes them through. The gate
also requires the two patch layers to be byte-identical afterwards — every rejected probe
changed nothing — and it asserts the JSON refusal shape (`{ok:false,error}`) instead of a
body-less reset. The gate is a **rejection matrix**: it never performs a valid
authenticated toggle, so it proves the admission/validation boundary rather than the
write path; a valid toggle against the fake environment is covered by
`scripts/repro-review.mjs` probe C, and the audit's own live valid-toggle probe confirmed
the home-patch write path separately. `--expect baseline` documents the 1.2.0 matrix and
only matches a v1.2.0 checkout. Without the unpacked runtime the script falls back to an in-process HTTP server
behind a stub fence and reports `mode: fallback-http`, `platformAuthority: false` — the
handler contract, not the platform wiring.

### 7.2 Repro gate — `node scripts/repro-review.mjs` (default `--expect fixed`)

It replays the six reviewed defect families and exits 0 only when none reproduces (exit 1
with `REGRESSION: <families>` otherwise); where a family can observe the repaired outcome
(management admission, control queue, rendered panel message, search recall, schema fitting)
it requires that outcome too. Its management family drives the real handlers with a
**stub** connection fence that mirrors the platform (untrusted `Host` → `403`, no cookie →
`401`) — `scripts/live-boot.mjs` remains the real-platform authority. Without the DSH
runtime the YAML family reports `skip` (the platform insert/override rule cannot be stubbed
honestly) and the gate still exits 0 when nothing reproduces; a skip is never a pass.
`--expect baseline` is the historical 1.2.0 mode and passes only on a v1.2.0 checkout.

The `repro-review` and `live-boot` gates were checked against the `v1.2.0` tag in both
directions: on `v1.2.0` the baseline modes pass and the fixed modes fail, and on this release
the reverse.

### 7.3 Fixture note

The real-runtime smoke fixture that previously lacked a Host `connection` service is fixed in
`02fe061`: `mountPlugin()` now provides it (and `mountPlugin({ connection: false })` models a
host without it). With the runtime present `npm test` is 187 tests, 184 pass / 3 skip /
0 fail (the three optional real-catalog cases skip unless `MCP_REVIEW_CATALOG` points at a
local copy of the review catalog, which makes it 187 pass / 0 skip), and on CI — no runtime,
no catalog — it is 187 tests, 166 pass / 21 skip / 0 fail. The 1.3.0 live-status cases run in
every posture: their fixtures need no DSH runtime.

### 7.4 Independent audits (2026-11-19)

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

Final postures on this tree: `npm test` 187 tests — 184 pass / 3 skip / 0 fail locally,
187 pass / 0 skip with `MCP_REVIEW_CATALOG`, 166 pass / 21 skip / 0 fail on a runtime-less
CI; `node scripts/repro-review.mjs` PASS `0/6`; `node scripts/live-boot.mjs` PASS `9/9`
(real boot; plus the 1.3.0 two-row live probes).

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
- Deletion of `.mcp-hub.bak`/temporary files is not managed: the backup is rewritten in
  place, and a crash mid-rename can leave a random-suffix temporary (never a truncated
  target, because the rename is atomic).
