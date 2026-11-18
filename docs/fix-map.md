# Fix map — 1.2.0 review → 1.2.1

Audit trail for the 2026-11-19 review (`SYNTHESIS.md` §3/§4/§5). Every row names the
code that changed and the regression that locks it. Test names are verbatim from the
files; a test may cover several rows.

**Status legend**

| Status | Meaning |
|---|---|
| Fixed | Implemented and covered by a regression. |
| Partially fixed | The verified part is implemented; the remainder is explicitly out of scope and documented. |
| Deferred | Deliberately not in 1.2.1; stated in `README.md` → Limitations and `CHANGELOG.md` → Deferred. |
| Not changed | Optional item left as-is; noted here so the reviewer does not look for it. |
| Moot | The premise no longer applies in the merged code. |

**Where the fixes live**

| File | Role in 1.2.1 |
|---|---|
| `index.js` | Disclosure (`WeakMap` state, `masked` safety net, corrective `tools/pre-execute`), `mcp_load` / `mcp_call` / `mcp_search`, catalog prompt section, `mcp_server` approval gate, `__test` exports. |
| `lib/patch.js` | YAML-AST patch rewrite, semantic verification, atomic 0600 write, backup, compare-and-swap. |
| `lib/search.js` | Tokenizer + CJK gloss, OR ranking, empty states, hidden count, valid compact schema fitting, descriptions. |
| `lib/management.js` | Routes and their admission (including the fail-closed `503` window), method/content-type/body checks, control queue, state machine, redaction, status, `mcp_servers` / `mcp_server`. |
| `client.js` | Panel error retention, request generations, abort deadlines, `Map` pending, locale `active`, `entryId` addressing, tones, a11y. |
| `README.md`, `CHANGELOG.md`, `docs/` | This lane: tool count, cost formula, security contract, limitations, verification. |

---

## P0 — S1–S12

| Item | Status | What changed (file · function) | Regression evidence (test file › test name) |
|---|---|---|---|
| S1 — management routes: no auth / origin / content-type check | Fixed | `lib/management.js` · `rejectUntrusted` (calls `connection.requestRejection`, `503` when the service or its fence is absent, fail-closed on throw), `requireMethod` (405 + `Allow`), `checkJsonContentType` (requires `application/json`, `415` for a missing or non-JSON header); `index.js` · management `ctx.inject([... 'connection'])` so the half does not activate without the fence | `test/management.test.mjs` › `every route answers a rejected admission with JSON before doing anything`; `a 401 rejection status is preserved in the JSON answer`; `a connection fence that throws fails closed`; `all three routes fail closed with 503 when the connection service is absent`; `POST routes refuse a declared non-JSON content type`; `a POST with a JSON body but no content-type header is a 415 with zero manager calls`; `methods are enforced with an allow header`; `test/core.test.mjs` › `management admission requires the Host connection service`; `scripts/live-boot.mjs` (default gate, real boot 9/9): `401`/`403` admission, `403` bad `Host`, `415` text/plain and missing content type, `405` + `Allow`, `400` bad body, `200` authenticated, patch layers byte-identical |
| S2 — `enabled` missing/typed as non-boolean becomes "stop" | Fixed | `lib/management.js` · `validateBodyObject`, `validateAddressing`, `validateEnabled` run before lookup/enqueue | `test/management.test.mjs` › `enabled must be a real boolean and bad bodies never enqueue work`; `scripts/live-boot.mjs` probes `toggle-missing-enabled` / `toggle-enabled-string` → `400` |
| S3 — hand-written YAML rewrite corrupts the patch | Fixed | `lib/patch.js` · `parsePatchDocument`, `lastOverride`, `flattenInsertRows`, `effectiveDisabled`, `snapshotOf`, `verifyRewrite`, `setPatchDisabled` (AST only; append verified top-level override for insert-only rows) | `test/patch.test.mjs` › `setPatchDisabled keeps every reviewed fixture valid with the intended flag` (23 fixtures); `rewrites keep comments, CRLF line endings and block scalars`; `setPatchDisabled refuses text it cannot turn into a valid sequence`; `a row that only lives inside an insert group gets a top-level override`; `applyPatchOverride writes a top-level override for an insert-only home row`; also `scripts/repro-review.mjs` probe A: `0/23` valid inputs turn unparseable |
| S4 — file transaction: mode downgrade, weak backup, lost edits, non-atomic fallback | Fixed (process-local; cross-process lock deferred) | `lib/patch.js` · `resolveWritePath` (realpath; dangling symlink refused), `existingMode`, `writeAtomically` (`wx` + random suffix + `chmod` + `rename`), `backupPatchFile` (0600, throws), `writePatchFile` (CAS, 3 attempts), `applyPatchOverride` (re-reads inside the transaction) | `test/patch.test.mjs` › `backupPatchFile writes the snapshot next to the real file, mode 0600, and reports failure`; `writePatchFile defaults to 0600, preserves an existing mode and leaves no temp files`; `writePatchFile refuses to overwrite content it did not read`; `applyPatchOverride edits the current file, keeps 0600 and backs up the old bytes`; `two sequential edits on one file both survive`; `applyPatchOverride keeps a symlinked dotfile a symlink and backs up the real target`; `applyPatchOverride throws and leaves the original bytes when the result cannot be validated`; `applyPatchOverride fails visibly when the backup cannot be written`; `applyPatchOverride refuses a missing patch file` |
| S5 — control plane uses a stale snapshot, early success, no rollback, no bounds | Fixed | `lib/management.js` · `createControlQueue`, `runOperation` (re-reads rows inside the task), `changeServerEnabled`, `restartServer` (preference rollback), `waitForServerPhase` (real unload, `failed` is failure), `awaitBounded`, `phaseFailure`, `operationResult` | `test/management.test.mjs` › `stop and start issued together run in order and end enabled`; `a start whose fiber fails is a failure, with the diagnostic surfaced`; `a restart whose start step fails reports the failure and the observed state`; `the control queue bounds its backlog and refuses with 429`; `the HTTP routes answer 429 when the queue is full`; `a hung listPlugins cannot block the phase wait forever`; `a hung listPlugins cannot block the state route forever`; `waitForServerPhase stops early on request abort`; `waitForServerPhase does not report a still-unloading row as stopped`; `a server that never reaches its phase is a bounded 500, not a hang` |
| S6 — blind profile-patch write after a manager refusal; layer chosen by regex | Fixed | `lib/management.js` · `resolveToggleTarget` (patch declaration by composition, not text regex), `patchDeclaresRow`, `changeServerEnabled` exhaustive `application` branches (`applied` / `restart-required` / `overridden` / failed-cancelled throw, no patch fallback) | `test/management.test.mjs` › `application: overridden is a 409 that and does not claim the change ran`; `application: restart-required reports "saved, needs restart" without claiming running`; `application: failed/cancelled keep the manager diagnostic and never write the patch`; `a home-patch row is toggled through the home patch, never the manager`; `a profile-patch row is toggled through the profile patch`; `a row locked by the Harness without a writable declaration is a 409` |
| S7 — mixed `findServer` matching toggles another server | Fixed | `lib/management.js` · `resolveServerTarget` (exact `entryId` → `id` → name; case-insensitive only on a unique hit; ambiguity → 400 + candidates), `findServer`, `isMcpClientModule` (exact module identity); `client.js` · `addressOf` / `addressBody` send `entryId` | `test/management.test.mjs` › `an unknown server is a 404 and an ambiguous name lists its candidates`; `addressing is exact and entryId wins over a colliding server name`; `resolveServerTarget keeps the helper contract`; `the model tool resolves uniquely and lists candidates on ambiguity`; `the MCP module identity is exact, not a prefix`; `test/client.test.mjs` › `toggle and restart POST address the row by entryId as JSON`; `addressing falls back to id when a row has no entryId` |
| S8 — `targetSummary` echoes argv credentials / malformed URLs | Fixed | `lib/management.js` · `targetSummary` (flags only, no `=value`/attached value; `(invalid URL)` placeholder; URL `.host`) | `test/management.test.mjs` › `targetSummary never exposes argument values or an unparseable URL`; `the MCP module identity is exact, not a prefix` |
| S9 — search silent on a real catalog (AND, no CJK, case-sensitive server, bad empty state) | Fixed | `lib/search.js` · `tokenize` + `CJK_GLOSSARY`, `compact`, `matchOneToken`, `scoreEntry` (OR + matched-count ranking), `rankCatalog` (case-insensitive server filter, scope-aware counts), `renderSearch` (three empty states), `countHidden`, `MCP_SEARCH_DESCRIPTION`; `index.js` · `mcp_search` execute | `test/search.test.mjs` › `the review's measured queries all recall the expected tools (S9, table-driven)`; `server filter is case-insensitive (S9, table-driven)`; `OR semantics: one unmatched token does not zero the result (S9)`; `a single token hit ranks by position then precision (S9)`; `no query still lists servers and tools (S9)`; `empty state (a): no catalog at all says so`; `empty state (b): a misspelled server lists the known servers (P2-6)`; `empty state (c): an unmatched query lists examples and the English hint`; `real catalog: measured queries all recall (S9)`; `tokenize bridges CJK queries to English tool names`; `mcp_search description states the English hint and the two-schema cap`; also `scripts/repro-review.mjs` probe E |
| S10 — `detail:"full"` prints invalid JSON | Fixed | `lib/search.js` · `fitDetailSchema` (`fitSchema`) with `stripAnnotations` → `compactNode` → `compactSchema` → omit; `MAX_DETAIL_TOOLS` (2), `DETAIL_SCHEMA_BUDGET` (6000), `MAX_SIGNATURE_CHARS` (200); `renderSearch` omitted notice | `test/search.test.mjs` › `fitSchema returns the original JSON when it already fits`; `fitSchema strips annotations before cutting structure`; `fitSchema compacts nested schemas into valid JSON`; `fitSchema keeps enum, oneOf, array items and $defs reachable in compact form`; `fitSchema omits the JSON when even the compact form is too large`; `fitSchema never mutates the caller schema`; `synthetic 2k and 8k schemas degrade without printing invalid JSON (S10)`; `every printed schema parses and fits its budget (synthetic matrix)`; `detail:"full" prints at most two schemas within the total budget`; `detail:"full" omits oversized schemas and prints signature plus required names`; `a single match gets the whole page budget for its schema`; `real catalog: the 57,175-char compare_web_captures schema always parses (S10)`; `real catalog: every schema either parses within budget or is explicitly omitted (S10)`; also `scripts/repro-review.mjs` probe F |
| S11 — client: errors cleared, stale responses, hung requests, special ids | Fixed | `client.js` · `requestJson` (AbortController + deadline + tracking set), `load` / `act` (sequence / `appliedSequence` / `actionSequence` guards), `pending` as `Map`, `pickLocale` (`active`), `addressOf` / `addressBody`, `outcomeOf`, `statusTone`, `card` a11y props, effect cleanup | `test/client.test.mjs` › `a failed action stays visible after a following successful poll`; `an older poll response cannot overwrite a newer action snapshot`; `a hung request is aborted at its deadline and polling recovers`; `unmount aborts requests that are still in flight`; `a server whose id is "constructor" toggles without staying busy`; `the panel reads the platform locale snapshot "active"`; `the panel keeps the browser-language fallback`; also `scripts/repro-review.mjs` probe D |
| S12 — per-agent state keyed by `agent.id`, not the scope it masks | Fixed | `index.js` · `loadedByAgent` and `disclosures` are `WeakMap`s keyed by the Agent object; `stateOf`, `dropDisclosure`, `agent/disposed` cleanup; `liveStates` only for teardown | `test/core.test.mjs` › `S12: two agents that share an id are masked independently` |

---

## P1 — P1-1…P1-13

| Item | Status | What changed (file · function) | Regression evidence |
|---|---|---|---|
| P1-1 — cost model as a constant; strategy by money | Fixed | `README.md` · “Cost: what a load actually costs”: `cost ≈ prompt length × (P_miss − P_hit)`, measured endpoints with their caveats, one measured load example, monotonic/batch/`mcp_call` guidance | Documentation: `README.md` (English and Chinese halves). No test. |
| P1-2 — status only from `enabled`/`fiberPhase`/`toolCount` | Fixed | `lib/management.js` · `collectServerRows` reads `row.diagnostic`; `serverStatus` reports `error` on a diagnostic and `stopping`; `presentServer` / `renderServerList` expose it; `client.js` renders the diagnostic on the card | `test/management.test.mjs` › `the state route reports diagnostic, stopping and the full row contract`; `serverStatus keeps the documented vocabulary, including stopping`; `test/client.test.mjs` › `a server diagnostic is rendered on the card` |
| P1-3 — same-batch load + call yields a bare unknown tool | Fixed | `index.js` · corrective `tools/pre-execute` branch: catalog name + globally visible + not in this step's `toolSet` → deny with next-step guidance | `test/core.test.mjs` › `P1-3: a tool loaded in this step is refused with next-step guidance` |
| P1-4 — `eagerTools` applies to subagents | Fixed | `index.js` · `isSubagent` (`header.origin === 'subagent'` or `delegationDepth > 0`), `loadedSet` seeds `eagerTools` for roots only; missing metadata → root | `test/core.test.mjs` › `P1-4: eagerTools applies to root agents only` |
| P1-5 — no prompt hint that the catalog exists | Fixed | `index.js` · `systemPrompt.section({ name: 'mcp-progressive:catalog', order: 3050, text })` — server names/counts up to 4, `mcp_search` pointer, empty catalog contributes `''` | `test/core.test.mjs` › `P1-5: the catalog prompt section is per-assembly and contributes nothing without a catalog` |
| P1-6 — `mcp_call` drops the MCP error body and presentation meta | Partially fixed | `index.js` · `contentText`, error branch of `mcp_call.execute` returns `Error from MCP tool "…": <server text>` (dedupes the native `Error: ` wrapper); `pendingResults` + `projectContent` forward content blocks and images. Nested `meta` has no seam into the outer card — documented in `README.md` → Limitations | `test/core.test.mjs` › `P1-6: mcp_call returns the MCP error text content instead of a bare message` |
| P1-7 — `mcp_server` has no approval gate | Fixed | `index.js` · `tools/pre-execute` handler returns `{ kind: 'ask', reason, displayReason }` for `mcp_server` start/stop/restart; `mcp_servers` and the browser routes are not gated | `test/core.test.mjs` › `P1-7: mcp_server writes ask for approval while mcp_servers stays ungated` |
| P1-8 — untestable pure helpers; no test script | Fixed | Host half split into `lib/patch.js` / `lib/search.js` / `lib/management.js`; `index.js` · `__test` exports the seams; `test/*.test.mjs` with `node --test`; `package.json` declares `"test": "node --test"` (set before this lane) | `test/smoke.test.mjs` › `__test exposes the stable pure-helper seam`; `the pure helpers behave as documented`; whole suite: `npm test` → 152 cases (see Evidence run) |
| P1-9 — fail-open never self-heals | Fixed | `index.js` · `reconcile` sets `state.masked = false` in the catch and `true` only after a restriction install; `system-prompt/assemble` safety net tests `disclosures.get(agent)?.masked !== true`; failure log names the agent id and catalog size | `test/core.test.mjs` › `P1-9: a failed restriction install is retried by the assemble safety net`; `P1-9: a failed reconcile logs the agent id and the catalog size` |
| P1-10 — PTC guidance branch is dead code | Fixed | `index.js` · `ptcRefusalGuidance` checks the result text (and the thrown message as fallback) for `run_code`; applied to result and error paths before returning/throwing | `test/core.test.mjs` › `P1-10: a PTC refusal returned as a result yields the guidance string` |
| P1-11 — nested MCP dispatch missing from the session log | Fixed | `index.js` · `currentStep` derives `{turn, step}` from the open step; `mcp_call` passes `log` to `ctx.tools.execute`; `auditLine` (target + argument keys) is appended when no open step exists | `test/core.test.mjs` › `P1-11: the nested dispatch carries the derived step and logs both events`; `P1-11: an underivable step falls back to an in-result audit line` |
| P1-12 — global `warnOnce` silences other agents | Fixed | `index.js` · `warnOnce(kind, agent, text)` keys on `${kind}:${agentKey(agent)}` | `test/core.test.mjs` › `P1-12: warnOnce keys include the agent identity` |
| P1-13 — documentation contradicts the code | Fixed | `README.md` / `CHANGELOG.md` / `docs/fix-map.md` / `docs/security.md` (this lane): tool count 5, cache note wording, cost model, `~/.dsh/cordis.patch.yml`, management security, disabled-content-type rule, install 1.2.1, `yaml` dependency, tests section, limitations | This table; `git show` of the two docs commits |

---

## P2 — selected items

| Item | Status | What changed (file · function) | Regression evidence |
|---|---|---|---|
| P2-1 — "already loaded" misleading hint | Fixed | `index.js` · `mcp_load` already-loaded branch (`visible()` → native vs pending wording); search hint only when `accepted.length === 0 && searchHint` | `test/core.test.mjs` › `P2-1/P2-18: already-loaded says native, and pending says how to recover` |
| P2-2 — "Hidden until loaded: A of B" numbers contradict a server filter | Fixed | `lib/search.js` · `rankCatalog` returns `availableNames` of the filtered scope; `countHidden`; `renderSearch` drops the line when the count is 0 | `test/search.test.mjs` › `hidden count shares the server-filtered scope (no more "201 of 170")`; `hidden line is dropped when nothing is hidden (P2-2)`; `hidden count never exceeds its own denominator for any server scope`; `countHidden only counts names inside the searched scope`; `real catalog: measured queries all recall (S9)` (asserts 170 of 170) |
| P2-3 — `signatureOf` unbounded | Fixed | `lib/search.js` · `signatureOf` → `oneLine(…, MAX_SIGNATURE_CHARS /* 200 */)` | `test/search.test.mjs` › `signatureOf stays short and honest`; `real catalog: every schema either parses within budget or is explicitly omitted (S10)` asserts every signature ≤ 200 |
| P2-4 — `mcp_servers` has no hidden/leaked counts | Deferred | Not implemented: the count needs disclosure state private to `index.js`. `reconcile` still warns about leaked schemas (`${leaked.length} MCP schema(s) stay visible…`) | Code read (`index.js` · `reconcile`, `lib/management.js` · `renderServerList`); stated in `README.md` → Limitations and `CHANGELOG.md` → Deferred |
| P2-5 — PTC detection relies on `/run_code/` text | Partially fixed | `index.js` · detection now covers the result path as well as a thrown message (`ptcRefusalGuidance`), but it is still a text match, not an error code | `test/core.test.mjs` › `P1-10: a PTC refusal returned as a result yields the guidance string` |
| P2-6 — `oneLine` budgets UTF-16 units, not tokens | Not changed | `lib/search.js` · `oneLine` still clips by string length; `summaryChars` is a character budget (24–600) | Code read; no behaviour regression claimed |
| P2-7 — two concurrent `mcp_call`s of one tool | Moot | `index.js` · `mcp_load` / `mcp_call` do not declare `isConcurrencySafe`, so the platform pipeline runs them exclusively per agent; only `mcp_search` returns `true` | Code read (`index.js` tool definitions) + review §8.9 |
| P2-8 — `catalogOf()` sees only the global registry view | Not changed | `index.js` · `catalogOf` still reads `ctx.tools.schemas()` (global); agent-scope-mounted MCP tools are out of scope for 1.2.1 | Code read; 1.3 candidate |
| P2-9 — `state` route accepts any method | Fixed | `lib/management.js` · `requireMethod(req, res, ['GET', 'HEAD'])` and `['POST']` on the other routes, with `Allow` | `test/management.test.mjs` › `methods are enforced with an allow header`; raw probe in `docs/security.md` (`DELETE` → `405 Allow: GET, HEAD`) |
| P2-10 — oversized body destroys the socket, client sees only a reset | Fixed | `lib/management.js` · `readJsonBody` answers `413`, removes the data listener and drains (`req.resume()`) | `test/management.test.mjs` › `an oversized body is answered with 413 instead of a reset connection` |
| P2-11 — panel action error cleared by the next poll | Fixed | `client.js` · separate `loadError` vs `outcome`; only a new action or a successful action snapshot clears the last action outcome | `test/client.test.mjs` › `a failed action stays visible after a following successful poll` |
| P2-12 — "stopping" borrows the starting (warning) tone | Fixed | `client.js` · `BUSY_STATE`, `statusTone` (stopping → neutral, starting/restarting → warning) | `test/client.test.mjs` › `a stopping row uses a different tone than a starting row` |
| P2-13 — a11y: switch name, live region, restart hit area | Fixed | `client.js` · switch `aria-label` names the setting + server, `aria-checked`, `role="status"` + `aria-live="polite"` outcome region, restart button 32×32 with `::after { inset: -2px }`; focus-visible ring; reduced-motion | `test/client.test.mjs` › `controls carry readable accessible names and a polite live region` |
| P2-14 — corrective hint's first sentence is wrong | Fixed | `index.js` · text now says "is registered but not loaded in this conversation" vs "is not in this MCP catalog right now" | `test/core.test.mjs` › `P2-14: a hidden catalog call says registered-but-not-loaded, not unregistered` |
| P2-15 — `mutating` / `reconcilePending` are dead code | Fixed | `index.js` · both flags removed; `scheduleReconcileAll` is the only coalescer (comment documents why the flags were dead) | `test/core.test.mjs` › `registry notifications still coalesce into one restriction install` |
| P2-16 — `mcp_call` shadows an `alwaysVisible` tool pointlessly | Fixed | `index.js` · `needsShadow = scope !== undefined && !alreadyShadowed && !allowVisible(toolName)` | `test/core.test.mjs` › `P2-16: mcp_call does not shadow an alwaysVisible target` |
| P2-18 — "already loaded" coupled to shadow-registration failure | Fixed | `index.js` · `mcp_load` distinguishes native from booked-not-visible and names the `unload:true` recovery | `test/core.test.mjs` › `P2-1/P2-18: already-loaded says native, and pending says how to recover` |

Not in the required list but worth recording: **P2-17** (a transient `mcp_call` shadow is
visible to a third party that calls `ctx.tools.definitions(agent)` without a step tool-set)
is addressed by documentation instead of code — see the matching bullet in `README.md` →
Limitations.

---

## Evidence run

Environment: this worktree (1.2.1), Node v25.8.0, macOS, unpacked runtime present at
`/tmp/dsh-asar/dsh/node_modules/@deepseek-ai`.

```
$ npm test                      # unpacked runtime present, MCP_REVIEW_CATALOG unset
ℹ tests 152
ℹ pass 149
ℹ fail 0
ℹ skipped 3

$ MCP_REVIEW_CATALOG=<local copy of the review catalog> npm test
ℹ tests 152
ℹ pass 152
ℹ fail 0
ℹ skipped 0

$ DSH_RUNTIME=/nonexistent npm test      # what CI runs (no runtime, no catalog)
ℹ tests 152
ℹ pass 132
ℹ fail 0
ℹ skipped 20
```

The 3 cases skipped in the default local posture are the real-catalog schema cases; they only
run when `MCP_REVIEW_CATALOG` points at a local copy of the review's 210-tool catalog (private,
not committed). The 20 CI skips are those 3 plus the 17 runtime-dependent cases.

```
$ node scripts/repro-review.mjs
  ok  yaml  S3 — hand-written YAML rewrite corrupts a valid patch file
  ok  managementAdmission  S1/S2 — the management routes have no admission and coerce `enabled`
  ok  controlQueue  S5 — a stop and a start issued together execute only the stop
  ok  client  S11 — a failed panel action is cleared by the next poll
  ok  search  S9 — the catalog search is AND-shaped and case-sensitive
  ok  fullSchema  S10 — `detail:"full"` prints an invalid JSON schema
  0/6 defect families reproduced (6 evaluated, 0 skipped)
  PASS — no reviewed defect reproduces (regression gate)
$ echo $?
0
```

Without the DSH runtime the YAML family prints `skip` (the platform insert/override rule
cannot be stubbed honestly), `5 evaluated, 1 skipped`, and the gate still exits 0 when
nothing reproduces.

```
$ node scripts/live-boot.mjs        # default --expect fixed, real boot
  ok  state-unauthenticated    status=401  expected=401|403 (admitted by 401)
  ok  state-bad-host           status=403  expected=403
  ok  toggle-text-plain        status=415  expected=415
  ok  toggle-get-method        status=405  expected=405
  ok  toggle-missing-enabled   status=400  expected=400
  ok  toggle-enabled-string    status=400  expected=400
  ok  toggle-no-content-type   status=415  expected=415
  ok  state-wrong-method       status=405  expected=405
  ok  state-authenticated      status=200  expected=200

  PASS  (1058 ms)
```

`live-boot` also snapshots both patch layers before and after the probes and fails unless
they are byte-identical: every rejected probe changed nothing.

Gate semantics: `repro-review`'s default `--expect fixed` is the regression gate (exit 0 = no
reviewed defect reproduces); `--expect baseline` is the historical 1.2.0 evidence mode and
only passes on a `v1.2.0` checkout. `live-boot`'s default `--expect fixed` is the real-platform
gate (real DSH boot, `node:http` so `Host` is sent, real cookie); `--expect baseline` only
matches `v1.2.0`. Both gates were checked against the `v1.2.0` tag in both directions by the
regression lane: on `v1.2.0` the baseline modes pass and the fixed modes fail, and on this
release the reverse.
