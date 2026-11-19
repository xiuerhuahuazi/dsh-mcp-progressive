# dsh-mcp-progressive

English | [中文](#中文)

Progressive disclosure for MCP tools in DeepSeek Harness — the model stops paying for every
`mcp__*` tool schema on every request — plus an **MCP servers** tab and two model tools to
start, stop and restart MCP servers without leaving the Harness.

## English

### Why

Each MCP server contributes one model-facing tool per remote tool (`mcp__<server>__<tool>`),
and the complete schema set is re-sent on **every** request. Two or three rich MCP servers can
cost tens of thousands of tokens per turn even when the model never calls them.

### What it does

The plugin leaves MCP connections and the global tool registry untouched — approvals, timeouts,
cancellation, images and the tool-card pipeline keep working — and changes only the viewing
agent's registry view:

1. Hiding happens in the registry view, not in the prompt: a per-agent scope restriction
   (`agent.ctx.tools.restrict({ deny })`) removes the unloaded schemas from `schemas(agent)` —
   the exact list the prompt provider reads — and from `get`/`executable`, so a hidden tool is
   neither in the prompt nor callable directly. The catalog is read from the **global** registry;
   MCP tools mounted only inside an agent or preset scope are outside it (see Limitations).
2. Loading re-registers the selected definitions inside the agent's own scope, which a
   restriction leaves visible. The deny list is therefore never rebuilt for a load: it changes
   only when the catalog changes (a server connects or disconnects), while a load or unload is
   what rewrites the request's tool array (see [Cost](#cost-what-a-load-actually-costs)).
3. With `manageServers` enabled (the default) five small meta-tools replace the catalog:

   | Tool | Purpose |
   |---|---|
   | `mcp_search` | Search the hidden catalog: full name, one-line summary, parameter signature. `detail: "full"` prints a compact input schema for up to two matches. |
   | `mcp_load` | Make selected tools native for this conversation from the next step; `unload: true` removes them; no arguments lists what is loaded. |
   | `mcp_call` | Run one hidden tool directly through the normal tool pipeline, without loading it. |
   | `mcp_servers` | List every configured MCP server with its runtime status. |
   | `mcp_server` | Start, stop or restart one MCP server (approval-gated; see below). |

   `manageServers: false` registers only the first three; `enableLoad`/`enableCall` gate the
   middle two. A typical turn is `mcp_search` → `mcp_load` → call the real tool natively, or
   `mcp_search` → `mcp_call` for a single use.

4. `mcp_search` is OR-shaped: one matching word is enough, so a typo cannot hide every relevant
   tool. It carries a small Chinese→English gloss table (`浏览器` → `browser`, `截图` →
   `screenshot`/`capture`, `b站` → `bilibili`, …) and matches CJK runs against
   whitespace/punctuation-stripped text, and its `server` filter is case-insensitive. Empty
   answers stay distinct: no catalog at all, a server filter that matched no server, and a query
   that matched nothing each explain a different recovery. The hidden count shares the searched
   scope, so `server:"rea"` cannot report "201 of 170".
5. Signatures are capped at 200 characters. `detail: "full"` prints each schema as valid,
   compact JSON (annotations stripped, then a type/enum/required-only form) within a ≈6,000
   character total budget for at most two tools; when even the compact form does not fit it
   prints the signature, the required names and `schema omitted: too large (N chars)` — never a
   truncated JSON document.
6. A guessed-but-unavailable `mcp__*` call gets a corrective message instead of a bare
   unknown-tool error, and the text distinguishes "registered but not loaded in this
   conversation" from "not in this MCP catalog right now".
7. `mcp_load` reports two states of an already-booked tool honestly: loaded-and-native
   ("already loaded: it is a native tool in this conversation; call it directly") and
   loaded-but-not-visible (a failed shadow registration — "pass it with `unload:true`, then load
   it again"). A separate same-step mistake is answered by the corrective `tools/pre-execute`
   handler, not by `mcp_load`: calling a tool that was loaded in the same step returns "loaded in
   this step; call it in the next step — do not batch `mcp_load` with the call" while the
   `mcp_load` itself succeeded.
8. `mcp_call` dispatches through `ctx.tools.execute`, so it runs the full pre-execute pipeline
   (guards, policy, approval, timeout). It returns the MCP server's own error text instead of a
   bare thrown message, forwards deferred context and turn conclusion, and detects a PTC refusal
   from the result. It writes **no** session events for the nested call: a synthetic
   `tool/result` for a call no assistant message declares would leave an orphan tool message in
   `session.deriveMessages()` and the next provider request would be rejected. The audit trail is
   an in-result line on every **returned** result — `(audit: dispatched <tool>; argument keys: …)`
   — (a rare internal pipeline failure still throws), and the empty-output fallback keeps
   `(<tool> completed with no output.)` next to it. Its transient scope registration is removed
   afterwards, and an `alwaysVisible` target needs no registration at all.
9. One short prompt section advertises the catalog without listing any schema — up to four
   servers with counts and a pointer to `mcp_search`, roughly:
   `MCP catalog: rea (170 tools), bilibili (31), blender (9); not loaded by default — mcp_search to find one.`

Loaded state is per live agent and in memory, keyed by Agent object identity (`WeakMap`) rather
than by id, so two agents that ever share an id cannot share a mask. A Harness restart resets it.
`eagerTools` is a root-conversation baseline: subagents (`origin: "subagent"` or a positive
`delegationDepth`) start with an empty loaded set, and an agent whose session metadata is missing
is treated as a root.

### MCP server management

Every MCP server is one loader row of `@deepseek-ai/dsh-mcp-client`. An unused server can be
disconnected entirely (its child process exits) without unloading this plugin:

- **Plugins page → "MCP servers" tab** — one card per MCP server: a status tag (running /
  stopped / connected-with-no-tools / starting / stopping / error / unknown), transport, target,
  tool count, a live detail line when the connection has something to say, the startup
  diagnostic when there is one, a restart button and the host switch for start/stop. Status and
  detail prefer the **live MCP client cell** (see *Live connection status* below): a reconnecting
  row names its attempt budget and the next retry, a row blocked on credentials says so, and a
  failed row shows `failed: <reason> · <last error>`. The full detail also stays in the tag's
  `title`, so the clamped second line loses nothing. The client only rebuilds a live-derived
  detail for a row that is still `starting`/`error`/`running`/`idle`: a `stopped`/`stopping` row
  renders a Host `statusDetail` if one was sent, but never inherits a stale live failure. Where
  the live cell is available, "connected, no tools" is now reported only for `connected` with
  `toolCount: 0`. The list
  reuses the built-in Plugins page card design (48px icon tile, 14px card title, 13px
  description, status tag, 36×20 switch) and DSH theme tokens only, so it matches the host in
  light and dark themes. It polls the same-origin routes; no client RPC surface is added.
- **Model tools** — `mcp_servers` lists every configured server with its status and the same
  one-line live detail;
  `mcp_server { server, action: "start" | "stop" | "restart" }` changes one. Only this write tool
  asks for approval (the panel is a human click, so its routes are not gated). On a host without
  an approval service the platform denies the ask instead of running it.

How a change is applied:

- a row declared by a bundle or by the profile patch is toggled through the Harness
  `pluginManager` service (the same path as the Plugins page switches);
- a row inserted by the home-level patch (`~/.dsh/cordis.patch.yml`) is not addressable through
  that service, so the plugin writes a verified top-level `- id: … / disabled: …` override into
  that patch file itself (see the file transaction below);
- a row the Harness locks and no writable patch declares is refused with `409`.
- HMR applies either change live and both survive a restart. Stopping a server removes its
  `mcp__<server>__*` tools from every session; starting it reconnects and re-registers them.

A control operation answers what really happened, not just "done": `desiredEnabled`, `applied`,
`changed`, `observedEnabled`, `observedStatus` and how it was applied. `restart-required` means
"persisted, takes effect after the next Harness restart"; `overridden` is a 409 explaining that
another configuration layer wins; `failed`/`cancelled` keep the manager's diagnostic instead of
falling back to a blind patch write; a restart whose start step fails reports the observed state
and tries to restore the pre-restart preference. Operations are serialized in one process-wide
queue (16 waiting operations maximum, then `429`), each re-reads live state inside the task, and
manager/phase waits are bounded (5 s per manager call, 30 s per phase) and cancellable by the
request.

The route contract is strict, because two of these routes can rewrite the composition:

- every route asks the Host `connection` service for its trust verdict first — unauthenticated
  callers get `401`, a foreign `Host` or cross-site origin gets `403`, and a fence that throws is
  treated as forbidden;
- `/dsh-mcp-hub/state` is GET/HEAD only (`405` with `Allow`), the other two are POST only;
- a declared content type must be `application/json` (case-insensitive, parameters such as
  `charset` ignored); a missing header is refused the same way with `415` — the panel always
  sends `application/json`;
- the body must be a JSON object, every identifier (`entryId`, `id`, `server`) must be a
  non-empty string, and `enabled` must be a real boolean (`400`) — all before any lookup or
  queueing, so a malformed request can never stop a server;
- an unknown row is `404`, an ambiguous name is `400` with candidates, an oversized body
  (> 64 KiB) is `413`; a stalled inventory/phase read (`listPlugins`) is `504`, while a stalled
  enable write (`setPluginEnabled`) surfaces as `500` carrying the manager diagnostic. Answers
  are JSON with `cache-control: no-store`.

Patch-file writes are a real transaction: the edit is made on the YAML AST, re-parsed and
validated against the composition's effective `disabled` before a byte reaches the disk;
comments, CRLF style and insert groups are preserved; the write goes through an exclusive
random-suffix temporary file renamed over the target, keeps the existing mode (0600 for a new
file), follows a symlinked dotfile instead of replacing it, writes a 0600 `.mcp-hub.bak` first,
and refuses (instead of overwriting) when the file changed between read and write.

Management activates only on profiles that provide `pluginManager`, `profileContext`,
`webServer`, `loader` and the Host `connection` service (desktop); the routes are fenced by
Connection's trust check, so a host without it registers neither the routes nor the two
management tools. While a recomposition leaves already-mounted routes without that service they
answer `503` and change nothing. Headless profiles keep the disclosure half exactly as before.

#### Live connection status (1.3.0)

A row's status is read from the **running MCP client instance itself**, through the Loader entry
that row really imported: `entry.moduleNamespace.connectionStatusOf(entry.fiber?.ctx?.fiber ??
entry.fiber).current()`. The Loader's `entries()` (including `include:` rows) already supplies
that entry, so a poll costs one object lookup and touches nothing. `current()` returns the
client's own `McpConnectionStatus` — `connected { toolCount, connectedAt }`, `connecting
{ attempt }`, `reconnecting { attempt, maxAttempts, nextRetryAtMs, lastError }`,
`waiting-credentials { lastError }`, `failed { reason, lastError }`, `closed` — and the plugin
maps it onto the **unchanged** public status vocabulary:

| Live state | Status token | Detail (`statusDetail`) |
|---|---|---|
| `connected`, `toolCount > 0` | `running` | — (the tool count is the live generation's) |
| `connected`, `toolCount = 0` | `idle` | — (shown as "connected, no tools") |
| `connecting` | `starting` | `connecting (attempt N)` |
| `reconnecting` | `starting` | `reconnecting (attempt N/M) · retry in Ns · <last error>` |
| `waiting-credentials` | `starting` | `waiting for credentials` |
| `closed` | `starting` | `closed` |
| `failed` | `error` | `failed: <reason> · <last error>` |

The vocabulary stays `stopped | running | idle | starting | stopping | error | unknown`; the
detail is **text**, never a new token, so a model reading `mcp_servers` sees the same statuses
as before plus one explanatory line. A row configured off is `stopped` (or `stopping` while
its fiber is still up), an unloading row is `stopping`, and a row whose **fiber failed** is
decided by the inference — a failed re-apply disposes the old supervisor before the new apply
throws, so the cell can still say `closed` while the fiber is `failed`; the `error` status and
the diagnostic win there. The live read only decides a row that is enabled, not unloading and
not failed.

The seam is guarded, because it is **not an officially documented plugin contract**: it is a
public field on the Loader entry class, and the MCP client exports `connectionStatusOf` as part
of its module surface (`typeof entry.moduleNamespace?.connectionStatusOf === 'function'`,
wrapped in `try/catch`). An older Host, a group/builtin row, a missing fiber handle or a
throwing cell simply yields `null`, and the 1.2.1 inference from `fiberPhase`, `diagnostic` and
the registered `mcp__<server>__*` names answers instead — a failed read can never be reported
as "connected". The plugin never imports `@deepseek-ai/dsh-mcp-client`: a second module instance
keeps its own status `WeakMap`, so it would return `undefined` for another instance's fiber, and
the entry is the only honest channel (see [docs/architecture.md](docs/architecture.md)). The
read is read-only — one `current()` per state poll, no `onChange` subscription (the client hands
out a disposer with nowhere for the plugin to keep it), no write, no new HTTP surface: the state
payload gains `live` (whitelisted, bounded fields) and `statusDetail`, and an older Host is read
exactly as before.

### Install

Requires DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0` (0.2.2 moved tool declarations out of the
`system-prompt/assemble` waterfall, which is why older releases cannot run this one). The plugin
declares one runtime dependency, `yaml` (`^2.9.1`), used for the patch rewrite; the bundle
installation installs it.

**1.3.0 lives on GitHub, not on npm yet.** The npm registry still serves only
`dsh-mcp-progressive@1.2.0`, which predates 1.2.1 and 1.3.0, so installing
`dsh-mcp-progressive@1.3.0` from npm fails until that release is published there. Install from
the `v1.3.0` GitHub tag:

```
plugin_manager → action: "install_bundle", target: "github:xiuerhuahuazi/dsh-mcp-progressive#v1.3.0"
```

or **Settings → Plugins → install bundle** with the same spec. The tag points at the release
commit recorded in the v1.3.0 release notes; when you need an immutable target, pin that sha
instead of the tag (the DSH docs recommend a pinned digest over a moving branch). The bundle
inserts the row `mcp-progressive`; no other bundle is required.

Upgrading from the npm `dsh-mcp-progressive@1.2.0` (or 1.0.0), or from a 1.2.1 git install:
remove the old installed package/bundle first, then install the git spec above; restart the
Harness app once so the client half and package metadata are picked up, then refresh the page. A
fresh install shows the **MCP servers** tab on first start.

Once 1.3.0 is published to npm, plain `dsh-mcp-progressive@1.3.0` will work too; this section
will say so at that point.

### Configuration

The inserted row takes an optional config:

```yaml
- id: mcp-progressive
  name: dsh-mcp-progressive
  config:
    prefix: 'mcp__'          # tool-name prefix that marks hidden MCP tools
    alwaysVisible: []        # exact names or 'mcp__server__*' prefixes never hidden
    eagerTools: []           # names loaded for the root agent from the start
    searchLimit: 12          # default result page size (1-40)
    summaryChars: 160        # one-line description budget per result (24-600)
    enableLoad: true         # register mcp_load
    enableCall: true         # register mcp_call
    correctiveUnknownTool: true
    manageServers: true      # register the server list / start / stop half (2 more tools)
```

The bundle's own patch passes `{}`; override the row from the profile patch to change these
values.

### Cost: what a load actually costs

The tool array sits at the head of the prompt, and a cache prefix runs from that point to the
end of the conversation. Paying for the tools once while they are unchanged (cache-hit price) is
cheap; **changing the array re-bills the whole prefix as a miss**. So the price of one load is
not a constant — it grows with the conversation:

```
cost of one load ≈ (prompt length at the moment of the load) × (P_miss − P_hit)
```

`P_miss`/`P_hit` are the provider's per-token cache-miss and cache-hit prices. Removing tools
pays the same miss again, which is why unloading is not a way to save money and why loading is
best kept monotonic.

Measured endpoints on one profile snapshot (DeepSeek V4.1 Flash; two MCP servers, 87 + 207
tools; tool arrays read back from recorded `request/header` entries):

| | tools in request | of which MCP | tool-definition JSON | tokens |
|---|---|---|---|---|
| before | 351 | 294 | 864,556 chars | 268,154 |
| after | ≈60 (incl. meta-tools) | 0 | ≈49–51k chars | ≈15.1–15.8k |

That is ≈94.1–94.4 % less tool-definition payload, or ≈252,000–253,000 fewer prompt tokens per
request. The "after" endpoint is a range on purpose: the same review records **48,671 chars** in
its synthesis and **50,832 chars (61 tools)** in its probe run, i.e. the two captures are not the
same snapshot. Treat all of this as **one uncontrolled profile capture, not a benchmark** (the
before/after rows may include server changes, and no derivation script or `request/header`
snapshot is committed). The token figures are derived from the recorded usage with the measured
ratio of **3.224 chars/token** for this block (a flat 4 chars/token would understate it by about
24 %).

Money is the same formula with prices. One profile measured a single late `mcp_load` at
≈0.45 元 (a near-full cache miss; the cached saving for the removed block in the same snapshot
was ≈0.010 元 per request). Treat that as one example, not a budget: the ≈45-request payback
quoted with it assumed a much larger cache discount than 10×; at a 10× discount the same miss is
paid back after roughly 10 cached requests, and a longer conversation makes every load more
expensive. Re-measure on your own profile before making a decision that depends on the amount.

What follows from the formula:

- **one-off calls** → `mcp_call`: it shadows its target only for the nested dispatch and removes
  it afterwards, so the next prompt's tool array is unchanged and no cache prefix is invalidated;
- **repeated calls** → `mcp_load`, batching several names in one call so one miss covers all of
  them;
- **keep loading monotonic** — unload only when the context actually matters, and pay the miss;
- **`eagerTools`** is for tools a session always needs, and applies to the root agent only (a
  subagent would pay the same miss in a short, throw-away context);
- **load tools, not a server**: in the measured snapshot the 294 MCP tools accounted for
  253,058 tokens (≈860 each), so loading a 170-tool server wholesale would cost six figures of
  tokens.

### Tests / verification

Everything runs locally with no network and no access to `~/.dsh`:

- `npm test` — the suite in `test/` (`node --test`), **191** tests. With the unpacked DSH
  runtime present (`$DSH_RUNTIME`, default `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai`) it
  is 188 pass / 3 skip / 0 fail: the three real-catalog schema cases only run when
  `MCP_REVIEW_CATALOG` points at a local copy of the review's 210-tool catalog (then 191 pass
  / 0 skip; the catalog is private and not committed). On CI (`.github/workflows/test.yml`,
  Node 22 and 24) neither the runtime nor that catalog exists, so the 18 runtime-dependent and
  the 3 real-catalog cases skip: 170 pass / 21 skip / 0 fail.
- `node scripts/repro-review.mjs` — the review-defect **regression gate** (default
  `--expect fixed`). It replays the six defect families from the 2026-11-19 review and exits 0
  only when none of them reproduces; otherwise it prints `REGRESSION: <families>` and exits 1.
  Where a family can observe the repaired outcome (admission, control queue, rendered panel
  message, search recall, schema fitting) the gate requires that outcome too, so a partial
  regression cannot hide behind "not reproduced". On this checkout it prints
  `0/6 defect families reproduced` / `PASS` and exits 0. `--expect baseline` is the historical
  1.2.0 evidence mode: it passes only on a `v1.2.0` checkout (6/6 reproduced) and otherwise
  reports `NOT A 1.2.0 CHECKOUT`. Without the DSH runtime the YAML family is reported as
  `skip`: the verdict counts it separately (`(5/6 evaluated, 1 skipped — skips are not
  evidence)` on both the reproduced and the PASS line) and `--json` carries `skipsNotEvidence`
  / `authority`, so a skipped run is not the six-family gate.
- `node scripts/live-boot.mjs` — the real-platform **behavioural gate** (default `--expect fixed`,
  **11/11 probes**). It boots a throw-away real DSH web instance (`DSH_HOME` in a temp directory,
  OS-assigned port) with the package installed, mints the browser session cookie and drives the
  routes with `node:http`, so an explicit `Host` header really reaches the server. It accepts
  `401|403` for the unauthenticated probe and asserts `403` for a bad `Host`, `415` for
  `text/plain` and for a missing content type, `405` + `Allow` for the wrong method, `400` for a
  bad body and `200` authenticated — and that both patch layers are byte-identical afterwards.
  The throw-away profile also declares two real MCP loader rows — `mcp-probe-broken` (a command
  that cannot spawn) and `mcp-probe-ok` (a minimal stdio MCP server written into the temp home,
  exposing two tools) — and the gate adds `state-live-broken`, which requires `status: "error"`,
  `live.state: "failed"` and a `statusDetail` carrying the spawn error even though the row's
  `fiberPhase` is `active` (inference alone would have called it `idle`), and
  `state-live-connected`, which requires `status: "running"`, `live.state: "connected"`,
  `live.toolCount: 2` and `statusDetail: null`; both rows settle in ≈65 ms (`live rows settled:
  yes`). Result on this tree: `PASS (11/11)`. `--expect baseline` documents the 1.2.0 matrix and
  only matches a `v1.2.0` checkout; it reports the two live probes as `skip`. A skip is printed
  and counted separately: a run that needed one exits 0 where CI/fallback require it, but its
  verdict is not the authoritative gate — the fallback prints `PASS (9/11, 2 skipped —
  fallback/no runtime: skips are not evidence)` and `--json` carries `skipsNotEvidence` /
  `authority`. Without the unpacked runtime the gate falls back to an in-process HTTP server
  behind a stub fence (`mode: fallback-http`, `platformAuthority: false`) and the live probes are
  skipped there too — there is no real Loader row to assert.
- `node scripts/probe-live-status.mjs` — the seam's **capability gate** (1.3.0), independent of
  the HTTP stack so a panel or admission regression cannot hide a seam regression. Against a real
  Cordis Loader and the installed `@deepseek-ai/dsh-mcp-client` it asserts (A)
  `typeof entry.moduleNamespace.connectionStatusOf === 'function'` on every MCP row and that the
  plugin's `liveStatusOf()` reads both rows; (B) a row whose command cannot spawn ends `failed`
  with `ENOENT` in `lastError`, presented as `error` with the spawn text in `statusDetail`; (C) a
  row running a minimal stdio MCP server ends `connected` with `toolCount ≥ 2`, presented as
  `running` with no detail; (D) `collectServerRows` creates no `onChange` subscription. It exits
  0 only when every assertion passes; a failed run prints the verdict and exits **1** through its
  own code — its cleanup quiesces the rows first, so the upstream mid-spawn `SIGTERM` hazard
  (see Limitations) cannot turn the verdict into a signal death or leak the temp home
  (`--json` adds `exitCode`, `cleanup` and `signals`; `PROBE_LIVE_FORCE_FAIL=1` is the hidden
  negative self-test). Without the DSH runtime it prints `SKIP: runtime unavailable` (and which
  packages are missing) and exits 0, so a runtime-less checkout stays green — `--json` marks
  `skipped: true`, `authority: false`. Run it on every DSH upgrade: the plugin's guarded fallback
  keeps working when the seam moves, but this gate turns that silent downgrade into a red line.

The `repro-review` and `live-boot` fixed/baseline modes were checked against the `v1.2.0` tag in
both directions by the regression lane: on `v1.2.0` the baseline modes pass and the fixed modes
fail, and on this release the reverse. `probe-live-status` is a capability gate, not a
regression matrix, so it has no baseline mode.

The tests use three worlds: the real DSH runtime (real Cordis, real `dsh-tools`), a fake plugin
context for the HTTP routes, and a fake browser for `client.js`. The review-item → fix → test
mapping is in [docs/fix-map.md](docs/fix-map.md).

### Limitations

- Hiding is **view + dispatch, not a permission boundary**: a hidden tool cannot be called
  directly, but `mcp_call` can still run it, and policy/approval still applies.
- `mcp_call` deliberately bypasses the step's admission set — that is the point of the tool — but
  it still runs the full pre-execute pipeline (guards, policy, approval, timeout, logging).
- `mcp_call` cannot make a nested error look like one: the outer call is still a successful text
  result, with the nested error preserved as text rather than as `isError`, and the nested tool's
  presentation `meta` is not forwarded to the outer card.
- While `mcp_call` runs, its target is registered in the agent scope. DSH's own prompt reads the
  step-restricted snapshot and is unaffected, but a third-party plugin calling
  `ctx.tools.definitions(agent)` without a step tool-set can observe the target definition.
- Patch writes are compare-and-swap with stale detection and retries, not a cross-process file
  lock: a concurrent `plugin_manager` (pnpm) write is detected and retried, but not coordinated.
- `mcp_servers` does not report how many catalog tools are hidden or leaked (deferred: that needs
  disclosure state private to the Host half); a failed mask is reported by one warning in the log.
- An upstream SDK behaviour can signal the caller's process group: `@modelcontextprotocol/client`'s
  `StdioClientTransport._dispose()` may call `proc.kill("SIGTERM")` on a transport whose spawn has
  not completed, and a `ChildProcess` with no pid forwards that to pid 0. It is pre-existing
  (identical in 1.2.1), not introduced by this plugin; the capability gate now quiesces before
  disposing, but the plugin's own Stop/Restart is platform-owned. Observed through the gate's
  failure path; the end-to-end app impact is **unverified**, and Stop/Restart on a row that is
  still starting should be treated as a known hazard until the SDK is fixed.
- Live status depends on a seam that DSH does not document as a plugin contract: when the Host
  does not expose `Entry.moduleNamespace.connectionStatusOf` (or the read throws), the plugin
  falls back silently to the 1.2.1 inference from loader rows, diagnostics and registered tool
  names — an enabled row whose server gave up reconnecting can then read "connected, no tools"
  until it is restarted. The 1.3.0 panel and `mcp_servers` are correct wherever the seam exists
  (DSH 0.2.2-rc.3 verified); `scripts/probe-live-status.mjs` is the loud check for a DSH release
  that moves it.
- The mcp-manager migration is **not** in 1.3.0. The official service exists and would still feed
  disclosure (it registers `mcp__*` tools), but it composes 0 servers here, owns only
  `Config.servers`, cannot see home-patch rows, and its writes would be refused for values a home
  patch overrides; migrating would also require moving the definitions and offering no official
  CRUD route. See [docs/architecture.md](docs/architecture.md) for the verdict and the
  preconditions.
- The `/dsh-mcp-hub/*` fence comes from the Host `connection` service, and the management half is
  only active while that service exists; a recomposition window in which the routes are still
  mounted but the service is momentarily gone answers `503` (fail closed) and changes nothing.
- Loaded tools stay in the tool array for the rest of the session; unloading changes the array
  again and pays another cache miss.
- Disclosure bookkeeping is fail-open: if a scope or a registration is unavailable it logs one
  warning per `(kind, Agent)` and leaves the tool visible instead of failing a model request; the
  prompt-assembly safety net retries a mask that was never installed.
- PTC-presented agents (`tools: { mode: ptc }`, e.g. the shipped `preset-ptc`) read the same
  restricted view, so hiding and loaded tools are covered there too; `mcp_call` cannot dispatch
  a raw call in PTC mode and answers with guidance to `mcp_load` and call the tool inside
  `run_code`.
- The catalog is read from the global registry view only: MCP tools mounted by an agent preset
  or an agent scope are neither hidden nor searchable by `mcp_search` (a 1.4 candidate; the
  disclosure restriction does not see them).
- Non-MCP tools are never touched.

### License

MIT.

## 中文

MCP 工具的渐进披露：模型不必在每次请求里为每个 `mcp__*` 工具 schema 付费；另带一个
**MCP 服务器**标签页和两个模型工具，可以在 Harness 里直接启动、停止、重启 MCP 服务器。

### 为什么

每个 MCP Server 的每个远程工具都会注册一个面向模型的工具（`mcp__<server>__<tool>`），
完整 schema 集合在**每次请求**都会重发。两三个内容丰富的 MCP Server 即使一次都没被调用，
每回合也可能花掉数万 token。

### 它做什么

插件不改动 MCP 连接和全局工具注册表——审批、超时、取消、图片与工具卡片流程都照常工作——
只改变当前 agent 看到的注册表视图：

1. 隐藏发生在注册表视图而不是 prompt：每个 agent 作用域上的一条 restriction
   （`agent.ctx.tools.restrict({ deny })`）把未装载的 schema 从 `schemas(agent)`
   （prompt provider 读取的正是这份）以及 `get`/`executable` 中移除，因此被隐藏的工具既不在
   prompt 中，也无法被直接调用。目录读取的是**全局**注册表；只挂在 agent / preset 作用域里的
   MCP 工具不在其中（见「限制」）。
2. 装载会把选中的定义重新注册到该 agent 自己的作用域，作用域内注册不受 restriction 影响。
   因此装载**不会重建** deny 列表：deny 只在目录变化（某个服务器连上或断开）时改变，而真正
   改写请求工具数组的是装载/卸载（见[费用](#费用一次装载到底花多少)）。
3. 开启 `manageServers`（默认开启）时，用五个小元工具替代目录：

   | 工具 | 作用 |
   |---|---|
   | `mcp_search` | 检索隐藏目录：完整名称、一行摘要、参数签名；`detail: "full"` 对最多两个匹配项打印精简输入 schema。 |
   | `mcp_load` | 让选中的工具从下一步起成为本会话的原生工具；`unload: true` 移除；不带参数则列出已装载项。 |
   | `mcp_call` | 通过正常工具管线直接运行一个隐藏工具，无需装载。 |
   | `mcp_servers` | 列出所有已配置 MCP 服务器及其运行状态。 |
   | `mcp_server` | 启动、停止或重启一个 MCP 服务器（需审批，见下）。 |

   `manageServers: false` 只注册前三个；`enableLoad`/`enableCall` 控制中间两个。典型回合是
   `mcp_search` → `mcp_load` → 原生调用真实工具；单次使用则 `mcp_search` → `mcp_call`。
4. `mcp_search` 采用 OR 语义：命中一个词就够了，一个拼写错误不会把相关工具全部藏起来。它带一张
   小型中文→英文词表（`浏览器` → `browser`，`截图` → `screenshot`/`capture`，`b站` →
   `bilibili` 等），中文串按去掉空白/标点后的文本匹配，`server` 过滤大小写不敏感。三种空结果
   各自给出不同的恢复建议：完全没有目录、服务器过滤没有匹配、查询词没有匹配；隐藏计数与搜索
   作用域一致，因此 `server:"rea"` 不会再出现「201 of 170」。
5. 签名上限 200 字符。`detail: "full"` 把每个 schema 打印成**合法**的精简 JSON（先剥注释，再退到
   只保留 type/enum/required 的形式），最多两个工具、整体约 6000 字符预算；连精简形式都放不下时
   打印签名、必填名和 `schema omitted: too large (N chars)`，绝不输出被截断的 JSON。
6. 猜测调用未注册的 `mcp__*` 时返回纠正提示而不是裸的未知工具错误，并区分「已注册但本会话未装载」
   与「当前不在这个 MCP 目录里」。
7. `mcp_load` 对「已登记」的两种状态如实区分：已装载且原生（「already loaded: it is a native
   tool in this conversation; call it directly」）、已装载但不可见（scope 注册失败——「pass it
   with `unload:true`, then load it again」）。另有一种「同一步装载+调用」的误用由纠正性的
   `tools/pre-execute` 处理、而不是 `mcp_load`：调用本步刚装载的工具会返回「loaded in this
   step; call it in the next step — do not batch `mcp_load` with the call」，而那次
   `mcp_load` 本身是成功的。
8. `mcp_call` 经 `ctx.tools.execute` 分发，因此走完整 pre-execute 管线（guards、策略、审批、超时）。
   它返回 MCP 服务器自己的错误文本而不是裸的抛出消息，转发 deferred context 与结束回合信号，并从
   结果里识别 PTC 拒绝。它为嵌套调用**不写任何 session 事件**：为一条没有任何 assistant 消息声明
   的调用追加 `tool/result`，会在 `session.deriveMessages()` 里留下孤立的工具结果，下一次模型请求
   会被拒绝。审计线索在每一个**返回的**结果里都是一行——`(audit: dispatched <tool>; argument keys:
   …)`——（极少数内部管线失败仍会抛出），空输出回退还把 `(<tool> completed with no output.)`
   保留在它旁边。临时 scope 注册随后移除；`alwaysVisible` 目标则完全不需要注册。
9. 一段很短的 system-prompt 章节提示目录存在，但不列出任何 schema——最多四个服务器及计数，并指向
   `mcp_search`，大致是：
   `MCP catalog: rea (170 tools), bilibili (31), blender (9); not loaded by default — mcp_search to find one.`

已装载状态按活跃 agent 保存在内存中，键是 Agent 对象身份（`WeakMap`）而不是 id，因此两个曾共用
id 的 agent 不会共享同一份遮蔽。Harness 重启即重置。`eagerTools` 只作为根会话基线：子代理
（`origin: "subagent"` 或正的 `delegationDepth`）从空集合开始；缺少 session 元数据的 agent
按根代理处理。

### MCP 服务器管理

每个 MCP 服务器都是 `@deepseek-ai/dsh-mcp-client` 的一个 loader 行。不用的服务器可以整行断开
（子进程退出），不需要卸载本插件：

- **插件页 → 「MCP 服务器」标签页**：每个 MCP 服务器一行，显示状态标签（运行中 / 已停止 /
  已连接（无工具）/ 启动中 / 停止中 / 错误 / 未知）、传输方式、目标、工具数、连接有话说时的一行
  实时详情、启动诊断（有时）、重启按钮和启停开关。状态与详情优先来自**运行中 MCP 客户端的实时
  状态单元**（见下面「实时连接状态」）：重连中的行会写明第几次尝试及下次重试时间，等待凭据的行会
  直说，失败的行显示 `failed: <原因> · <最近错误>`；完整详情同时留在标签的 `title` 里，被截断的
  第二行不会丢信息。客户端只为仍在 `starting`/`error`/`running`/`idle` 的行重建实时详情：
  `stopped`/`stopping` 的行若 Host 给了 `statusDetail` 就照常显示，但绝不继承过期的实时失败。
  有实时单元时，只有它报告 `connected` 且 `toolCount: 0` 才显示「已连接（无工具）」。
  卡片沿用插件页既有设计（48px 图标、14px 卡片标题、13px 描述、状态标签、
  36×20 开关）且只用 DSH 主题 token，明暗主题都与宿主一致；数据来自同源路由，不新增客户端 RPC。
- **模型工具**：`mcp_servers` 列出所有已配置服务器及状态，并附同一行实时详情；
  `mcp_server { server, action: "start" | "stop" | "restart" }` 控制其中一个。只有这个写工具需要
  审批（面板是人点按钮，人就是同意，故其路由不设审批门）；宿主没有审批服务时平台会拒绝而不是执行。

生效方式：

- bundle 或 profile 补丁声明的行，通过 Harness 的 `pluginManager` 服务切换（与插件页开关
  同一条路径）；
- 仅由 home 层补丁（`~/.dsh/cordis.patch.yml`）插入的行无法被该服务寻址，插件会把一条校验过的
  顶层 `- id: … / disabled: …` 覆盖写入该补丁文件（见下面的文件事务）；
- 被 Harness 锁定、且没有任何可写补丁声明该 id 的行返回 `409`；
- HMR 会即时应用，两种方式都持久化、重启后仍有效。停止服务器会从所有会话移除它的
  `mcp__<server>__*` 工具；启动会重新连接并注册。

控制操作回答真实发生的事，而不只是「完成」：`desiredEnabled`、`applied`、`changed`、
`observedEnabled`、`observedStatus` 以及生效途径。`restart-required` 表示「已保存，需重启
Harness 后生效」；`overridden` 是 409，说明被另一个配置层压住；`failed`/`cancelled` 保留
manager 的诊断而不是盲写补丁；restart 的启动步骤失败时会报告观察到的状态并尝试恢复重启前的
偏好。操作在同一进程内的队列里串行执行（最多 16 个等待操作，超出返回 `429`），每个任务
在内部重新读取实时状态，manager/阶段等待都有上限（每次 manager 调用 5 秒、每个阶段 30 秒）
且可被请求取消。

其中两条路由能改写组合，因此路由契约是严格的：

- 每条路由先向 Host 的 `connection` 服务要信任判定——未认证 → `401`，外部 `Host` 或跨站
  `Origin` → `403`，判定抛错按禁止处理；
- `/dsh-mcp-hub/state` 只允许 GET/HEAD（否则 `405` 带 `Allow`），另外两条只允许 POST；
- 声明的 content-type 必须是 `application/json`（大小写不敏感，忽略 `charset` 等参数）；完全
  不带该头同样返回 `415`——面板始终发送 `application/json`；
- body 必须是 JSON 对象，所有标识符（`entryId`、`id`、`server`）必须是非空字符串，`enabled`
  必须是真正的布尔值（否则 `400`）——全部在查找与入队之前校验，畸形请求不可能停掉服务器；
- 未知行 `404`，歧义名称 `400` 并附候选，超过 64 KiB 的请求体 `413`；卡住的目录/阶段读取
  （`listPlugins`）返回 `504`，而卡住的启用写入（`setPluginEnabled`）以 `500` 冒泡并带 manager
  诊断。响应均为 JSON，`cache-control: no-store`。

补丁写入是真正的事务：在 YAML AST 上编辑，先重新解析并按组合后的有效 `disabled` 校验，通过后
才落盘；保留注释、CRLF 风格与 insert 组；写入经独占随机后缀临时文件 rename 覆盖目标，保留原
权限（新文件 0600），跟随软链而不是替换它，先写 0600 的 `.mcp-hub.bak`，发现文件在读写之间被
改动时拒绝覆盖（而不是悄悄覆盖）。

管理半侧只在提供 `pluginManager`、`profileContext`、`webServer`、`loader` 与 Host 的 `connection`
服务的 profile（桌面）激活；这些路由靠 Connection 的信任检查把关，因此没有该服务的宿主既不注册这些
路由、也不注册两个管理工具。若一次重组后路由仍挂载而该服务暂时消失，它们会返回 `503` 且不做任何
改动。headless profile 保持原有的披露半侧不变。

#### 实时连接状态（1.3.0）

一行的状态读自**运行中的 MCP 客户端实例本身**，通道是这一行真正 import 到的 Loader entry：
`entry.moduleNamespace.connectionStatusOf(entry.fiber?.ctx?.fiber ?? entry.fiber).current()`。
Loader 的 `entries()`（含 `include:` 行）本来就提供该 entry，所以一次轮询只是一次对象查找，
不触碰别的状态。`current()` 返回客户端自己的 `McpConnectionStatus`——`connected { toolCount,
connectedAt }`、`connecting { attempt }`、`reconnecting { attempt, maxAttempts, nextRetryAtMs,
lastError }`、`waiting-credentials { lastError }`、`failed { reason, lastError }`、`closed`——
插件把它映射到**未改变**的公开状态词表：

| 实时状态 | 状态词 | 详情（`statusDetail`） |
|---|---|---|
| `connected`，`toolCount > 0` | `running` | —（工具数取实时 generation 的） |
| `connected`，`toolCount = 0` | `idle` | —（显示为「已连接（无工具）」） |
| `connecting` | `starting` | `connecting (attempt N)` |
| `reconnecting` | `starting` | `reconnecting (attempt N/M) · retry in Ns · <最近错误>` |
| `waiting-credentials` | `starting` | `waiting for credentials` |
| `closed` | `starting` | `closed` |
| `failed` | `error` | `failed: <原因> · <最近错误>` |

词表仍是 `stopped | running | idle | starting | stopping | error | unknown`；详情是**文本**，
不是新状态词，所以读 `mcp_servers` 的模型看到的状态和以前一致，只多一行解释。配置为关闭的行是
`stopped`（fiber 仍在时是 `stopping`）、正在卸载的行是 `stopping`，而**fiber 已失败**的行由推断
裁决——失败的重应用会先 dispose 旧 supervisor 再让新 apply 抛错，此时状态单元仍可能是 `closed`，
所以失败行以 `error` 状态与 `diagnostic` 为准。实时状态只裁决「已启用、未在卸载、且未失败」的行。

这条缝有守卫，因为它**不是被官方文档化的插件契约**：它是 Loader entry 类上的公开字段，而 MCP
客户端把 `connectionStatusOf` 作为模块表面的一部分导出（判断
`typeof entry.moduleNamespace?.connectionStatusOf === 'function'`，外包 `try/catch`）。旧版
Host、group/builtin 行、缺少 fiber 句柄或读取抛错时一律得到 `null`，回落到 1.2.1 的推断
（`fiberPhase`、`diagnostic` 与已注册的 `mcp__<server>__*` 名），因此**读取失败永远不会被报成
「已连接」**。插件绝不 import `@deepseek-ai/dsh-mcp-client`：同版本的第二个模块实例有自己独立的
状态 `WeakMap`，对另一个实例的 fiber 只会返回 `undefined`，entry 是唯一诚实的通道
（见 [docs/architecture.md](docs/architecture.md)）。读取是只读的——每次轮询一次 `current()`，
不订阅 `onChange`（客户端只给 disposer，插件没有可以保管它的宿主位置），不写盘、不新增 HTTP
面：state 载荷新增 `live`（白名单、有界字段）与 `statusDetail`，旧版 Host 的读取行为与以前完全
一致。

### 安装

需要 DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`（0.2.2 把工具声明移出了
`system-prompt/assemble` 瀑布，这正是旧版本无法运行本版本的原因）。插件声明唯一的运行时依赖
`yaml`（`^2.9.1`），用于补丁改写；安装 bundle 时会一并安装。

**1.3.0 目前只在 GitHub 上，还没发布到 npm。** npm registry 上仍然只有
`dsh-mcp-progressive@1.2.0`（早于 1.2.1 与 1.3.0），所以用 npm spec
`dsh-mcp-progressive@1.3.0` 会失败，直到该版本正式发布到 npm。请从 `v1.3.0` 的 GitHub tag 安装：

```
plugin_manager → action: "install_bundle", target: "github:xiuerhuahuazi/dsh-mcp-progressive#v1.3.0"
```

或在**设置 → 插件 → 安装 bundle** 中填入同一个 spec。该 tag 指向 v1.3.0 release notes 里记录的
发布 commit；需要不可变目标时，钉住那个 sha，而不是 tag（DSH 文档建议钉 sha，而不是跟随会移动的
分支）。该 bundle 会插入 `mcp-progressive` 行，不依赖其他 bundle。

从 npm 的 `dsh-mcp-progressive@1.2.0`（或 1.0.0）、或从 1.2.1 的 git 安装升级：先移除旧的已安装
包/bundle，再安装上面的 git spec；**重启一次 Harness 应用**让客户端半侧与包元数据生效，然后刷新
页面；全新安装首次启动即可看到「MCP 服务器」标签页。

等 1.3.0 发布到 npm 之后，直接 `dsh-mcp-progressive@1.3.0` 也会可用；届时本节会更新。

### 配置

插入的行支持可选配置（示例见英文部分的 YAML）：`prefix`、`alwaysVisible`（精确名或以 `*` 结尾
的前缀）、`eagerTools`（只对根 agent 生效）、`searchLimit`（1–40，默认 12）、`summaryChars`
（24–600，默认 160）、`enableLoad`、`enableCall`、`correctiveUnknownTool`、`manageServers`。
bundle 自带 patch 传入 `{}`；如需修改，在 profile 的 `cordis.patch.yml` 中覆盖该行即可。

### 费用：一次装载到底花多少

工具数组位于 prompt 头部，缓存前缀从那里一直延伸到会话末尾。工具不变时按缓存命中价付费很便宜；
**改变数组会把整段前缀按未命中重算**。所以一次装载的价格不是常数，而随对话变长：

```
一次装载成本 ≈ （装载时刻的 prompt 长度）×（P_miss − P_hit）
```

`P_miss`/`P_hit` 是服务商每 token 的缓存未命中价与命中价。移除工具要再付一次同样的未命中，所以
卸载不是省钱手段，装载最好保持单调。

一个 profile 快照上的实测端点（DeepSeek V4.1 Flash；两个 MCP Server：87 + 207 个工具；工具数组
取自记录的 `request/header`）：

| | 请求内工具 | 其中 MCP | 工具定义 JSON | token |
|---|---|---|---|---|
| 之前 | 351 | 294 | 864,556 字符 | 268,154 |
| 之后 | ≈60（含元工具） | 0 | ≈4.9–5.1 万字符 | ≈1.51–1.58 万 |

即每次请求工具定义体积约 **−94.1%–−94.4%**、prompt **少约 25.2–25.3 万 token**。「之后」端点刻意写成
区间：同一份评审在合成报告里记录 **48,671 字符**、在其探针运行里记录 **50,832 字符（61 个工具）**，
两次抓取并非同一快照。请把这些数字当作**一次未受控的 profile 抓取，而不是基准测试**（前后两行可能
混入服务器增减；仓库里也没有提交推导脚本或 `request/header` 快照）。token 数字按记录用量与实测比值
**3.224 字符/token** 推算（按 4 字符/token 估算会低估约 24%）。

费用就是同一公式套价格。某 profile 实测一次较晚的 `mcp_load` 约 **0.45 元**（近似全量缓存未命中；
同一快照里被移除工具块的缓存命中节省约 **0.010 元/请求**）。这只是一个例子，不是预算：与它一起
引用的「≈45 次回本」是按比 10× 大得多的缓存折扣算出来的；按 10× 折扣，这次未命中约 10 次缓存
请求回本，而会话越长每次装载越贵。真要按金额决策，请在自己的 profile 上重测。

由公式得出的做法：

- **单次调用** → `mcp_call`：它只在嵌套分发期间临时注册目标、随后移除，下一次 prompt 的工具数组
  不变，不会作废缓存前缀；
- **重复调用** → `mcp_load`，一次批量传入多个名字，让一次未命中覆盖全部；
- **保持单调装载**——只有上下文确实重要时才卸载，并为此付一次未命中；
- **`eagerTools`** 用于会话必定要用的工具，且只对根 agent 生效（子代理会在短命的上下文里再付一次）；
- **装载工具，而不是装载服务器**：实测快照里 294 个 MCP 工具占 253,058 token（平均 ≈860/个），
  整个装载一个 170 工具的服务器会花六位数 token。

### 测试与验证

全部本地运行，不联网、不读写 `~/.dsh`：

- `npm test`——`test/` 下的测试（`node --test`），共 **191** 个。在 `$DSH_RUNTIME`（默认
  `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai`）有解包运行时的情况下是 188 通过 / 3 跳过 /
  0 失败：三个「真实目录」schema 用例只有把 `MCP_REVIEW_CATALOG` 指向评审用 210 工具目录的
  本地副本时才运行（此时 191 通过 / 0 跳过；该目录是私有数据，不随仓库提交）。CI
  （`.github/workflows/test.yml`，Node 22 与 24）既没有解包运行时、也没有该目录，于是 18 个
  依赖运行时的用例 + 3 个真实目录用例跳过：170 通过 / 21 跳过 / 0 失败。
- `node scripts/repro-review.mjs`——评审缺陷**回归门**（默认 `--expect fixed`）。它把
  2026-11-19 评审的六组缺陷在当前代码上重放，只有一组都不复现时才 exit 0；否则打印
  `REGRESSION: <families>` 并 exit 1。凡是能观察到「修好后的结果」的组（准入、控制队列、
  面板渲染出的操作消息、检索召回、schema 适配），门也要求那个结果，因此局部回退无法藏在
  「未复现」后面。本检出输出 `0/6 defect families reproduced` / `PASS` 且 exit 0。
  `--expect baseline` 是历史的 1.2.0 证据模式：只有在 `v1.2.0` 检出上才通过（6/6 复现），
  否则报告 `NOT A 1.2.0 CHECKOUT`。没有 DSH 运行时的情况下 YAML 那组报告为 `skip`：结论行会
  单独计数（复现行与 PASS 行都显示 `(5/6 evaluated, 1 skipped — skips are not evidence)`），
  `--json` 带 `skipsNotEvidence` / `authority`，因此带 skip 的运行不是六组回归门。
- `node scripts/live-boot.mjs`——真实平台的**行为门**（默认 `--expect fixed`，**11/11 个探针**）。
  它用临时 `DSH_HOME` 和操作系统分配的端口启动一个真实 DSH Web 实例并安装本包，从启动令牌换取
  浏览器 cookie，再用 `node:http` 探测路由（因此显式 `Host` 真的会到达服务器）。未认证探针接受
  `401|403`，并断言坏 `Host` → `403`、`text/plain` 与缺少 content-type → `415`、错误方法 →
  `405` 带 `Allow`、坏 body → `400`、已认证 → `200`，且事后两层补丁文件逐字节不变。临时 profile
  还声明两条真实 MCP loader 行——`mcp-probe-broken`（一条无法 spawn 的命令）与
  `mcp-probe-ok`（写进临时 home 的最小 stdio MCP 服务器，暴露两个工具）——门里因此多出
  `state-live-broken`：要求该行 `status: "error"`、`live.state: "failed"`，且 `statusDetail`
  带上 spawn 错误，即使它的 `fiberPhase` 是 `active`（只靠推断会把它当成 `idle`）；以及
  `state-live-connected`：要求 `status: "running"`、`live.state: "connected"`、
  `live.toolCount: 2`、`statusDetail: null`。两行都在 ≈65 ms 内稳定（`live rows settled:
  yes`）。本检出结果：`PASS (11/11)`。`--expect baseline` 记录 1.2.0 矩阵，只在 `v1.2.0`
  检出上成立；它把这两个实时探针报告为 `skip`。skip 会单独打印并计数：需要 skip 的运行在
  CI/fallback 要求下仍 exit 0，但它的结论不是权威门——fallback 打印
  `PASS (9/11, 2 skipped — fallback/no runtime: skips are not evidence)`，`--json` 带
  `skipsNotEvidence` / `authority`。没有解包运行时则退回进程内 HTTP 服务器 + 桩围栏
  （`mode: fallback-http`、`platformAuthority: false`），实时探针同样跳过——没有真实 Loader 行
  可供断言。
- `node scripts/probe-live-status.mjs`——这条缝的**能力门**（1.3.0），不依赖 HTTP 栈，因此面板或
  准入的回归藏不住缝本身的回归。它对着真实 Cordis Loader 与已安装的
  `@deepseek-ai/dsh-mcp-client` 断言：(A) 每条 MCP 行上
  `typeof entry.moduleNamespace.connectionStatusOf === 'function'`，且插件的 `liveStatusOf()`
  能读到两行；(B) 命令无法 spawn 的行最终为 `failed`、`lastError` 带 `ENOENT`，呈现为 `error`
  且 `statusDetail` 含 spawn 文本；(C) 运行最小 stdio MCP 服务器的行最终为 `connected`、
  `toolCount ≥ 2`，呈现为 `running` 且无详情；(D) `collectServerRows` 不创建任何 `onChange`
  订阅。只有全部断言通过才 exit 0；失败的运行会打印结论并由脚本自己 exit **1**——清理会先把各行
  quiesce，因此上游 mid-spawn 的 `SIGTERM` 隐患（见「限制」）不会把结论变成信号死亡或泄漏临时目录
  （`--json` 增加 `exitCode`、`cleanup`、`signals`；`PROBE_LIVE_FORCE_FAIL=1` 是隐藏的负向自测）。
  没有 DSH 运行时则打印 `SKIP: runtime unavailable`（并列出缺失的包）且 exit 0，让无运行时的检出保持
  绿色，`--json` 标记 `skipped: true`、`authority: false`。每次升级 DSH 都该跑它：插件带守卫的回落
  会让缝被移动时功能继续降级运行，而这个门把「静默降级」变成红线。

回归线已用 `v1.2.0` 标签双向核对 `repro-review` 与 `live-boot` 的 fixed/baseline 模式：在
`v1.2.0` 上 baseline 模式通过、fixed 模式失败；在本版本上相反。`probe-live-status` 是能力断言
而不是回归矩阵，因此没有 baseline 模式。

测试使用三个世界：真实 DSH 运行时（真实 Cordis、真实 `dsh-tools`）、用于 HTTP 路由的假插件
上下文、以及驱动 `client.js` 的假浏览器。评审条目 → 修复 → 测试的对应表在
[docs/fix-map.md](docs/fix-map.md)。

### 限制

- 隐藏是**视图 + 分发**层面的，不是权限边界：被隐藏的工具不能直接调用，但仍可通过
  `mcp_call` 执行，策略与审批照常生效。
- `mcp_call` 有意绕过本步的准入集合——这正是该工具的意义——但它仍走完整 pre-execute 管线
  （guards、策略、审批、超时、日志）。
- `mcp_call` 无法把嵌套错误伪装成错误：外层调用仍是一个成功的文本结果，嵌套错误以文本保留而非
  `isError`，嵌套工具的 presentation `meta` 也不会转发到外层卡片。
- `mcp_call` 运行期间目标会注册到 agent 作用域。DSH 自己的 prompt 读取的是本步受限快照，不受
  影响；但第三方插件若不带 step tool-set 调用 `ctx.tools.definitions(agent)`，可以看到该定义。
- 补丁写入是对比并交换（compare-and-swap）+ 过期检测与重试，不是跨进程文件锁：并发的
  `plugin_manager`（pnpm）写入会被检测并重试，但不会被协调。
- `mcp_servers` 不报告有多少目录工具被隐藏或泄漏（推迟：需要 Host 半侧私有的披露状态）；遮蔽
  失败只在日志里留一条警告。
- 上游 SDK 有一种会把信号发给调用方进程组的行为：`@modelcontextprotocol/client` 的
  `StdioClientTransport._dispose()` 可能在 transport 的 spawn 尚未完成时调用
  `proc.kill("SIGTERM")`，而没有 pid 的 `ChildProcess` 会把它转发给 pid 0。它是既有问题
  （1.2.1 同样存在），不是本插件引入的；能力门现在会先 quiesce 再 dispose，但插件自己的
  停止/重启由平台拥有。该信号在能力门的失败路径上被观察到，端到端对应用的影响**未验证**；
  在 SDK 修复前，对仍在启动中的行执行停止/重启应视为已知风险。
- 实时状态依赖一条 DSH 未文档化为插件契约的缝：当 Host 不提供
  `Entry.moduleNamespace.connectionStatusOf`（或读取抛错）时，插件静默回落到 1.2.1 的推断
  （loader 行、诊断与已注册工具名）；此时已启用但重连预算耗尽的服务器可能显示为「已连接（无工具）」，
  直到重启。凡有该缝的地方（DSH 0.2.2-rc.3 已验证），1.3.0 的面板与 `mcp_servers` 都正确；
  `scripts/probe-live-status.mjs` 是 DSH 移动该缝时的响铃检查。
- mcp-manager 迁移**不在** 1.3.0 内。官方服务存在、迁过去披露也仍然有效（它照样把 `mcp__*` 注册进
  `ctx.tools`），但它在当前部署里管着 0 台服务器、只拥有 `Config.servers`、看不见 home 补丁里的行，
  且被 home 补丁覆盖的值会让它的写入被拒；迁移还要搬定义、且官方没有 CRUD 路由。裁决与前置条件见
  [docs/architecture.md](docs/architecture.md)。
- `/dsh-mcp-hub/*` 的信任门来自 Host 的 `connection` 服务，管理半侧也只在该服务存在时激活；若一次
  重组后路由仍挂载而服务暂时消失，它们返回 `503`（fail closed）且不做任何改动。
- 已装载的工具会在本会话剩余时间里留在工具数组中；卸载会再次改变数组并再付一次缓存未命中。
- 披露记账是 fail-open 的：作用域或注册不可用时，按「种类 + Agent 对象」只记一条警告并让工具保持
  可见，不会让模型请求失败；prompt 组装时的安全网会重试从未装上的遮蔽。
- PTC 呈现的 agent（`tools: { mode: ptc }`，如内置 `preset-ptc`）读取同一份受限视图，隐藏与
  已装载工具都覆盖；`mcp_call` 在 PTC 模式下不能直接分发，会提示改用 `mcp_load` 后在
  `run_code` 内调用。
- 目录只读取全局注册表视图：由 agent preset 或 agent 作用域挂载的 MCP 工具既不会被隐藏，也搜不到
  （1.4 候选；披露 restriction 看不到它们）。
- 非 MCP 工具不受影响。

### 许可证

MIT。
