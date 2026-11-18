# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-11-19

Security:

- `/dsh-mcp-hub/*` management routes now ask the Host `connection` service for
  its trust verdict first (unauthenticated → `401`, foreign `Host` or
  cross-site origin → `403`, a fence that throws is forbidden), accept
  `GET`/`HEAD` on `state` only and `POST` on the other two routes (`405` with
  `Allow`), require `application/json` on the write routes (`415` for a
  different type and for a missing header), validate the body strictly before
  any lookup or enqueue (JSON object, non-empty string identifiers, real
  boolean `enabled`; `400`), reject bodies over 64 KiB (`413`) and refuse work
  beyond 16 waiting operations (`429`).
- The management half is gated behind the Host `connection` service: without
  it no routes and no management tools are registered, and while a
  recomposition leaves the routes mounted without the service they answer
  `503` instead of failing open.
- `mcp_server` start/stop/restart (the model tool only) asks the platform
  approval pipeline before mutating a server row; without an approval service
  the platform denies it instead of running it. The browser panel stays
  ungated: a human clicking is the consent. The ask's `displayReason` is a
  `{ en, zh }` locale record, as the platform contract declares, not a bare
  string.
- Server target descriptions no longer echo command-line argument values or a
  malformed URL: stdio rows print the executable name plus flag names only,
  and an unparseable URL becomes `(invalid URL)`.
- Patch-file edits are YAML-AST based and validated against the composition's
  effective `disabled` before a byte is written, so quoted keys, flow
  documents, indented roots, multi-line scalars and document end markers can no
  longer produce an unparseable patch file.
- A BOM-prefixed patch file, which the platform's `js-yaml` accepts, is now
  parsed and rewritten too, and the BOM byte prefix is preserved (before this,
  such a row could not be toggled and its file was left untouched).
- Patch writes go through an exclusive random-suffix temporary file renamed
  over the target, keep the existing mode (0600 for a new file), follow a
  symlinked dotfile instead of replacing it, require a written 0600
  `.mcp-hub.bak`, compare-and-swap against the content they read, and throw
  instead of falling back to an in-place truncating write.

Fixed:

- Control-plane operations re-read live state inside the serialized task and
  return `desiredEnabled` / `applied` / `changed` / `observedEnabled` /
  `observedStatus` / `via` (plus `application` and `message`); a failed fiber
  is a failure, "stopped" waits for the fiber to be gone, a restart whose start
  step fails reports the observed state and tries to restore the pre-restart
  preference, and the remaining `application` outcomes are handled exhaustively
  (`restart-required`, `overridden` → 409, `failed`/`cancelled` keep the
  manager diagnostic) with no blind patch fallback.
- An abort during `restart` (the panel aborts at its 10 s deadline) now restores
  the pre-restart preference on a fresh, non-aborted bounded budget and reports
  `rollback` in the response, so the stop's persisted `disabled: true` can no
  longer survive the interrupted request. A non-abort stop failure (for example
  the 30 s phase timeout on a live caller) restores the same saved preference and
  reports `rollback` too, while a restart of an already-disabled server performs
  no rollback write (`rollback: null`) (`F1b: a timed-out stop during restart
  restores the preference and reports the rollback`; `F1b: a failed restart of an
  already-disabled server performs no rollback write`).
- Manager calls take the earlier of the operation deadline and a per-call 5 s
  budget, and the 30 s operation budget starts when the task reaches the head of
  the queue rather than when it joined it; phase waits are bounded and
  cancellable by the request, and the control queue refuses a growing backlog
  with `429`.
- Server lookup addresses one row exactly (`entryId` → `id` → name, with the
  panel sending `entryId`); an ambiguous identifier returns candidates instead
  of toggling a different server. Module identity is exact, not a prefix.
- `mcp_search` ranks with OR semantics (one matching word is enough), carries a
  Chinese→English gloss table, matches CJK runs whitespace-insensitively,
  filters servers case-insensitively, keeps three distinct empty states, and
  computes the hidden count over the searched scope.
- Signatures are capped at 200 characters; `detail: "full"` prints a valid,
  compact JSON Schema or `schema omitted: too large (N chars)` plus the
  signature and required names, within a ≈6,000-character budget for at most
  two tools — never a truncated JSON document.
- Per-agent disclosure state is keyed by Agent object identity (`WeakMap`) so
  two agents sharing an id cannot share a mask, and the prompt-assembly safety
  net retries a restriction that was never installed (`masked`) instead of
  trusting existing state. `warnOnce` is also keyed by the Agent object, so two
  agents that share an id cannot silence each other's warnings.
- `mcp_call` returns the MCP server's error text instead of a bare thrown
  message, forwards deferred context and turn conclusion, and detects a PTC
  refusal from the result. It writes **no** session events for the nested call:
  the earlier synthetic `tool/call` + `tool/result` pair left an orphan tool
  message in a real session history (no assistant message declares the call) and
  made the next DeepSeek request fail with `INVALID_REQUEST` ("tool result has
  no matching call"). The audit trail is now an in-result line on every
  returned result (`(audit: dispatched <tool>; argument keys: …)`) — a rare
  internal pipeline failure still throws — kept next to the empty-output
  fallback sentence (whitespace-only nested content keeps that fallback too,
  `F12: whitespace-only nested content keeps the no-output fallback`), and an
  `alwaysVisible` target needs no transient shadow.
- Corrective unknown-tool text distinguishes "registered but not loaded in this
  conversation" from "not in this MCP catalog right now".
- The corrective `tools/pre-execute` handler (not `mcp_load`) refuses a call to
  a tool loaded in the same step with next-step guidance; `mcp_load` itself
  succeeds there, and it distinguishes an already-native tool from a
  booked-but-not-visible one and names the `unload:true` recovery path.
- Successful control operations re-read the live row, so `observedStatus` counts
  the post-operation tool catalog instead of the pre-operation snapshot (a
  just-started server reads `running`, not `idle`); `readJsonBody` rejects with
  an `AbortError` when the client disconnects mid-body instead of leaving the
  handler pending.
- The client panel keeps an action error until the next action, discards stale
  responses by request generation, aborts hung requests on a deadline and on
  unmount, uses a `Map` for pending rows (ids such as `constructor` work),
  addresses rows by `entryId`, reads the locale snapshot's `active` field,
  gives `stopping` its own tone, shows diagnostics and `restart-required`
  results, and improves the accessible names, live region and restart hit area.

Changed:

- The Host half is split into `lib/patch.js`, `lib/search.js` and
  `lib/management.js`; the pure helpers are exported through `__test` and
  covered by a `node --test` suite (167 tests, CI on Node 22 and 24).
- The plugin declares one runtime dependency, `yaml` `^2.9.1`, for the patch
  rewrite.
- The management half activates only where `pluginManager`, `profileContext`,
  `webServer`, `loader` and the Host `connection` service exist; headless
  profiles keep the disclosure half only.
- Server state adds `entryId`, `diagnostic` and a `stopping` status.
- `eagerTools` applies to the root agent only; subagents start with an empty
  loaded set.
- A short system-prompt section advertises the hidden MCP catalog and how to
  search it.
- README now documents five tools (with `manageServers`), the
  prompt-length × cache-price-difference cost model with one measured example,
  the route and patch security contract, `npm test` / `scripts/repro-review.mjs`
  / `scripts/live-boot.mjs`, and the deferred items below.
- `docs/fix-map.md` and `docs/security.md` record the review-item → fix → test
  mapping and the management security contract.
- The suite gained a real-`dsh-session` regression for the nested `mcp_call`
  dispatch (no orphan tool result, no synthetic nested events) and regressions
  for the independent-audit findings, so the history-integrity bug cannot come
  back unnoticed.

Deferred:

- P2-4: `mcp_servers` still does not report hidden/leaked counts; that needs
  disclosure state private to the Host half, so a failed mask remains visible
  only in the log.
- No cross-process file lock: patch writes are compare-and-swap with three
  attempts, not coordinated with `plugin_manager`'s pnpm writes. This is the one
  documented audit residual (security audit F5): with more than two concurrent
  writers an edit can fail visibly with `PATCH_STALE`; the file is never
  corrupted and the loss is never silent.
- A nested `mcp_call` error survives as text in a successful outer result, and
  the nested tool's presentation `meta` is not forwarded.
- Server status stays an inference from loader rows/diagnostics and registered
  tool names, not a live MCP handshake.

## [1.2.0] - 2026-11-06

### Added

- Independent repository baseline, published from the `dsh-mcp-progressive@1.2.0`
  npm package.
- Per-agent progressive disclosure of `mcp__*` tool schemas via scope
  restrictions, plus the `mcp_search` / `mcp_load` / `mcp_call` meta-tools.
- MCP server list / start / stop / restart: Plugins-page tab, `mcp_servers` and
  `mcp_server` tools.
