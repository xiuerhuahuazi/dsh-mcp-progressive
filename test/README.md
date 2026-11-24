# Regression harness

The harness, eight `test/*.test.mjs` suites and three release-gate scripts live here:

| Path | What it is | Runs on CI |
| --- | --- | --- |
| `test/harness.mjs` | the shared harness (runtime loader, fake plugin context, management environment, fake browser) | imported, not a test |
| `test/*.test.mjs` | the regression suites (`node:test` + `node:assert/strict`) | yes |
| `scripts/repro-review.mjs` | review-defect regression gate (default); historical 1.2.0 evidence with `--expect baseline` | no (release gate; its YAML family needs the runtime) |
| `scripts/live-boot.mjs` | real-platform behavioural gate: 9 HTTP probes plus, as of 1.3.0, `state-live-broken` / `state-live-connected` against two real MCP loader rows, and as of 1.5.0 `state-disclosure`, and as of 1.6.0 `state-lazy-row` (13/13 in `--expect fixed`) | no (it boots a server) |
| `scripts/probe-live-status.mjs` | capability gate for the Loader-entry live-status seam (1.3.0): assertions A–D against a real Loader; exits 1 on failure (cleanup quiesces, reaps its servers, removes its temp home), `PROBE_LIVE_FORCE_FAIL=1` self-test | no (real Loader in a temp dir; no server) |

## How to run

```sh
npm install --no-audit --no-fund     # once; the only dependency is `yaml`
npm test                             # the suites (302 tests; CI's gate)

node scripts/repro-review.mjs        # review-defect gate: exit 0 = no reviewed defect reproduces
node scripts/repro-review.mjs --json # the same, machine readable
node scripts/repro-review.mjs --expect baseline   # historical 1.2.0 evidence; only passes on a v1.2.0 checkout

node scripts/live-boot.mjs           # real-boot gate; --expect fixed is the default
node scripts/live-boot.mjs --json    # the same, machine readable
node scripts/live-boot.mjs --expect baseline      # historical 1.2.0 matrix; only passes on a v1.2.0 checkout

node scripts/probe-live-status.mjs   # capability gate: exit 0 only when every A–D assertion passes
node scripts/probe-live-status.mjs --json   # assertions + observed rows, machine readable
```

The three real-catalog schema cases are optional and private: point
`MCP_REVIEW_CATALOG` at a local copy of the review's 210-tool catalog to run them.

| Posture | `npm test` |
| --- | --- |
| unpacked runtime present, `MCP_REVIEW_CATALOG` unset (default local) | 302 tests, 299 pass / 3 skip / 0 fail |
| unpacked runtime present, `MCP_REVIEW_CATALOG` set | 302 tests, 302 pass / 0 skip / 0 fail |
| no runtime, no catalog (`DSH_RUNTIME=/nonexistent`, the CI posture) | 302 tests, 260 pass / 42 skip / 0 fail |

`npm test` is the gate CI runs. The three scripts are release gates run locally: `repro-review`
needs the unpacked DSH runtime for its YAML family, `live-boot` boots a real server, and
`probe-live-status` needs the runtime and a real Loader (no HTTP), so none belongs in the fast
hermetic suite. The 1.3.0 live-status cases and the 1.4.0 hazard cases are suite cases and run
in every posture — their fixtures need no runtime.

## The gates

### `scripts/repro-review.mjs` — review-defect regression gate

Default mode is `--expect fixed`. It replays the six defect families from the 2026-11-19
review and:

* exits **0** only when **none** of them reproduces, and exits **1** with a
  `REGRESSION: <families>` line when one does;
* asserts the repaired outcome where a family can observe it (management admission, the
  control queue, the message the panel actually renders, search recall, schema fitting), so
  a partial regression cannot hide behind "not reproduced";
* drives the management routes with a **stub** connection fence that mirrors the platform
  (untrusted `Host` → `403`, no cookie → `401`). The real-platform authority is
  `scripts/live-boot.mjs`, which boots the app and uses the platform's own fence;
* reports the YAML family as `skip` with its reason when the DSH runtime is absent (the
  platform insert/override rule cannot be stubbed honestly). A skip is printed and counted
  separately: the gate still exits 0 when nothing reproduces, but the verdict is not the
  six-family gate — it reads `(5/6 evaluated, 1 skipped — skips are not evidence)` and `--json`
  carries `skipsNotEvidence: true` / `authority: false`.

`--expect baseline` is the historical 1.2.0 evidence mode: it exits 0 only when all six
families reproduce, so it passes on a `v1.2.0` checkout and reports `NOT A 1.2.0 CHECKOUT`
on this release.

### `scripts/live-boot.mjs` — real-platform gate

Default mode is `--expect fixed`. It boots a throw-away real DSH web instance, mints the
browser session cookie from the launch token, drives the routes with `node:http` (so an
explicit `Host` header really reaches the server), snapshots both patch layers before and
after, and requires every probe plus the byte-identical patch layers to hold.

Expected statuses (13 probes in `--expect fixed`):

| Probe | `--expect baseline` | `--expect fixed` |
| --- | --- | --- |
| `GET /state`, no cookie | 200 | 401 or 403 (JSON refusal) |
| `GET /state`, bad `Host` | 200 | 403 |
| `POST /toggle`, `content-type: text/plain` | 404 (the handler ran) | 415 |
| `GET /toggle` | 405 | 405, `Allow: POST` |
| `POST /toggle`, `enabled` missing | 404 | 400 |
| `POST /toggle`, `enabled: "true"` | 404 | 400 |
| `POST /toggle`, no `content-type` header | 404 | 415 |
| `POST /state` (wrong method) | 200 | 405, `Allow: GET, HEAD` |
| `GET /state`, authenticated same-origin | 200 | 200 |
| `state-live-broken` (row `mcp-probe-broken`) | `skip` | row `status: error`, `live.state: failed`, `statusDetail` contains `ENOENT` |
| `state-live-connected` (row `mcp-probe-ok`) | `skip` | row `status: running`, `live.state: connected`, `live.toolCount >= 2`, `statusDetail: null` |
| `state-disclosure` (row `mcp-probe-ok`) | `skip` | `body.disclosure.hiddenTools >= 2` and a positive token estimate; the row carries `hiddenTools >= 2` and `hiddenTokens > 0` |
| `state-lazy-row` (row `mcp-probe-lazy`) | `skip` | row `status: stopped`, `enabled: false`, `lazy: true`, `hiddenTools >= 1`, `hiddenTokens > 0`, `toolCount: 0` |

`state-unauthenticated` accepts either status because the platform may reject at the
Host/Origin fence (`403`) or, once the Host is accepted, for the missing authenticated peer
(`401`); both are its verdict. In `--expect fixed` a refusal must be a JSON `{ok:false,error}`
body, not a reset. `--expect baseline` only matches a `v1.2.0` checkout. `repro-review` and
`live-boot` were checked against the `v1.2.0` tag in both directions: on `v1.2.0` the baseline
modes pass and the fixed modes fail, and on this release the reverse.

As of 1.3.0 the throw-away profile also declares **two real MCP loader rows** —
`mcp-probe-broken` (a command that cannot spawn) and `mcp-probe-ok` (a minimal stdio MCP server
written into the temp home, exposing two tools); as of 1.6 it adds `mcp-probe-lazy`, a
`disabled: true` row with a pre-seeded cache. The gate waits until both rows publish a settled
live state (≈70 ms here; `live rows settled: yes`) and then asserts them through `/state`:
`state-live-broken` requires `status: "error"`, `live.state: "failed"` and a `statusDetail`
carrying the spawn error **even though the row's `fiberPhase` is `active`** (inference alone would
have called it `idle`), and `state-live-connected` requires `status: "running"`,
`live.state: "connected"`, `live.toolCount: 2` and `statusDetail: null`. As of 1.5.0,
`state-disclosure` also requires the read-only footprint: `body.disclosure.hiddenTools >= 2`
with a positive token estimate, and `hiddenTools >= 2` / `hiddenTokens > 0` on the connected
`mcp-probe-ok` row. That exercises the Loader-entry seam and the disclosure snapshot against a
real client, not only against fixtures; on this tree the gate is `PASS (13/13)`. `--expect
baseline` reports the four live/disclosure/lazy probes as `skip` (a 1.2.0 row carries no live status
and has no disclosure fields), and the fallback mode skips them too because it has no real
Loader row. Skips are printed and counted separately: a run that needed one exits 0 where
CI/fallback require it, but its verdict is not the authoritative gate — the fallback prints
`PASS (9/13, 4 skipped — fallback/no runtime: skips are not evidence)` and `--json` carries
`skipsNotEvidence: true` / `authority: false`, alongside each probe's `row`/`skipped` and the
top-level `liveWait` (the row-settling wait).

If the DSH runtime is not installed the script falls back to a minimal real HTTP server that
mounts the plugin's own route handlers and says so in its result: `"mode": "fallback-http"`,
`"platformAuthority": false` (plus a `fallbackReason`). The fallback proves the handler
contract behind a stub fence, not the platform wiring.

### `scripts/probe-live-status.mjs` — capability gate (1.3.0)

The plugin reads a row's live status from the running client through
`entry.moduleNamespace.connectionStatusOf(...)`, guarded so that a missing seam falls back to the
1.2.1 inference. That fallback is the right user-facing behaviour and the wrong release
behaviour, so this script is its counterpart. It runs a real Cordis `Context`, the real Loader and
the installed `@deepseek-ai/dsh-mcp-client` over two rows (a broken command and a real mini stdio
MCP server) inside a `mkdtemp` home, and asserts:

* **A** — `typeof entry.moduleNamespace.connectionStatusOf === 'function'` on every MCP row, and
  the plugin's `liveStatusOf()` reads both rows;
* **B** — the broken row ends `failed` with `ENOENT` in `lastError`, and `liveStatusView` /
  `presentServer` turn it into `status: error` with the spawn text in `statusDetail`;
* **C** — the real row ends `connected` with `toolCount >= 2`, presented as `status: running`
  with `toolCount: 2` and no detail;
* **D** — `collectServerRows` creates no `onChange` subscription (the public `onChange` is
  instrumented before the read, and the client's own observer set is checked when readable).

All eight assertions must pass for exit 0. A failed run prints the verdict and exits **1
through its own code**, never 143: cleanup quiesces the rows (bounded) before disposing, leaves a
row that is still mid-spawn undisposed, reaps the server children it created, removes the temp
home and records an in-process `SIGTERM` rather than letting it decide the exit — `--json` adds
`exitCode`, `cleanup` and `signals`. The hidden `PROBE_LIVE_FORCE_FAIL=1` knob exercises that
negative path without editing an assertion; on this tree it prints
`ERROR: PROBE_LIVE_FORCE_FAIL=1: assertion A forced to fail …`, `FAIL (0/1 assertions)`, exits 1
and leaves no `dsh-live-status-probe-*` directory behind (`PROBE_LIVE_QUIESCE_MS` shortens the
settle wait). Without the DSH runtime the script prints `SKIP: runtime unavailable` (plus the
missing packages) and exits 0, so a runtime-less checkout stays green — the printed line says the
skip is **not evidence**, and `--json` marks `skipped: true` / `authority: false`. It is the
"DSH renamed the seam" alarm: run it on every DSH upgrade, not only on plugin releases.

## What the suite covers

`test/smoke.test.mjs` asserts the contract that must survive the `lib/` extraction and the
1.2.1/1.3.0 fixes:

* the plugin module still exports `name === 'mcp-progressive'`, `apply` and `__test`, and
  `__test` still exposes `setPatchDisabled`, `patchDeclares`, `serverStatus`,
  `targetSummary` and `yamlScalar` (the stable seam — the harness never imports `lib/`);
* the pure helpers keep their documented behaviour on the simple inputs;
* the management half registers exactly the three routes
  (`/dsh-mcp-hub/state|toggle|restart`) and the two management tools (`mcp_servers`,
  `mcp_server`) next to the three meta-tools;
* `GET /dsh-mcp-hub/state` answers `{ ok: true, servers: [...] }`;
* a server that never reaches its phase fails with `500` instead of hanging (the virtual
  clock makes the plugin's fixed 30 s deadline reachable in ~0.6 s of real time);
* the client panel mounts, renders its title and drives the server switch;
* **with the real DSH runtime**: after `apply()` the `mcp__*` catalog is absent from
  `root.tools.schemas(agent)` for that agent, still present in the global registry, and the
  five meta/management tools are registered;
* **with the real DSH runtime**: `mcp_call` dispatches the hidden tool through
  `ctx.tools.execute` exactly once and returns its output;
* **with the real DSH runtime**: `mcp_call` leaves a real `dsh-session` history with no
  orphan tool result — it writes no nested `tool/call`/`tool/result` events (an unpaired
  `tool/result` would make the next provider request fail), and the target/argument audit line
  is in every returned result instead (a rare internal pipeline failure still throws). A second
  case keeps the empty-output fallback sentence next to that audit line, including when the
  nested block is whitespace-only (`F12`).
* **live status (1.3.0)**, in `test/management.test.mjs` and `test/client.test.mjs` (not
  `smoke`), locked by fixtures that expose the same `connectionStatusOf(fiber) → { current(),
  onChange() }` seam as the real client (the fixture's `onChange` throws, so a subscription
  attempt fails the test):
  * every MCP state maps onto the unchanged vocabulary with one bounded detail line, and an
    absent/throwing/garbage seam falls back to the inference — a failed read can never say
    "connected" (`liveStatusView maps every MCP state …`, `serverStatus prefers the live status …`,
    `sanitizeLiveStatus keeps only the documented fields …`, `a Loader entry without a usable
    live-status seam falls back cleanly (older DSH)`, `a throwing or empty live read falls back
    instead of failing the request`);
  * the state route and both model answers carry `live`/`statusDetail` while the rest of the row
    contract is unchanged, the fiber is normalized to `fiber.ctx.fiber`, no extra field can ride
    in, and a live `toolCount` wins over the prefix count (`the state route reports a reconnecting
    row …`, `a connected row is running or idle by the live tool count …`, `a failed live status
    is an error and a disabled row stays stopped`, `presentServer carries live and statusDetail …`,
    `the model-facing text appends the live status detail`, `the mcp_server result text carries
    the live detail in its trailing list`);
  * a read never reaches a write path (`reading live status never reaches a write path`);
  * the panel renders the detail as a clamped line with the full string in the tag `title`, names
    the reconnect attempt, and still renders an older Host row without the new fields
    (`test/client.test.mjs` › `a reconnecting starting row …`, `a starting row waiting for
    credentials says so`, `an error row shows the Host detail …`, `an error row without a Host
    detail falls back to live.lastError`, `a detail that disappears between polls is removed
    cleanly`, `a running row without live data renders exactly as before`, `an older Host row
    without live/statusDetail fields still renders`).
  * the 1.3 audit fixes: a failed fiber outranks a stale live cell (`F3: a failed fiber outranks
    a stale live cell`), a non-string `lastError` cannot throw the detail builder (`F5: a
    hand-built non-string lastError cannot make the detail throw`), and the panel keeps a
    stopped/stopping row free of a stale live failure detail while a Host `statusDetail` still
    renders (`a stopped or stopping row does not inherit a stale live failure detail`, `a
    stopped row still shows the statusDetail the Host sent`).
* **start-safety valve (1.4.0)**, in `test/client.test.mjs`: while a row's Host status is
  `starting` and its live cell does not prove the transport settled (`connecting`, `reconnecting`,
  `waiting-credentials`, or no live cell — anything but `closed`), the panel disables **Stop** and
  **Restart** and puts a localized reason in each control's `title`/`aria-label`
  (`hazard.starting`: `Wait for the server to finish starting before stopping or restarting it` /
  `启动完成后再停止或重启`), and a click that still reaches a *hazard-blocked* control performs no
  POST (a `busy`-disabled control keeps the pre-1.4 behaviour). A live `closed` cell is not blocked
  — `closed` is published only at the end of `dispose()`, so that row cannot still be spawning —
  but it is **not** an escape from a hung start: a row stuck in `starting` keeps both controls
  disabled (indefinitely for `waiting-credentials`, ~2 minutes for a crash-restart back-off), and
  the ways out are the ungated `mcp_server` tool, a patch edit, or a Harness restart. The guard
  also reads the last poll (`POLL_MS` 2.5 s), so it is a best-effort snapshot. A `stopped` row's
  Start is never disabled by the guard; a pending action still disables every control; a
  `starting` row without live data falls back to the lock. Tests:
  `a starting row disables stop and restart and explains why`;
  `the starting hazard hint is localized`;
  `reconnecting and waiting-credentials starting rows are blocked too`;
  `a closed transport is not a spawn hazard, so the row stays controllable`;
  `a starting row without live data falls back to the hazard lock`;
  `running, idle, error and stopped rows keep their controls enabled`;
  `a stopped row is still startable`;
  `a pending action still disables every control`;
  `a pending action wins over the hazard hint when the row turns starting`.

## The three worlds in `test/harness.mjs`

1. **Real runtime** — a real Cordis `Context`, the real `dsh-tools` `ToolsService` and the
   real native executor, imported by absolute path from the unpacked DSH runtime.
   `DSH_RUNTIME` overrides the location (default
   `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai`); `hasRuntime()` reports whether it is
   there and `runtimeImport(pkg)` performs the absolute import *after* that check.
   `mountPlugin()` models a desktop host: it provides `agents`, `pluginManager`,
   `profileContext`, `webServer`, `loader` and the Host `connection` service, so the
   plugin's management inject gate opens and `mcp_servers` / `mcp_server` and the three
   `/dsh-mcp-hub/*` routes exist. Pass `mountPlugin({ connection: false })` to model a host
   without Connection — the management half then stays inactive, exactly as it does in
   production.
2. **Fake plugin context** — a plain object speaking the Cordis surface the plugin uses
   (`on` / `effect` / `get` / `inject` / `tools` / `logger` / `webServer` / `pluginManager`
   / `profileContext` / `loader` / `connection`). `inject()` only runs its callback when
   every named service exists, so the management half activates exactly like it does on a
   host that has the desktop profile services — and stays inactive on one that has not.
3. **Fake browser** — a `vm` sandbox with stub React hooks, a stub
   `window.__ModuleLoader__`, a stub `document` and a captured `setInterval`, enough to
   drive `client.js` without a browser.

Helpers: `makeRoot()`, `makeAgent()`, `registerTool()`, `visibleNames()`,
`promptTools()`, `mountPlugin()`, `callTool()`, `createManagementEnv()`, `request()`,
`mountClientPanel()`, `findNode()`, `makeTempDir()`, `withTempDir()`, `withVirtualClock()`
and `flushMicrotasks()`.

One harness-only convenience: Cordis refuses to register the same service twice, so a test
that wants its own `connection` implementation on a `mountPlugin()` root would fail on the
second `reflect.provide`. The harness swaps that one service **in place** — the service
identity and every fiber that already holds it stay stable, and the caller's implementation
takes over (the management routes keep working and see the new `requestRejection`).

## What is intentionally skipped in CI

CI has no DSH runtime, so:

* 39 runtime-dependent cases call `t.skip()` when `hasRuntime()` is false, and the 3
  real-catalog schema cases skip unless `MCP_REVIEW_CATALOG` names a local copy of the
  private review catalog. Locally with the runtime present that is 244 pass / 3 skip
  (246 pass / 0 skip with the variable set); without the runtime, which is the CI posture,
  it is 260 pass / 42 skip. The live-status, audit-fix, 1.4.0 hazard and 1.5 footprint/batch
  cases are not skipped anywhere: their fixtures are pure JS.
* `scripts/repro-review.mjs` is not part of `npm test`; its YAML family also skips when the
  DSH runtime is absent, and the script is a release gate, not a suite case.
* `scripts/measure-tools-payload.mjs` is not part of `npm test` either: it reads two session
  captures and prints tool-array sizes; `--self-test` pins its arithmetic (21 assertions).
* `scripts/live-boot.mjs` and `scripts/probe-live-status.mjs` are not part of `npm test` — one
  boots a server and both need the unpacked runtime/real Loader, so they stay release gates.
  Without the runtime, `live-boot` falls back and reports its four live/disclosure/lazy probes as
  `skip`, and `probe-live-status` prints `SKIP: runtime unavailable` and exits 0. Both mark
  those runs as non-authoritative (`skipsNotEvidence`/`authority`; the probe's printed line
  says the skip is not evidence): a skip is printed and counted separately, and a run that
  needed one is not the
  authoritative gate even though it exits 0 where CI/fallback require it.
* the control-queue *timeout* case uses `withVirtualClock()`, which advances `Date.now()` by
  a fixed step per call: the plugin's fixed `SERVER_WAIT_MS = 30000` deadline is then
  reached in ~0.6 s of real time. It is in the suite (it asserts a `500`, not a timing), but
  the assertion deliberately avoids wall-clock numbers so it cannot become flaky.

## Hermeticity

* temp directories only (`os.tmpdir()`), always removed afterwards;
* `~/.dsh` is never read or written: `scripts/live-boot.mjs` boots the real app with `DSH_HOME`
  pointed at a throw-away `mkdtemp` home, and `scripts/probe-live-status.mjs` runs the real
  Loader in the same kind of temp home (a temp `node_modules` symlink resolves the row name);
* no user MCP server is ever started: the 1.3.0 scripts start only their own throw-away mini
  stdio MCP server inside the temp home, and the user's real servers are untouched;
* no fixed port: the live boot asks the OS for a free one (`--port 0`) and reads the port
  back from the URL the app prints.

## How the live boot works

`scripts/live-boot.mjs` creates a throw-away `DSH_HOME`, a `test` profile (`dsh-base` +
`dsh-web-app` + this plugin), installs the plugin source into
`<home>/profiles/test/node_modules/dsh-mcp-progressive`, boots
`dsh --profile test --port <free> --no-open` as a child process, mints the browser session
cookie from the launch token the app prints, drives the routes over real HTTP, snapshots
both patch layers, then kills the child, shuts the listener down and removes the home. The
temp profile patch declares the two probe rows (`mcp-probe-broken`, `mcp-probe-ok`), and the
inline mini MCP server for the second is written into the temp home. The expected matrix is in
*The gates* above.
