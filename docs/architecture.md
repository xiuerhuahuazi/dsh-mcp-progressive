# Architecture — where this plugin plugs in (1.4.0)

The seams this plugin uses, why each exists, and the ones it deliberately does not use. Written
from the 1.4.0 code and the running Host (DSH 0.2.2-rc.3); the memo behind it is
`dsh-mcp-progressive-review/2026-11-19/arch-1.3-investigation.md`.

## 1. Disclosure: a per-agent scope restriction

DSH 0.2.2 assembles tool declarations from `systemPrompt.tools()` providers *before* the
`system-prompt/assemble` waterfall and re-attaches them afterwards, so a hook there cannot remove
a schema; the seam is the registry view:

- `agent.ctx.tools.restrict({ deny })` removes the unloaded `mcp__*` schemas from
  `schemas(agent)` — the exact list the prompt provider reads — and from `get`/`executable`, so a
  hidden tool is neither in the prompt nor directly callable.
- A loaded tool is re-registered **inside the same agent scope**, which restrictions leave
  visible, so it is a real native tool without re-deriving the restriction list.
- The deny list is rebuilt **only when the catalog changes** (a server connects or disconnects),
  never on a load or unload. That keeps the request's tool array stable per session, which is
  what the cache-cost model in the README depends on: a load changes the step's tool set, not
  the restriction.
- State is per live Agent, keyed by Agent **object identity** (`WeakMap`), never by `agent.id`;
  `reconcile` is coalesced and idempotent, and the prompt-assembly safety net retries a mask that
  was never installed (fail-open, with one warning per `(kind, Agent)`).
- The catalog (`catalogOf()`) is read from the **global** registry view: MCP tools mounted only
  inside an agent or preset scope are neither hidden nor searchable (documented limitation).

## 2. `mcp_call`'s transient shadow

`mcp_call` registers a shadow of exactly its target definition in the agent scope, dispatches one
nested `ctx.tools.execute`, then removes it; an `alwaysVisible` target needs no shadow. The nested
call runs the full pre-execute pipeline (guards, policy, approval, timeout) and writes no session
events — an unpaired `tool/result` would make the next provider request invalid — so the audit
line lives in the returned result. A plugin reading `ctx.tools.definitions(agent)` without a step
tool-set can observe the shadow; documented.

## 3. Live status: the Loader entry seam

The source is the running `@deepseek-ai/dsh-mcp-client` instance's own status cell:

```
Entry { ctx, fiber?, moduleNamespace, … }          // cordis-plugin-loader
entry.moduleNamespace.connectionStatusOf(entry.fiber?.ctx?.fiber ?? entry.fiber).current()
```

- `moduleNamespace` is the module instance the entry **really imported**; `entries()` recurses into
  subtrees, so `include:` rows are found too. The client keys its cell `WeakMap` on `fiber.ctx.fiber`,
  and `entry.fiber?.ctx?.fiber ?? entry.fiber` normalizes the `ctx.plugin()` handle the same way.
- The read is **read-only and per request**: one `current()` per state poll. There is no
  `onChange` subscription — the client returns a disposer and the plugin has no host-owned place
  to keep it, so per-request subscription would leak.
- Any missing seam or failure — no `moduleNamespace`, no `connectionStatusOf`, a throwing read,
  no fiber — yields `null` and the 1.2.1 inference (`fiberPhase`, `diagnostic`, registered
  `mcp__<server>__*` names) answers instead. A failed read is never reported as "connected".
- The plugin never imports `@deepseek-ai/dsh-mcp-client` or re-implements its status cell: a
  second module instance has an empty `WeakMap` and answers `undefined` for another instance's
  fiber even at the same version, so the entry is the only honest channel.
- This is a **public field of the Loader entry class, not a documented plugin contract**: hence
  the duck-typed guard, `try/catch`, and `scripts/probe-live-status.mjs` (a rename fails loudly).
- Sanitization: whitelisted fields only; `lastError` renders primitives only and its segment is
  clipped to 120 chars (the whole detail is also bounded by the reason prefix, max ≈177); numbers
  are finite. A disabled row is `stopped` (or `stopping` while its fiber is up), an unloading row
  `stopping`, and a failed fiber outranks a stale cell — the inference owns it.

## 4. Management half

Activated only when `pluginManager`, `profileContext`, `webServer`, `loader` and the Host
`connection` service are all present (desktop). It adds three same-origin routes
(`/dsh-mcp-hub/state|toggle|restart`) and the `mcp_servers` / `mcp_server` tools; every route asks
`connection.requestRejection` first and fails closed (`401`/`403`/`503`). The state route joins
`pluginManager.listPlugins()` to `loader.entries()` by `entryId`, so each row carries its
`fiberPhase`, `diagnostic`, registered tool count — and now the live status above.

Writes are layer-aware: a bundle/profile row goes through `pluginManager.setPluginEnabled`; a row
only a home patch declares is written as a verified top-level `- id: … / disabled: …` override
(YAML-AST edit, effective-value verification, atomic 0600 write, CAS); a locked row with no
writable declaration is `409`. Every operation re-reads live state inside one serialized queue
and answers what actually happened (`applied` / `restart-required` / `overridden` / observed
status / rollback).

1.4.0 adds no server-side seam: the panel's start-safety valve (`client.js` · `spawnHazard`) only
disables **Stop/Restart** while a row's status is `starting` and its live cell is not `closed`
(audit R1). It is a **UI mitigation only** — the disposal that can signal the caller's process
group belongs to `@deepseek-ai/dsh-mcp-client` / `@modelcontextprotocol/client`, so the routes,
the `mcp_server` tool and a loader-driven reload/uninstall are unchanged and can still reach it.

## 5. mcp-manager migration verdict

**Not in 1.3.0 or 1.4.0.** The official `mcpManager` service is present in this deployment and its
`list()`/`watch()`/`restart()` are real capabilities, but moving the server definitions is a
configuration-ownership change, not a bug fix:

- the manager composes **0 servers** here; the MCP rows are home-patch loader rows it cannot see;
- it owns only `Config.servers`, written through the official Settings writer — which refuses
  values overridden by a home patch (`Configuration for "…" is overridden by a home patch`), the
  user's current setup;
- there is no Remote CRUD (only `watch`/`restart`/`probe`), so this panel would still own add/edit;
- it registers `mcp__*` tools, so disclosure would survive — the gain is official status/watch/restart.

Preconditions for revisiting it: definitions live in the profile patch (or DSH offers a writable
home-level path), the move is done in one step (a same-name loader row and manager server collide
and the second fiber fails), and the panel's role is settled (status + restart, or an official
Settings form only). Until then `liveStatusOf` is the cheaper, read-only answer.

## 6. Do not do

1. Do not `import('@deepseek-ai/dsh-mcp-client')` or clone `McpStatusCell`/its `WeakMap`: the
   second instance's map is empty, so the copy has no status.
2. Do not subscribe `onChange` per request: the client only returns a disposer, and there is no
   host-owned place to keep it.
3. Do not move the home-patch rows into `mcp-manager.servers`: home-patch overrides make the
   Settings writes fail, and a partial move collides on server names.
4. Do not use `mcpManager.register()` for the user's servers: it is memory-only, forces
   `enabled: true`, and disappears with the plugin.
5. Do not use `mcpResources` as a status source, and do not replace the patch writer with
   `settings` (the client's row config has no volatile fields, so a write is refused).

## 7. Open product questions

- Long-term home of MCP definitions: home patch (cross-profile reuse) or profile patch (officially
  writable)? It decides whether `mcpManager` can ever be the single source.
- Add/edit via the official Settings form (`mcp-manager`'s volatile `servers` can generate one), or
  keep this panel as the only place? It decides whether a migration buys anything beyond status.
- Should `reconnecting (attempt N/M)` become a status token? Current answer: no — the vocabulary
  stays `stopped|running|idle|starting|stopping|error|unknown`, and the state is text in
  `statusDetail`. Revisit only with a deliberate vocabulary change.
