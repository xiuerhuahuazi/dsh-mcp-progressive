/**
 * Management-half regression: route admission, strict bodies, the control
 * state machine and exact addressing.
 *
 * These tests drive the handlers `registerServerManagement` really registered
 * through `createManagementEnv` + `request`, so the fake plugin manager sees
 * exactly what a browser or the model would cause.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import nodePath from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

import { MANAGEMENT_ROUTES, createManagementEnv, request, withVirtualClock } from './harness.mjs'
import {
  MCP_CLIENT_MODULE,
  MAX_PENDING_OPERATIONS,
  QueueFullError,
  createControlQueue,
  isMcpClientModule,
  resolveServerTarget,
  serverStatus,
  targetSummary,
  waitForServerPhase,
} from '../lib/management.js'

const STATE = '/dsh-mcp-hub/state'
const TOGGLE = '/dsh-mcp-hub/toggle'
const RESTART = '/dsh-mcp-hub/restart'
const JSON_HEADERS = { 'content-type': 'application/json' }

/** POST one JSON body the way the panel does. */
function post(env, routePath, body, headers = {}) {
  return request(env, routePath, { method: 'POST', body, headers: { ...JSON_HEADERS, ...headers } })
}

/** One fake plugin-manager row; `MCP_CLIENT_MODULE` unless overridden. */
function row(overrides = {}) {
  return {
    entryId: 'include:demo',
    patchId: 'demo',
    moduleName: MCP_CLIENT_MODULE,
    enabled: true,
    fiberPhase: 'active',
    toolCount: 3,
    readOnlyReason: null,
    ...overrides,
  }
}

/** Extract the plain result object from a successful route answer. */
function resultOf(response) {
  assert.equal(response.body?.ok, true, `expected ok:true, got ${JSON.stringify(response.body)}`)
  return response.body.result
}

test('every route answers a rejected admission with JSON before doing anything', async (t) => {
  const env = await createManagementEnv({ rejection: 'reject' })
  t.after(() => env.dispose())
  const before = env.row.enabled

  const state = await request(env, STATE)
  assert.equal(state.status, 403)
  assert.deepEqual(state.body, { ok: false, error: 'forbidden' })
  assert.equal(state.headers['content-type'], 'application/json; charset=utf-8')

  const toggle = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
  assert.equal(toggle.status, 403)
  assert.equal(toggle.body.ok, false)
  assert.equal(env.calls.length, 0, 'a rejected request must not reach the plugin manager')
  assert.equal(env.row.enabled, before, 'a rejected request must not mutate state')

  const restart = await post(env, RESTART, { entryId: 'include:demo' })
  assert.equal(restart.status, 403)
  assert.equal(env.calls.length, 0)
})

test('a 401 rejection status is preserved in the JSON answer', async (t) => {
  const env = await createManagementEnv({ rejection: () => 401 })
  t.after(() => env.dispose())
  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
  assert.equal(response.status, 401)
  assert.deepEqual(response.body, { ok: false, error: 'unauthorized' })
  assert.equal(env.calls.length, 0)
})

test('a connection fence that throws fails closed', async (t) => {
  const env = await createManagementEnv({
    rejection: () => {
      throw new Error('fence exploded')
    },
  })
  t.after(() => env.dispose())
  const response = await request(env, STATE)
  assert.equal(response.status, 403)
  assert.equal(env.calls.length, 0)
})

test('POST routes refuse a declared non-JSON content type', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())

  const textPlain = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false }, { 'content-type': 'text/plain' })
  assert.equal(textPlain.status, 415)
  assert.equal(textPlain.body.ok, false)
  assert.equal(env.calls.length, 0, 'a form-shaped request must not reach the manager')

  const form = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false }, { 'content-type': 'application/x-www-form-urlencoded' })
  assert.equal(form.status, 415)
  assert.equal(env.calls.length, 0)

  const withCharset = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false }, { 'content-type': 'Application/JSON; charset=utf-8' })
  assert.equal(withCharset.status, 200, 'the media type is matched case-insensitively and ignores parameters')
  assert.equal(env.row.enabled, false)
})

test('a POST with a JSON body but no content-type header is a 415 with zero manager calls', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())

  // The shared request() now adds the JSON media type for any body. Setting the
  // header key to undefined models a client that sends the body without it: the
  // handler reads `req.headers['content-type']` as undefined, exactly the
  // header-less case.
  const noHeader = await request(env, TOGGLE, {
    method: 'POST',
    body: { entryId: 'include:demo', enabled: false },
    headers: { 'content-type': undefined },
  })
  assert.equal(noHeader.status, 415)
  assert.equal(noHeader.body.ok, false)
  assert.match(noHeader.body.error, /content-type must be application\/json/)
  assert.equal(env.calls.length, 0, 'a header-less request must not reach the manager')
  assert.equal(env.row.enabled, true)

  const emptyHeader = await request(env, TOGGLE, {
    method: 'POST',
    body: { entryId: 'include:demo', enabled: false },
    headers: { 'content-type': '' },
  })
  assert.equal(emptyHeader.status, 415)
  assert.equal(env.calls.length, 0)
})

test('methods are enforced with an allow header', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())

  const getToggle = await request(env, TOGGLE)
  assert.equal(getToggle.status, 405)
  assert.equal(getToggle.headers.allow, 'POST')
  assert.equal(env.calls.length, 0)

  const deleteState = await request(env, STATE, { method: 'DELETE' })
  assert.equal(deleteState.status, 405)
  assert.equal(deleteState.headers.allow, 'GET, HEAD')

  const headState = await request(env, STATE, { method: 'HEAD' })
  assert.equal(headState.status, 200, 'HEAD is allowed on the state route')
  assert.equal(headState.headers.allow, undefined)
})

test('enabled must be a real boolean and bad bodies never enqueue work', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())

  const badBodies = [
    { entryId: 'include:demo', enabled: 'true' },
    { entryId: 'include:demo' },
    { entryId: 'include:demo', enabled: null },
    { entryId: 'include:demo', enabled: 1 },
    { entryId: 'include:demo', enabled: 'false' },
  ]
  for (const body of badBodies) {
    const response = await post(env, TOGGLE, body)
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    assert.equal(response.body.ok, false)
    assert.match(response.body.error, /enabled must be a boolean/)
  }

  for (const body of [[], '"text"', null, 42]) {
    const response = await post(env, TOGGLE, body)
    assert.equal(response.status, 400, `expected 400 for a non-object body ${JSON.stringify(body)}`)
    assert.match(response.body.error, /body must be a JSON object/)
  }

  for (const body of [
    { enabled: false },
    { entryId: '', enabled: false },
    { entryId: 42, enabled: false },
    { id: null, enabled: false },
    { server: '', enabled: false },
  ]) {
    const response = await post(env, TOGGLE, body)
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    assert.match(response.body.error, /entryId|id|server/)
  }

  assert.equal(env.calls.length, 0, 'rejected bodies must never enqueue a mutation')
  assert.equal(env.row.enabled, true)
})

test('an oversized body is answered with 413 instead of a reset connection', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())

  const response = await post(env, TOGGLE, 'x'.repeat(65537))
  assert.equal(response.status, 413)
  assert.equal(response.body.ok, false)
  assert.match(response.body.error, /exceeds/)
  assert.equal(response.destroyed, false, 'the socket is drained, not destroyed before the answer')
  assert.equal(env.calls.length, 0)
})

test('an unknown server is a 404 and an ambiguous name lists its candidates', async (t) => {
  const rows = [row({ entryId: 'include:a', patchId: 'a' }), row({ entryId: 'include:b', patchId: 'b' })]
  const entries = [
    { id: 'include:a', options: { config: { serverName: 'dup', command: 'node' } } },
    { id: 'include:b', options: { config: { serverName: 'dup', command: 'node' } } },
  ]
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  const unknown = await post(env, TOGGLE, { entryId: 'include:nope', enabled: false })
  assert.equal(unknown.status, 404)

  const ambiguous = await post(env, TOGGLE, { server: 'dup', enabled: false })
  assert.equal(ambiguous.status, 400)
  assert.equal(ambiguous.body.candidates.length, 2)
  assert.deepEqual(
    ambiguous.body.candidates.map((candidate) => candidate.entryId).sort(),
    ['include:a', 'include:b'],
  )
  assert.match(ambiguous.body.error, /matches 2 MCP servers/)
  assert.equal(env.calls.length, 0)
})

test('addressing is exact and entryId wins over a colliding server name', async (t) => {
  const state = {
    rows: [
      row({ entryId: 'include:first-row', patchId: 'first-row', enabled: true }),
      row({ entryId: 'include:second-row', patchId: 'second-row', enabled: true }),
    ],
  }
  const entries = [
    { id: 'include:first-row', options: { config: { serverName: 'second-row', command: 'node' } } },
    { id: 'include:second-row', options: { config: { serverName: 'z-server', command: 'node' } } },
  ]
  const calls = []
  const env = await createManagementEnv({
    rows: state.rows.map((entry) => ({ ...entry })),
    entries,
    manager: {
      async listPlugins() {
        return state.rows.map((entry) => ({ ...entry }))
      },
      async setPluginEnabled(id, enabled) {
        calls.push({ id, enabled })
        const target = state.rows.find((entry) => entry.entryId === id)
        target.enabled = enabled
        target.fiberPhase = enabled ? 'active' : null
        return { application: 'applied' }
      },
    },
  })
  t.after(() => env.dispose())

  // A name that is row A's display name and row B's row id cannot be guessed.
  const ambiguous = await post(env, TOGGLE, { server: 'second-row', enabled: false })
  assert.equal(ambiguous.status, 400)
  assert.equal(ambiguous.body.candidates.length, 2)
  assert.equal(calls.length, 0)

  const byEntryId = await post(env, TOGGLE, { entryId: 'include:second-row', enabled: false })
  assert.equal(byEntryId.status, 200)
  assert.deepEqual(calls.at(-1), { id: 'include:second-row', enabled: false })
  assert.equal(resultOf(byEntryId).entryId, 'include:second-row')

  const byRowId = await post(env, TOGGLE, { id: 'second-row', enabled: true })
  assert.equal(byRowId.status, 200)
  assert.deepEqual(calls.at(-1), { id: 'include:second-row', enabled: true })

  // Only a case-insensitive server *name* may match loosely.
  const byLooseName = await post(env, TOGGLE, { server: 'SECOND-ROW', enabled: false })
  assert.equal(byLooseName.status, 200)
  assert.deepEqual(calls.at(-1), { id: 'include:first-row', enabled: false })
})

test('resolveServerTarget keeps the helper contract', () => {
  const servers = [
    { entryId: 'include:a', id: 'a', serverName: 'alpha' },
    { entryId: 'include:b', id: 'b', serverName: 'beta' },
  ]
  assert.equal(resolveServerTarget(servers, { entryId: 'include:b' }).id, 'b')
  assert.equal(resolveServerTarget(servers, { id: 'a' }).id, 'a')
  assert.equal(resolveServerTarget(servers, { server: 'ALPHA' }).id, 'a')
  assert.throws(() => resolveServerTarget(servers, { server: 'missing' }), /unknown MCP server/)
  assert.throws(() => resolveServerTarget(servers, {}), /requires/)
})

test('stop and start issued together run in order and end enabled', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())
  assert.equal(env.row.enabled, true)

  const [stop, start] = await Promise.all([
    post(env, TOGGLE, { entryId: 'include:demo', enabled: false }),
    post(env, TOGGLE, { entryId: 'include:demo', enabled: true }),
  ])

  assert.equal(stop.status, 200)
  assert.equal(start.status, 200)
  assert.equal(env.row.enabled, true, 'the second operation must act on live state, not the entry snapshot')
  assert.deepEqual(env.calls.map((call) => call.enabled), [false, true], 'both operations, in order')
  assert.equal(resultOf(stop).desiredEnabled, false)
  assert.equal(resultOf(start).desiredEnabled, true)
  assert.equal(resultOf(start).observedStatus, 'running')
})

test('a start whose fiber fails is a failure, with the diagnostic surfaced', async (t) => {
  const env = await createManagementEnv({
    rows: [row({ enabled: false, fiberPhase: null, toolCount: 0 })],
    mutate(fakeRow, enabled) {
      fakeRow.enabled = enabled
      fakeRow.fiberPhase = 'failed'
      fakeRow.diagnostic = 'spawn ENOENT'
      return { application: 'applied' }
    },
  })
  t.after(() => env.dispose())

  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: true })
  assert.equal(response.status, 500, 'a failed fiber is not a successful start')
  assert.equal(response.body.ok, false)
  assert.match(response.body.error, /failed to start/)
  assert.match(response.body.error, /spawn ENOENT/)
  assert.equal(response.body.observed.status, 'error')
})

test('a restart whose start step fails reports the failure and the observed state', async (t) => {
  const env = await createManagementEnv({
    mutate(fakeRow, enabled) {
      if (enabled) throw new Error('synthetic start failure')
      fakeRow.enabled = false
      fakeRow.fiberPhase = null
      return { application: 'applied' }
    },
  })
  t.after(() => env.dispose())

  const response = await post(env, RESTART, { entryId: 'include:demo' })
  assert.equal(response.status, 500)
  assert.equal(response.body.ok, false)
  assert.match(response.body.error, /restart failed/)
  assert.match(response.body.error, /synthetic start failure/)
  assert.equal(response.body.observed.status, 'stopped')
  assert.equal(env.calls[0].enabled, false, 'the stop step ran before the failing start')
})

/** One environment whose manager returns a fixed ChangeResult. */
async function envWithApplication(application, extra = {}) {
  return createManagementEnv({
    manager: {
      async listPlugins() {
        return [row()]
      },
      async setPluginEnabled() {
        return { changed: true, application, ...extra }
      },
    },
  })
}

test('application: overridden is a 409 that and does not claim the change ran', async (t) => {
  const env = await envWithApplication('overridden')
  t.after(() => env.dispose())

  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
  assert.equal(response.status, 409)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.application, 'overridden')
  assert.match(response.body.error, /overrides/)
  assert.equal(response.body.observed.status, 'running')
})

test('application: restart-required reports "saved, needs restart" without claiming running', async (t) => {
  const env = await envWithApplication('restart-required', { changed: true, restartReason: 'no-hmr' })
  t.after(() => env.dispose())

  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
  assert.equal(response.status, 200)
  const result = resultOf(response)
  assert.equal(result.application, 'restart-required')
  assert.equal(result.applied, false, 'the runtime did not change yet')
  assert.equal(result.saved, undefined)
  assert.match(result.message, /saved;/)
  assert.match(result.message, /next Harness restart/)
  assert.match(result.message, /no-hmr/)
  assert.equal(response.body.servers[0].enabled, true, 'the observed snapshot still shows the live row')
})

test('application: failed/cancelled keep the manager diagnostic and never write the patch', async (t) => {
  for (const application of ['failed', 'cancelled']) {
    const env = await createManagementEnv({
      manager: {
        async listPlugins() {
          return [row()]
        },
        async setPluginEnabled() {
          return {
            changed: false,
            application,
            error: { code: 'unaddressable', diagnostic: `manager ${application} the change` },
          }
        },
      },
    })
    t.after(() => env.dispose())
    const before = fs.readFileSync(env.patchPath, 'utf8')

    const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
    assert.equal(response.status, 500, `${application} must be an error`)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.application, application)
    assert.equal(response.body.code, 'unaddressable')
    assert.match(response.body.error, new RegExp(`manager ${application} the change`))
    assert.equal(fs.readFileSync(env.patchPath, 'utf8'), before, 'a non-applied result must not touch the patch')
  }
})

test('the state route reports diagnostic, stopping and the full row contract', async (t) => {
  const rows = [
    row({ entryId: 'include:demo', patchId: 'demo', enabled: true, fiberPhase: 'active', diagnostic: 'connect ECONNREFUSED' }),
    row({ entryId: 'include:stop', patchId: 'stop', enabled: true, fiberPhase: 'unloading' }),
    row({ entryId: 'include:start', patchId: 'start', enabled: true, fiberPhase: 'loading' }),
    row({ entryId: 'include:off', patchId: 'off', enabled: false, fiberPhase: null }),
  ]
  const entries = [
    { id: 'include:demo', options: { config: { serverName: 'demo', command: '/usr/local/bin/server', args: ['--token', 'SYNTHETIC_SECRET'], transport: 'stdio' } } },
    { id: 'include:stop', options: { config: { serverName: 'stopper', url: 'https://alice:SYNTHETIC_SECRET@10.0.0.7:8443/private?token=SYNTHETIC_SECRET' } } },
    { id: 'include:start', options: { config: { serverName: 'starter', url: 'https://bad host/private' } } },
    { id: 'include:off', options: { config: { serverName: 'off', command: 'node' } } },
  ]
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  const response = await request(env, STATE)
  assert.equal(response.status, 200)
  const byName = new Map(response.body.servers.map((server) => [server.serverName, server]))

  const demo = byName.get('demo')
  assert.equal(demo.status, 'error')
  assert.equal(demo.diagnostic, 'connect ECONNREFUSED')
  assert.equal(demo.entryId, 'include:demo')
  assert.equal(demo.id, 'demo')
  assert.equal(demo.transport, 'stdio')
  assert.equal(demo.fiberPhase, 'active')
  assert.equal(demo.toolCount, 3)
  assert.equal(demo.target, 'server --token')
  assert.ok(!JSON.stringify(response.body).includes('SYNTHETIC_SECRET'), 'no command-line credential may be echoed')

  assert.equal(byName.get('stopper').status, 'stopping')
  assert.equal(byName.get('stopper').target, '10.0.0.7:8443')
  assert.equal(byName.get('starter').status, 'starting')
  assert.equal(byName.get('starter').target, '(invalid URL)')
  assert.equal(byName.get('off').status, 'stopped')
  assert.equal(byName.get('off').diagnostic, null)
})

test('targetSummary never exposes argument values or an unparseable URL', () => {
  const stdio = targetSummary({ command: '/usr/local/bin/server', args: ['--token', 'SYNTHETIC_SECRET'] }, 'stdio')
  assert.equal(stdio, 'server --token')
  assert.ok(!stdio.includes('SYNTHETIC_SECRET'))

  const inline = targetSummary({ command: '/opt/bin/mcp', args: ['--token=SYNTHETIC_SECRET', 'positional'] }, 'stdio')
  assert.equal(inline, 'mcp --token')
  assert.ok(!inline.includes('SYNTHETIC_SECRET'))

  const attachedShort = targetSummary({ command: 'mysql', args: ['-pSYNTHETIC_SECRET', '-n'] }, 'stdio')
  assert.equal(attachedShort, 'mysql -n')
  assert.ok(!attachedShort.includes('SYNTHETIC_SECRET'))

  const validUrl = targetSummary({ url: 'https://alice:SYNTHETIC_SECRET@10.0.0.7:8443/private?token=SYNTHETIC_SECRET' }, 'streamable-http')
  assert.equal(validUrl, '10.0.0.7:8443')
  assert.ok(!validUrl.includes('SYNTHETIC_SECRET'))

  const invalid = targetSummary({ url: 'https://alice:SYNTHETIC_SECRET@bad host/private?token=SYNTHETIC_SECRET' }, 'streamable-http')
  assert.equal(invalid, '(invalid URL)')
  assert.ok(!invalid.includes('SYNTHETIC_SECRET'))

  assert.ok(targetSummary({ command: 'node' }, 'stdio').includes('node'))
  assert.equal(targetSummary({}, 'streamable-http'), '')
})

test('serverStatus keeps the documented vocabulary, including stopping', () => {
  assert.equal(serverStatus({ enabled: false }), 'stopped')
  assert.equal(serverStatus({ enabled: false, fiberPhase: 'unloading' }), 'stopping')
  assert.equal(serverStatus({ enabled: false, fiberPhase: 'active' }), 'stopping')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'unloading' }), 'stopping')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'pending' }), 'starting')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'loading' }), 'starting')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 0 }), 'idle')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 2 }), 'running')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'failed' }), 'error')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', diagnostic: 'boom' }), 'error')
  assert.equal(serverStatus({ enabled: false, fiberPhase: 'failed' }), 'stopped')
  assert.equal(serverStatus({ enabled: true }), 'unknown')
})

test('the MCP module identity is exact, not a prefix', () => {
  assert.equal(isMcpClientModule(MCP_CLIENT_MODULE), true)
  assert.equal(isMcpClientModule(`${MCP_CLIENT_MODULE}/lib/index.js`), true)
  assert.equal(isMcpClientModule(`${MCP_CLIENT_MODULE}-extra`), false)
  assert.equal(isMcpClientModule('@deepseek-ai/dsh-mcp-client2'), false)
  assert.equal(isMcpClientModule('x@deepseek-ai/dsh-mcp-client'), false)
  assert.equal(isMcpClientModule(undefined), false)
})

test('a hung listPlugins cannot block the phase wait forever', async () => {
  const hung = new Promise(() => {})
  const started = Date.now()
  const outcome = await withVirtualClock(10_000, () =>
    waitForServerPhase({ pluginManager: { listPlugins: () => hung } }, 'include:demo', true),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.outcome, 'timeout')
  assert.ok(Date.now() - started < 5000, 'the deadline is reachable even while the awaited call never settles')
})

test('a hung listPlugins cannot block the state route forever', async (t) => {
  const hung = new Promise(() => {})
  const env = await createManagementEnv({ manager: { listPlugins: () => hung } })
  t.after(() => env.dispose())

  const started = Date.now()
  const response = await withVirtualClock(10_000, () => request(env, STATE))
  assert.equal(response.status, 504)
  assert.equal(response.body.ok, false)
  assert.ok(Date.now() - started < 5000)
})

test('waitForServerPhase stops early on request abort', async () => {
  const hung = new Promise(() => {})
  const controller = new AbortController()
  const pending = waitForServerPhase(
    { pluginManager: { listPlugins: () => hung } },
    'include:demo',
    true,
    { signal: controller.signal, timeoutMs: 60_000 },
  )
  const timer = setTimeout(() => controller.abort(), 20)
  try {
    await assert.rejects(pending, (error) => error?.name === 'AbortError')
  } finally {
    clearTimeout(timer)
  }
})

test('waitForServerPhase does not report a still-unloading row as stopped', async () => {
  const stopped = await waitForServerPhase(
    { pluginManager: { listPlugins: async () => [{ entryId: 'x', enabled: false, fiberPhase: 'unloading' }] } },
    'x',
    false,
    { timeoutMs: 100 },
  )
  assert.equal(stopped.ok, false)
  assert.equal(stopped.outcome, 'timeout')
})

test('the control queue bounds its backlog and refuses with 429', async () => {
  const queue = createControlQueue({ maxPending: 2 })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const first = queue(() => gate)
  const second = queue(() => 'second')
  await assert.rejects(queue(() => 'third'), (error) => error instanceof QueueFullError && error.status === 429)
  release('first')
  assert.equal(await first, 'first')
  assert.equal(await second, 'second')
})

test('the HTTP routes answer 429 when the queue is full', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const env = await createManagementEnv({
    mutate(fakeRow, enabled) {
      fakeRow.enabled = enabled
      fakeRow.fiberPhase = enabled ? 'active' : null
      return gate.then(() => ({ application: 'applied' }))
    },
  })
  t.after(() => env.dispose())

  const requests = []
  for (let index = 0; index <= MAX_PENDING_OPERATIONS; index += 1) {
    requests.push(post(env, TOGGLE, { entryId: 'include:demo', enabled: false }))
  }
  // Let every handler enqueue before the head of the queue can finish.
  await new Promise((resolve) => setTimeout(resolve, 50))
  release()
  const responses = await Promise.all(requests)
  const statuses = responses.map((response) => response.status)
  assert.equal(statuses.filter((status) => status === 429).length, 1, `exactly one refusal: ${statuses.join(',')}`)
  assert.equal(statuses.filter((status) => status === 200).length, MAX_PENDING_OPERATIONS)
})

test('the model tool resolves uniquely and lists candidates on ambiguity', async (t) => {
  const rows = [row({ entryId: 'include:a', patchId: 'a' }), row({ entryId: 'include:b', patchId: 'b' })]
  const entries = [
    { id: 'include:a', options: { config: { serverName: 'dup', command: 'node' } } },
    { id: 'include:b', options: { config: { serverName: 'dup', command: 'node' } } },
  ]
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  const definition = env.ctx.tools.definitions().find((entry) => entry.name === 'mcp_server')
  assert.ok(definition, 'mcp_server must be registered')

  const ambiguous = await definition.execute({ server: 'dup', action: 'start' })
  assert.match(ambiguous, /matches 2 MCP servers/)
  assert.match(ambiguous, /Candidates:/)
  assert.match(ambiguous, /row a/)
  assert.match(ambiguous, /row b/)
  assert.equal(env.calls.length, 0)
})

test('the model tool reports the application and the observed state', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())

  const definition = env.ctx.tools.definitions().find((entry) => entry.name === 'mcp_server')
  const text = await definition.execute({ server: 'demo', action: 'stop' })
  assert.match(text, /stop: applied; observed stopped; application: applied/)
  assert.match(text, /MCP servers \(1\):/)
})

test('all three routes stay registered exactly as before', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())
  assert.deepEqual([...env.routes.keys()].sort(), [...MANAGEMENT_ROUTES].sort())
})

test('a server that never reaches its phase is a bounded 500, not a hang', async (t) => {
  // The same case as smoke.test.mjs, but with the JSON content type S1 now
  // requires; the harness request() does not send one, so that frozen test
  // reaches this route through a 415 before it ever gets here.
  const env = await createManagementEnv({
    rows: [row({ enabled: false, fiberPhase: null, toolCount: 0 })],
    mutate(fakeRow, enabled) {
      fakeRow.enabled = enabled
      fakeRow.fiberPhase = 'pending'
      return { application: 'applied' }
    },
  })
  t.after(() => env.dispose())

  const started = Date.now()
  const response = await withVirtualClock(10_000, () => post(env, TOGGLE, { entryId: 'include:demo', enabled: true }))
  assert.equal(response.status, 500)
  assert.equal(response.body.ok, false)
  assert.match(response.body.error, /timed out waiting for MCP server "demo" to start/)
  assert.ok(Date.now() - started < 10_000, 'the 30 s deadline must be reachable without real-time waiting')
})

/** A patch-file reader used to simulate HMR applying a `disabled` override. */
function patchReader(filePath, parse) {
  return () => {
    try {
      const entries = parse(fs.readFileSync(filePath, 'utf8'))
      return Array.isArray(entries) ? entries : []
    } catch {
      return []
    }
  }
}

test('a home-patch row is toggled through the home patch, never the manager', async (t) => {
  const managerCalls = []
  let env = null
  const readHome = () => patchReader(nodePath.join(env.home, 'cordis.patch.yml'), parse)()
  env = await createManagementEnv({
    rows: [row({ readOnlyReason: 'unaddressable' })],
    manager: {
      async listPlugins() {
        const declared = readHome().find((entry) => entry?.id === 'demo')
        const enabled = declared?.disabled !== true
        return [{ ...row({ readOnlyReason: 'unaddressable' }), enabled, fiberPhase: enabled ? 'active' : null }]
      },
      async setPluginEnabled(id, enabled) {
        managerCalls.push({ id, enabled })
        return { application: 'applied' }
      },
    },
  })
  t.after(() => env.dispose())
  fs.writeFileSync(nodePath.join(env.home, 'cordis.patch.yml'), '- id: demo\n  disabled: false\n', 'utf8')

  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
  assert.equal(response.status, 200)
  const result = resultOf(response)
  assert.equal(result.via, 'home-patch', 'the home layer wins for a home-declared row')
  assert.equal(result.observedStatus, 'stopped')
  assert.deepEqual(managerCalls, [], 'the manager must not be called for a home-patch row')
  const rewritten = parse(fs.readFileSync(nodePath.join(env.home, 'cordis.patch.yml'), 'utf8'))
  assert.equal(rewritten[0].disabled, true)
})

test('a profile-patch row is toggled through the profile patch', async (t) => {
  const managerCalls = []
  let env = null
  const readProfile = () => patchReader(env.patchPath, parse)()
  env = await createManagementEnv({
    rows: [row({ readOnlyReason: 'management-required' })],
    manager: {
      async listPlugins() {
        const declared = readProfile().find((entry) => entry?.id === 'demo')
        const enabled = declared?.disabled !== true
        return [{ ...row({ readOnlyReason: 'management-required' }), enabled, fiberPhase: enabled ? 'active' : null }]
      },
      async setPluginEnabled(id, enabled) {
        managerCalls.push({ id, enabled })
        return { application: 'applied' }
      },
    },
  })
  t.after(() => env.dispose())
  fs.writeFileSync(env.patchPath, '- id: demo\n  disabled: false\n', 'utf8')

  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
  assert.equal(response.status, 200)
  const result = resultOf(response)
  assert.equal(result.via, 'profile-patch')
  assert.equal(result.observedStatus, 'stopped')
  assert.deepEqual(managerCalls, [])
  assert.equal(parse(fs.readFileSync(env.patchPath, 'utf8'))[0].disabled, true)
})

test('a row locked by the Harness without a writable declaration is a 409', async (t) => {
  const env = await createManagementEnv({ rows: [row({ readOnlyReason: 'unaddressable' })] })
  t.after(() => env.dispose())
  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
  assert.equal(response.status, 409)
  assert.match(response.body.error, /locked by this Harness/)
  assert.equal(env.calls.length, 0)
})
