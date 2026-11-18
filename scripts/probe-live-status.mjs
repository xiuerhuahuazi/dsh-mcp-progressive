#!/usr/bin/env node
/**
 * Capability assertion for the Loader entry seam behind 1.3's live MCP status.
 *
 * Why this exists
 * ---------------
 * The plugin reads a running MCP client's connection status only through
 *
 *     entry.moduleNamespace.connectionStatusOf(entry.fiber)?.current()
 *
 * and it deliberately never imports `@deepseek-ai/dsh-mcp-client` itself: a
 * second module instance has its own empty status WeakMap, so the Loader entry
 * is the only honest channel. `Entry.moduleNamespace` is an undocumented shape
 * of the vendored Loader, and the whole read has a documented fallback to the
 * old inference (`fiberPhase` + `toolCount`). That fallback is right for an
 * older Harness, but it means a rename in a Harness upgrade would silently turn
 * a failed MCP connection back into a plausible "idle" row. This script is the
 * repository's loud guard for exactly that: it asserts the seam against a real
 * runtime (real Cordis `Context`, real Loader, the installed
 * `@deepseek-ai/dsh-mcp-client`) so an upgrade that moves the seam fails one
 * crisp assertion instead of degrading quietly.
 *
 * `scripts/live-boot.mjs` also covers the behaviour end to end (two real loader
 * rows in a booted DSH web app, asserted through `/dsh-mcp-hub/state`, with
 * `statusDetail`/`live` in the payload). This probe stays independent of the
 * HTTP stack so a panel/admission regression cannot hide a seam regression.
 *
 * What it asserts
 * ---------------
 *   A  `typeof entry.moduleNamespace.connectionStatusOf === 'function'` for
 *      every MCP row, and the plugin's own `liveStatusOf()` reads a status.
 *   B  A row whose command cannot spawn ends `failed` with `lastError` carrying
 *      ENOENT; `liveStatusView` / `serverStatus` / `presentServer` turn that
 *      into `error` with the spawn text in `statusDetail`.
 *   C  A row running a real minimal stdio MCP server ends `connected` with
 *      `toolCount >= 2`; the presented row is `running` with no detail.
 *   D  Reading the status subscribes to nothing: the plugin creates no
 *      `onChange` observer (instrumented before the read), and the client's
 *      own observer set is unchanged by `collectServerRows` (when readable).
 *
 * Hermetic: the host dir and the mini MCP server live in a `mkdtemp` home, the
 * runtime is imported read-only by absolute path (bare row names resolve
 * through a `node_modules` symlink inside the temp dir), `~/.dsh` is never
 * read or written, nothing is restarted, and the temp dir is removed.
 *
 * Usage: node scripts/probe-live-status.mjs [--json]
 * Exit: 0 only when every assertion passed; 0 with `SKIP: runtime unavailable`
 * (CI posture, same as the other scripts) when the DSH runtime is absent.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = process.env.DSH_RUNTIME ?? '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai'
const MCP = '@deepseek-ai/dsh-mcp-client'
const BROKEN_COMMAND = '/nonexistent/definitely-not-a-command'
const wantJson = process.argv.includes('--json')

/** Where each runtime package must be, or the probe reports a skip. */
const RUNTIME_PACKAGES = ['cordis', 'cordis-plugin-loader', 'dsh-mcp-client']
const runtimeFiles = RUNTIME_PACKAGES.map((name) => path.join(RUNTIME, name, 'lib', 'index.js'))

/**
 * The minimal MCP server the connected row runs. Stdio only, two tools, and
 * stdin closing (the client's teardown) ends it. It is deliberately a copy of
 * the one `scripts/live-boot.mjs` writes: both scripts stay standalone gates,
 * exactly like the duplicated platform fence in `scripts/repro-review.mjs`.
 */
const MINI_MCP_SERVER_SOURCE = `// Written by scripts/probe-live-status.mjs into a throw-away directory.
import readline from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return // a notification
  const id = message.id
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      reply(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'live-status-probe', version: '0.0.0' },
      })
      return
    case 'tools/list':
      reply(id, {
        tools: [
          { name: 'probe_ping', description: 'Answer pong.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'probe_echo', description: 'Echo the arguments.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        ],
      })
      return
    case 'tools/call':
      reply(id, { content: [{ type: 'text', text: 'pong' }], isError: false })
      return
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + String(message.method) } })
  }
})

// The client closes this pipe when it disposes the connection, so the fake
// server ends with its owner (and also when the whole probe is killed).
lines.on('close', () => process.exit(0))
`

/** `FiberState` is a const enum (erased at runtime); mirror the inventory's values. */
const PHASE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 5: 'unloading' }

/** Mirror of `dsh-host-plugin-inventory`'s row shape (the plugin's only input). */
function inventoryRow(entry) {
  return {
    entryId: entry.id,
    patchId: entry.id,
    moduleName: entry.options?.name,
    enabled: entry.disabled !== true,
    fiberPhase: PHASE[entry.fiber?.state] ?? null,
    toolCount: 0,
    readOnlyReason: null,
  }
}

/**
 * Poll `predicate` until it holds. The MCP client settles asynchronously: a
 * bad spawn burns its reconnect budget, a good server has to answer
 * `initialize`, so a fixed sleep would be either slow or flaky.
 */
async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
}

/** The status handle's observer set, when the runtime still exposes it. */
function listenerCount(handle) {
  return handle?.listeners instanceof Set ? handle.listeners.size : null
}

/** Report one `SKIP` when the DSH runtime is not installed. */
function runtimeMissing() {
  return runtimeFiles.filter((file) => !fs.existsSync(file))
}

async function main() {
  const missing = runtimeMissing()
  if (missing.length > 0) {
    if (wantJson) {
      console.log(JSON.stringify({ probe: 'live-status-seam', skipped: true, reason: 'runtime unavailable', missing }, null, 2))
    } else {
      console.log(`SKIP: runtime unavailable (DSH_RUNTIME=${RUNTIME})`)
      for (const file of missing) console.log(`  missing: ${file}`)
    }
    return 0
  }

  const checks = []
  const record = (name, ok, detail) => {
    checks.push({ name, ok: ok === true, detail })
    return ok === true
  }
  let temp = null
  let entries = []
  let cleanup = null
  try {
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-live-status-probe-'))
    const hostDir = path.join(temp, 'host')
    await fsp.mkdir(hostDir, { recursive: true })
    // Bare loader row names resolve from `ctx.baseUrl` by walking up for
    // `node_modules`; pointing that at the installed runtime keeps the row
    // name `@deepseek-ai/dsh-mcp-client` (the name the plugin filters on)
    // without copying or importing a second module instance.
    await fsp.symlink(path.dirname(RUNTIME), path.join(temp, 'node_modules'), 'dir')
    const miniServer = path.join(temp, 'mini-mcp-server.mjs')
    await fsp.writeFile(miniServer, MINI_MCP_SERVER_SOURCE, 'utf8')

    const { Context } = await import(pathToFileURL(runtimeFiles[0]).href)
    const loaded = await import(pathToFileURL(runtimeFiles[1]).href)
    const Loader = loaded.default ?? loaded
    const { collectServerRows, liveStatusOf, liveStatusView, presentServer, serverStatus } = await import(
      pathToFileURL(path.join(REPO_ROOT, 'lib', 'management.js')).href
    )

    // The real Cordis context: only `tools` is simulated (a minimal registry
    // the client can register tool definitions into). Everything else — the
    // Loader, its import machinery, the MCP client — is the installed runtime.
    const definitions = new Map()
    const fakeTools = {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
      schemas() {
        return [...definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
      },
      definitions() {
        return [...definitions.values()]
      },
    }

    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(hostDir).href}/`
    ctx.provide('tools', fakeTools)
    const loaderHandle = ctx.plugin(Loader)
    await loaderHandle

    await ctx.loader.create({
      id: 'probe-broken-mcp',
      name: MCP,
      config: {
        serverName: 'probe-broken',
        transport: 'stdio',
        command: BROKEN_COMMAND,
        args: [],
        reconnect: { enabled: true, initialDelayMs: 25, maxDelayMs: 50, maxAttempts: 2 },
        startupTimeoutMs: 2000,
      },
    })
    await ctx.loader.create({
      id: 'probe-real-mcp',
      name: MCP,
      config: {
        serverName: 'probe-real',
        transport: 'stdio',
        command: process.execPath,
        args: [miniServer],
        reconnect: { enabled: true, initialDelayMs: 25, maxDelayMs: 50, maxAttempts: 2 },
        startupTimeoutMs: 10_000,
      },
    })

    entries = [...ctx.loader.entries()].filter((entry) => entry.options?.name === MCP)
    const entryOf = (id) => entries.find((entry) => entry.id === id)
    const brokenEntry = entryOf('probe-broken-mcp')
    const realEntry = entryOf('probe-real-mcp')

    // --- A: the capability (checked before any wait) ----------------------
    // First, because an upgrade that moved the seam would still let both rows
    // settle through the fallback inference; waiting 35 s would only hide the
    // real cause behind a timeout.
    const namespaces = entries.map((entry) => entry.moduleNamespace)
    const capabilityOk = record(
      'A. entry.moduleNamespace.connectionStatusOf is a function',
      entries.length === 2 && namespaces.every((namespace) => typeof namespace?.connectionStatusOf === 'function'),
      {
        rows: entries.map((entry) => entry.id),
        connectionStatusOf: namespaces.map((namespace) => typeof namespace?.connectionStatusOf),
        handleNormalization: entries.map((entry) => entry.fiber?.ctx?.fiber !== entry.fiber),
      },
    )
    if (!capabilityOk) {
      throw new Error(
        'the live-status seam is unavailable: entry.moduleNamespace.connectionStatusOf is not a function on every MCP row (a Harness upgrade may have moved it)',
      )
    }

    await waitFor('the broken row to give up', () => liveStatusOf(brokenEntry)?.state === 'failed', 15_000)
    await waitFor('the real row to connect', () => liveStatusOf(realEntry)?.state === 'connected', 20_000)

    // The same row contract the desktop host's inventory publishes.
    ctx.provide('pluginManager', {
      async listPlugins() {
        return entries.map(inventoryRow)
      },
      async setPluginEnabled() {
        throw new Error('the probe never mutates the composition')
      },
    })

    // --- A: the plugin reads both rows through the seam --------------------
    const brokenLive = liveStatusOf(brokenEntry)
    const realLive = liveStatusOf(realEntry)
    record('A. liveStatusOf reads both rows through the seam', brokenLive !== null && realLive !== null, {
      broken: brokenLive,
      real: realLive,
    })

    // --- D: reading subscribes to nothing ---------------------------------
    // Instrument the public seam (`onChange`) on the very handles the plugin
    // resolves; any observer the plugin created would be counted here. The
    // client's private observer set is reported as evidence when readable:
    // private field names may change between runtimes, and the public
    // instrumentation must stay authoritative.
    const handles = namespaces.map((namespace, index) =>
      namespace.connectionStatusOf(entries[index].fiber?.ctx?.fiber ?? entries[index].fiber),
    )
    let onChangeCalls = 0
    for (const handle of handles) {
      if (typeof handle?.onChange !== 'function') continue
      const original = handle.onChange
      handle.onChange = function instrumented(...args) {
        onChangeCalls += 1
        return original.apply(this, args)
      }
    }
    const listenersBefore = handles.map(listenerCount)
    const servers = await collectServerRows(ctx)
    await collectServerRows(ctx)
    const listenersAfter = handles.map(listenerCount)
    const listenerDelta = listenersBefore
      .map((before, index) => (before === null || listenersAfter[index] === null ? null : listenersAfter[index] - before))
      .filter((delta) => delta !== null)
    const listenersUnchanged = listenerDelta.every((delta) => delta === 0)
    record(
      'D. collectServerRows creates no onChange subscription',
      onChangeCalls === 0 && listenersUnchanged,
      {
        onChangeCalls,
        listenersBefore,
        listenersAfter,
        listenerDelta: listenerDelta.length === 0 ? 'listener set not readable; onChange instrumentation is authoritative' : listenerDelta,
        rowsRead: servers.map((row) => ({ serverName: row.serverName, status: serverStatus(row), live: row.live })),
      },
    )

    // The rows `collectServerRows` publishes are what B and C assert; nothing
    // below re-derives them from a hand-made wrapper.
    const byName = new Map(servers.map((server) => [server.serverName, server]))
    const brokenServer = byName.get('probe-broken')
    const realServer = byName.get('probe-real')
    record(
      'D. collectServerRows keeps both live rows',
      brokenServer?.live?.state === 'failed' && realServer?.live?.state === 'connected',
      [...byName.values()].map((server) => ({ serverName: server.serverName, status: serverStatus(server), live: server.live })),
    )

    // --- B: a failed spawn reaches the presentable row --------------------
    const brokenView = liveStatusView(brokenServer)
    const brokenRow = presentServer(brokenServer)
    record(
      'B. broken row: live failed with the ENOENT diagnostic',
      brokenLive?.state === 'failed' && /ENOENT/.test(String(brokenLive?.lastError ?? '')),
      { live: brokenLive },
    )
    record(
      'B. broken row: status error and the spawn text in statusDetail',
      brokenView?.status === 'error' &&
        brokenRow.status === 'error' &&
        brokenRow.statusDetail !== null &&
        String(brokenRow.statusDetail).includes('ENOENT'),
      { liveStatusView: brokenView, presented: brokenRow },
    )

    // --- C: a real server reaches running with its live tool count ---------
    const realView = liveStatusView(realServer)
    const realRow = presentServer(realServer)
    record(
      'C. real row: live connected with toolCount >= 2',
      realLive?.state === 'connected' && Number.isFinite(realLive?.toolCount) && realLive.toolCount >= 2,
      { live: realLive, registeredTools: [...definitions.keys()].sort() },
    )
    record(
      'C. real row: status running with toolCount 2 and no detail',
      realView?.status === 'running' &&
        realRow.status === 'running' &&
        realRow.toolCount === 2 &&
        realRow.statusDetail === null,
      { liveStatusView: realView, presented: realRow },
    )

    const result = {
      probe: 'live-status-seam',
      runtime: RUNTIME,
      skipped: false,
      pass: checks.every((check) => check.ok),
      checks,
      observed: {
        capability: namespaces.map((namespace) => typeof namespace?.connectionStatusOf),
        broken: { live: brokenLive, presented: brokenRow },
        real: { live: realLive, presented: realRow },
      },
    }

    printResult(result)
    cleanup = async () => {
      for (const entry of entries) {
        try {
          await entry.fiber?.dispose?.()
        } catch {
          // A failed cleanup must not mask the assertion result.
        }
      }
    }
    return result.pass ? 0 : 1
  } catch (error) {
    const result = {
      probe: 'live-status-seam',
      skipped: false,
      pass: false,
      error: error?.message ?? String(error),
      stack: error?.stack,
      checks,
    }
    printResult(result)
    cleanup = async () => {
      for (const entry of entries) {
        try {
          await entry.fiber?.dispose?.()
        } catch {
          // Ignored: the error above is the reported failure.
        }
      }
    }
    return 1
  } finally {
    if (cleanup !== null) await cleanup()
    if (temp !== null) await fsp.rm(temp, { recursive: true, force: true })
  }
}

function printResult(result) {
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log('\ndsh-mcp-progressive — live-status seam (real Loader)\n')
  if (result.error !== undefined) console.log(`  ERROR: ${result.error}\n`)
  for (const check of result.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`)
    if (!check.ok) console.log(`        observed: ${JSON.stringify(check.detail)}`)
  }
  if (result.observed !== undefined) {
    const observed = {
      capability: result.observed.capability,
      'broken.live': result.observed.broken.live,
      'broken.row': {
        status: result.observed.broken.presented?.status,
        statusDetail: result.observed.broken.presented?.statusDetail,
      },
      'real.live': result.observed.real.live,
      'real.row': {
        status: result.observed.real.presented?.status,
        toolCount: result.observed.real.presented?.toolCount,
        statusDetail: result.observed.real.presented?.statusDetail,
      },
    }
    console.log(`\n  observed: ${JSON.stringify(observed, null, 2).split('\n').join('\n  ')}`)
  }
  console.log(`\n  ${result.pass ? 'PASS' : 'FAIL'}\n`)
}

const code = await main()
process.exit(code)
