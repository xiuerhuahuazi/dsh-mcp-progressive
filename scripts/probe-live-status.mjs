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
 * The failure path is part of the contract, because a moved seam is exactly
 * when it runs. Disposing a stdio MCP transport while its speculative
 * version-negotiation sibling is still spawning makes the upstream SDK call
 * `proc.kill('SIGTERM')` on a `ChildProcess` whose pid is still undefined —
 * pid 0, i.e. **the caller's process group** (audit R1). Cleanup therefore
 * waits (bounded) until no row is `connecting`/`reconnecting`, disposes only
 * rows it could confirm settled, reaps the server children it created (the
 * recorded pid files, then a bounded command-line scan for a spawn that lands
 * while cleanup is already running), removes the temp dir, and then exits
 * through its own code. A SIGTERM that still arrives is recorded, not allowed
 * to turn the verdict into 143.
 *
 * Hermetic: the host dir and the mini MCP server live in a `mkdtemp` home, the
 * runtime is imported read-only by absolute path (bare row names resolve
 * through a `node_modules` symlink inside the temp dir), `~/.dsh` is never
 * read or written, nothing is restarted, and the temp dir is removed.
 *
 * Hidden self-test knobs (never used by the gate):
 *   PROBE_LIVE_FORCE_FAIL=1     fail assertion A before the rows settle, so the
 *                               negative path (moved seam) is exercised without
 *                               editing an assertion;
 *   PROBE_LIVE_QUIESCE_MS=<ms>  shorten the settle wait (e.g. 1) to exercise
 *                               the "skip dispose, reap children" branch.
 *
 * Usage: node scripts/probe-live-status.mjs [--json]
 * Exit: 0 only when all eight assertions passed. 0 with
 * `SKIP: runtime unavailable` (CI posture, same as the other scripts) when the
 * DSH runtime is absent — that SKIP is explicit and carries `authority: false`,
 * it is not evidence for the capability. A failed run exits 1, never 143.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = process.env.DSH_RUNTIME ?? '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai'
const MCP = '@deepseek-ai/dsh-mcp-client'
const BROKEN_COMMAND = '/nonexistent/definitely-not-a-command'
const wantJson = process.argv.includes('--json')
/** Hidden negative self-test: fail assertion A before the rows settle. */
const FORCE_FAIL = process.env.PROBE_LIVE_FORCE_FAIL === '1'
/** How long cleanup may wait for rows to leave `connecting`/`reconnecting`. */
const QUIESCE_MS = readBudget('PROBE_LIVE_QUIESCE_MS', 10_000)
/** How long cleanup may wait for a confirmed-settled row to dispose. */
const DISPOSE_BUDGET_MS = 3_000
const execFileAsync = promisify(execFile)

/** A non-negative integer env override, or `fallback` when absent/invalid. */
function readBudget(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * Signals aimed at this process. Cleanup avoids the upstream mid-spawn kill
 * (see the header), and this handler is the belt to that brace: if a signal
 * arrives anyway, it must not turn the gate's own verdict into a 143.
 */
const receivedSignals = []
process.on('SIGTERM', () => receivedSignals.push('SIGTERM'))

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
import fs from 'node:fs'
import readline from 'node:readline'

// argv[2] is a path prefix; each process writes <prefix>.<pid>.pid so the probe
// can reap exactly the server processes it spawned if it must tear down without
// disposing the client (the upstream mid-spawn SIGTERM, audit R1).
const pidPrefix = process.argv[2]
if (typeof pidPrefix === 'string' && pidPrefix !== '') {
  try {
    fs.writeFileSync(pidPrefix + '.' + process.pid + '.pid', String(process.pid))
  } catch {
    // The pid file is best-effort: a read-only temp dir must not kill the run.
  }
}

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

/** One short sleep, used by the settle wait. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Report the missing runtime packages; empty means the capability can run. */
function runtimeMissing() {
  return runtimeFiles.filter((file) => !fs.existsSync(file))
}

/**
 * The live cell's raw state for one row, or null when the seam is unavailable.
 * Cleanup reads this directly (not the plugin's `liveStatusOf`): it is exactly
 * the read that has to be safe while a row is still loading.
 */
function statusStateOf(entry) {
  try {
    const namespace = entry?.moduleNamespace
    const read = namespace?.connectionStatusOf
    if (typeof read !== 'function') return null
    const handle = read.call(namespace, entry.fiber?.ctx?.fiber ?? entry.fiber)
    const state = handle?.current?.()?.state
    return typeof state === 'string' ? state : null
  } catch {
    return null
  }
}

/**
 * Wait (bounded) until no row is `connecting`/`reconnecting`.
 *
 * This is the guard against audit R1: disposing a stdio transport while its
 * speculative version-negotiation sibling is still spawning asks the SDK to
 * kill a pid that is still undefined, which signals this process's group. The
 * wait is bounded because a wedged row must not hang the gate; rows that are
 * still mid-spawn (or unreadable) are left undisposed by `cleanup`.
 */
async function quiesceRows(entries, timeoutMs) {
  const started = Date.now()
  const waitedMs = () => Date.now() - started
  let states = []
  for (;;) {
    states = entries.map(statusStateOf)
    // An unreadable row is not a settled row: waiting cannot make the seam
    // appear, so cleanup takes the skip-dispose path immediately.
    if (states.some((state) => state === null)) {
      return { settled: false, reason: 'unreadable', states, waitedMs: waitedMs() }
    }
    const midSpawn = states.some((state) => state === 'connecting' || state === 'reconnecting')
    if (!midSpawn) return { settled: true, states, waitedMs: waitedMs() }
    if (waitedMs() >= timeoutMs) return { settled: false, reason: 'still-mid-spawn', states, waitedMs: waitedMs() }
    await sleep(25)
  }
}

/** Await an already-started group of promises, but stop waiting after `timeoutMs`. */
async function settleWithin(promise, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const settled = Promise.resolve(promise).then(() => true)
  const outcome = await Promise.race([settled, timeout])
  clearTimeout(timer)
  return outcome
}

/**
 * Reap the mini server processes this probe spawned, and only those.
 *
 * Each server writes `<prefix>.<pid>.pid` into the temp dir. A recorded pid is
 * signalled only when `ps` still shows it running our temp-dir script, so a
 * recycled pid can never be killed by the gate; the sibling process the client
 * spawns for version negotiation writes its own file and is handled the same
 * way.
 */
async function reapServers(tempDir, serverScript, errors) {
  if (tempDir === null || serverScript === null) return { attempted: false, reason: 'no temp dir' }
  let names = []
  try {
    names = (await fsp.readdir(tempDir)).filter((name) => name.startsWith('mini-mcp-server.') && name.endsWith('.pid'))
  } catch (error) {
    errors.push(`read pid files: ${error?.message ?? String(error)}`)
    return { attempted: false, reason: 'pid files unreadable' }
  }
  const reaped = []
  for (const name of names) {
    const pidFile = path.join(tempDir, name)
    try {
      const pid = Number.parseInt((await fsp.readFile(pidFile, 'utf8')).trim(), 10)
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        reaped.push({ pid: null, killed: false, reason: `invalid pid file ${name}` })
        continue
      }
      let command = ''
      try {
        command = String((await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)])).stdout)
      } catch {
        reaped.push({ pid, killed: false, reason: 'process already gone' })
        continue
      }
      if (!command.includes(serverScript)) {
        reaped.push({ pid, killed: false, reason: 'pid no longer runs the probe server (not signalled)' })
        continue
      }
      process.kill(pid, 'SIGKILL')
      reaped.push({ pid, killed: true, reason: 'killed' })
    } catch (error) {
      // ESRCH means it is already gone; anything else is recorded, not thrown.
      reaped.push({ pid: null, killed: false, reason: error?.code === 'ESRCH' ? 'already gone' : error?.message ?? String(error) })
    }
  }
  return { attempted: true, servers: reaped }
}

/**
 * Pids (other than ours) whose command line still runs `serverScript`.
 *
 * This catches a server the client spawned after the pid-file scan: the file
 * is written by the child itself, so a very early spawn can land in the gap.
 * Matching the command line keeps the kill scoped to processes this probe
 * started — a recycled pid or an unrelated node process never matches.
 */
async function childrenRunning(serverScript, errors) {
  let table = ''
  try {
    table = String((await execFileAsync('ps', ['-ax', '-o', 'pid=,command='])).stdout)
  } catch (error) {
    errors.push(`ps scan: ${error?.message ?? String(error)}`)
    return []
  }
  const pids = []
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const pid = Number.parseInt(match[1], 10)
    if (pid === process.pid) continue
    if (match[2].includes(serverScript)) pids.push(pid)
  }
  return pids
}

/**
 * Reap a server that was spawned while cleanup was running, and every
 * reconnect generation it produces, until the process table has been quiet for
 * two consecutive checks (bounded).
 *
 * Only used when at least one row had to be left undisposed: a disposed client
 * closes its own transports. Killing a child makes the client reconnect, so
 * the loop keeps going until its reconnect budget is exhausted or the bound is
 * hit — and reports `quiet: false` instead of pretending.
 */
async function reapSpawnedChildren(serverScript, errors) {
  const killed = []
  if (serverScript === null) return { attempted: false, quiet: false, killed }
  const deadline = Date.now() + 2_000
  let quietChecks = 0
  while (Date.now() < deadline) {
    const pids = await childrenRunning(serverScript, errors)
    if (pids.length === 0) {
      quietChecks += 1
      if (quietChecks >= 2) return { attempted: true, quiet: true, killed }
      await sleep(100)
      continue
    }
    quietChecks = 0
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
        killed.push(pid)
      } catch (error) {
        if (error?.code !== 'ESRCH') errors.push(`kill ${pid}: ${error?.message ?? String(error)}`)
      }
    }
    await sleep(25)
  }
  return { attempted: true, quiet: false, killed }
}

async function main() {
  const missing = runtimeMissing()
  if (missing.length > 0) {
    const result = {
      probe: 'live-status-seam',
      skipped: true,
      pass: false,
      authority: false,
      skipsNotEvidence: true,
      exitCode: 0,
      reason: 'runtime unavailable',
      missing,
    }
    if (wantJson) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`SKIP: runtime unavailable (DSH_RUNTIME=${RUNTIME})`)
      for (const file of missing) console.log(`  missing: ${file}`)
      console.log('  not evidence: a runtime-less run cannot prove the seam (JSON: authority:false, skipsNotEvidence:true)')
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
  let serverScript = null
  let cleanupReport = null
  let cleanedUp = false

  /**
   * Idempotent, failure-safe teardown (audit F2). It never throws, it removes
   * the temp home, and it only disposes rows whose live cell it could confirm
   * settled — a row still mid-spawn is left to its own child, which this
   * teardown reaps directly.
   */
  async function cleanup() {
    if (cleanedUp === true) return cleanupReport
    cleanedUp = true
    const report = { quiesce: null, disposed: [], disposeSkipped: [], servers: null, tempRemoved: false, signals: [], errors: [] }
    try {
      report.quiesce = await quiesceRows(entries, QUIESCE_MS)
      const disposals = []
      entries.forEach((entry) => {
        // Re-read right before deciding: the row may have started reconnecting
        // between the settle loop and this call, and a mid-spawn dispose is
        // exactly the window that signals our process group.
        const state = statusStateOf(entry)
        if (state === null || state === 'connecting' || state === 'reconnecting') {
          report.disposeSkipped.push({ id: entry.id, state })
          return
        }
        report.disposed.push({ id: entry.id, state })
        disposals.push(
          Promise.resolve()
            .then(() => entry.fiber?.dispose?.())
            .catch((error) => report.errors.push(`dispose ${entry.id}: ${error?.message ?? String(error)}`)),
        )
      })
      if (disposals.length > 0 && (await settleWithin(Promise.allSettled(disposals), DISPOSE_BUDGET_MS)) === false) {
        report.errors.push(`disposal did not settle within ${DISPOSE_BUDGET_MS} ms; continuing teardown`)
      }
    } catch (error) {
      // A cleanup failure must never mask the assertion verdict.
      report.errors.push(`dispose: ${error?.message ?? String(error)}`)
    }
    try {
      report.servers = await reapServers(temp, serverScript, report.errors)
      // A child spawned after the pid-file scan would otherwise outlive the
      // probe for a moment; only the skip-dispose path can leave one behind.
      report.spawned = report.disposeSkipped.length > 0
        ? await reapSpawnedChildren(serverScript, report.errors)
        : { attempted: false, quiet: true, killed: [] }
    } catch (error) {
      report.errors.push(`reap: ${error?.message ?? String(error)}`)
    }
    try {
      if (temp !== null) {
        await fsp.rm(temp, { recursive: true, force: true })
        report.tempRemoved = true
      }
    } catch (error) {
      report.errors.push(`remove temp dir: ${error?.message ?? String(error)}`)
    }
    report.signals = [...receivedSignals]
    cleanupReport = report
    return report
  }

  let result
  try {
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-live-status-probe-'))
    const hostDir = path.join(temp, 'host')
    await fsp.mkdir(hostDir, { recursive: true })
    // Bare loader row names resolve from `ctx.baseUrl` by walking up for
    // `node_modules`; pointing that at the installed runtime keeps the row
    // name `@deepseek-ai/dsh-mcp-client` (the name the plugin filters on)
    // without copying or importing a second module instance.
    await fsp.symlink(path.dirname(RUNTIME), path.join(temp, 'node_modules'), 'dir')
    serverScript = path.join(temp, 'mini-mcp-server.mjs')
    await fsp.writeFile(serverScript, MINI_MCP_SERVER_SOURCE, 'utf8')
    const pidPrefix = path.join(temp, 'mini-mcp-server')

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
        args: [serverScript, pidPrefix],
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
      FORCE_FAIL === false &&
        entries.length === 2 &&
        namespaces.every((namespace) => typeof namespace?.connectionStatusOf === 'function'),
      {
        rows: entries.map((entry) => entry.id),
        connectionStatusOf: namespaces.map((namespace) => typeof namespace?.connectionStatusOf),
        handleNormalization: entries.map((entry) => entry.fiber?.ctx?.fiber !== entry.fiber),
        forcedFailure: FORCE_FAIL,
      },
    )
    if (!capabilityOk) {
      throw new Error(
        FORCE_FAIL
          ? 'PROBE_LIVE_FORCE_FAIL=1: assertion A forced to fail before the rows settle (negative self-test)'
          : 'the live-status seam is unavailable: entry.moduleNamespace.connectionStatusOf is not a function on every MCP row (a Harness upgrade may have moved it)',
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

    result = {
      probe: 'live-status-seam',
      runtime: RUNTIME,
      skipped: false,
      pass: checks.every((check) => check.ok),
      // A real-Loader run is evidence; a SKIP (above) is not.
      authority: true,
      skipsNotEvidence: false,
      forcedFailure: FORCE_FAIL,
      checks,
      observed: {
        capability: namespaces.map((namespace) => typeof namespace?.connectionStatusOf),
        broken: { live: brokenLive, presented: brokenRow },
        real: { live: realLive, presented: realRow },
      },
    }
  } catch (error) {
    result = {
      probe: 'live-status-seam',
      runtime: RUNTIME,
      skipped: false,
      pass: false,
      authority: true,
      skipsNotEvidence: false,
      forcedFailure: FORCE_FAIL,
      error: error?.message ?? String(error),
      stack: error?.stack,
      checks,
    }
  } finally {
    // Cleanup is defensive by construction; this last resort only guarantees
    // that a bug in it cannot swallow the verdict or the exit code.
    try {
      await cleanup()
    } catch (error) {
      if (result === undefined) {
        result = { probe: 'live-status-seam', runtime: RUNTIME, skipped: false, pass: false, checks }
      }
      result.cleanupFailed = error?.message ?? String(error)
    }
  }

  result.cleanup = cleanupReport
  result.signals = [...receivedSignals]
  result.exitCode = result.pass === true ? 0 : 1
  printResult(result)
  return result.exitCode
}

/** Failures are evidence too: print the assertion verdict, then the teardown. */
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
  const cleanup = result.cleanup
  if (cleanup !== null && cleanup !== undefined) {
    const states = (cleanup.quiesce?.states ?? []).map((state) => state ?? 'unknown').join('/')
    const reaped = (cleanup.servers?.servers ?? []).map((server) => `${server.pid ?? '?'}:${server.reason}`)
    console.log(
      `\n  cleanup: quiesced ${cleanup.quiesce?.settled === true ? 'yes' : 'NO'} (${cleanup.quiesce?.waitedMs ?? 0} ms, states ${states || '-'}${cleanup.quiesce?.reason === undefined ? '' : `, ${cleanup.quiesce.reason}`}); ` +
        `disposed ${cleanup.disposed.length}; skipped ${cleanup.disposeSkipped.length}; ` +
        `servers ${reaped.length === 0 ? 'none recorded' : reaped.join(', ')}; ` +
        `spawned reaped ${cleanup.spawned?.killed?.length ?? 0}${cleanup.spawned?.attempted === true && cleanup.spawned?.quiet !== true ? ' (NOT quiet)' : ''}; ` +
        `temp removed ${cleanup.tempRemoved ? 'yes' : 'NO'}`,
    )
    for (const error of cleanup.errors) console.log(`        cleanup error: ${error}`)
  }
  if (Array.isArray(result.signals) && result.signals.length > 0) {
    console.log(`        note: ignored ${result.signals.length} in-process ${result.signals.join('+')} during teardown (upstream mid-spawn kill, audit R1)`)
  }
  const passed = (result.checks ?? []).filter((check) => check.ok === true).length
  const total = (result.checks ?? []).length
  console.log(`\n  ${result.pass ? 'PASS' : 'FAIL'}  (${passed}/${total} assertions)\n`)
}

const code = await main()
process.exit(code)
