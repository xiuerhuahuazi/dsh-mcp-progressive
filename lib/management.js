import path from 'node:path'

import { messageOf } from './util.js'
import { readPatchFile, patchDeclares, applyPatchOverride } from './patch.js'

// ---------------------------------------------------------------------------
// MCP server management (optional half).
//
// Every MCP server is one loader row whose module is the shipped
// @deepseek-ai/dsh-mcp-client. The lazy filter above never needs to know about
// them, but a user may want to stop a server that is not in use — that saves a
// child process, not just context. Rows declared by a bundle or by the profile
// patch are toggled through the `pluginManager` service. Rows inserted by the
// home-level patch (~/.dsh/cordis.patch.yml) are not addressable through that
// service, so the plugin writes the `disabled` override into that patch file
// itself. HMR applies either change live and both survive a restart.
//
// The HTTP routes are mounted on the same listener as the panel itself, so
// they re-apply Connection's trust fence (`requestRejection`) before reading
// anything: unauthenticated or cross-origin callers must not be able to read
// the server inventory or rewrite the composition.
// ---------------------------------------------------------------------------

/** Module name every MCP server row uses. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
export const ROUTE_SERVER_STATE = '/dsh-mcp-hub/state'
export const ROUTE_SERVER_TOGGLE = '/dsh-mcp-hub/toggle'
export const ROUTE_SERVER_RESTART = '/dsh-mcp-hub/restart'
export const USER_PATCH_FILENAME = 'cordis.patch.yml'
export const SERVER_WAIT_MS = 30000
export const SERVER_POLL_MS = 300
/** Deadline for one `pluginManager` call; a stalled host service must not pin an operation. */
export const MANAGER_CALL_MS = 5000
/** Maximum operations waiting behind the running one; beyond it the request is refused with 429. */
export const MAX_PENDING_OPERATIONS = 16
/** Maximum accepted JSON body, in bytes. */
export const MAX_BODY_BYTES = 65536
/** How often a bounded wait re-checks its deadline; small enough to be a UI-friendly bound. */
const BOUNDED_POLL_MS = 25
/** Default deadline for a lazy start (connection + tool registration). */
const LAZY_TIMEOUT_DEFAULT_MS = 30_000
/** Configured lazy timeout bounds; a per-call `timeoutMs` is clamped to at least 1 ms. */
const LAZY_TIMEOUT_MIN_MS = 5_000
const LAZY_TIMEOUT_MAX_MS = 120_000
/** How often `ensureServer` re-checks the tool registry after a start. */
const TOOL_POLL_MS = 250

/**
 * An error the HTTP layer can answer as-is. Anything else becomes a plain 500.
 * `status` is the HTTP status; the extra fields are for the browser panel and
 * the model-facing tool, which need candidates / the manager's verdict.
 */
export class ManagementRequestError extends Error {
  constructor(status, message, details = {}) {
    super(message)
    this.name = 'ManagementRequestError'
    this.status = status
    if (details.candidates !== undefined) this.candidates = details.candidates
    if (details.application !== undefined) this.application = details.application
    if (details.code !== undefined) this.code = details.code
    if (details.observed !== undefined) this.observed = details.observed
    if (details.rollback !== undefined) this.rollback = details.rollback
  }
}

/** Refusal for an operation that would wait behind too many queued ones. */
export class QueueFullError extends ManagementRequestError {
  constructor(maxPending = MAX_PENDING_OPERATIONS) {
    super(429, `too many pending MCP server operations (max ${maxPending}); retry in a moment`)
    this.name = 'QueueFullError'
  }
}

/** Sleep helper for the bounded waits below. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** An error shaped like `AbortController`'s so callers can tell cancellation apart. */
function abortError() {
  const error = new Error('request aborted by the client')
  error.name = 'AbortError'
  return error
}

/** Whether a thrown value is the request-cancellation signal. */
export function isAbortError(error) {
  return error !== null && typeof error === 'object' && error.name === 'AbortError'
}

/** Last path segment of a command/arg, for a compact display string. */
export function baseName(value) {
  const text = String(value ?? '')
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

/** Collapse whitespace and clip one display line without splitting a word. */
function clip(text, maxChars) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const head = collapsed.slice(0, Math.max(0, maxChars - 1))
  const boundary = head.lastIndexOf(' ')
  return `${boundary > maxChars * 0.6 ? head.slice(0, boundary) : head}…`
}

/**
 * Whether one Loader row ships the MCP client module.
 *
 * Exact identity, never `startsWith`: `@deepseek-ai/dsh-mcp-client-extra`
 * would match a prefix test and the plugin would list/toggle a foreign row.
 * A subpath of the package is still the same module.
 */
export function isMcpClientModule(moduleName) {
  if (typeof moduleName !== 'string' || moduleName === '') return false
  return moduleName === MCP_CLIENT_MODULE || moduleName.startsWith(`${MCP_CLIENT_MODULE}/`)
}

/** An argv item shaped like a flag (`--name`, `-n`, `--name=value`). */
const FLAG_ARG = /^-{1,2}[A-Za-z0-9]/

/**
 * Compact, non-secret description of where one MCP server points.
 *
 * The model and the panel both show this string, so it must never carry a
 * credential: stdio rows print the executable name plus flag *names* only
 * (`--token=SECRET` becomes `--token`), and a URL that cannot be parsed is
 * replaced by a fixed placeholder instead of being echoed.
 */
export function targetSummary(config, transport) {
  if (transport === 'stdio') {
    const command = typeof config?.command === 'string' ? baseName(config.command) : ''
    const flags = []
    const args = Array.isArray(config?.args) ? config.args : []
    for (const item of args) {
      if (typeof item !== 'string' || !FLAG_ARG.test(item)) continue
      // The value may be this arg's `=value` part, an attached short-option
      // value (`-pSECRET`) or the next argv item; only the flag name itself is
      // known to be safe to display.
      const name = item.split('=')[0]
      const flag = name.startsWith('--') || name.length <= 2 ? name : ''
      if (flag !== '' && !flags.includes(flag)) flags.push(flag)
      if (flags.length >= 4) break
    }
    return [command, ...flags].filter(Boolean).join(' ')
  }
  if (typeof config?.url === 'string' && config.url !== '') {
    try {
      return new URL(config.url).host || '(invalid URL)'
    } catch {
      return '(invalid URL)'
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// Live connection status.
//
// A loader row's `moduleNamespace` is the module instance that row really
// imported, i.e. the *running* MCP client. Importing
// `@deepseek-ai/dsh-mcp-client` ourselves would resolve to a second instance
// whose status WeakMap is empty, so the entry is the only honest channel.
//
// Reading is best-effort and read-only: there is no host-owned place to keep an
// `onChange` disposer, so the plugin polls `current()` (the panel already polls
// the state route). A missing seam, a throwing read or an unknown state all
// fall back to the inference below, so an older Harness behaves exactly as
// before and a broken cell can never be reported as "connected".
// ---------------------------------------------------------------------------

/** Diagnostic bound kept in the panel payload, in characters. */
const LIVE_ERROR_MAX_CHARS = 240
/** Diagnostic bound appended to the one-line status detail, in characters. */
const DETAIL_ERROR_MAX_CHARS = 120

/**
 * A sanitized copy of one MCP client `McpConnectionStatus`.
 *
 * Only the documented fields survive (the status is third-party data and must
 * not smuggle extra fields into the panel payload), numbers are kept only when
 * finite, and text is collapsed to one bounded line.
 *
 * @param {unknown} status the value the MCP client's `current()` returned
 * @returns {object|null} the live status, or null when it is not a usable shape
 */
export function sanitizeLiveStatus(status) {
  if (status === null || typeof status !== 'object') return null
  if (typeof status.state !== 'string' || status.state === '') return null
  const live = { state: clip(status.state, 40) }
  if (typeof status.reason === 'string' && status.reason !== '') live.reason = clip(status.reason, 40)
  if (typeof status.lastError === 'string' && status.lastError !== '') {
    live.lastError = clip(status.lastError, LIVE_ERROR_MAX_CHARS)
  }
  for (const field of ['toolCount', 'connectedAt', 'attempt', 'maxAttempts', 'nextRetryAtMs']) {
    const value = status[field]
    if (typeof value === 'number' && Number.isFinite(value)) live[field] = value
  }
  return live
}

/**
 * Read the live connection status off one Loader entry.
 *
 * `entry.fiber` is the thenable handle returned by `ctx.plugin()`; the MCP
 * client's status WeakMap is keyed by the fiber behind that handle, so the read
 * is normalized with `fiber.ctx.fiber` and the raw handle stays as fallback.
 * Every failure mode — no namespace, no `connectionStatusOf`, a throwing read,
 * no handle — is "no live status", never an exception.
 *
 * @param {object|undefined} entry one Loader entry
 * @returns {object|null} the sanitized live status, or null when unavailable
 */
export function liveStatusOf(entry) {
  try {
    const namespace = entry?.moduleNamespace
    const connectionStatusOf = namespace?.connectionStatusOf
    if (typeof connectionStatusOf !== 'function') return null
    const fiber = entry.fiber?.ctx?.fiber ?? entry.fiber
    const handle = connectionStatusOf.call(namespace, fiber)
    if (typeof handle?.current !== 'function') return null
    return sanitizeLiveStatus(handle.current())
  } catch {
    return null
  }
}

/** `retry in Ns`, or '' when the next attempt time is unknown or already due. */
function retryInText(nextRetryAtMs, now) {
  if (typeof nextRetryAtMs !== 'number' || !Number.isFinite(nextRetryAtMs)) return ''
  const remainingMs = nextRetryAtMs - now
  if (remainingMs <= 0) return ''
  return `retry in ${Math.max(1, Math.round(remainingMs / 1000))}s`
}

/**
 * The ` · <lastError>` segment of a status detail, bounded to one line.
 *
 * The live cell is third-party data, so a hand-built or corrupted cell can
 * carry anything here. Only primitives are rendered: strings and
 * numbers/booleans/bigints are clipped, while an object/array/symbol is dropped
 * rather than coerced (coercion can invoke a throwing `toString`). This is what
 * keeps the exported helper total.
 *
 * @param {unknown} lastError the cell's `lastError` field
 * @returns {string} the prefixed segment, or '' when there is nothing to show
 */
function lastErrorSegment(lastError) {
  if (typeof lastError === 'string') {
    return lastError === '' ? '' : ` · ${clip(lastError, DETAIL_ERROR_MAX_CHARS)}`
  }
  if (typeof lastError === 'number' || typeof lastError === 'boolean' || typeof lastError === 'bigint') {
    return ` · ${clip(String(lastError), DETAIL_ERROR_MAX_CHARS)}`
  }
  return ''
}

/**
 * Map one row's live status onto the public status vocabulary plus its
 * one-line detail text, keeping `statusDetail` for the panel and the model.
 *
 * Returns null whenever the live status must not decide the row: the row is
 * configured off, it is unloading, its fiber is failed, its state is missing or
 * unknown, or the read already fell back to null. `now` is injectable so the
 * retry countdown is deterministic in tests.
 *
 * @param {object} server one server row (with or without `live`)
 * @param {number} [now] epoch milliseconds used for the retry countdown
 * @returns {{status: string, detail: string|null}|null}
 */
export function liveStatusView(server, now = Date.now()) {
  const live = server?.live
  if (live === null || live === undefined || typeof live !== 'object') return null
  // A row configured off is stopped no matter what its last cell says, an
  // unloading row is "stopping", and a *failed* fiber outranks a stale cell:
  // a colliding re-apply disposes the old supervisor before the new apply
  // throws, so the cell can still say "closed" while the fiber is `failed`.
  // In all three cases the inference owns the row (and its diagnostic).
  if (server?.enabled !== true || server.fiberPhase === 'unloading' || server.fiberPhase === 'failed') return null
  switch (live.state) {
    case 'connected': {
      const count = Number.isFinite(live.toolCount) ? live.toolCount : Number(server.toolCount) || 0
      return { status: count > 0 ? 'running' : 'idle', detail: null }
    }
    case 'connecting': {
      const attempt = Number.isFinite(live.attempt) ? ` (attempt ${live.attempt + 1})` : ''
      return { status: 'starting', detail: `connecting${attempt}` }
    }
    case 'reconnecting': {
      const budget = Number.isFinite(live.attempt) && Number.isFinite(live.maxAttempts)
        ? ` (attempt ${live.attempt}/${live.maxAttempts})`
        : ''
      const retry = retryInText(live.nextRetryAtMs, now)
      const error = lastErrorSegment(live.lastError)
      return { status: 'starting', detail: `reconnecting${budget}${retry === '' ? '' : ` · ${retry}`}${error}` }
    }
    case 'waiting-credentials':
      return { status: 'starting', detail: 'waiting for credentials' }
    case 'closed':
      return { status: 'starting', detail: 'closed' }
    case 'failed': {
      const reason = typeof live.reason === 'string' && live.reason !== '' ? live.reason : 'unknown'
      return { status: 'error', detail: `failed: ${reason}${lastErrorSegment(live.lastError)}` }
    }
    default:
      return null
  }
}

/**
 * One of stopped / running / idle / starting / stopping / error / unknown.
 *
 * A live status wins when the row really has one (see `liveStatusView`);
 * otherwise the Loader's fiber phase and `diagnostic` are the only evidence, so
 * an enabled row can be reported as failed even when its phase is missing.
 */
export function serverStatus(server) {
  const phase = server?.fiberPhase ?? null
  if (phase === 'unloading') return 'stopping'
  if (server?.enabled !== true) {
    // Configured off but still holding a live fiber means the shutdown is in
    // progress; reporting "stopped" here would hide a process that is still up.
    return phase === 'active' || phase === 'pending' || phase === 'loading' ? 'stopping' : 'stopped'
  }
  const live = liveStatusView(server)
  if (live !== null) return live.status
  if (phase === 'failed') return 'error'
  if (typeof server?.diagnostic === 'string' && server.diagnostic !== '') return 'error'
  if (phase === 'pending' || phase === 'loading') return 'starting'
  if (phase === 'active') return server.toolCount > 0 ? 'running' : 'idle'
  return 'unknown'
}

/** Profile-relative patch files for the current composition (desktop profiles only). */
export function patchPathsOf(ctx) {
  const profile = ctx.profileContext
  if (profile === null || typeof profile !== 'object') return { home: null, profile: null }
  const home = typeof profile.home === 'string' && profile.home !== '' ? path.join(profile.home, USER_PATCH_FILENAME) : null
  const profilePatch = typeof profile.patchPath === 'string' && profile.patchPath !== '' ? profile.patchPath : null
  return { home, profile: profilePatch }
}

/**
 * The effective deadline of one bounded call: the earlier of the caller's
 * operation deadline and this call's own budget. Taking the outer deadline
 * alone would make `MANAGER_CALL_MS` dead and let one stalled call consume the
 * whole operation budget.
 */
export function boundedDeadline(options = {}, now = Date.now()) {
  const outer = options.deadline ?? Number.POSITIVE_INFINITY
  const perCall = now + (options.timeoutMs ?? MANAGER_CALL_MS)
  return Math.min(outer, perCall)
}

/**
 * Await one promise unless it is still pending at its effective deadline (or a
 * request abort arrives). The deadline is polled instead of raced against a
 * timer so a virtual clock in tests reaches it immediately, and a hung host
 * service can never pin the serialized queue.
 */
export async function awaitBounded(promise, options = {}) {
  const label = options.label ?? 'plugin manager call'
  const deadline = boundedDeadline(options)
  const signal = options.signal
  const pending = Promise.resolve(promise)
  let settled = false
  let failure = null
  pending.then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      failure = error
    },
  )
  // Give the call one event-loop turn before the first deadline check: a call
  // that settles promptly must not be failed by a deadline a simulated clock
  // jumped past, while a truly hung one still hits its bound on the next check.
  await new Promise((resolve) => setImmediate(resolve))
  while (!settled) {
    if (signal?.aborted === true) throw abortError()
    if (Date.now() >= deadline) throw new ManagementRequestError(504, `${label} did not answer in time`)
    await sleep(BOUNDED_POLL_MS)
  }
  if (failure !== null) throw failure
  return pending
}

/** List the plugin-manager rows, bounded so a stalled service cannot hang a request. */
async function listPluginRows(ctx, options = {}) {
  const manager = ctx.pluginManager
  return awaitBounded(Promise.resolve().then(() => manager.listPlugins()), {
    deadline: options.deadline,
    timeoutMs: MANAGER_CALL_MS,
    label: 'listPlugins',
    signal: options.signal,
  })
}

/** Per-server counters the Host footprint snapshot can add to a row. */
const FOOTPRINT_FIELDS = ['hiddenTools', 'hiddenTokens', 'hiddenChars', 'loadedTools']

/**
 * One hidden-footprint counter from the Host snapshot, or null.
 *
 * The snapshot is Host-owned data (and, for a hand-built callback, arbitrary
 * input), so only a finite, non-negative number is accepted and it is truncated
 * to a whole count. Everything else is "not present" rather than zero: a row
 * without a snapshot must keep its pre-1.5 payload shape.
 */
function footprintCounter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
}

/** Merge one server's counters from `options.footprint.byServer` onto its row. */
function mergeFootprint(server, options, serverName) {
  const byServer = options?.footprint?.byServer
  if (byServer === null || typeof byServer !== 'object') return
  const counters = byServer[serverName]
  if (counters === null || typeof counters !== 'object') return
  for (const field of FOOTPRINT_FIELDS) {
    const value = footprintCounter(counters[field])
    if (value !== null) server[field] = value
  }
}

/**
 * Call one optional Host callback and degrade any failure to null.
 *
 * The footprint and loaded-view snapshots are read-only extras: a host that
 * predates them, a callback that throws, or a non-object answer must never turn
 * a state poll or a tool call into an error.
 */
function callOptional(callback, arg) {
  if (typeof callback !== 'function') return null
  try {
    const value = callback(arg)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * One optional Host snapshot, or null when it cannot be serialized.
 *
 * `/state` is a JSON response, and the snapshots are Host-owned read-only data.
 * A seam that returns a BigInt or a circular object would otherwise make
 * `sendJson` throw after the response was chosen (and answer a 500); the check
 * is `JSON.stringify` without cloning, so an already-safe value passes through
 * unchanged.
 */
function jsonSafe(value) {
  if (value === null || typeof value !== 'object') return null
  try {
    JSON.stringify(value)
    return value
  } catch {
    return null
  }
}

/** Normalize a `lazyConnect` option (Set or string[]) into a Set of server names. */
function toServerSet(value) {
  const set = new Set()
  const items = value instanceof Set ? value : Array.isArray(value) ? value : []
  for (const item of items) if (typeof item === 'string' && item !== '') set.add(item)
  return set
}

/** Clamp the configured lazy-start timeout to its documented 5–120 s range. */
function resolveLazyTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LAZY_TIMEOUT_DEFAULT_MS
  return Math.min(LAZY_TIMEOUT_MAX_MS, Math.max(LAZY_TIMEOUT_MIN_MS, Math.trunc(value)))
}

/** The effective per-call deadline: the caller's bound when valid, else the configured one. */
function ensureTimeoutMs(requested, fallback) {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(LAZY_TIMEOUT_MAX_MS, Math.max(1, Math.trunc(requested)))
}

/**
 * The `lazy` flag of one row, or null when the caller carries no lazy configuration.
 *
 * `'*'` is the wildcard that accepts every configured server (P1.1 auto-adoption
 * of all MCPs); a present-but-empty set still stamps `false` on every row.
 */
function lazyFlagOf(options, serverName) {
  const lazy = options?.lazyConnect
  if (lazy instanceof Set) return lazy.has('*') || lazy.has(serverName)
  if (Array.isArray(lazy)) return lazy.includes('*') || lazy.includes(serverName)
  return null
}

/**
 * Whether the requested tool is visible in the live registry.
 *
 * A `toolName` is matched exactly; without one the `mcp__<server>__` prefix is
 * the test. The registry is a live service, so a throwing `definitions()` read
 * means "not registered yet" rather than an exception.
 */
function toolAppeared(ctx, serverName, toolName) {
  let definitions
  try {
    definitions = ctx.tools.definitions()
  } catch {
    return false
  }
  if (!Array.isArray(definitions)) return false
  const wanted = typeof toolName === 'string' && toolName !== '' ? toolName : ''
  const prefix = `mcp__${serverName}__`
  for (const definition of definitions) {
    const name = typeof definition?.name === 'string' ? definition.name : ''
    if (name === '') continue
    if (wanted === '' ? name.startsWith(prefix) : name === wanted) return true
  }
  return false
}

/** Poll the live tool registry until the requested tool appears or the deadline passes. */
async function waitForTool(ctx, serverName, toolName, deadline) {
  while (true) {
    if (toolAppeared(ctx, serverName, toolName)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await sleep(Math.min(TOOL_POLL_MS, remaining))
  }
}

/**
 * Whether any live agent's loaded set holds a tool from this server.
 *
 * `unreadable: true` means the live agent list could not be read; that is not
 * evidence of "nothing loaded", so it fails closed and counts as in use. The
 * warm-idle release then refuses instead of stopping a server that may still
 * back a loaded tool.
 */
function loadedToolNamesOf(view, serverName) {
  if (view !== null && typeof view === 'object' && view.unreadable === true) return true
  const agents = view !== null && typeof view === 'object' && Array.isArray(view.agents) ? view.agents : []
  const prefix = `mcp__${serverName}__`
  for (const agent of agents) {
    if (agent === null || typeof agent !== 'object' || !Array.isArray(agent.loaded)) continue
    for (const name of agent.loaded) {
      if (typeof name === 'string' && name.startsWith(prefix)) return true
    }
  }
  return false
}

/** All configured MCP server rows, with their effective runtime state. */
export async function collectServerRows(ctx, options = {}) {
  const plugins = await listPluginRows(ctx, options)
  // A non-array answer is not a verified empty inventory. A caller that acts on
  // "the catalogue is empty" (the lazy scanner) must see a failure instead of
  // treating it as an authoritative uninstall of everything, so
  // `requirePluginRows` turns it into an error; the state/tool paths keep the
  // tolerant pre-existing behavior.
  if (!Array.isArray(plugins) && options.requirePluginRows === true) {
    throw new ManagementRequestError(500, 'plugin manager returned a malformed server list')
  }
  const entries = new Map()
  try {
    for (const entry of ctx.loader.entries()) entries.set(entry.id, entry)
  } catch {
    // Row lookup is optional; configuration below degrades to row ids.
  }
  let schemas = []
  try {
    schemas = ctx.tools.schemas()
  } catch {
    // A tool registry that cannot enumerate schemas only costs the tool count.
  }
  const servers = []
  for (const row of Array.isArray(plugins) ? plugins : []) {
    if (!isMcpClientModule(row?.moduleName)) continue
    const entry = entries.get(row.entryId)
    const config = entry?.options?.config ?? {}
    const id = typeof row.patchId === 'string' && row.patchId !== '' ? row.patchId : String(row.entryId ?? '').split(':').pop()
    const serverName = typeof config.serverName === 'string' && config.serverName !== '' ? config.serverName : id
    const transport = typeof config.transport === 'string'
      ? config.transport
      : typeof config.url === 'string' ? 'streamable-http' : 'stdio'
    let toolCount = 0
    const toolPrefix = `mcp__${serverName}__`
    for (const schema of schemas) if (typeof schema?.name === 'string' && schema.name.startsWith(toolPrefix)) toolCount += 1
    const live = liveStatusOf(entry)
    // Once connected the live generation is the truth: the prefix count also
    // sees tools a previous generation left behind.
    if (live?.state === 'connected' && Number.isFinite(live.toolCount)) toolCount = live.toolCount
    const server = {
      id,
      serverName,
      transport,
      target: targetSummary(config, transport),
      enabled: row.enabled !== false,
      fiberPhase: row.fiberPhase ?? null,
      live,
      toolCount,
      readOnlyReason: row.readOnlyReason ?? null,
      entryId: row.entryId,
      diagnostic: typeof row.diagnostic === 'string' && row.diagnostic !== '' ? row.diagnostic : null,
    }
    mergeFootprint(server, options, serverName)
    // Once the management half has a lazy set (even an empty one) every row
    // gets a boolean; only a caller that carries no lazy configuration gets the
    // old shape.
    const lazy = lazyFlagOf(options, serverName)
    if (lazy !== null) server.lazy = lazy
    servers.push(server)
  }
  servers.sort((left, right) => left.serverName.localeCompare(right.serverName))
  return servers
}

/** Push one public view of a server row to the browser/tools. */
export function presentServer(server) {
  const payload = {
    entryId: server.entryId ?? null,
    id: server.id,
    serverName: server.serverName,
    transport: server.transport,
    target: server.target,
    enabled: server.enabled,
    fiberPhase: server.fiberPhase,
    live: server.live ?? null,
    toolCount: server.toolCount,
    status: serverStatus(server),
    statusDetail: liveStatusView(server)?.detail ?? null,
    diagnostic: typeof server.diagnostic === 'string' && server.diagnostic !== '' ? server.diagnostic : null,
  }
  // Only present when this request carried a footprint snapshot: an older Host
  // keeps the exact 1.4 payload shape.
  for (const field of FOOTPRINT_FIELDS) {
    const value = footprintCounter(server[field])
    if (value !== null) payload[field] = value
  }
  // `/state` always includes `lazy: true|false` once the management half has a
  // lazy set (an empty set still counts). Only a raw pre-1.6 row has no boolean,
  // and for it the old payload shape is kept unchanged.
  if (typeof server.lazy === 'boolean') payload.lazy = server.lazy
  return payload
}

/** Candidate list for an ambiguous identifier, shaped for the panel and the model. */
function candidatesOf(servers) {
  return servers.map((server) => ({ entryId: server.entryId ?? null, id: server.id, serverName: server.serverName }))
}

/** The command that identifies an ambiguity, for the error text. */
function describeCandidates(servers) {
  return servers.map((server) => `"${server.serverName}" (row ${server.id}, entry ${server.entryId ?? '-'})`).join(', ')
}

/**
 * Resolve one server from the request's addressing fields.
 *
 * Precedence is entryId → id → `server` (a name or row id), and every match is
 * exact. A case-insensitive server-name match is accepted only when it lands on
 * exactly one row; ambiguity always yields a 400 with the candidates instead of
 * silently toggling a different server.
 */
export function resolveServerTarget(servers, addressing = {}) {
  const list = Array.isArray(servers) ? servers : []
  if (addressing.entryId !== undefined && addressing.entryId !== null) {
    const match = list.find((server) => server.entryId === addressing.entryId)
    if (match !== undefined) return match
    throw new ManagementRequestError(404, `unknown MCP server entryId "${addressing.entryId}"`)
  }
  if (addressing.id !== undefined && addressing.id !== null) {
    const matches = list.filter((server) => server.id === addressing.id)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw ambiguousError(`row id "${addressing.id}"`, matches)
    throw new ManagementRequestError(404, `unknown MCP server row id "${addressing.id}"`)
  }
  const wanted = addressing.server
  if (wanted === undefined || wanted === null) {
    throw new ManagementRequestError(400, 'requires entryId, id or server')
  }
  const exact = list.filter(
    (server) => server.serverName === wanted || server.id === wanted || server.entryId === wanted,
  )
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw ambiguousError(`"${wanted}"`, exact)
  const loose = list.filter((server) => String(server.serverName).toLowerCase() === String(wanted).toLowerCase())
  if (loose.length === 1) return loose[0]
  if (loose.length > 1) throw ambiguousError(`"${wanted}"`, loose)
  throw new ManagementRequestError(404, `unknown MCP server "${wanted}"`)
}

/** 400 for a name that identifies more than one row, carrying the candidates. */
function ambiguousError(label, matches) {
  return new ManagementRequestError(
    400,
    `${label} matches ${matches.length} MCP servers: ${describeCandidates(matches)}`,
    { candidates: candidatesOf(matches) },
  )
}

/** Find one server by display name, row id or entry id (undefined on no match). */
export function findServer(servers, name) {
  try {
    return resolveServerTarget(servers, { server: name })
  } catch (error) {
    if (error?.status === 404) return undefined
    throw error
  }
}

/** Whether one patch file declares the given row id, tolerating an unreadable file. */
function patchDeclaresRow(filePath, id) {
  try {
    const text = readPatchFile(filePath)
    return text !== null && patchDeclares(text, id) ? text : null
  } catch {
    // A patch that cannot be parsed does not declare the row; the manager path
    // then decides and reports its own refusal instead of us guessing.
    return null
  }
}

/** Decide how one server row can be toggled in this composition. */
export function resolveToggleTarget(ctx, server) {
  const { home, profile } = patchPathsOf(ctx)
  if (home !== null) {
    const homeText = patchDeclaresRow(home, server.id)
    if (homeText !== null) return { kind: 'patch', file: home, text: homeText, layer: 'home' }
  }
  if (server.readOnlyReason === null || server.readOnlyReason === undefined) return { kind: 'manager' }
  if (profile !== null) {
    const profileText = patchDeclaresRow(profile, server.id)
    if (profileText !== null) return { kind: 'patch', file: profile, text: profileText, layer: 'profile' }
  }
  throw new ManagementRequestError(
    409,
    `server "${server.serverName}" is locked by this Harness (${server.readOnlyReason})`,
  )
}

/** Poll the plugin manager until the target row reaches the requested phase. */
export async function waitForServerPhase(ctx, entryId, enabled, options = {}) {
  const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? SERVER_WAIT_MS)
  const signal = options.signal
  let last = null
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw abortError()
    let rows = null
    try {
      rows = await listPluginRows(ctx, { deadline, signal })
    } catch (error) {
      if (isAbortError(error)) throw error
      // A stalled manager call cannot be outwaited by polling; the deadline is
      // already spent, so report the timeout rather than spinning.
      if (error?.status === 504) break
      // HMR may be mid-recomposition; retry until the deadline.
      rows = null
    }
    const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.entryId === entryId) : undefined
    if (row !== undefined) {
      last = row
      if (enabled) {
        if (row.enabled === true && row.fiberPhase === 'active') return { ok: true, row, outcome: 'active' }
        if (row.fiberPhase === 'failed') {
          return {
            ok: false,
            row,
            outcome: 'failed',
            diagnostic: typeof row.diagnostic === 'string' && row.diagnostic !== '' ? row.diagnostic : null,
          }
        }
      } else if (
        row.enabled === false &&
        row.fiberPhase !== 'unloading' &&
        row.fiberPhase !== 'active' &&
        row.fiberPhase !== 'pending' &&
        row.fiberPhase !== 'loading'
      ) {
        // "Stopped" is only truthful once the fiber is gone, not while unloading.
        return { ok: true, row, outcome: 'unloaded' }
      }
    }
    await sleep(Math.min(SERVER_POLL_MS, Math.max(0, deadline - Date.now())))
  }
  return { ok: false, row: last, outcome: 'timeout' }
}

/** Build an explicit result for one operation; both the route and the model use it. */
function operationResult(partial) {
  const result = {
    desiredEnabled: partial.desiredEnabled === true,
    applied: partial.applied === true,
    changed: partial.changed === true,
    observedEnabled: partial.observedEnabled === true,
    observedStatus: partial.observedStatus ?? 'unknown',
    via: partial.via,
  }
  if (partial.application !== undefined) result.application = partial.application
  if (partial.message !== undefined) result.message = partial.message
  return result
}

/** Observed enablement/status derived from a live plugin-manager row. */
function observedFrom(row, fallback) {
  if (row === null || row === undefined || typeof row !== 'object') {
    return { enabled: fallback.enabled === true, status: serverStatus(fallback) }
  }
  const shaped = {
    enabled: row.enabled !== false,
    fiberPhase: row.fiberPhase ?? null,
    diagnostic: typeof row.diagnostic === 'string' ? row.diagnostic : fallback.diagnostic ?? null,
    toolCount: fallback.toolCount ?? 0,
  }
  return { enabled: shaped.enabled, status: serverStatus(shaped) }
}

/**
 * Re-read one server after a successful operation.
 *
 * The phase wait tells us the fiber is up, but the tool catalog is not part of
 * a manager row; it is counted from the live registry. Reporting the
 * pre-operation count would call a just-started server "idle".
 */
async function observeServer(ctx, server, waitedRow, options) {
  try {
    const servers = await collectServerRows(ctx, options)
    const live = servers.find((candidate) => candidate.entryId === server.entryId)
    if (live !== undefined) return { enabled: live.enabled === true, status: serverStatus(live) }
  } catch {
    // A follow-up read is best-effort; the phase wait already observed enough.
  }
  return observedFrom(waitedRow, server)
}

/** Turn a non-arriving phase into an explicit failure (never a 200 "ok"). */
function phaseFailure(server, enabled, waited) {
  const observed = observedFrom(waited.row, server)
  if (enabled && waited.outcome === 'failed') {
    const diagnostic = typeof waited.diagnostic === 'string' && waited.diagnostic !== '' ? `: ${waited.diagnostic}` : ''
    return new ManagementRequestError(500, `MCP server "${server.serverName}" failed to start${diagnostic}`, { observed })
  }
  const verb = enabled ? 'start' : 'stop'
  return new ManagementRequestError(500, `timed out waiting for MCP server "${server.serverName}" to ${verb}`, { observed })
}

/**
 * Persist and/or apply one enablement change and report exactly what happened.
 *
 * The pre-operation row is only used for the no-op comparison; the caller
 * re-reads it inside the serialized task, so two queued operations always act
 * on live state instead of an entry-time snapshot.
 */
async function changeServerEnabled(ctx, server, enabled, options) {
  const desiredEnabled = enabled
  if (server.enabled === desiredEnabled) {
    if (!desiredEnabled) {
      // Already configured off: still wait for a real unload before reporting.
      if (server.fiberPhase === 'unloading' || server.fiberPhase === 'active') {
        const waited = await waitForServerPhase(ctx, server.entryId, false, options)
        if (!waited.ok) throw phaseFailure(server, false, waited)
      }
      return operationResult({
        desiredEnabled,
        applied: true,
        changed: false,
        observedEnabled: false,
        observedStatus: serverStatus({ ...server, enabled: false, fiberPhase: null }),
        via: 'noop',
      })
    }
    if (server.fiberPhase === 'active' && server.diagnostic === null) {
      return operationResult({
        desiredEnabled,
        applied: true,
        changed: false,
        observedEnabled: true,
        observedStatus: serverStatus(server),
        via: 'noop',
      })
    }
  }

  const target = resolveToggleTarget(ctx, server)
  if (target.kind === 'patch') {
    try {
      applyPatchOverride(target.file, target.text, server.id, !enabled)
    } catch (error) {
      throw new ManagementRequestError(500, `could not write the ${target.layer} patch: ${messageOf(error)}`)
    }
    const waited = await waitForServerPhase(ctx, server.entryId, enabled, options)
    if (!waited.ok) throw phaseFailure(server, enabled, waited)
    const observed = await observeServer(ctx, server, waited.row, options)
    return operationResult({
      desiredEnabled,
      applied: true,
      changed: true,
      observedEnabled: observed.enabled,
      observedStatus: observed.status,
      via: `${target.layer}-patch`,
    })
  }

  let saved
  try {
    saved = await awaitBounded(
      Promise.resolve().then(() => ctx.pluginManager.setPluginEnabled(server.entryId, enabled)),
      { deadline: options.deadline, timeoutMs: MANAGER_CALL_MS, label: 'setPluginEnabled', signal: options.signal },
    )
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ManagementRequestError(
      500,
      `plugin manager could not ${enabled ? 'enable' : 'disable'} "${server.serverName}": ${messageOf(error)}`,
      { observed: { enabled: server.enabled, status: serverStatus(server) } },
    )
  }
  const application = saved?.application
  if (application === 'applied') {
    const waited = await waitForServerPhase(ctx, server.entryId, enabled, options)
    if (!waited.ok) throw phaseFailure(server, enabled, waited)
    const observed = await observeServer(ctx, server, waited.row, options)
    return operationResult({
      desiredEnabled,
      applied: true,
      changed: true,
      observedEnabled: observed.enabled,
      observedStatus: observed.status,
      via: 'plugin-manager',
      application,
    })
  }
  if (application === 'restart-required') {
    const reason = typeof saved?.restartReason === 'string' ? ` (${saved.restartReason})` : ''
    // The manager persisted the preference but could not apply it; report what
    // was saved without claiming the runtime changed.
    return operationResult({
      desiredEnabled,
      applied: false,
      changed: saved?.changed !== false,
      observedEnabled: server.enabled === true,
      observedStatus: serverStatus(server),
      via: 'plugin-manager',
      application,
      message: `saved; takes effect after the next Harness restart${reason}`,
    })
  }
  if (application === 'overridden') {
    let live = null
    try {
      const servers = await collectServerRows(ctx, options)
      live = servers.find((candidate) => candidate.entryId === server.entryId) ?? null
    } catch {
      // The explanation is still useful when the follow-up read fails.
    }
    const observed = live === null ? { enabled: server.enabled === true, status: serverStatus(server) } : observedFrom(live, server)
    throw new ManagementRequestError(
      409,
      `another configuration layer overrides "${server.serverName}"; the preference was saved but the running state did not change`,
      { application, observed },
    )
  }
  // failed / cancelled / an application this version does not know: never fall
  // back to writing a patch the manager did not ask us to touch.
  const code = typeof saved?.error?.code === 'string' ? saved.error.code : undefined
  const diagnostic = typeof saved?.error?.diagnostic === 'string' ? saved.error.diagnostic : undefined
  const detail = [code === undefined ? '' : ` (${code})`, diagnostic === undefined ? '' : `: ${diagnostic}`].join('')
  throw new ManagementRequestError(
    500,
    `plugin manager could not ${enabled ? 'enable' : 'disable'} "${server.serverName}"${detail || ' (unknown outcome)'}`,
    {
      application: typeof application === 'string' ? application : 'failed',
      code,
      observed: { enabled: server.enabled, status: serverStatus(server) },
    },
  )
}

/**
 * Re-assert the persisted preference after an interrupted restart.
 *
 * Only the saved preference is restored (a patch write or the manager's
 * `setPluginEnabled`): the request that asked for the restart is already gone,
 * so there is nobody left to wait for a runtime phase.
 */
async function restorePersistedPreference(ctx, server, enabled, options) {
  const target = resolveToggleTarget(ctx, server)
  if (target.kind === 'patch') {
    applyPatchOverride(target.file, target.text, server.id, !enabled)
    return 'preference-restored'
  }
  const saved = await awaitBounded(
    Promise.resolve().then(() => ctx.pluginManager.setPluginEnabled(server.entryId, enabled)),
    { deadline: options.deadline, timeoutMs: MANAGER_CALL_MS, label: 'setPluginEnabled rollback', signal: options.signal },
  )
  const application = saved?.application
  if (application === 'applied' || application === 'restart-required') return 'preference-restored'
  throw new ManagementRequestError(500, `rollback was ${application ?? 'not applied'}`)
}

/**
 * Stop then start, restoring the pre-restart preference when the start fails or
 * the caller aborts.
 *
 * A restart first persists `disabled: true`; if the caller goes away (the
 * panel aborts after 10 s) that preference would drift unless the stop is
 * undone. Every restore runs on a fresh budget and a *non-aborted* signal, or
 * the very abort that interrupted the restart would cancel the repair too.
 */
async function restartServer(ctx, server, options) {
  const wasEnabled = server.enabled === true
  const restoreOptions = { signal: undefined, deadline: Date.now() + MANAGER_CALL_MS }
  // The abort path answers a caller who is no longer waiting, so it restores the
  // saved preference only; the failure path still waits for the runtime.
  const restorePreference = async () => {
    if (!wasEnabled) return null
    try {
      return await restorePersistedPreference(ctx, server, true, restoreOptions)
    } catch (error) {
      return `preference-restore-failed: ${clip(messageOf(error), 160)}`
    }
  }
  const liveObserved = async () => {
    try {
      const servers = await collectServerRows(ctx, restoreOptions)
      const live = servers.find((candidate) => candidate.entryId === server.entryId) ?? null
      if (live !== null) return { enabled: live.enabled === true, status: serverStatus(live) }
    } catch {
      // The error below keeps whatever the failed step already observed.
    }
    return undefined
  }
  const abortFailure = async (error) => {
    const rollback = await restorePreference()
    return new ManagementRequestError(500, `restart aborted: ${messageOf(error)}`, {
      observed: (await liveObserved()) ?? error?.observed,
      rollback,
    })
  }

  let stop = null
  if (wasEnabled) {
    try {
      stop = await changeServerEnabled(ctx, server, false, options)
    } catch (error) {
      if (isAbortError(error)) throw await abortFailure(error)
      // A live caller whose stop timed out (the model tool has no client
      // deadline) can still be left with the patch at disabled: true. Restore
      // the saved preference without waiting for the runtime the timeout
      // proves stuck, and report it like every other restart failure.
      const rollback = await restorePreference()
      const observed = (await liveObserved()) ?? error?.observed
      throw new ManagementRequestError(error?.status ?? 500, `restart failed: ${messageOf(error)}`, {
        application: error?.application,
        observed,
        rollback,
      })
    }
  }

  let startTarget = server
  try {
    const servers = await collectServerRows(ctx, options)
    startTarget = servers.find((candidate) => candidate.entryId === server.entryId) ?? { ...server, enabled: false, fiberPhase: null }
  } catch (error) {
    if (isAbortError(error)) throw await abortFailure(error)
    startTarget = { ...server, enabled: false, fiberPhase: null }
  }
  try {
    const start = await changeServerEnabled(ctx, startTarget, true, options)
    return { outcome: start, steps: { stop } }
  } catch (error) {
    if (isAbortError(error)) throw await abortFailure(error)
    let live = null
    try {
      const servers = await collectServerRows(ctx, restoreOptions)
      live = servers.find((candidate) => candidate.entryId === server.entryId) ?? null
    } catch {
      // The failure below already carries the observed state from the failed step.
    }
    let rollback = null
    if (wasEnabled) {
      // The stop succeeded but the start did not: the persisted preference now
      // says disabled although the user asked for a restart. Try to restore the
      // original value so the next boot matches the user's intent, and say
      // either way what happened.
      try {
        await changeServerEnabled(ctx, live ?? startTarget, true, restoreOptions)
        rollback = 'preference-restored'
      } catch (rollbackError) {
        rollback = `preference-restore-failed: ${clip(messageOf(rollbackError), 160)}`
      }
    }
    const observed = live === null
      ? error?.observed ?? { enabled: false, status: 'stopped' }
      : { enabled: live.enabled === true, status: serverStatus(live) }
    throw new ManagementRequestError(error?.status ?? 500, `restart failed: ${messageOf(error)}`, {
      application: error?.application,
      observed,
      rollback,
    })
  }
}

/**
 * Re-read the live rows inside the serialized task, resolve the addressed row,
 * then apply the operation. Returns `{ action, server, outcome, steps? }`.
 *
 * The operation carries the desired enablement explicitly (a toggle request
 * names it), so no action string can be misread as "stop".
 */
async function runOperation(ctx, operation, addressing, options) {
  const servers = await collectServerRows(ctx, options)
  const server = resolveServerTarget(servers, addressing)
  if (operation.kind === 'restart') {
    const restarted = await restartServer(ctx, server, options)
    return { action: operation.action ?? 'restart', server, outcome: restarted.outcome, steps: restarted.steps }
  }
  const outcome = await changeServerEnabled(ctx, server, operation.enabled === true, options)
  return { action: operation.action ?? 'toggle', server, outcome }
}

/** Flatten one operation's outcome for the browser panel. */
function publicResult(operation) {
  const payload = {
    action: operation.action,
    entryId: operation.server.entryId ?? null,
    serverName: operation.server.serverName,
    desiredEnabled: operation.outcome.desiredEnabled,
    applied: operation.outcome.applied,
    changed: operation.outcome.changed,
    observedEnabled: operation.outcome.observedEnabled,
    observedStatus: operation.outcome.observedStatus,
    via: operation.outcome.via,
  }
  if (operation.outcome.application !== undefined) payload.application = operation.outcome.application
  if (operation.outcome.message !== undefined) payload.message = operation.outcome.message
  if (operation.steps !== undefined) {
    payload.steps = {
      stop: operation.steps.stop === null || operation.steps.stop === undefined ? null : {
        applied: operation.steps.stop.applied,
        observedStatus: operation.steps.stop.observedStatus,
      },
    }
  }
  return payload
}

/**
 * Serialized mutations: two toggles from the UI or the model never interleave.
 * The queue also refuses work beyond `maxPending` so a flood cannot grow an
 * unbounded backlog behind one slow operation.
 */
export function createControlQueue(options = {}) {
  const maxPending = options.maxPending ?? MAX_PENDING_OPERATIONS
  let chain = Promise.resolve()
  let pending = 0
  return (task) => {
    if (pending >= maxPending) return Promise.reject(new QueueFullError(maxPending))
    pending += 1
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run.then(
      (value) => {
        pending -= 1
        return value
      },
      (error) => {
        pending -= 1
        throw error
      },
    )
  }
}

/** A token estimate for the one-line disclosure text: plain below 1k, else `1.5k`. */
function formatTokens(value) {
  const tokens = footprintCounter(value) ?? 0
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

/** Names listed per reason in the "kept visible" line. */
const KEPT_VISIBLE_NAMES = 3
/** Character bound of that line. */
const KEPT_VISIBLE_MAX_CHARS = 400

/**
 * One bounded `Kept visible (not masked): …` line, grouped by adoption reason.
 *
 * This is the model-facing answer for "why are these tools still visible?"
 * (the panel only shows per-reason counts). The snapshot is Host data, so a
 * malformed entry is skipped rather than coerced; names and reasons are clipped,
 * at most three names per reason are listed, and the whole line is bounded.
 * Returns null when there is nothing usable to report.
 */
function keptVisibleLine(notAdopted) {
  if (!Array.isArray(notAdopted) || notAdopted.length === 0) return null
  const groups = new Map()
  for (const item of notAdopted) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.reason !== 'string' || item.reason.trim() === '') continue
    const reason = clip(item.reason, 80)
    if (reason === '') continue
    const names = groups.get(reason) ?? []
    const name = typeof item.name === 'string' ? clip(item.name, 100) : ''
    if (name !== '' && !names.includes(name)) names.push(name)
    groups.set(reason, names)
  }
  if (groups.size === 0) return null
  const parts = []
  for (const [reason, names] of groups) {
    // A reason with no usable name is not a kept-visible tool: omit it rather
    // than print a noisy "reason: 0".
    if (names.length === 0) continue
    const shown = names.slice(0, KEPT_VISIBLE_NAMES).join(', ')
    const more = names.length > KEPT_VISIBLE_NAMES ? `, +${names.length - KEPT_VISIBLE_NAMES} more` : ''
    parts.push(`${reason}: ${names.length} (${shown}${more})`)
  }
  if (parts.length === 0) return null
  return clip(`Kept visible (not masked): ${parts.join('; ')}.`, KEPT_VISIBLE_MAX_CHARS)
}

/** Render one state snapshot as the compact tool answer. */
export function renderServerList(servers, options = {}) {
  if (!Array.isArray(servers) || servers.length === 0) {
    return 'No MCP servers are configured. Add @deepseek-ai/dsh-mcp-client rows to the profile patch first.'
  }
  const lines = [`MCP servers (${servers.length}):`]
  for (const server of servers) {
    const status = serverStatus(server)
    // The live detail explains a status the phase alone cannot (a reconnecting
    // or credential-blocked connection); it is already one bounded line.
    const liveDetail = liveStatusView(server)?.detail
    const detail = [server.transport, server.target].filter(Boolean).join(' ')
    const tools = server.toolCount > 0 ? `, ${server.toolCount} tools` : ''
    const lazy = server.lazy === true ? ', lazy' : ''
    const hiddenTools = footprintCounter(server.hiddenTools) ?? 0
    const hidden = hiddenTools > 0 ? `, ${hiddenTools} hidden ≈ ${formatTokens(server.hiddenTokens)} tokens` : ''
    const diagnostic = server.diagnostic ? `; diagnostic: ${clip(server.diagnostic, 160)}` : ''
    lines.push(
      `- ${server.serverName} (row ${server.id}): ${status}${liveDetail ? ` — ${liveDetail}` : ''}${tools}${lazy}${hidden}` +
        `${detail ? ` — ${detail}` : ''}${diagnostic}`,
    )
  }
  lines.push(
    'Start, stop or restart one with mcp_server { server, action: "start" | "stop" | "restart" }. ' +
      'A "restart-required" outcome is saved but only takes effect after a Harness restart.',
  )
  const disclosureHidden = footprintCounter(options?.disclosure?.hiddenTools) ?? 0
  if (disclosureHidden > 0) {
    lines.push(
      `Hidden by default: ${disclosureHidden} tools ≈ ${formatTokens(options.disclosure.hiddenTokens)} tokens; ` +
        'mcp_load makes them native, mcp_call runs one directly.',
    )
  }
  const keptVisible = keptVisibleLine(options?.disclosure?.notAdopted)
  if (keptVisible !== null) lines.push(keptVisible)
  return lines.join('\n')
}

/**
 * Read a JSON request body, bounded.
 *
 * The error carries its own HTTP status so an oversized body is answered with
 * 413 (and the rest of the request drained) instead of a reset connection. The
 * parse error never repeats body bytes: a caller can put a secret there. A
 * client that disconnects mid-body rejects with an AbortError so the handler
 * (and its closures) cannot stay pending forever.
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    let settled = false
    const cleanup = () => {
      req.removeListener?.('data', onData)
      req.removeListener?.('close', onAbort)
      req.removeListener?.('aborted', onAbort)
    }
    const fail = (status, message) => {
      if (settled) return
      settled = true
      // Stop buffering but keep the socket readable so the client can receive
      // the status line instead of seeing a reset mid-upload.
      cleanup()
      req.resume?.()
      reject(new ManagementRequestError(status, message))
    }
    const onData = (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(413, `request body exceeds ${limit} bytes`)
        return
      }
      parts.push(chunk)
    }
    // A normal request also finishes with 'close'; `settled` is already true
    // once 'end' delivered the body, so only a premature close aborts here.
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }
    req.on('data', onData)
    req.on('close', onAbort)
    req.on('aborted', onAbort)
    req.on('end', () => {
      if (settled) return
      settled = true
      cleanup()
      const raw = Buffer.concat(parts).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new ManagementRequestError(400, 'invalid JSON body'))
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
  })
}

/** Send one JSON response with no-store caching. */
export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

/** Answer one error with its HTTP status and the fields the panel/model need. */
function sendError(res, error) {
  const status = typeof error?.status === 'number' ? error.status : 500
  const payload = { ok: false, error: messageOf(error) }
  if (Array.isArray(error?.candidates) && error.candidates.length > 0) payload.candidates = error.candidates
  if (error?.application !== undefined) payload.application = error.application
  if (error?.code !== undefined) payload.code = error.code
  if (error?.observed !== undefined) payload.observed = error.observed
  if (error?.rollback !== undefined) payload.rollback = error.rollback
  try {
    sendJson(res, status, payload)
  } catch {
    // The client may have gone away before we could answer; nothing else to do.
  }
}

/**
 * Apply Connection's trust fence first; true when the request was rejected.
 *
 * The routes stay registered while the service may be momentarily absent (an
 * HMR recomposition or an unload window), so a missing fence must fail closed:
 * answering 503 here is the only safe reading of "no admission available".
 */
function rejectUntrusted(ctx, req, res) {
  const connection = ctx.get?.('connection')
  const requestRejection = connection?.requestRejection
  if (typeof requestRejection !== 'function') {
    sendJson(res, 503, { ok: false, error: 'management routes require the Host connection service' })
    return true
  }
  let rejection
  try {
    rejection = requestRejection.call(connection, req)
  } catch {
    // A fence that throws is not a permission: fail closed.
    rejection = 403
  }
  if (rejection === undefined || rejection === null) return false
  const status = typeof rejection === 'number' && rejection >= 400 && rejection <= 599 ? rejection : 403
  sendJson(res, status, { ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' })
  return true
}

/** Validate an HTTP method; false means the response is already sent. */
function requireMethod(req, res, allowed) {
  const method = String(req.method ?? 'GET').toUpperCase()
  if (allowed.includes(method)) return true
  sendJson(res, 405, { ok: false, error: `${allowed.join(' or ')} required` }, { allow: allowed.join(', ') })
  return false
}

/**
 * Require `application/json` on a body-carrying route.
 *
 * A missing type is refused just like a declared non-JSON one: an HTML form or
 * a cross-site `fetch` can only send `text/plain`, `application/x-www-form-urlencoded`
 * or `multipart/form-data` without a preflight, so the media type is part of the
 * admission gate in front of the mutation path (only `; charset=` parameters are
 * ignored, and the type is matched case-insensitively).
 */
function checkJsonContentType(req, res) {
  const raw = req.headers?.['content-type']
  const type = typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : ''
  if (type === 'application/json') return true
  sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
  return false
}

/** Abort signal wired to the request lifecycle, so cancelling the browser call stops waiting. */
function requestSignal(req, res) {
  const controller = new AbortController()
  const abort = () => {
    // A normal completed response also closes; only a premature close cancels.
    if (res?.writableFinished === true) return
    if (!controller.signal.aborted) controller.abort()
  }
  if (typeof res?.once === 'function') res.once('close', abort)
  else if (typeof req?.once === 'function') req.once('close', abort)
  if (typeof req?.once === 'function') req.once('aborted', abort)
  return controller.signal
}

/** The body must be a JSON object; arrays and primitives cannot address a server. */
function validateBodyObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ManagementRequestError(400, 'body must be a JSON object')
  }
}

/** Identifiers present in the body must be non-empty strings, before any lookup. */
function validateAddressing(body) {
  for (const field of ['entryId', 'id', 'server']) {
    const value = body[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ManagementRequestError(400, `${field} must be a non-empty string`)
    }
  }
  if (body.entryId === undefined && body.id === undefined && body.server === undefined) {
    throw new ManagementRequestError(400, 'requires one of entryId, id or server')
  }
}

/** `enabled` is a boolean and nothing else; a string "true" must never mean stop. */
function validateEnabled(body) {
  if (typeof body.enabled !== 'boolean') {
    const received = body.enabled === null ? 'null' : Array.isArray(body.enabled) ? 'array' : typeof body.enabled
    throw new ManagementRequestError(400, `enabled must be a boolean (received ${received})`)
  }
}

/**
 * Register the management tools and the Plugins-page HTTP routes.
 *
 * `options.footprint(agent)` and `options.loadedView()` are the optional Host
 * seams that add the hidden-footprint and loaded-tool snapshots to `/state` and
 * to `mcp_servers`. Both are read-only extras: a missing callback, a throwing
 * one or a malformed answer degrades to null and never fails a request.
 *
 * `options.lazyConnect` (Set or string[]) names the rows that may start on
 * demand, and `'*'` accepts every configured row (P1.1 auto-adoption); the
 * returned `ensureServer` / `releaseServer` / `listServers` are the
 * connection-layer control API the Host calls from `mcp_load` / `mcp_call` /
 * its warm timer. Once this function is called, every `/state` row carries
 * `lazy: true|false` (an empty lazy set still stamps `false`); the flag is
 * absent only on a raw row that predates the management half.
 */
export function registerServerManagement(ctx, options = {}) {
  const runExclusive = createControlQueue()
  const footprintCallback = typeof options.footprint === 'function' ? options.footprint : null
  const loadedViewCallback = typeof options.loadedView === 'function' ? options.loadedView : null
  const lazyServers = toServerSet(options.lazyConnect)
  const lazyStartTimeoutMs = resolveLazyTimeout(options.lazyStartTimeoutMs)
  /** Whether this server may start on demand (`'*'` accepts every configured row). */
  const isLazyServer = (serverName) => lazyServers.has('*') || lazyServers.has(serverName)
  /** The lazy poll warns once per registration instead of on every failed tick. */
  let listServersWarned = false
  ctx.logger?.info?.('mcp-progressive: MCP server management ready (tools + Plugins tab routes)')

  const describe = async (requestOptions = {}) => {
    // One snapshot per request: `agent` is absent for the panel, so its
    // disclosure is the cold default view rather than a session's live load.
    const footprint = callOptional(footprintCallback, requestOptions.agent)
    const servers = await collectServerRows(ctx, {
      ...requestOptions,
      footprint: footprint ?? undefined,
      lazyConnect: lazyServers,
    })
    const payload = { ok: true, now: Date.now(), servers: servers.map(presentServer) }
    // The snapshots are Host data: one that cannot be serialized is omitted
    // instead of failing the response (a BigInt or a circular object).
    payload.disclosure = jsonSafe(footprint?.total)
    payload.loaded = jsonSafe(callOptional(loadedViewCallback))
    if (requestOptions.result !== undefined) payload.result = requestOptions.result
    return payload
  }

  /**
   * Queue one operation and return its public result.
   *
   * The 30 s budget starts when the task reaches the head of the queue, not
   * when it joined it: an operation that waited behind slow work must not
   * begin with an already-expired deadline and fail without doing anything.
   */
  const enqueueOperation = async (operation, addressing, signal) => {
    const finished = await runExclusive(() => {
      const options = { signal, deadline: Date.now() + SERVER_WAIT_MS }
      return runOperation(ctx, operation, addressing, options)
    })
    return publicResult(finished)
  }

  /** Re-read one row by its display name (null when it is gone). */
  const findServerByName = async (serverName) => {
    const servers = await collectServerRows(ctx)
    return servers.find((server) => server.serverName === serverName) ?? null
  }

  /** `true` when a live agent loaded a tool from this server (or the view is unreadable), null when the callback throws. */
  const loadedFromServer = (serverName) => {
    if (typeof loadedViewCallback !== 'function') return false
    try {
      return loadedToolNamesOf(loadedViewCallback(), serverName)
    } catch {
      return null
    }
  }

  /** Wait for the requested tool after a start; the shared tail of `ensureServer`. */
  const finishEnsure = async (serverName, toolName, deadline, started) => {
    if (await waitForTool(ctx, serverName, toolName, deadline)) return { ok: true, started }
    const what = typeof toolName === 'string' && toolName !== '' ? `"${toolName}"` : `tools of "${serverName}"`
    return { ok: false, reason: 'timeout', message: `${what} did not appear in time` }
  }

  /** Wait for an already-starting row; null when it reaches active, else a failure. */
  const awaitStarting = async (server, deadline) => {
    const waited = await waitForServerPhase(ctx, server.entryId, true, { deadline })
    if (waited.ok) return null
    if (waited.outcome === 'timeout') {
      return { ok: false, reason: 'timeout', message: `server "${server.serverName}" did not finish starting in time` }
    }
    const diagnostic = typeof waited.diagnostic === 'string' && waited.diagnostic !== '' ? `: ${waited.diagnostic}` : ''
    return { ok: false, reason: 'failed', message: `server "${server.serverName}" failed to start${diagnostic}` }
  }

  /**
   * Start one lazy server if needed and wait for its tool to register.
   *
   * Never throws: every failure is an `{ok:false, reason}` answer. The decision
   * to toggle is taken inside the shared serialized queue with a re-read, so
   * concurrent callers cannot double-toggle; the tool poll runs after the queue
   * task returns, so a slow registration never pins the control queue.
   */
  const ensureServer = async (serverName, callOptions = {}) => {
    try {
      if (!isLazyServer(serverName)) return { ok: false, reason: 'not-lazy' }
      const timeoutMs = ensureTimeoutMs(callOptions?.timeoutMs, lazyStartTimeoutMs)
      const deadline = Date.now() + timeoutMs
      const toolName = callOptions?.toolName
      const server = await findServerByName(serverName)
      if (server === null) return { ok: false, reason: 'unknown-server' }

      if (server.enabled === true) {
        const status = serverStatus(server)
        if (status === 'starting') {
          const failure = await awaitStarting(server, deadline)
          if (failure !== null) return failure
        } else if (status !== 'running' && status !== 'idle') {
          return { ok: false, reason: 'failed', message: `server "${serverName}" is ${status}` }
        }
        return await finishEnsure(serverName, toolName, deadline, false)
      }

      const decision = await runExclusive(async () => {
        const fresh = await findServerByName(serverName)
        if (fresh === null) return { kind: 'unknown-server' }
        if (fresh.enabled === true) {
          return serverStatus(fresh) === 'starting' ? { kind: 'starting', server: fresh } : { kind: 'already' }
        }
        try {
          await changeServerEnabled(ctx, fresh, true, { deadline })
          return { kind: 'started' }
        } catch (error) {
          return { kind: 'failed', message: messageOf(error) }
        }
      })
      if (decision.kind === 'unknown-server') return { ok: false, reason: 'unknown-server' }
      if (decision.kind === 'failed') return { ok: false, reason: 'failed', message: decision.message }
      if (decision.kind === 'starting') {
        const failure = await awaitStarting(decision.server, deadline)
        if (failure !== null) return failure
        return await finishEnsure(serverName, toolName, deadline, false)
      }
      return await finishEnsure(serverName, toolName, deadline, decision.kind === 'started')
    } catch (error) {
      return { ok: false, reason: 'failed', message: messageOf(error) }
    }
  }

  /**
   * Stop one lazy server, unless a live agent still has a tool loaded from it.
   *
   * The in-use and starting checks are repeated inside the serialized queue
   * just before the stop, so a load or a pending start cannot slip between the
   * outer decision and the mutation. An unreadable loaded view (`unreadable:
   * true`) counts as in use: "unknown" must never become a stop. Never throws.
   */
  const releaseServer = async (serverName) => {
    try {
      if (!isLazyServer(serverName)) return { ok: false, reason: 'not-lazy' }
      const server = await findServerByName(serverName)
      if (server === null) return { ok: false, reason: 'unknown-server' }
      const inUse = loadedFromServer(serverName)
      if (inUse === null) return { ok: false, reason: 'failed', message: 'could not read the loaded view' }
      if (inUse) return { ok: false, reason: 'in-use' }
      if (server.enabled !== true) return { ok: true, stopped: false }
      if (serverStatus(server) === 'starting') return { ok: false, reason: 'starting' }

      const deadline = Date.now() + lazyStartTimeoutMs
      const decision = await runExclusive(async () => {
        const fresh = await findServerByName(serverName)
        if (fresh === null) return { kind: 'unknown-server' }
        const stillInUse = loadedFromServer(serverName)
        if (stillInUse === null) return { kind: 'failed', message: 'could not read the loaded view' }
        if (stillInUse) return { kind: 'in-use' }
        if (fresh.enabled !== true) return { kind: 'already-stopped' }
        if (serverStatus(fresh) === 'starting') return { kind: 'starting' }
        try {
          await changeServerEnabled(ctx, fresh, false, { deadline })
          return { kind: 'stopped' }
        } catch (error) {
          return { kind: 'failed', message: messageOf(error) }
        }
      })
      if (decision.kind === 'unknown-server') return { ok: false, reason: 'unknown-server' }
      if (decision.kind === 'in-use') return { ok: false, reason: 'in-use' }
      if (decision.kind === 'starting') return { ok: false, reason: 'starting' }
      if (decision.kind === 'failed') return { ok: false, reason: 'failed', message: decision.message }
      if (decision.kind === 'already-stopped') return { ok: true, stopped: false }
      return { ok: true, stopped: true }
    } catch (error) {
      return { ok: false, reason: 'failed', message: messageOf(error) }
    }
  }

  /**
   * Snapshot every configured row for the Host's periodic lazy poll.
   *
   * Read-only and never throwing. A failed or malformed catalogue read returns
   * **null**, never `[]`: `[]` is an authoritative "no servers configured"
   * answer that a scanner would apply as an uninstall of everything, so it is
   * reserved for a verified empty inventory. One warning is logged per
   * registration, so a broken source pauses auto-adoption without spamming.
   */
  const listServers = async () => {
    try {
      const servers = await collectServerRows(ctx, { requirePluginRows: true })
      return servers.map((server) => ({
        serverName: server.serverName,
        enabled: server.enabled === true,
        status: serverStatus(server),
        lazy: isLazyServer(server.serverName),
      }))
    } catch (error) {
      if (!listServersWarned) {
        listServersWarned = true
        ctx.logger?.warn?.(`mcp-progressive: could not list MCP servers for the lazy poll: ${messageOf(error)}`)
      }
      return null
    }
  }

  const stateHandler = async (req, res) => {
    if (rejectUntrusted(ctx, req, res)) return
    if (!requireMethod(req, res, ['GET', 'HEAD'])) return
    try {
      sendJson(res, 200, await describe({ signal: requestSignal(req, res) }))
    } catch (error) {
      sendError(res, error)
    }
  }

  const toggleHandler = async (req, res) => {
    if (rejectUntrusted(ctx, req, res)) return
    if (!requireMethod(req, res, ['POST'])) return
    if (!checkJsonContentType(req, res)) return
    const signal = requestSignal(req, res)
    let body
    try {
      body = await readJsonBody(req)
      validateBodyObject(body)
      validateAddressing(body)
      validateEnabled(body)
    } catch (error) {
      sendError(res, error)
      return
    }
    try {
      const result = await enqueueOperation({ kind: 'toggle', action: 'toggle', enabled: body.enabled }, body, signal)
      sendJson(res, 200, await describe({ signal, result }))
    } catch (error) {
      sendError(res, error)
    }
  }

  const restartHandler = async (req, res) => {
    if (rejectUntrusted(ctx, req, res)) return
    if (!requireMethod(req, res, ['POST'])) return
    if (!checkJsonContentType(req, res)) return
    const signal = requestSignal(req, res)
    let body
    try {
      body = await readJsonBody(req)
      validateBodyObject(body)
      validateAddressing(body)
    } catch (error) {
      sendError(res, error)
      return
    }
    try {
      const result = await enqueueOperation({ kind: 'restart', action: 'restart' }, body, signal)
      sendJson(res, 200, await describe({ signal, result }))
    } catch (error) {
      sendError(res, error)
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'mcp_servers',
    description:
      'List every configured MCP server with its runtime status (running / stopped / starting / stopping / error / idle / unknown), row id, transport, tool count and any startup diagnostic. ' +
      'MCP servers can be stopped to free their child process without unloading this plugin. ' +
      'Use mcp_server { server, action } to start, stop or restart one.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      try {
        // A real dispatch carries `exec.agent`, so a model sees its own loaded
        // set; a direct call without one keeps the plain list (and the pre-1.5
        // payload shape used by older callers).
        const footprint = exec !== null && typeof exec === 'object'
          ? callOptional(footprintCallback, exec.agent)
          : null
        const servers = await collectServerRows(ctx, {
          ...(footprint === null ? {} : { footprint }),
          lazyConnect: lazyServers,
        })
        return renderServerList(servers, { disclosure: footprint?.total ?? null })
      } catch (error) {
        return `Error: could not list MCP servers: ${messageOf(error)}`
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'mcp_server',
    description:
      'Start, stop or restart one configured MCP server by name or row id. Stopping disconnects its process and removes its tools from every session; ' +
      'starting reconnects it. The choice is persisted in the profile patch (or the home patch for home-inserted rows) and survives a restart. ' +
      'Call mcp_servers first to see exact names and status; an ambiguous name lists its candidates instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name or row id from mcp_servers (for example "rea" or "rea-mcp").' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'start = enable and connect; stop = disable and disconnect; restart = stop then start.' },
      },
      required: ['server', 'action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const name = typeof args?.server === 'string' ? args.server.trim() : ''
      const action = args?.action === 'stop' ? 'stop' : args?.action === 'restart' ? 'restart' : args?.action === 'start' ? 'start' : ''
      if (name === '' || action === '') return 'Error: mcp_server requires { server, action: "start" | "stop" | "restart" }.'
      try {
        const operation = action === 'restart'
          ? { kind: 'restart', action }
          : { kind: 'toggle', action, enabled: action === 'start' }
        const result = await enqueueOperation(operation, { server: name })
        let summary
        if (result.application === 'restart-required') {
          summary = `${action}: saved; takes effect after the next Harness restart. Observed: ${result.observedStatus}.`
        } else {
          summary = `${action}: ${result.applied ? 'applied' : 'not applied'}; observed ${result.observedStatus}` +
            `${result.application === undefined ? '' : `; application: ${result.application}`}` +
            `${result.changed ? '' : ' (no change was needed)'}.`
        }
        const after = await collectServerRows(ctx)
        return `${summary}\n${renderServerList(after)}`
      } catch (error) {
        if (Array.isArray(error?.candidates) && error.candidates.length > 0) {
          const lines = error.candidates.map(
            (candidate) => `- ${candidate.serverName} (row ${candidate.id}, entry ${candidate.entryId ?? '-'})`,
          )
          return `Error: ${messageOf(error)}\nCandidates:\n${lines.join('\n')}`
        }
        return `Error: ${messageOf(error)}`
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_SERVER_STATE, handler: stateHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_SERVER_TOGGLE, handler: toggleHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_SERVER_RESTART, handler: restartHandler }))

  return { ensureServer, releaseServer, listServers }
}
