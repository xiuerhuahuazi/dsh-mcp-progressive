# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- `/dsh-mcp-hub/*` management routes now go through the Host connection
  admission (Host/Origin fence + authenticated browser peer), reject non-JSON
  bodies, and answer `405`/`415` instead of executing.
- `mcp_server` start/stop/restart asks for approval before mutating a server row.
- Server descriptions no longer forward command-line arguments or malformed URLs
  verbatim.

### Fixed

- Patch-file edits are YAML AST based and validated before the write, so quoted
  keys, flow documents, indented roots, multi-line scalars and document end
  markers can no longer produce an unparseable patch file.
- Patch writes are atomic, preserve the `0600` mode, follow a symlinked patch
  file instead of replacing it, keep a readable backup, and no longer silently
  fall back to an in-place truncating write.
- The start/stop/restart queue re-reads the row inside the task, returns an
  explicit desired/applied/observed state, treats a failed fiber as a failure,
  and reports `restart-required` / `overridden` / `failed` instead of pretending
  success.
- Server lookup addresses one row exactly; ambiguous names return candidates.
- `mcp_search` ranks with OR semantics (a single matching word is enough),
  handles CJK queries, matches server names case-insensitively, and distinguishes
  “no catalog”, “server filter matched nothing” and “query matched nothing”.
- `detail: "full"` degrades to a valid, compact JSON Schema or omits the schema
  with an explicit note instead of printing truncated invalid JSON.
- Per-agent disclosure state is keyed by agent identity (`WeakMap`), and the
  prompt-assembly safety net retries when the restriction was never installed.
- `mcp_call` returns MCP error text instead of a bare `Error`, forwards
  presentation metadata, records the nested dispatch in the session log, detects
  PTC refusals from the result instead of a thrown message, and cleans up its
  transient shadow safely.
- The client panel keeps action errors until the next action, discards stale
  responses by request generation, aborts hung requests, survives server ids
  such as `constructor`, and reads the `active` locale field.

### Changed

- `eagerTools` applies to the root agent only; subagents start with an empty
  loaded set.
- A short system-prompt section advertises the hidden MCP catalog and how to
  search it.
- README cost model is expressed as prompt-length × cache-price difference with
  measured endpoints, and the tool count / limitations sections match the code.

## [1.2.0] - 2026-11-06

### Added

- Independent repository baseline, published from the `dsh-mcp-progressive@1.2.0`
  npm package.
- Per-agent progressive disclosure of `mcp__*` tool schemas via scope
  restrictions, plus the `mcp_search` / `mcp_load` / `mcp_call` meta-tools.
- MCP server list / start / stop / restart: Plugins-page tab, `mcp_servers` and
  `mcp_server` tools.
