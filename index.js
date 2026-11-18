/**
 * MCP progressive disclosure — Host half.
 *
 * MCP servers register one model-facing tool per remote tool (`mcp__<server>__<tool>`),
 * and every one of those schemas is sent on every request. With a few servers that is
 * tens of thousands of tokens of tool definitions that the model may never use.
 *
 * This plugin keeps the registry untouched (so connections, approvals, cancellation,
 * images and presentation keep working) and instead:
 *
 * 1. keeps unloaded `mcp__*` schemas out of each agent's registry view with a
 *    per-agent scope restriction (`agent.ctx.tools.restrict({ deny })`). dsh 0.2.2
 *    detached tool declarations from the `system-prompt/assemble` waterfall — the
 *    tools array is provider-owned and re-attached after it, so a prompt-level
 *    filter would be inert (0.1.x behaviour). A scope restriction removes the
 *    schemas from `schemas(agent)` (the exact list the prompt provider reads) and
 *    from `get`/`executable`, so hidden tools leave both the prompt and dispatch;
 * 2. loads a tool back as a scope-local registration in the same agent scope,
 *    which restrictions leave visible — so a loaded tool is a real native tool
 *    without ever re-deriving the restriction list;
 * 3. registers three tiny meta-tools:
 *      mcp_search  find tools in the hidden catalog (name, summary, signature)
 *      mcp_load    mark selected tools as loaded for this agent, so they become
 *                  ordinary native tools from the next step (and can be unloaded)
 *      mcp_call    run one hidden tool directly through the full tool pipeline
 * 4. answers a guessed-but-unregistered `mcp__*` call with a corrective message
 *    instead of a bare unknown-tool error.
 *
 * State is per live Agent (Session); unloading is explicit. Loaded tools are native:
 * they go through policy/approval/timeout/post-execute exactly like first-party tools.
 *
 * No npm dependencies: tools are plain definitions registered on `ctx.tools`,
 * which also means the bundle is installable from a linked workspace directory.
 *
 * The optional management half (below) also lists / starts / stops the MCP server
 * rows themselves. It is registered only when the desktop profile services exist,
 * so a headless profile keeps the disclosure half alone.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Loader identity for this plugin. */
export const name = 'mcp-progressive'

/** Services that must exist before this plugin activates. */
export const inject = ['tools']

/** Meta-tool names; never hidden, never loadable. */
const META_TOOLS = new Set(['mcp_search', 'mcp_load', 'mcp_call'])

/** Hard cap for one search page, independent of configuration. */
const MAX_SEARCH_LIMIT = 40

/** Hard cap for full-schema detail pages. */
const MAX_DETAIL_TOOLS = 2

/** Hard cap on the JSON Schema bytes a `detail: 'full'` result may print per tool. */
const MAX_DETAIL_CHARS = 4000

/**
 * Configuration defaults. This bundle declares no Config schema because it is
 * installed from a linked workspace directory without resolvable dependencies;
 * every field is optional and validated defensively in `apply`.
 *
 * @typedef {object} McpLazyConfig
 * @property {string} [prefix] tool-name prefix that identifies hidden MCP tools
 * @property {string[]} [alwaysVisible] exact names or trailing-`*` prefixes never hidden
 * @property {string[]} [eagerTools] names loaded for every agent from the start
 * @property {number} [searchLimit] default search page size, 1..40
 * @property {number} [summaryChars] one-line description budget per result
 * @property {boolean} [enableLoad] register mcp_load
 * @property {boolean} [enableCall] register mcp_call
 * @property {boolean} [correctiveUnknownTool] answer unregistered mcp names with guidance
 * @property {boolean} [manageServers] register MCP server list/start/stop (tools + Plugins tab)
 */
const CONFIG_DEFAULTS = {
  prefix: 'mcp__',
  alwaysVisible: [],
  eagerTools: [],
  searchLimit: 12,
  summaryChars: 160,
  enableLoad: true,
  enableCall: true,
  correctiveUnknownTool: true,
  manageServers: true,
}

/** Collapse whitespace and clip one description line without splitting a word. */
function oneLine(text, maxChars) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const head = collapsed.slice(0, Math.max(0, maxChars - 1))
  const boundary = head.lastIndexOf(' ')
  const cut = boundary > maxChars * 0.6 ? head.slice(0, boundary) : head
  return `${cut}…`
}

/**
 * Compile allow patterns: an entry ending in `*` is a prefix match, otherwise
 * the exact tool name matches. Returns a predicate.
 */
function compileAllowlist(entries) {
  const exact = new Set()
  const prefixes = []
  for (const raw of entries ?? []) {
    const entry = String(raw ?? '').trim()
    if (!entry) continue
    if (entry.endsWith('*')) prefixes.push(entry.slice(0, -1))
    else exact.add(entry)
  }
  if (exact.size === 0 && prefixes.length === 0) return () => false
  return (toolName) => exact.has(toolName) || prefixes.some((prefix) => toolName.startsWith(prefix))
}

/** Resolve a local JSON Pointer (`#/$defs/x`, `#/definitions/x`) against one tool's schema root. */
function resolveRef(node, root, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return node
  const ref = node.$ref
  if (typeof ref !== 'string') return node
  let target
  if (ref.startsWith('#/$defs/')) target = root?.$defs?.[ref.slice(8)]
  else if (ref.startsWith('#/definitions/')) target = root?.definitions?.[ref.slice(14)]
  if (target === undefined) return node
  return resolveRef(target, root, depth + 1)
}

/** Render one JSON Schema parameter node as a short type signature. */
function typeLabel(node, root) {
  const resolved = resolveRef(node, root)
  if (resolved === null || typeof resolved !== 'object') return 'any'
  if (typeof resolved.const !== 'undefined') return JSON.stringify(resolved.const)
  if (Array.isArray(resolved.enum)) return resolved.enum.map((value) => JSON.stringify(value)).join('|')
  if (Array.isArray(resolved.oneOf)) {
    const labels = [...new Set(resolved.oneOf.map((branch) => typeLabel(branch, root)))]
    return labels.length > 0 && labels.length <= 3 ? labels.join('|') : 'any'
  }
  switch (resolved.type) {
    case 'array':
      return resolved.items === undefined ? 'any[]' : `${typeLabel(resolved.items, root)}[]`
    case 'object':
      return 'object'
    case 'integer':
      return 'integer'
    default:
      return typeof resolved.type === 'string' ? resolved.type : 'any'
  }
}

/** Render `name: type` pairs for one tool's object parameters. */
function signatureOf(parameters) {
  const properties = resolveRef(parameters, parameters)?.properties
  if (properties === null || typeof properties !== 'object') return ''
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : [])
  const parts = []
  for (const [key, node] of Object.entries(properties)) {
    const optional = required.has(key) ? '' : '?'
    parts.push(`${key}${optional}: ${typeLabel(node, parameters)}`)
  }
  return parts.join(', ')
}

/** Normalize a thrown value into a message string. */
function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/** Format a byte-ish char budget for JSON: drop `description` fields to fit. */
function fitSchema(schema, budget) {
  let text = JSON.stringify(schema)
  if (text.length <= budget) return { text, truncated: false }
  const clone = JSON.parse(text)
  const strip = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) strip(item)
      return
    }
    delete node.description
    delete node.title
    delete node.examples
    delete node.default
    for (const value of Object.values(node)) strip(value)
  }
  strip(clone)
  text = JSON.stringify(clone)
  if (text.length <= budget) return { text, truncated: true }
  return { text: `${text.slice(0, Math.max(0, budget - 1))}…`, truncated: true }
}

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
// ---------------------------------------------------------------------------

/** Module name every MCP server row uses. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
const ROUTE_SERVER_STATE = '/dsh-mcp-hub/state'
const ROUTE_SERVER_TOGGLE = '/dsh-mcp-hub/toggle'
const ROUTE_SERVER_RESTART = '/dsh-mcp-hub/restart'
const USER_PATCH_FILENAME = 'cordis.patch.yml'
const PATCH_BACKUP_SUFFIX = '.mcp-hub.bak'
const PATCH_TMP_SUFFIX = '.mcp-hub.tmp'
const SERVER_WAIT_MS = 30000
const SERVER_POLL_MS = 300

/** Sleep helper for the bounded wait below. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Escape one literal for use inside a RegExp. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether one YAML patch text declares an entry with the given id (any depth). */
function patchDeclares(patchText, id) {
  if (typeof patchText !== 'string' || patchText === '') return false
  const target = escapeRegExp(id)
  const pattern = new RegExp(`^\\s*-\\s+id:\\s*(?:'${target}'|"${target}"|${target})\\s*(?:#.*)?$`, 'm')
  return pattern.test(patchText)
}

/** Render a YAML scalar (ids in this deployment are plain, quoted fallback is safe). */
function yamlScalar(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(String(value)) ? String(value) : JSON.stringify(String(value))
}

/** Indent used by one top-level patch entry (defaults to two spaces). */
function patchItemIndent(lines, start, end) {
  for (let index = start + 1; index < end; index++) {
    const match = /^(\s+)(?:[A-Za-z_$][\w$.-]*|'[^']+'|"[^"]+")\s*:/.exec(lines[index])
    if (match !== null) return match[1].length
  }
  return 2
}

/**
 * Set one top-level patch entry's `disabled` value, appending the entry when it
 * does not exist yet. Pure string operation: the caller reads, backs up, writes.
 */
function setPatchDisabled(patchText, id, disabled) {
  const newline = String(patchText).includes('\r\n') ? '\r\n' : '\n'
  const lines = String(patchText).split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const starts = []
  for (let index = 0; index < lines.length; index++) {
    if (/^-\s/.test(lines[index])) starts.push(index)
  }
  let blockStart = -1
  for (const start of starts) {
    const match = /^-\s+id:\s*(['"]?)([^'"\s#]+)\1\s*(?:#.*)?$/.exec(lines[start])
    if (match !== null && match[2] === id) blockStart = start
  }
  const value = disabled ? 'true' : 'false'
  if (blockStart >= 0) {
    const end = starts.find((start) => start > blockStart) ?? lines.length
    const indent = ' '.repeat(patchItemIndent(lines, blockStart, end))
    let replaced = false
    for (let index = blockStart + 1; index < end; index++) {
      const match = /^(\s+)disabled:\s*/.exec(lines[index])
      if (match !== null && match[1].length === indent.length) {
        lines[index] = `${indent}disabled: ${value}`
        replaced = true
        break
      }
    }
    if (!replaced) lines.splice(blockStart + 1, 0, `${indent}disabled: ${value}`)
  } else {
    lines.push(`- id: ${yamlScalar(id)}`, `  disabled: ${value}`)
  }
  return lines.join(newline) + newline
}

/** Read a UTF-8 file, or null when it does not exist / cannot be read. */
function readPatchFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/** Keep the pre-write text next to the patch so a broken edit is recoverable. */
function backupPatchFile(filePath, text) {
  try {
    fs.writeFileSync(filePath + PATCH_BACKUP_SUFFIX, text, 'utf8')
  } catch {
    // A backup is best-effort; never block the requested toggle on it.
  }
}

/** Replace a file atomically, falling back to an in-place write on Windows locks. */
function writePatchFile(filePath, text) {
  const temporary = filePath + PATCH_TMP_SUFFIX
  fs.writeFileSync(temporary, text, 'utf8')
  try {
    fs.renameSync(temporary, filePath)
  } catch {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The temporary file stays next to the patch; harmless and easy to remove.
    }
    fs.writeFileSync(filePath, text, 'utf8')
  }
}

/** Apply one `disabled` override to the given patch file. */
function applyPatchOverride(filePath, patchText, id, disabled) {
  const next = setPatchDisabled(patchText, id, disabled)
  if (next === patchText) return false
  backupPatchFile(filePath, patchText)
  writePatchFile(filePath, next)
  return true
}

/** Last path segment of a command/arg, for a compact display string. */
function baseName(value) {
  const text = String(value ?? '')
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

/** Compact, non-secret description of where one MCP server points. */
function targetSummary(config, transport) {
  if (transport === 'stdio') {
    const command = typeof config?.command === 'string' ? baseName(config.command) : ''
    const args = Array.isArray(config?.args)
      ? config.args.filter((item) => typeof item === 'string').slice(0, 2).map((item) => baseName(item))
      : []
    return [command, ...args].filter(Boolean).join(' ')
  }
  if (typeof config?.url === 'string') {
    try {
      return new URL(config.url).host
    } catch {
      return config.url
    }
  }
  return ''
}

/** One of stopped / running / idle / starting / error / unknown. */
function serverStatus(server) {
  if (!server.enabled) return 'stopped'
  if (server.fiberPhase === 'failed') return 'error'
  if (server.fiberPhase === 'pending' || server.fiberPhase === 'loading' || server.fiberPhase === 'unloading') return 'starting'
  if (server.fiberPhase === 'active') return server.toolCount > 0 ? 'running' : 'idle'
  return 'unknown'
}

/** Profile-relative patch files for the current composition (desktop profiles only). */
function patchPathsOf(ctx) {
  const profile = ctx.profileContext
  if (profile === null || typeof profile !== 'object') return { home: null, profile: null }
  const home = typeof profile.home === 'string' && profile.home !== '' ? path.join(profile.home, USER_PATCH_FILENAME) : null
  const profilePatch = typeof profile.patchPath === 'string' && profile.patchPath !== '' ? profile.patchPath : null
  return { home, profile: profilePatch }
}

/** All configured MCP server rows, with their effective runtime state. */
async function collectServerRows(ctx) {
  const plugins = await ctx.pluginManager.listPlugins()
  const entries = new Map()
  try {
    for (const entry of ctx.loader.entries()) entries.set(entry.id, entry)
  } catch {
    // Row lookup is optional; configuration below degrades to row ids.
  }
  const schemas = ctx.tools.schemas()
  const servers = []
  for (const row of Array.isArray(plugins) ? plugins : []) {
    if (typeof row?.moduleName !== 'string' || !row.moduleName.startsWith(MCP_CLIENT_MODULE)) continue
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
    })
  }
  servers.sort((left, right) => left.serverName.localeCompare(right.serverName))
  return servers
}

/** Push one public view of a server row to the browser/tools. */
function presentServer(server) {
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport,
    target: server.target,
    enabled: server.enabled,
    fiberPhase: server.fiberPhase,
    toolCount: server.toolCount,
    status: serverStatus(server),
  }
}

/** Find one server by display name, row id or entry id. */
function findServer(servers, name) {
  const wanted = String(name ?? '').trim()
  if (wanted === '') return undefined
  return servers.find((server) =>
    server.serverName === wanted || server.id === wanted || server.entryId === wanted ||
    server.serverName.toLowerCase() === wanted.toLowerCase() || server.id.toLowerCase() === wanted.toLowerCase(),
  )
}

/** Decide how one server row can be toggled in this composition. */
function resolveToggleTarget(ctx, server) {
  const { home, profile } = patchPathsOf(ctx)
  if (home !== null) {
    const homeText = readPatchFile(home)
    if (homeText !== null && patchDeclares(homeText, server.id)) return { kind: 'patch', file: home, text: homeText, layer: 'home' }
  }
  if (server.readOnlyReason === null || server.readOnlyReason === undefined) return { kind: 'manager' }
  if (profile !== null) {
    const profileText = readPatchFile(profile)
    if (profileText !== null && patchDeclares(profileText, server.id)) return { kind: 'patch', file: profile, text: profileText, layer: 'profile' }
  }
  throw new Error(`server "${server.serverName}" is locked by this Harness (${server.readOnlyReason})`)
}

/** Poll the plugin manager until the target row reaches the requested phase. */
async function waitForServerPhase(ctx, entryId, enabled) {
  const deadline = Date.now() + SERVER_WAIT_MS
  let last = null
  while (Date.now() < deadline) {
    try {
      const rows = await ctx.pluginManager.listPlugins()
      const row = rows.find((candidate) => candidate?.entryId === entryId)
      if (row !== undefined) {
        last = row
        if (!enabled && row.enabled === false) return { ok: true, row }
        if (enabled && row.enabled === true && (row.fiberPhase === 'active' || row.fiberPhase === 'failed')) return { ok: true, row }
      }
    } catch {
      // HMR may be mid-recomposition; retry until the deadline.
    }
    await sleep(SERVER_POLL_MS)
  }
  return { ok: false, row: last }
}

/** Toggle one MCP server's loader row. Resolves after HMR reports the new phase. */
async function setServerEnabled(ctx, server, enabled) {
  const target = resolveToggleTarget(ctx, server)
  if (target.kind === 'manager') {
    const result = await ctx.pluginManager.setPluginEnabled(server.entryId, enabled)
    const application = result?.application
    if (application === 'applied') {
      const waited = await waitForServerPhase(ctx, server.entryId, enabled)
      if (!waited.ok) throw new Error(`timed out waiting for "${server.serverName}" to ${enabled ? 'start' : 'stop'}`)
      return { via: 'plugin-manager', row: waited.row }
    }
    // A row the manager could not address may still accept a profile-patch override.
    const { profile } = patchPathsOf(ctx)
    const profileText = profile === null ? null : readPatchFile(profile)
    if (profileText === null) {
      throw new Error(`plugin manager could not ${enabled ? 'enable' : 'disable'} "${server.serverName}" (${application ?? 'unknown'})`)
    }
    applyPatchOverride(profile, profileText, server.id, !enabled)
    const waited = await waitForServerPhase(ctx, server.entryId, enabled)
    if (!waited.ok) throw new Error(`timed out waiting for "${server.serverName}" to ${enabled ? 'start' : 'stop'}`)
    return { via: 'profile-patch', row: waited.row }
  }
  applyPatchOverride(target.file, target.text, server.id, !enabled)
  const waited = await waitForServerPhase(ctx, server.entryId, enabled)
  if (!waited.ok) throw new Error(`timed out waiting for "${server.serverName}" to ${enabled ? 'start' : 'stop'}`)
  return { via: `${target.layer}-patch`, row: waited.row }
}

/** Serialized mutations: two toggles from the UI or the model never interleave. */
function createControlQueue() {
  let chain = Promise.resolve()
  return (task) => {
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Render one state snapshot as the compact tool answer. */
function renderServerList(servers) {
  if (servers.length === 0) {
    return 'No MCP servers are configured. Add @deepseek-ai/dsh-mcp-client rows to the profile patch first.'
  }
  const lines = [`MCP servers (${servers.length}):`]
  for (const server of servers) {
    const status = serverStatus(server)
    const detail = [server.transport, server.target].filter(Boolean).join(' ')
    const tools = server.toolCount > 0 ? `, ${server.toolCount} tools` : ''
    lines.push(`- ${server.serverName} (row ${server.id}): ${status}${tools}${detail ? ` — ${detail}` : ''}`)
  }
  lines.push('Start, stop or restart one with mcp_server { server, action: "start" | "stop" | "restart" }.')
  return lines.join('\n')
}

/** Read a JSON request body, bounded. */
function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${messageOf(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Send one JSON response with no-store caching. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Register the management tools and the Plugins-page HTTP routes. */
function registerServerManagement(ctx) {
  const runExclusive = createControlQueue()
  ctx.logger?.info?.('mcp-progressive: MCP server management ready (tools + Plugins tab routes)')

  const describe = async () => {
    const servers = await collectServerRows(ctx)
    return { ok: true, now: Date.now(), servers: servers.map(presentServer) }
  }

  const stateHandler = async (req, res) => {
    try {
      sendJson(res, 200, await describe())
    } catch (error) {
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  const toggleHandler = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' })
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: messageOf(error) })
    }
    const name = typeof body?.server === 'string' ? body.server : ''
    const enabled = body?.enabled === true
    try {
      const servers = await collectServerRows(ctx)
      const server = findServer(servers, name)
      if (server === undefined) return sendJson(res, 404, { ok: false, error: `unknown MCP server "${name}"` })
      await runExclusive(async () => {
        if (server.enabled !== enabled) await setServerEnabled(ctx, server, enabled)
      })
      sendJson(res, 200, await describe())
    } catch (error) {
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  const restartHandler = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' })
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: messageOf(error) })
    }
    const name = typeof body?.server === 'string' ? body.server : ''
    try {
      const servers = await collectServerRows(ctx)
      const server = findServer(servers, name)
      if (server === undefined) return sendJson(res, 404, { ok: false, error: `unknown MCP server "${name}"` })
      await runExclusive(async () => {
        if (server.enabled) await setServerEnabled(ctx, server, false)
        await setServerEnabled(ctx, server, true)
      })
      sendJson(res, 200, await describe())
    } catch (error) {
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'mcp_servers',
    description:
      'List every configured MCP server with its runtime status (running / stopped / starting / error), row id, transport and tool count. ' +
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
      'Call mcp_servers first to see exact names and status.',
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
      const name = typeof args?.server === 'string' ? args.server : ''
      const action = args?.action === 'stop' ? 'stop' : args?.action === 'restart' ? 'restart' : args?.action === 'start' ? 'start' : ''
      if (name === '' || action === '') return 'Error: mcp_server requires { server, action: "start" | "stop" | "restart" }.'
      try {
        const servers = await collectServerRows(ctx)
        const server = findServer(servers, name)
        if (server === undefined) return `Error: unknown MCP server "${name}". Call mcp_servers to list configured servers.`
        await runExclusive(async () => {
          if (action === 'stop') await setServerEnabled(ctx, server, false)
          else if (action === 'start') await setServerEnabled(ctx, server, true)
          else {
            if (server.enabled) await setServerEnabled(ctx, server, false)
            await setServerEnabled(ctx, server, true)
          }
        })
        const after = await collectServerRows(ctx)
        const current = findServer(after, name)
        return `${action} finished${current ? `: ${current.serverName} is now ${serverStatus(current)}` : ''}.\n${renderServerList(after)}`
      } catch (error) {
        return `Error: ${messageOf(error)}`
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_SERVER_STATE, handler: stateHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_SERVER_TOGGLE, handler: toggleHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_SERVER_RESTART, handler: restartHandler }))
}

/**
 * The Host plugin body.
 * @param ctx - plugin context carrying the tool registry and prompt assembly.
 * @param rawConfig - optional row configuration merged over CONFIG_DEFAULTS.
 */
export function apply(ctx, rawConfig) {
  const config = { ...CONFIG_DEFAULTS, ...(rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}) }
  const prefix = typeof config.prefix === 'string' && config.prefix.length > 0 ? config.prefix : CONFIG_DEFAULTS.prefix
  const summaryChars = Number.isFinite(config.summaryChars)
    ? Math.min(600, Math.max(24, Math.trunc(config.summaryChars)))
    : CONFIG_DEFAULTS.summaryChars
  const defaultLimit = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, Number.isFinite(config.searchLimit) ? Math.trunc(config.searchLimit) : CONFIG_DEFAULTS.searchLimit),
  )
  const allowVisible = compileAllowlist(Array.isArray(config.alwaysVisible) ? config.alwaysVisible : [])
  const eagerTools = new Set(Array.isArray(config.eagerTools) ? config.eagerTools.filter((item) => typeof item === 'string') : [])
  const enableLoad = config.enableLoad !== false
  const enableCall = config.enableCall !== false
  const manageServers = config.manageServers !== false

  /** Loaded tool names per live agent id; absent = only the eager baseline. */
  const loadedByAgent = new Map()
  /** Assembled request payloads produced by mcp_call, keyed by its outer execution. */
  const pendingContent = new WeakMap()
  /** Monotonic correlator for nested dispatches. */
  let nestedSeq = 0

  const agentKey = (agent) => (agent === undefined || agent === null ? undefined : agent.id)

  /** Names loaded for one agent (falls back to the configuration baseline). */
  const loadedSet = (agent) => {
    const key = agentKey(agent)
    if (key === undefined) return eagerTools
    let set = loadedByAgent.get(key)
    if (set === undefined) {
      set = new Set(eagerTools)
      loadedByAgent.set(key, set)
    }
    return set
  }

  /** Whether a name belongs to the hidden MCP catalog at all. */
  const isCatalogName = (toolName) =>
    typeof toolName === 'string' && toolName.startsWith(prefix) && !META_TOOLS.has(toolName)

  /** Whether one schema must stay out of the assembled prompt for this agent. */
  const isHidden = (toolName, agent) =>
    isCatalogName(toolName) && !allowVisible(toolName) && !loadedSet(agent).has(toolName)

  /** Split `mcp__<server>__<tool>` into its parts. */
  const parseName = (toolName) => {
    const rest = toolName.slice(prefix.length)
    const separator = rest.indexOf('__')
    if (separator <= 0) return { server: rest, tool: '' }
    return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) }
  }

  /**
   * The MCP catalog as the unrestricted global registry sees it. It must not be
   * read through the agent scope: the disclosure restriction installed for that
   * agent removes exactly these names from the scoped view.
   */
  const catalogOf = () =>
    ctx.tools
      .schemas()
      .filter((schema) => isCatalogName(schema.name))
      .map((schema) => {
        const { server, tool } = parseName(schema.name)
        return {
          name: schema.name,
          server,
          tool,
          description: schema.description ?? '',
          parameters: schema.parameters,
          signature: signatureOf(schema.parameters),
        }
      })

  /** Score one catalog entry against lowercased query tokens. */
  const scoreEntry = (entry, tokens, query) => {
    if (tokens.length === 0) return 0
    const name = entry.name.toLowerCase()
    const short = entry.tool.toLowerCase()
    const description = String(entry.description).toLowerCase()
    let score = 0
    if (query.length > 0 && name === query) score += 1000
    if (query.length > 0 && short === query) score += 900
    for (const token of tokens) {
      let hit = 0
      if (short === token) hit = 60
      else if (short.startsWith(token)) hit = 40
      else if (short.includes(token)) hit = 30
      else if (name.includes(token)) hit = 20
      else if (entry.server.toLowerCase().includes(token)) hit = 12
      else if (description.includes(token)) hit = 8
      if (hit === 0) return 0
      score += hit
    }
    return score
  }

  /** Rank the catalog for one query. */
  const searchCatalog = (query, server, limit) => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const entries = catalogOf().filter((entry) => server === undefined || entry.server === server)
    const ranked = []
    for (const entry of entries) {
      const score = scoreEntry(entry, tokens, query.toLowerCase())
      if (tokens.length > 0 && score === 0) continue
      ranked.push({ entry, score })
    }
    ranked.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    return {
      entries: ranked.slice(0, limit).map((item) => item.entry),
      matched: ranked.length,
      servers: summarizeServers(entries),
      available: entries.length,
    }
  }

  /** Server names with tool counts, stable order. */
  const summarizeServers = (entries) => {
    const counts = new Map()
    for (const entry of entries) counts.set(entry.server, (counts.get(entry.server) ?? 0) + 1)
    return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))
  }

  /** Render one search result as compact text. */
  const renderSearch = (result, { query, detail, agent }) => {
    const lines = []
    if (result.servers.length === 0) {
      return (
        'No MCP tools are registered right now. Check that the MCP server rows are connected and enabled; ' +
        'when a server reconnects its tools become searchable again.'
      )
    }
    lines.push(`MCP servers: ${result.servers.map(([server, count]) => `${server} (${count} tools)`).join(', ')}`)
    const hiddenCount = deniedNames(agent).length
    if (hiddenCount > 0) lines.push(`Hidden until loaded: ${hiddenCount} of ${result.available} tools (not in your tool set).`)
    const emptyQuery = query.trim() === ''
    if (result.entries.length === 0) {
      lines.push(`No tool matched "${query}".`)
    } else if (emptyQuery) {
      lines.push(`Showing ${result.entries.length} of ${result.available} tools (pass query words or server to narrow):`)
    } else {
      lines.push(`Matches ${result.matched} of ${result.available}:`)
    }
    if (result.entries.length > 0) {
      for (const entry of result.entries) {
        const signature = entry.signature ? `(${entry.signature})` : '()'
        const summary = oneLine(entry.description, summaryChars)
        const marker = loadedSet(agent).has(entry.name) ? ' [loaded]' : ''
        lines.push(`- ${entry.name}${signature}${marker}${summary ? ` — ${summary}` : ''}`)
      }
      if (!emptyQuery && result.matched > result.entries.length) {
        lines.push(`(${result.matched - result.entries.length} more not shown; narrow the query or raise limit up to ${MAX_SEARCH_LIMIT}.)`)
      }
      if (detail === 'full') {
        const detailed = result.entries.slice(0, MAX_DETAIL_TOOLS)
        for (const entry of detailed) {
          const fitted = fitSchema(entry.parameters, MAX_DETAIL_CHARS)
          lines.push(`schema for ${entry.name}${fitted.truncated ? ' (annotations trimmed to fit)' : ''}:`)
          lines.push(fitted.text)
        }
        if (result.entries.length > detailed.length) {
          lines.push(`(full schemas shown for the first ${MAX_DETAIL_TOOLS} matches only.)`)
        }
      } else if (emptyQuery) {
        lines.push(
          `${enableLoad ? 'mcp_load makes tools native; ' : ''}mcp_call runs one directly without loading.`,
        )
      } else {
        lines.push(
          `detail:"full" shows input schemas. ${enableLoad ? 'mcp_load adds tools as native tools; ' : ''}mcp_call runs one without loading.`,
        )
      }
    }
    return lines.join('\n')
  }

  // ---------------------------------------------------------------------------
  // Disclosure: keep unloaded catalog schemas out of each agent's tool view.
  //
  // dsh >= 0.2.2 assembles tool declarations from `systemPrompt.tools()`
  // providers *before* the `system-prompt/assemble` waterfall and re-attaches
  // them afterwards, so that hook cannot remove a schema. The supported seam is
  // the registry view itself:
  //
  // 1. one scope restriction per agent (`agent.ctx.tools.restrict({ deny })`)
  //    removes every catalog tool that is not permanently visible from
  //    `schemas(agent)` — the exact list the prompt provider reads — and from
  //    `get`/`executable`;
  // 2. a loaded tool comes back as a scope-local registration in the same agent
  //    scope, which restrictions leave visible. Loaded tools are native again
  //    without re-deriving (and re-committing) the restriction list;
  // 3. `mcp_call` shadows exactly its one target definition for the nested
  //    dispatch, so no window exposes the rest of the catalog.
  //
  // The deny list only changes when the catalog changes (a server connects or
  // disconnects), which keeps the prompt's tool array stable per session.
  // ---------------------------------------------------------------------------
  /** Per-agent disclosure state: the restriction and the scope-local shadows. */
  const disclosures = new Map()
  /** `restrict()`/`register()` emit `tools/change`; do not re-enter it. */
  let mutating = false
  /** A reconcile asked for while `mutating`; replayed after the mutation. */
  let reconcilePending = false
  /** Warn at most once per kind instead of once per agent. */
  const warned = new Set()
  const warnOnce = (kind, text) => {
    if (warned.has(kind)) return
    warned.add(kind)
    ctx.logger?.warn?.(text)
  }

  /** Catalog definitions from the unrestricted global view. */
  const catalogDefinitions = () => {
    try {
      return ctx.tools.definitions().filter((definition) => isCatalogName(definition?.name))
    } catch {
      return []
    }
  }

  /** Catalog names only. */
  const catalogNames = () => catalogDefinitions().map((definition) => definition.name)

  /** Names this agent must not see: catalog tools neither loaded nor allowed. */
  const deniedNames = (agent) => catalogNames().filter((toolName) => isHidden(toolName, agent))

  /** The agent's own Cordis scope, which may install a tool restriction. */
  const scopeFor = (agent) => {
    const scope = agent?.ctx
    return scope && typeof scope === 'object' && typeof scope.tools?.restrict === 'function' ? scope : undefined
  }

  /** Read (or create) one agent's disclosure state. */
  const stateOf = (key) => {
    let state = disclosures.get(key)
    if (state === undefined) {
      state = { restriction: undefined, deniedKey: undefined, shadows: new Map(), temps: new Set() }
      disclosures.set(key, state)
    }
    return state
  }

  /** Drop every disclosure effect owned for one agent. */
  const dropDisclosure = (key) => {
    const state = disclosures.get(key)
    if (state === undefined) return
    disclosures.delete(key)
    try {
      state.restriction?.()
    } catch {
      // The scope is already gone; nothing is left to lift.
    }
    for (const shadow of state.shadows.values()) {
      try {
        shadow.dispose()
      } catch {
        // Same: the owning scope is being torn down.
      }
    }
    state.shadows.clear()
    state.temps.clear()
  }

  /** Bring one agent's restriction and shadow set in line with the registry. */
  const reconcile = (agent) => {
    const key = agentKey(agent)
    if (key === undefined) return
    if (mutating) {
      reconcilePending = true
      return
    }
    const scope = scopeFor(agent)
    if (scope === undefined) {
      warnOnce('scope', 'mcp-progressive: agent scope unavailable; MCP tool schemas are not hidden for that agent')
      return
    }
    mutating = true
    reconcilePending = false
    try {
      const state = stateOf(key)
      const catalog = catalogDefinitions()
      const definitions = new Map(catalog.map((definition) => [definition.name, definition]))
      const loaded = loadedSet(agent)
      // Refresh loaded shadows; a reconnected server replaces its definition.
      for (const [name, shadow] of [...state.shadows]) {
        const current = definitions.get(name)
        if (loaded.has(name) && current !== undefined && current === shadow.definition) continue
        state.shadows.delete(name)
        try {
          shadow.dispose()
        } catch {
          // Scope already gone.
        }
      }
      for (const name of loaded) {
        // A permanently visible tool needs no shadow: the restriction never hides it.
        if (allowVisible(name)) continue
        const definition = definitions.get(name)
        if (definition === undefined || state.shadows.has(name)) continue
        try {
          state.shadows.set(name, { dispose: scope.tools.register(definition), definition })
        } catch (error) {
          warnOnce('shadow', `mcp-progressive: could not load one MCP tool into the agent scope: ${messageOf(error)}`)
        }
      }
      // The restriction only has to deny what configuration never shows.
      const deny = catalog
        .reduce((names, definition) => {
          if (!allowVisible(definition.name)) names.push(definition.name)
          return names
        }, [])
        .sort()
      const deniedKey = deny.join('\u0000')
      if (state.restriction === undefined || state.deniedKey !== deniedKey) {
        // Install first, dispose last: restrictions intersect, so the overlap is
        // still fully masked, and a rejected `restrict()` leaves the old mask on.
        const installed = deny.length === 0 ? undefined : scope.tools.restrict({ deny })
        const previous = state.restriction
        state.restriction = installed
        state.deniedKey = deny.length === 0 ? undefined : deniedKey
        try {
          previous?.()
        } catch {
          // A stale disposer cannot keep the new restriction from applying.
        }
      }
      // The scoped view is exactly what the prompt provider reads. Loaded tools
      // (shadows) and the one transient `mcp_call` shadow are the only catalog
      // names that may appear there.
      const visible = ctx.tools.definitions(agent).reduce((names, definition) => {
        if (isCatalogName(definition?.name)) names.push(definition.name)
        return names
      }, [])
      const leaked = visible.filter((name) => !state.shadows.has(name) && !state.temps.has(name) && !allowVisible(name))
      if (leaked.length > 0) {
        ctx.logger?.warn?.(`mcp-progressive: ${leaked.length} MCP schema(s) stay visible for one agent: ${leaked.slice(0, 3).join(', ')}`)
      }
    } catch (error) {
      // Never let disclosure bookkeeping break agent creation or a tools/change
      // notification; the next reconcile retries.
      ctx.logger?.warn?.(`mcp-progressive: disclosure reconcile failed: ${messageOf(error)}`)
    } finally {
      mutating = false
      if (reconcilePending) {
        reconcilePending = false
        queueMicrotask(() => reconcile(agent))
      }
    }
  }

  const liveAgents = () => {
    try {
      return ctx.get('agents')?.list?.() ?? []
    } catch {
      return []
    }
  }

  const reconcileAll = () => {
    for (const agent of liveAgents()) reconcile(agent)
  }

  /**
   * Coalesce registry notifications: a connecting MCP server registers one tool
   * at a time, and each registration would otherwise drop/reinstall every
   * agent's mask. One microtask later all of them are handled once.
   */
  let reconcileScheduled = false
  const scheduleReconcileAll = () => {
    if (reconcileScheduled) return
    reconcileScheduled = true
    queueMicrotask(() => {
      reconcileScheduled = false
      reconcileAll()
    })
  }

  ctx.on('agent/created', ({ agent }) => {
    reconcile(agent)
    return undefined
  })
  ctx.on('tools/change', scheduleReconcileAll)
  // Safety net for a step of an agent this instance has not reconciled yet
  // (plugin loaded mid-Session, or an agent whose creation raced activation).
  // The provider has already collected this assembly's schemas, so this covers
  // the next step; nothing here may fail a model request.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    try {
      const key = agentKey(context?.scope)
      if (key !== undefined && !disclosures.has(key)) reconcile(context.scope)
    } catch {
      // Disclosure bookkeeping must never break prompt assembly.
    }
    return next()
  })
  ctx.effect(
    () => () => {
      for (const key of [...disclosures.keys()]) dropDisclosure(key)
    },
    'mcp-progressive: disclosure restrictions',
  )
  // Agents that already existed when this plugin activated (HMR, resume).
  reconcileAll()

  // ---------------------------------------------------------------------------
  // Corrective answer for hallucinated MCP tool names.
  // ---------------------------------------------------------------------------
  if (config.correctiveUnknownTool !== false) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (typeof exec?.name !== 'string' || !isCatalogName(exec.name)) return await next()
        if (ctx.tools.get(exec.name, exec.agent) !== undefined) return await next()
        return {
          kind: 'deny',
          reason:
            `MCP tool "${exec.name}" is not registered on this Harness (MCP tools are discovered at runtime). ` +
            'Call mcp_search to find the right tool, then mcp_load or mcp_call.',
        }
      } catch {
        return await next()
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Per-agent state cleanup.
  // ---------------------------------------------------------------------------
  ctx.on('agent/disposed', (payload) => {
    try {
      const key = agentKey(payload?.agent)
      if (key === undefined) return
      loadedByAgent.delete(key)
      dropDisclosure(key)
    } catch {
      // Cleanup is best-effort; a malformed payload must not disturb disposal.
    }
  })

  // ---------------------------------------------------------------------------
  // Meta tools.
  // ---------------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'mcp_search',
      description:
        'Search the MCP tool catalog. MCP tools are not listed in your tool set to save context, so search before using one. ' +
        'Returns each match\'s full tool name, a one-line summary, and its parameter signature; detail:"full" adds the input schema. ' +
        'Then call mcp_load to make matches native tools, or mcp_call to run one directly.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Words to match against tool names and descriptions. Empty lists the connected servers and their tool counts.',
          },
          server: { type: 'string', description: 'Only search tools from this MCP server name.' },
          limit: { type: 'integer', description: `Maximum matches to return (1-${MAX_SEARCH_LIMIT}); defaults to the configured page size.` },
          detail: {
            type: 'string',
            enum: ['brief', 'full'],
            description: 'brief (default) prints summaries and signatures; full also prints the input schema of up to two matches.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const query = typeof args?.query === 'string' ? args.query.trim() : ''
          const server = typeof args?.server === 'string' && args.server.trim() !== '' ? args.server.trim() : undefined
          const requested = Number.isFinite(args?.limit) ? Math.trunc(args.limit) : defaultLimit
          const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, requested))
          const detail = args?.detail === 'full' ? 'full' : 'brief'
          const result = searchCatalog(query, server, limit)
          return renderSearch(result, { query, detail, agent: exec.agent })
        } catch (error) {
          return `Error: mcp_search failed internally: ${messageOf(error)}`
        }
      },
    }),
  )

  if (enableLoad) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'mcp_load',
        description:
          'Load MCP tools into this conversation so they become native tools (available from your next step), or unload them again. ' +
          'Use after mcp_search when you plan to call a tool more than once; for a single call prefer mcp_call. ' +
          'Call with no tools to list what is currently loaded.',
        parameters: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exact MCP tool names from mcp_search results (for example mcp__server__tool).',
            },
            unload: { type: 'boolean', description: 'true removes the named tools instead of loading them.' },
          },
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const agent = exec.agent
          const loaded = loadedSet(agent)
          const names = Array.isArray(args?.tools) ? args.tools.filter((item) => typeof item === 'string') : []
          const unload = args?.unload === true

          if (names.length === 0) {
            const current = [...loaded].filter((toolName) => isCatalogName(toolName))
            if (current.length === 0) {
              return 'No MCP tools are loaded for this conversation. Use mcp_search to find tools, then pass their names here.'
            }
            return `Currently loaded (${current.length}): ${current.join(', ')}`
          }

          const known = new Set(catalogOf().map((entry) => entry.name))
          const accepted = []
          const rejected = []
          for (const toolName of names) {
            if (!isCatalogName(toolName)) {
              rejected.push(`${toolName} (not an MCP tool)`)
              continue
            }
            if (!known.has(toolName)) {
              rejected.push(`${toolName} (not in the current MCP catalog)`)
              continue
            }
            if (unload) {
              if (loaded.delete(toolName)) accepted.push(toolName)
              else rejected.push(`${toolName} (was not loaded)`)
            } else if (loaded.has(toolName)) {
              rejected.push(`${toolName} (already loaded)`)
            } else {
              loaded.add(toolName)
              accepted.push(toolName)
            }
          }

          // Re-derive this agent's restriction now, so the change is in force for
          // the next prompt assembly instead of one step later.
          if (accepted.length > 0) reconcile(agent)

          const lines = []
          if (accepted.length > 0) {
            lines.push(
              unload
                ? `Unloaded ${accepted.length} tool(s): ${accepted.join(', ')}. They leave your tool set from the next step.`
                : `Loaded ${accepted.length} tool(s): ${accepted.join(', ')}. They are native tools from your next step; call them directly.`,
            )
          }
          if (rejected.length > 0) lines.push(`Skipped: ${rejected.join('; ')}`)
          if (accepted.length === 0 && rejected.length > 0) {
            lines.push('Use mcp_search to confirm exact tool names.')
          }
          return lines.join('\n')
        },
      }),
    )
  }

  if (enableCall) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'mcp_call',
        description:
          'Run one MCP tool directly without loading it, through the normal permission, timeout and result pipeline. ' +
          'Prefer this for one-off calls; use mcp_load when you will call the same tool repeatedly. ' +
          'The tool must appear in mcp_search results.',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Exact MCP tool name from mcp_search results (for example mcp__server__tool).' },
            arguments: {
              type: 'object',
              additionalProperties: true,
              description: 'JSON arguments for the MCP tool, matching the schema that mcp_search detail:"full" prints.',
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const toolName = typeof args?.tool === 'string' ? args.tool.trim() : ''
          if (toolName === '') return 'Error: mcp_call requires the exact "tool" name; use mcp_search to find it.'
          if (!isCatalogName(toolName)) {
            return `Error: "${toolName}" is not an MCP tool. Use mcp_search to find the tool name.`
          }
          const definition = ctx.tools.get(toolName)
          if (definition === undefined) {
            return `Error: "${toolName}" is not in the current MCP catalog. Use mcp_search to find the right name.`
          }
          const callArguments =
            args?.arguments !== null && typeof args?.arguments === 'object' && !Array.isArray(args.arguments)
              ? args.arguments
              : {}
          nestedSeq += 1
          const callId = `${String(exec.callId)}:mcp-progressive:${nestedSeq}`
          // A scope-local registration is exempt from the disclosure restriction,
          // so shadowing exactly this one definition admits it for the nested
          // dispatch (and for nothing else) without lifting the mask.
          const scope = scopeFor(exec.agent)
          const state = disclosures.get(agentKey(exec.agent))
          const alreadyShadowed = state?.shadows.has(toolName) === true
          let shadow
          if (scope !== undefined && !alreadyShadowed) {
            try {
              shadow = scope.tools.register(definition)
              state?.temps.add(toolName)
            } catch (error) {
              warnOnce('call-shadow', `mcp-progressive: mcp_call could not shadow its target: ${messageOf(error)}`)
            }
          }
          let batch
          try {
            batch = await ctx.tools.execute({
              calls: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(callArguments) }],
              signal: exec.signal,
              agent: exec.agent,
            })
          } catch (error) {
            const message = messageOf(error)
            // The PTC preset only allows `run_code` at the top level; a nested raw
            // batch is rejected there, so say what works instead of failing raw.
            if (/run_code/.test(message)) {
              return (
                'Error: this agent runs in PTC mode, where mcp_call cannot dispatch a tool directly. ' +
                `Use mcp_load for ${toolName}, then call it inside run_code.`
              )
            }
            throw error
          } finally {
            try {
              shadow?.()
            } catch {
              // The calling scope is already gone.
            }
            state?.temps.delete(toolName)
          }
          const outcome = Array.isArray(batch?.results) ? batch.results[0]?.result : undefined
          if (outcome === undefined) {
            return `Error: MCP tool "${toolName}" produced no result.`
          }
          if (outcome.isError === true) {
            throw new Error(outcome.error?.message ?? `MCP tool "${toolName}" failed`)
          }
          // Deferred context belongs to the nested batch; forward it to the caller.
          if (Array.isArray(batch?.additionalContexts)) {
            for (const context of batch.additionalContexts) exec.deferContext(context)
          }
          if (batch?.concluded === true) exec.concludeTurn()
          const content = Array.isArray(outcome.content) ? outcome.content : []
          if (content.length > 0) pendingContent.set(exec, content)
          const text = content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
          if (text.trim() !== '') return text
          const imageCount = content.filter((block) => block?.type === 'image').length
          return imageCount > 0 ? `(${toolName} returned ${imageCount} image(s).)` : `(${toolName} completed with no output.)`
        },
        // Replace the text fallback with the exact blocks the MCP tool produced,
        // preserving images and their admission-owned attachment references.
        projectContent(exec, result) {
          const content = pendingContent.get(exec)
          if (content === undefined) return undefined
          pendingContent.delete(exec)
          if (result?.isError === true) return undefined
          return content
        },
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Optional management half: list / start / stop MCP server rows.
  // The dependency scope stays inactive (and costs nothing) on hosts that do
  // not provide the desktop profile services.
  // ---------------------------------------------------------------------------
  if (manageServers) {
    ctx.inject(['pluginManager', 'profileContext', 'webServer', 'loader'], (managementCtx) => {
      registerServerManagement(managementCtx)
    })
  }

  ctx.logger?.info?.(
    `mcp-progressive: hiding "${prefix}*" tool schemas with a per-agent scope restriction; meta-tools ${['mcp_search', enableLoad ? 'mcp_load' : '', enableCall ? 'mcp_call' : '']
      .filter(Boolean)
      .join(', ')}${manageServers ? '; MCP server management enabled' : ''}`,
  )
}

/** Pure helpers exported for the local test harness (not a plugin API). */
export const __test = { setPatchDisabled, patchDeclares, serverStatus, targetSummary, yamlScalar }
