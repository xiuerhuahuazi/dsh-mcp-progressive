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
// ---------------------------------------------------------------------------

/** Module name every MCP server row uses. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
export const ROUTE_SERVER_STATE = '/dsh-mcp-hub/state'
export const ROUTE_SERVER_TOGGLE = '/dsh-mcp-hub/toggle'
export const ROUTE_SERVER_RESTART = '/dsh-mcp-hub/restart'
export const USER_PATCH_FILENAME = 'cordis.patch.yml'
export const SERVER_WAIT_MS = 30000
export const SERVER_POLL_MS = 300

/** Sleep helper for the bounded wait below. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Last path segment of a command/arg, for a compact display string. */
export function baseName(value) {
  const text = String(value ?? '')
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

/** Compact, non-secret description of where one MCP server points. */
export function targetSummary(config, transport) {
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
export function serverStatus(server) {
  if (!server.enabled) return 'stopped'
  if (server.fiberPhase === 'failed') return 'error'
  if (server.fiberPhase === 'pending' || server.fiberPhase === 'loading' || server.fiberPhase === 'unloading') return 'starting'
  if (server.fiberPhase === 'active') return server.toolCount > 0 ? 'running' : 'idle'
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

/** All configured MCP server rows, with their effective runtime state. */
export async function collectServerRows(ctx) {
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
export function presentServer(server) {
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
export function findServer(servers, name) {
  const wanted = String(name ?? '').trim()
  if (wanted === '') return undefined
  return servers.find((server) =>
    server.serverName === wanted || server.id === wanted || server.entryId === wanted ||
    server.serverName.toLowerCase() === wanted.toLowerCase() || server.id.toLowerCase() === wanted.toLowerCase(),
  )
}

/** Decide how one server row can be toggled in this composition. */
export function resolveToggleTarget(ctx, server) {
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
export async function waitForServerPhase(ctx, entryId, enabled) {
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
export async function setServerEnabled(ctx, server, enabled) {
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
export function createControlQueue() {
  let chain = Promise.resolve()
  return (task) => {
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Render one state snapshot as the compact tool answer. */
export function renderServerList(servers) {
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
export function readJsonBody(req, limit = 65536) {
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
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Register the management tools and the Plugins-page HTTP routes. */
export function registerServerManagement(ctx) {
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
