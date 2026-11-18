# Regression harness

Three artefacts live here:

| Path | What it is | Runs on CI |
| --- | --- | --- |
| `test/harness.mjs` | the shared harness (runtime loader, fake plugin context, management environment, fake browser) | imported, not a test |
| `test/smoke.test.mjs` | the regression suite (`node:test` + `node:assert/strict`) | yes |
| `scripts/repro-review.mjs` | "before" evidence: reproduces the 2026-11-19 review defects | no (it *expects* the defects) |
| `scripts/live-boot.mjs` | end-to-end HTTP verification against a real DSH web instance | no (it boots a server) |

## How to run

```sh
npm install --no-audit --no-fund     # once; the only dependency is `yaml`
npm test                             # the suite (< 1 s)

node scripts/repro-review.mjs        # defect evidence, table output
node scripts/repro-review.mjs --json # the same, machine readable

node scripts/live-boot.mjs --expect baseline   # real DSH boot, documents today's defects
node scripts/live-boot.mjs --expect fixed      # the repaired behaviour (fails until it is fixed)
```

`npm test` is the gate. `scripts/repro-review.mjs` exits **0** while the
defects are still reproducible, so it is evidence and not a gate — do not add
it to CI before the fixes land. `scripts/live-boot.mjs --expect baseline` is
the same: it documents the current behaviour.

## What the suite covers

`test/smoke.test.mjs` asserts the contract that must survive the `lib/`
extraction and the 1.2.1 fixes:

* the plugin module still exports `name === 'mcp-progressive'`, `apply` and
  `__test`, and `__test` still exposes `setPatchDisabled`, `patchDeclares`,
  `serverStatus`, `targetSummary` and `yamlScalar` (the stable seam — the
  harness never imports `lib/`);
* the pure helpers keep their documented behaviour on the simple inputs;
* the management half registers exactly the three routes
  (`/dsh-mcp-hub/state|toggle|restart`) and the two management tools
  (`mcp_servers`, `mcp_server`) next to the three meta-tools;
* `GET /dsh-mcp-hub/state` answers `{ ok: true, servers: [...] }`;
* a server that never reaches its phase fails with `500` instead of hanging
  (the virtual clock makes the plugin's fixed 30 s deadline reachable in
  ~0.6 s of real time);
* the client panel mounts, renders its title and drives the server switch;
* **with the real DSH runtime**: after `apply()` the `mcp__*` catalog is
  absent from `root.tools.schemas(agent)` for that agent, still present in the
  global registry, and the five meta/management tools are registered;
* **with the real DSH runtime**: `mcp_call` dispatches the hidden tool
  through `ctx.tools.execute` exactly once and returns its output.

## The three worlds in `test/harness.mjs`

1. **Real runtime** — a real Cordis `Context`, the real `dsh-tools`
   `ToolsService` and the real native executor, imported by absolute path
   from the unpacked DSH runtime. `DSH_RUNTIME` overrides the location
   (default `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai`); `hasRuntime()`
   reports whether it is there and `runtimeImport(pkg)` performs the absolute
   import *after* that check. `mountPlugin()` models a desktop host: it
   provides `agents`, `pluginManager`, `profileContext`, `webServer`,
   `loader` and the Host `connection` service, so the plugin's management
   inject gate opens and `mcp_servers` / `mcp_server` and the three
   `/dsh-mcp-hub/*` routes exist. Pass `mountPlugin({ connection: false })` to
   model a host without Connection — the management half then stays inactive,
   exactly as it does in production.
2. **Fake plugin context** — a plain object speaking the Cordis surface the
   plugin uses (`on` / `effect` / `get` / `inject` / `tools` / `logger` /
   `webServer` / `pluginManager` / `profileContext` / `loader` /
   `connection`). `inject()` only runs its callback when every named service
   exists, so the management half activates exactly like it does on a host
   that has the desktop profile services — and stays inactive on one that has
   not.
3. **Fake browser** — a `vm` sandbox with stub React hooks, a stub
   `window.__ModuleLoader__`, a stub `document` and a captured `setInterval`,
   enough to drive `client.js` without a browser.

Helpers: `makeRoot()`, `makeAgent()`, `registerTool()`, `visibleNames()`,
`promptTools()`, `mountPlugin()`, `callTool()`, `createManagementEnv()`,
`request()`, `mountClientPanel()`, `findNode()`, `makeTempDir()`,
`withTempDir()`, `withVirtualClock()` and `flushMicrotasks()`.

One harness-only convenience: Cordis refuses to register the same service
twice, so a test that wants its own `connection` implementation on a
`mountPlugin()` root would fail on the second `reflect.provide`. The harness
swaps that one service **in place** — the service identity and every fiber
that already holds it stay stable, and the caller's implementation takes over
(the management routes keep working and see the new `requestRejection`).

## What is intentionally skipped in CI

CI has no DSH runtime, so:

* the real-runtime case (`with the real runtime: the catalog is hidden …`)
  calls `t.skip()` when `hasRuntime()` is false;
* `scripts/live-boot.mjs` is not part of `npm test` — it boots a server, and
  `node --test` must stay fast and hermetic;
* the control-queue *timeout* case uses `withVirtualClock()`, which advances
  `Date.now()` by a fixed step per call: the plugin's fixed `SERVER_WAIT_MS =
  30000` deadline is then reached in ~0.6 s of real time. It is in the suite
  (it asserts a `500`, not a timing), but the assertion deliberately avoids
  wall-clock numbers so it cannot become flaky.

## Hermeticity

* temp directories only (`os.tmpdir()`), always removed afterwards;
* `~/.dsh` is never read or written: `scripts/live-boot.mjs` boots the real
  app with `DSH_HOME` pointed at a throw-away `mkdtemp` home;
* no MCP server is ever started, and the user's real servers are untouched;
* no fixed port: the live boot asks the OS for a free one (`--port 0`) and
  reads the port back from the URL the app prints.

## The live boot

`scripts/live-boot.mjs` creates a throw-away `DSH_HOME`, a `test` profile
(`dsh-base` + `dsh-web-app` + this plugin), installs the plugin source into
`<home>/profiles/test/node_modules/dsh-mcp-progressive`, boots
`dsh --profile test --port <free> --no-open` as a child process, mints the
browser session cookie from the launch token the app prints, drives the
routes over real HTTP, then kills the child and removes the home.

If the DSH runtime is not installed the script falls back to a minimal real
HTTP server that mounts the plugin's own route handlers and says so in its
result (`"mode": "fallback-http"`). The fallback proves the handler
contract, not the platform wiring.

Expected statuses:

| Probe | `--expect baseline` | `--expect fixed` |
| --- | --- | --- |
| `GET /state`, no cookie | 200 | 403 |
| `GET /state`, bad `Host` | 200 | 403 |
| `POST /toggle`, `content-type: text/plain` | 404 (the handler ran) | 415 |
| `GET /toggle` | 405 | 405 |
| `POST /toggle`, `enabled` missing | 404 | 400 |
| `POST /toggle`, `enabled: "true"` | 404 | 400 |
| `GET /state`, authenticated same-origin | 200 | 200 |
