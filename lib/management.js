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
      // The value may be this arg's `=value` part or the next argv item; only
      // the flag name itself is known to be safe to display.
      const flag = item.split('=')[0]
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

/**
 * One of stopped / running / idle / starting / stopping / error / unknown.
 *
 * `diagnostic` is the startup failure the Loader recorded on the row, so an
 * enabled row can be reported as failed even when its fiber phase is missing.
 */
export function serverStatus(server) {
  const phase = server?.fiberPhase ?? null
  if (phase === 'unloading') return 'stopping'
  if (server?.enabled !== true) {
    // Configured off but still holding a live fiber means the shutdown is in
    // progress; reporting "stopped" here would hide a process that is still up.
    return phase === 'active' || phase === 'pending' || phase === 'loading' ? 'stopping' : 'stopped'
  }
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
 * Await one promise unless it is still pending at `deadline` (or a request
 * abort arrives). The deadline is polled instead of raced against a timer so
 * a virtual clock in tests reaches it immediately, and a hung host service can
 * never pin the serialized queue.
 */
export async function awaitBounded(promise, options = {}) {
  const label = options.label ?? 'plugin manager call'
  const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? MANAGER_CALL_MS)
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
  // An already-settled promise reports in the next microtask; don't add a poll.
  await Promise.resolve()
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

/** All configured MCP server rows, with their effective runtime state. */
export async function collectServerRows(ctx, options = {}) {
  const plugins = await listPluginRows(ctx, options)
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
    servers.push({
      id,
      serverName,
      transport,
      target: targetSummary(config, transport),
      enabled: row.enabled !== false,
      fiberPhase: row.fiberPhase ?? null,
      toolCount,
      readOnlyReason: row.readOnlyReason ?? null,
      entryId: row.entryId,
      diagnostic: typeof row.diagnostic === 'string' && row.diagnostic !== '' ? row.diagnostic : null,
    })
  }
  servers.sort((left, right) => left.serverName.localeCompare(right.serverName))
  return servers
}

/** Push one public view of a server row to the browser/tools. */
export function presentServer(server) {
  return {
    entryId: server.entryId ?? null,
    id: server.id,
    serverName: server.serverName,
    transport: server.transport,
    target: server.target,
    enabled: server.enabled,
    fiberPhase: server.fiberPhase,
    toolCount: server.toolCount,
    status: serverStatus(server),
    diagnostic: typeof server.diagnostic === 'string' && server.diagnostic !== '' ? server.diagnostic : null,
  }
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
    const observed = observedFrom(waited.row, server)
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
    const observed = observedFrom(waited.row, server)
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

/** Stop then start, restoring the pre-restart preference when the start fails. */
async function restartServer(ctx, server, options) {
  const wasEnabled = server.enabled === true
  let stop = null
  if (wasEnabled) stop = await changeServerEnabled(ctx, server, false, options)

  let startTarget = server
  try {
    const servers = await collectServerRows(ctx, options)
    startTarget = servers.find((candidate) => candidate.entryId === server.entryId) ?? { ...server, enabled: false, fiberPhase: null }
  } catch {
    startTarget = { ...server, enabled: false, fiberPhase: null }
  }
  try {
    const start = await changeServerEnabled(ctx, startTarget, true, options)
    return { outcome: start, steps: { stop } }
  } catch (error) {
    if (isAbortError(error)) throw error
    let live = null
    try {
      const servers = await collectServerRows(ctx, options)
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
        await changeServerEnabled(ctx, live ?? startTarget, true, options)
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

/** Render one state snapshot as the compact tool answer. */
export function renderServerList(servers) {
  if (!Array.isArray(servers) || servers.length === 0) {
    return 'No MCP servers are configured. Add @deepseek-ai/dsh-mcp-client rows to the profile patch first.'
  }
  const lines = [`MCP servers (${servers.length}):`]
  for (const server of servers) {
    const status = serverStatus(server)
    const detail = [server.transport, server.target].filter(Boolean).join(' ')
    const tools = server.toolCount > 0 ? `, ${server.toolCount} tools` : ''
    const diagnostic = server.diagnostic ? `; diagnostic: ${clip(server.diagnostic, 160)}` : ''
    lines.push(`- ${server.serverName} (row ${server.id}): ${status}${tools}${detail ? ` — ${detail}` : ''}${diagnostic}`)
  }
  lines.push(
    'Start, stop or restart one with mcp_server { server, action: "start" | "stop" | "restart" }. ' +
      'A "restart-required" outcome is saved but only takes effect after a Harness restart.',
  )
  return lines.join('\n')
}

/**
 * Read a JSON request body, bounded.
 *
 * The error carries its own HTTP status so an oversized body is answered with
 * 413 (and the rest of the request drained) instead of a reset connection. The
 * parse error never repeats body bytes: a caller can put a secret there.
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      // Stop buffering but keep the socket readable so the client can receive
      // the status line instead of seeing a reset mid-upload.
      req.removeListener?.('data', onData)
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
    req.on('data', onData)
    req.on('end', () => {
      if (settled) return
      settled = true
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

/** Apply Connection's trust fence first; true when the request was rejected. */
function rejectUntrusted(ctx, req, res) {
  let rejection
  try {
    rejection = ctx.get?.('connection')?.requestRejection?.(req)
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
 * Check the content type of a body-carrying route.
 *
 * A declared type must be JSON: an HTML form or a cross-site `fetch` can only
 * send `text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data`
 * without a preflight, so those are refused with 415. A request that declares
 * no type at all is accepted: the Connection trust fence above already rejected
 * unauthenticated/cross-origin callers, a browser cannot omit the type on a
 * cross-site request, and the in-process panel has always called these routes
 * that way.
 */
function checkJsonContentType(req, res) {
  const raw = req.headers?.['content-type']
  if (raw === undefined || raw === null || raw === '') return true
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

/** Register the management tools and the Plugins-page HTTP routes. */
export function registerServerManagement(ctx) {
  const runExclusive = createControlQueue()
  ctx.logger?.info?.('mcp-progressive: MCP server management ready (tools + Plugins tab routes)')

  const describe = async (options = {}) => {
    const servers = await collectServerRows(ctx, options)
    const payload = { ok: true, now: Date.now(), servers: servers.map(presentServer) }
    if (options.result !== undefined) payload.result = options.result
    return payload
  }

  /** Queue one operation and return its public result. */
  const enqueueOperation = async (operation, addressing, signal) => {
    const options = { signal, deadline: Date.now() + SERVER_WAIT_MS }
    const finished = await runExclusive(() => runOperation(ctx, operation, addressing, options))
    return publicResult(finished)
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
    async execute() {
      try {
        return renderServerList(await collectServerRows(ctx))
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
}
