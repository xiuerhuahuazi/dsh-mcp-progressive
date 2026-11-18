# Regression harness

Five artefacts live here:

| Path | What it is | Runs on CI |
| --- | --- | --- |
| `test/harness.mjs` | the shared harness (runtime loader, fake plugin context, management environment, fake browser) | imported, not a test |
| `test/smoke.test.mjs` | the regression suite (`node:test` + `node:assert/strict`) | yes |
| `scripts/repro-review.mjs` | review-defect regression gate (default); historical 1.2.0 evidence with `--expect baseline` | no (release gate; its YAML family needs the runtime) |
| `scripts/live-boot.mjs` | end-to-end HTTP gate against a real DSH web instance (default `--expect fixed`), including two real MCP rows for the live-status seam as of 1.3.0 | no (it boots a server) |
| `scripts/probe-live-status.mjs` | capability assertion for the Loader-entry live-status seam (1.3.0): fails when DSH stops exposing it | no (it boots a server) |

## How to run

```sh
npm install --no-audit --no-fund     # once; the only dependency is `yaml`
npm test                             # the suite (187 tests; CI's gate)

node scripts/repro-review.mjs        # review-defect gate: exit 0 = no reviewed defect reproduces
node scripts/repro-review.mjs --json # the same, machine readable
node scripts/repro-review.mjs --expect baseline   # historical 1.2.0 evidence; only passes on a v1.2.0 checkout

node scripts/live-boot.mjs           # real-boot gate; --expect fixed is the default
node scripts/live-boot.mjs --json    # the same, machine readable
node scripts/live-boot.mjs --expect baseline      # historical 1.2.0 matrix; only passes on a v1.2.0 checkout

node scripts/probe-live-status.mjs   # capability assertion: exit 0 only while the live-status seam exists
```

The three real-catalog schema cases are optional and private: point
`MCP_REVIEW_CATALOG` at a local copy of the review's 210-tool catalog to run them.

| Posture | `npm test` |
| --- | --- |
| unpacked runtime present, `MCP_REVIEW_CATALOG` unset (default local) | 187 tests, 184 pass / 3 skip / 0 fail |
| unpacked runtime present, `MCP_REVIEW_CATALOG` set | 187 tests, 187 pass / 0 skip / 0 fail |
| CI: no runtime, no catalog | 187 tests, 166 pass / 21 skip / 0 fail |

`npm test` is the gate CI runs. The three scripts are release gates run locally: one needs
the unpacked DSH runtime for its YAML family, the others boot a real server, so none belongs in
the fast hermetic suite. The 1.3.0 live-status cases are suite cases and run in every posture —
their fixtures need no runtime.

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
  platform insert/override rule cannot be stubbed honestly) — a skip is never a pass, and
  the gate still exits 0 when nothing reproduces.

`--expect baseline` is the historical 1.2.0 evidence mode: it exits 0 only when all six
families reproduce, so it passes on a `v1.2.0` checkout and reports `NOT A 1.2.0 CHECKOUT`
on this release.

### `scripts/live-boot.mjs` — real-platform gate

Default mode is `--expect fixed`. It boots a throw-away real DSH web instance, mints the
browser session cookie from the launch token, drives the routes with `node:http` (so an
explicit `Host` header really reaches the server), snapshots both patch layers before and
after, and requires every probe plus the byte-identical patch layers to hold.

Expected statuses:

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

`state-unauthenticated` accepts either status because the platform may reject at the
Host/Origin fence (`403`) or, once the Host is accepted, for the missing authenticated peer
(`401`); both are its verdict. In `--expect fixed` a refusal must be a JSON `{ok:false,error}`
body, not a reset. `--expect baseline` only matches a `v1.2.0` checkout. `repro-review` and
`live-boot` were checked against the `v1.2.0` tag in both directions: on `v1.2.0` the baseline
modes pass and the fixed modes fail, and on this release the reverse.

As of 1.3.0 the same boot also installs **two real MCP rows** — one whose command cannot start
and one working local MCP server — and requires the broken row to report `error` with a
`failed: …` detail and the working row to report `running` from the live cell (with the live tool
count). That exercises the Loader-entry seam against a real client, not only against fixtures.

If the DSH runtime is not installed the script falls back to a minimal real HTTP server that
mounts the plugin's own route handlers and says so in its result: `"mode": "fallback-http"`,
`"platformAuthority": false` (plus a `fallbackReason`). The fallback proves the handler
contract behind a stub fence, not the platform wiring.

### `scripts/probe-live-status.mjs` — capability gate (1.3.0)

The plugin reads a row's live status from the running client through
`entry.moduleNamespace.connectionStatusOf(...)`, guarded so that a missing seam falls back to the
1.2.1 inference. That fallback is the right user-facing behaviour and the wrong release
behaviour, so this script is its counterpart: on a booted instance with a real MCP row it asserts
that the namespace exposes `connectionStatusOf` as a function and that the read returns a usable
status cell, and exits non-zero otherwise. It is the "DSH renamed the seam" alarm — run it on
every DSH upgrade, not only on plugin releases. Like `live-boot` it boots an isolated instance,
so it is a release gate rather than a suite case.

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

* 18 runtime-dependent cases call `t.skip()` when `hasRuntime()` is false, and the 3
  real-catalog schema cases skip unless `MCP_REVIEW_CATALOG` names a local copy of the
  private review catalog. Locally with the runtime present that is 184 pass / 3 skip
  (187 pass / 0 skip with the variable set); on CI, which has neither, it is 166 pass /
  21 skip. The live-status cases are not skipped anywhere: their live fixtures are pure JS.
* `scripts/repro-review.mjs` is not part of `npm test`; its YAML family also skips when the
  DSH runtime is absent, and the script is a release gate, not a suite case.
* `scripts/live-boot.mjs` and `scripts/probe-live-status.mjs` are not part of `npm test` — they
  boot a server, and `node --test` must stay fast and hermetic.
* the control-queue *timeout* case uses `withVirtualClock()`, which advances `Date.now()` by
  a fixed step per call: the plugin's fixed `SERVER_WAIT_MS = 30000` deadline is then
  reached in ~0.6 s of real time. It is in the suite (it asserts a `500`, not a timing), but
  the assertion deliberately avoids wall-clock numbers so it cannot become flaky.

## Hermeticity

* temp directories only (`os.tmpdir()`), always removed afterwards;
* `~/.dsh` is never read or written: `scripts/live-boot.mjs` and `scripts/probe-live-status.mjs`
  boot the real app with `DSH_HOME` pointed at a throw-away `mkdtemp` home;
* no user MCP server is ever started: the 1.3.0 live-status boot starts only its own throw-away
  local server in an isolated home, and the user's real servers are untouched;
* no fixed port: the live boot asks the OS for a free one (`--port 0`) and reads the port
  back from the URL the app prints.

## How the live boot works

`scripts/live-boot.mjs` creates a throw-away `DSH_HOME`, a `test` profile (`dsh-base` +
`dsh-web-app` + this plugin), installs the plugin source into
`<home>/profiles/test/node_modules/dsh-mcp-progressive`, boots
`dsh --profile test --port <free> --no-open` as a child process, mints the browser session
cookie from the launch token the app prints, drives the routes over real HTTP, snapshots
both patch layers, then kills the child, shuts the listener down and removes the home. The
expected matrix is in *The gates* above.
