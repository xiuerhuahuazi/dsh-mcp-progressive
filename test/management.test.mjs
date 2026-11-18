/**
 * Management-half regression: route admission, strict bodies, the control
 * state machine and exact addressing.
 *
 * These tests drive the handlers `registerServerManagement` really registered
 * through `createManagementEnv` + `request`, so the fake plugin manager sees
 * exactly what a browser or the model would cause.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import nodePath from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

import { MANAGEMENT_ROUTES, createManagementEnv, request, withVirtualClock } from './harness.mjs'
import {
  MANAGER_CALL_MS,
  MCP_CLIENT_MODULE,
  MAX_PENDING_OPERATIONS,
  QueueFullError,
  SERVER_WAIT_MS,
  awaitBounded,
  boundedDeadline,
  createControlQueue,
  isMcpClientModule,
  liveStatusOf,
  liveStatusView,
  presentServer,
  readJsonBody,
  renderServerList,
  resolveServerTarget,
  sanitizeLiveStatus,
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

test('all three routes fail closed with 503 when the connection service is absent', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())
  const patchBefore = fs.readFileSync(env.patchPath, 'utf8')
  const rowBefore = env.row.enabled

  // An HMR recomposition can leave the routes registered while the service is
  // momentarily absent; a missing fence must never mean "trusted".
  env.services.delete('connection')

  const responses = [
    await request(env, STATE),
    await post(env, TOGGLE, { entryId: 'include:demo', enabled: false }),
    await post(env, RESTART, { entryId: 'include:demo' }),
  ]
  for (const response of responses) {
    assert.equal(response.status, 503)
    assert.deepEqual(response.body, {
      ok: false,
      error: 'management routes require the Host connection service',
    })
  }
  assert.equal(env.calls.length, 0, 'no manager call may happen without admission')
  assert.equal(env.row.enabled, rowBefore, 'no state may change without admission')
  assert.equal(fs.readFileSync(env.patchPath, 'utf8'), patchBefore, 'no patch write may happen without admission')

  // A service that exists but cannot answer admission is the same failure.
  env.services.set('connection', {})
  const noFence = await request(env, STATE)
  assert.equal(noFence.status, 503)
  assert.deepEqual(noFence.body, { ok: false, error: 'management routes require the Host connection service' })
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

// ---------------------------------------------------------------------------
// Security-audit regressions: F1 (restart abort rollback), F3 (per-call bound),
// F4 (queue deadline), F7 (stale observed tool count), F8 (body-read abort).
// ---------------------------------------------------------------------------

/** Open one registered route with a raw req/res pair the test can abort mid-flight. */
function openRoute(env, routePath) {
  const handler = env.routes.get(routePath)
  if (handler === undefined) throw new Error(`route not registered: ${routePath}`)
  const req = new EventEmitter()
  Object.assign(req, {
    headers: { host: '127.0.0.1:53809', 'content-type': 'application/json' },
    method: 'POST',
    url: routePath,
    destroyed: false,
    destroy() {
      this.destroyed = true
    },
  })
  const res = new EventEmitter()
  Object.assign(res, {
    headersSent: false,
    writableFinished: false,
    writeHead(status) {
      this.status = status
      this.headersSent = true
      return this
    },
    end(payload) {
      this.raw = payload
      this.writableFinished = true
      return this
    },
  })
  const pending = handler(req, res)
  return { req, res, pending }
}

/** Feed one complete JSON body to a raw request opened by `openRoute`. */
function sendBody(req, body) {
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
}

/** The JSON answer a raw response received, if any. */
function answerOf(res) {
  return typeof res.raw === 'string' ? JSON.parse(res.raw) : undefined
}

/** Settle a promise or fail the test; the timer is cleared so the process can exit. */
function within(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

test('F1: an abort mid-restart restores the preference instead of leaving disabled: true', async (t) => {
  const env = await createManagementEnv({ rows: [row({ enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' })] })
  t.after(() => env.dispose())
  const homePatch = nodePath.join(env.home, 'cordis.patch.yml')
  fs.writeFileSync(
    homePatch,
    '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: demo\n        command: node\n',
    'utf8',
  )

  const { req, res, pending } = openRoute(env, RESTART)
  sendBody(req, { entryId: 'include:demo' })
  // The row never unloads, so the stop step is still waiting for its phase here.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.match(fs.readFileSync(homePatch, 'utf8'), /disabled: true/, 'the stop persisted disabled: true before the abort')

  res.emit('close') // the panel's 10 s deadline or an unmount
  await within(pending, 5000, 'aborted restart')

  const answer = answerOf(res)
  assert.equal(res.status, 500)
  assert.equal(answer.ok, false)
  assert.match(answer.error, /restart aborted/)
  assert.equal(answer.rollback, 'preference-restored')
  const rewritten = parse(fs.readFileSync(homePatch, 'utf8'))
  const override = rewritten.find((entry) => entry?.id === 'demo')
  assert.ok(override, 'the row stays declared in the home patch')
  assert.equal(override.disabled, false, 'the persisted preference must not drift to disabled')
  assert.equal(env.calls.length, 0)
})

test('F1: an abort at the stop/start boundary restores the pre-restart preference', async (t) => {
  let env = null
  let activeRes = null
  let disabledReads = 0
  env = await createManagementEnv({
    rows: [row({ enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' })],
    entries: [{ id: 'include:demo', options: { config: { serverName: 'demo', command: 'node' } } }],
    manager: {
      // HMR stand-in: the row follows the home patch.
      async listPlugins() {
        const entriesNow = parse(fs.readFileSync(nodePath.join(env.home, 'cordis.patch.yml'), 'utf8'))
        const override = entriesNow.find((entry) => entry?.id === 'demo')
        const enabled = override?.disabled !== true
        const live = {
          entryId: 'include:demo',
          patchId: 'demo',
          moduleName: MCP_CLIENT_MODULE,
          enabled,
          fiberPhase: enabled ? 'active' : null,
          toolCount: 0,
          readOnlyReason: 'unaddressable',
        }
        if (!enabled) {
          disabledReads += 1
          if (disabledReads >= 2) {
            // The stop is done; hold the start-step read so the abort lands at
            // the stop/start boundary, before the start writes a preference.
            setTimeout(() => activeRes?.emit('close'), 10)
            return new Promise((resolve) => setTimeout(() => resolve([live]), 80))
          }
        }
        return [live]
      },
      async setPluginEnabled() {
        throw new Error('the home patch owns this row')
      },
    },
  })
  t.after(() => env.dispose())
  const homePatch = nodePath.join(env.home, 'cordis.patch.yml')
  fs.writeFileSync(
    homePatch,
    '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: demo\n        command: node\n',
    'utf8',
  )

  const opened = openRoute(env, RESTART)
  activeRes = opened.res
  sendBody(opened.req, { entryId: 'include:demo' })
  await within(opened.pending, 5000, 'boundary abort')

  const answer = answerOf(opened.res)
  assert.equal(opened.res.status, 500)
  assert.match(answer.error, /restart aborted/)
  assert.equal(answer.rollback, 'preference-restored')
  const rewritten = parse(fs.readFileSync(homePatch, 'utf8'))
  assert.equal(rewritten.find((entry) => entry?.id === 'demo')?.disabled, false)
  assert.equal(env.calls.length, 0)
})

test('F3: boundedDeadline takes the earlier of the operation and per-call budgets', () => {
  assert.equal(boundedDeadline({}, 0), MANAGER_CALL_MS, 'the per-call constant is the default bound')
  assert.equal(boundedDeadline({ deadline: 1_000_000, timeoutMs: 50 }, 0), 50, 'the per-call budget wins over a longer operation')
  assert.equal(boundedDeadline({ deadline: 10, timeoutMs: 50 }, 0), 10, 'a shorter operation budget still wins')
  assert.equal(boundedDeadline({ deadline: 1_000 }, 0), 1_000)
})

test('F3: a hung listPlugins fails on the per-call budget, not the 30 s operation deadline', async () => {
  const hung = new Promise(() => {})
  const started = Date.now()
  await assert.rejects(
    awaitBounded(hung, { deadline: Date.now() + SERVER_WAIT_MS, timeoutMs: 50, label: 'listPlugins' }),
    (error) => error?.status === 504 && /listPlugins did not answer in time/.test(error.message),
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 40 && elapsed < 1500, `per-call bound must fire near its own 50 ms budget (took ${elapsed} ms)`)
})

test('F4: a queued operation gets its budget when it starts, not when it joined the queue', async (t) => {
  let releaseFirst
  const gate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  let managerCalls = 0
  const env = await createManagementEnv({
    rows: [row({ enabled: true, fiberPhase: 'active' })],
    mutate(fakeRow, enabled) {
      managerCalls += 1
      if (managerCalls === 1) return gate
      fakeRow.enabled = enabled
      fakeRow.fiberPhase = enabled ? 'active' : null
      return { application: 'applied' }
    },
  })
  t.after(() => env.dispose())

  const [held, queued] = await withVirtualClock(1_000, async () => {
    const first = post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
    const second = post(env, TOGGLE, { entryId: 'include:demo', enabled: false })
    // Let both handlers join the queue while the head is gated.
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Burn well past the second request's enqueue-time 30 s budget.
    for (let index = 0; index < 40; index += 1) Date.now()
    releaseFirst()
    return Promise.all([first, second])
  })

  assert.notEqual(held.status, 200, 'the gated head fails')
  assert.equal(queued.status, 200, 'the queued operation must run with a fresh budget, not 504')
  assert.equal(queued.body.ok, true)
  assert.equal(queued.body.result.applied, true)
  assert.equal(queued.body.result.observedStatus, 'stopped')
  assert.equal(managerCalls, 2)
})

test('F7: a started server reports the freshly observed tool count, not "idle"', async (t) => {
  let env = null
  env = await createManagementEnv({
    rows: [row({ enabled: false, fiberPhase: null, toolCount: 0 })],
    entries: [{ id: 'include:demo', options: { config: { serverName: 'fresh', command: 'node' } } }],
    mutate(fakeRow, enabled) {
      fakeRow.enabled = enabled
      fakeRow.fiberPhase = enabled ? 'active' : null
      // The started server exposes a tool; the pre-operation snapshot could not
      // know that, the live registry can.
      env.ctx.tools.register({
        name: 'mcp__fresh__ping',
        description: 'ping',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      })
      return { application: 'applied' }
    },
  })
  t.after(() => env.dispose())

  const response = await post(env, TOGGLE, { entryId: 'include:demo', enabled: true })
  assert.equal(response.status, 200)
  const result = resultOf(response)
  assert.equal(result.observedStatus, 'running', 'a server that loaded tools is running, not idle')
  assert.equal(response.body.servers[0].toolCount, 1)
  assert.equal(response.body.servers[0].status, 'running')
})

test('F8: a client disconnect mid-body rejects the read and never reaches the manager', async (t) => {
  const env = await createManagementEnv()
  t.after(() => env.dispose())
  const patchBefore = fs.readFileSync(env.patchPath, 'utf8')

  for (const event of ['close', 'aborted']) {
    const { req, res, pending } = openRoute(env, TOGGLE)
    req.emit('data', Buffer.from('{"entryId":"include:demo",'))
    // No 'end': the client vanishes in the middle of the body.
    req.emit(event)
    await within(pending, 2000, `mid-body ${event}`)
    assert.equal(res.status, 500, `a mid-body ${event} answers instead of hanging`)
    assert.match(answerOf(res).error, /aborted/)
  }

  assert.equal(env.calls.length, 0)
  assert.equal(env.row.enabled, true)
  assert.equal(fs.readFileSync(env.patchPath, 'utf8'), patchBefore)
})

test('F8: readJsonBody rejects with an AbortError on a premature close', async () => {
  const req = new EventEmitter()
  const reading = readJsonBody(req)
  req.emit('data', Buffer.from('{"partial":'))
  req.emit('close')
  await assert.rejects(reading, (error) => error?.name === 'AbortError')
})

test('F1b: a timed-out stop during restart restores the preference and reports the rollback', async (t) => {
  const env = await createManagementEnv({ rows: [row({ enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' })] })
  t.after(() => env.dispose())
  const homePatch = nodePath.join(env.home, 'cordis.patch.yml')
  fs.writeFileSync(
    homePatch,
    '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: demo\n        command: node\n',
    'utf8',
  )

  const started = Date.now()
  // The row never unloads, so the stop waits until its 30 s phase deadline; the
  // virtual clock reaches that deadline without a live 30 s wait.
  const response = await withVirtualClock(10_000, () => post(env, RESTART, { entryId: 'include:demo' }))
  const elapsed = Date.now() - started

  assert.equal(response.status, 500)
  assert.equal(response.body.ok, false)
  assert.match(response.body.error, /restart failed/)
  assert.match(response.body.error, /timed out waiting/)
  assert.equal(response.body.rollback, 'preference-restored')
  const rewritten = parse(fs.readFileSync(homePatch, 'utf8'))
  assert.equal(rewritten.find((entry) => entry?.id === 'demo')?.disabled, false, 'the patch must not stay disabled: true')
  assert.equal(env.calls.length, 0)
  assert.ok(elapsed < 10_000, `the virtual clock must reach the deadline quickly (took ${elapsed} ms)`)
})

test('F1b: a failed restart of an already-disabled server performs no rollback write', async (t) => {
  const env = await createManagementEnv({ rows: [row({ enabled: false, fiberPhase: null, readOnlyReason: 'unaddressable' })] })
  t.after(() => env.dispose())
  const homePatch = nodePath.join(env.home, 'cordis.patch.yml')
  fs.writeFileSync(
    homePatch,
    '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: demo\n        command: node\n- id: demo\n  disabled: true\n',
    'utf8',
  )

  const response = await withVirtualClock(10_000, () => post(env, RESTART, { entryId: 'include:demo' }))

  assert.equal(response.status, 500)
  assert.match(response.body.error, /restart failed/)
  // Nothing was stopped, so there is no pre-restart "enabled" preference to
  // restore: the start's own write stands and the body carries no rollback.
  assert.equal(response.body.rollback, null)
  const rewritten = parse(fs.readFileSync(homePatch, 'utf8'))
  assert.equal(rewritten.find((entry) => entry?.id === 'demo')?.disabled, false)
  assert.equal(env.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Live connection status (1.3.0).
//
// The Loader entry's own `moduleNamespace` is the only route to the RUNNING
// mcp-client instance; these fixtures expose the same
// `connectionStatusOf(fiber) → { current(), onChange() }` seam the real client
// does, with `onChange` throwing so a subscription attempt fails the test.
// ---------------------------------------------------------------------------

/**
 * One Loader entry whose module namespace exposes a live status cell.
 *
 * @param {string} id entry id
 * @param {object|Function|null} statusOrThunk the status `current()` returns
 * @param {object} [overrides] entry fields the test wants to replace
 * @returns {{entry: object, fibers: object[], onChangeCalls: number}}
 */
function liveEntry(id, statusOrThunk, overrides = {}) {
  const fibers = []
  let onChangeCalls = 0
  const entry = {
    id,
    options: { config: { serverName: id.split(':').pop(), command: 'node' } },
    moduleNamespace: {
      connectionStatusOf(fiber) {
        fibers.push(fiber)
        return {
          current() {
            if (typeof statusOrThunk === 'function') return statusOrThunk()
            return statusOrThunk
          },
          onChange() {
            onChangeCalls += 1
            throw new Error('live status must be read, never subscribed')
          },
        }
      },
    },
    // The entry's fiber is the `ctx.plugin()` handle: the real fiber sits behind
    // `fiber.ctx.fiber`, which is the key of the client's status WeakMap.
    fiber: { ctx: { fiber: { tag: id } } },
    ...overrides,
  }
  return {
    entry,
    fibers,
    get onChangeCalls() {
      return onChangeCalls
    },
  }
}

test('liveStatusView maps every MCP state onto the public vocabulary and a one-line detail', () => {
  const now = 1_700_000_000_000
  const view = (live, overrides = {}) => liveStatusView({ enabled: true, live, ...overrides }, now)

  assert.deepEqual(view({ state: 'connected', toolCount: 3, connectedAt: now }), { status: 'running', detail: null })
  assert.deepEqual(view({ state: 'connected', toolCount: 0, connectedAt: now }), { status: 'idle', detail: null })
  assert.deepEqual(view({ state: 'connecting', attempt: 0 }), { status: 'starting', detail: 'connecting (attempt 1)' })
  assert.deepEqual(
    view({ state: 'reconnecting', attempt: 2, maxAttempts: 5, nextRetryAtMs: now + 3000, lastError: 'spawn ENOENT' }),
    { status: 'starting', detail: 'reconnecting (attempt 2/5) · retry in 3s · spawn ENOENT' },
  )
  assert.deepEqual(
    view({ state: 'reconnecting', attempt: 1, maxAttempts: 3, nextRetryAtMs: now - 500 }),
    { status: 'starting', detail: 'reconnecting (attempt 1/3)' },
    'a retry time already in the past is not advertised',
  )
  assert.deepEqual(
    view({ state: 'reconnecting', attempt: 1 }),
    { status: 'starting', detail: 'reconnecting' },
    'an incomplete status degrades instead of inventing numbers',
  )
  assert.deepEqual(view({ state: 'waiting-credentials', lastError: 'missing token' }), {
    status: 'starting',
    detail: 'waiting for credentials',
  })
  assert.deepEqual(view({ state: 'closed' }), { status: 'starting', detail: 'closed' })
  assert.deepEqual(view({ state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' }), {
    status: 'error',
    detail: 'failed: gave-up · spawn ENOENT',
  })
  assert.deepEqual(view({ state: 'failed', reason: 'reconnect-disabled' }), {
    status: 'error',
    detail: 'failed: reconnect-disabled',
  })

  // Nothing usable: the inferred status stays in charge, exactly as before.
  assert.equal(liveStatusView({ enabled: true }, now), null)
  assert.equal(liveStatusView({ enabled: true, live: null }, now), null)
  assert.equal(liveStatusView({ enabled: true, live: { state: 'from-the-future' } }, now), null)
  assert.equal(liveStatusView({ enabled: true, live: {} }, now), null)
  // A row configured off is stopped no matter what its last cell says.
  assert.equal(liveStatusView({ enabled: false, live: { state: 'connected', toolCount: 3 } }, now), null)
  // An unloading row is "stopping", never the live state.
  assert.equal(liveStatusView({ enabled: true, fiberPhase: 'unloading', live: { state: 'connected', toolCount: 3 } }, now), null)
})

test('serverStatus prefers the live status and keeps the inference when it is absent', () => {
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 3 }), 'running')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 0 }), 'idle')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 3, live: { state: 'failed', reason: 'gave-up' } }), 'error')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 0, live: { state: 'connected', toolCount: 0 } }), 'idle')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 0, live: { state: 'connected', toolCount: 2 } }), 'running')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 0, live: { state: 'reconnecting', attempt: 1, maxAttempts: 2 } }), 'starting')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 0, live: { state: 'closed' } }), 'starting')
  assert.equal(serverStatus({ enabled: false, fiberPhase: null, live: { state: 'connected', toolCount: 2 } }), 'stopped')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 2, live: { state: 'bogus' } }), 'running', 'an unknown state falls back')
  assert.equal(serverStatus({ enabled: true }), 'unknown')
})

test('sanitizeLiveStatus keeps only the documented fields and bounded text', () => {
  assert.deepEqual(
    sanitizeLiveStatus({
      state: 'reconnecting',
      attempt: 2,
      maxAttempts: Number.POSITIVE_INFINITY,
      nextRetryAtMs: Number.NaN,
      toolCount: -1,
      connectedAt: 1,
      reason: 42,
      lastError: 'spawn ENOENT\nat /very/long/path',
      secret: 'SYNTHETIC_SECRET',
      extra: { nested: true },
    }),
    {
      state: 'reconnecting',
      toolCount: -1,
      connectedAt: 1,
      attempt: 2,
      lastError: 'spawn ENOENT at /very/long/path',
    },
    'infinite/NaN numbers, non-string text and unknown fields are dropped',
  )
  assert.equal(sanitizeLiveStatus(null), null)
  assert.equal(sanitizeLiveStatus('connected'), null)
  assert.equal(sanitizeLiveStatus({}), null)
  assert.equal(sanitizeLiveStatus({ state: '' }), null)
  assert.equal(liveStatusOf(undefined), null, 'a row without a Loader entry has no live status')
})

test('the status detail clips a long lastError to one bounded line', () => {
  const longError = `spawn ENOENT at /very/long/path/${'x'.repeat(400)}\nsecond line`
  const view = liveStatusView({ enabled: true, live: { state: 'failed', reason: 'gave-up', lastError: longError } })
  assert.match(view.detail, /^failed: gave-up · spawn ENOENT at \/very\/long\/path\//)
  assert.ok(view.detail.length <= 140, `detail is bounded (length ${view.detail.length})`)
  assert.ok(!view.detail.includes('\n'))
})

test('the state route reports a reconnecting row as starting with its live detail', async (t) => {
  const nextRetryAtMs = Date.now() + 3000
  const { entry, fibers, onChangeCalls } = liveEntry('include:demo', {
    state: 'reconnecting',
    attempt: 2,
    maxAttempts: 5,
    nextRetryAtMs,
    lastError: 'spawn ENOENT',
    secret: 'SYNTHETIC_SECRET',
  })
  const env = await createManagementEnv({ rows: [row()], entries: [entry] })
  t.after(() => env.dispose())

  const response = await request(env, STATE)
  assert.equal(response.status, 200)
  const server = response.body.servers[0]
  assert.equal(server.status, 'starting')
  assert.equal(server.statusDetail, `reconnecting (attempt 2/5) · retry in 3s · spawn ENOENT`)
  assert.deepEqual(server.live, { state: 'reconnecting', attempt: 2, maxAttempts: 5, nextRetryAtMs, lastError: 'spawn ENOENT' })
  assert.equal(server.toolCount, 3, 'not connected: the registry prefix count is kept')
  assert.equal(server.diagnostic, null, 'a connection failure is not a fiber diagnostic')
  assert.deepEqual(fibers, [{ tag: 'include:demo' }], 'the read is normalized to fiber.ctx.fiber')
  assert.equal(onChangeCalls, 0, 'reading must never subscribe')
  assert.ok(!JSON.stringify(response.body).includes('SYNTHETIC_SECRET'), 'a status cannot smuggle fields into the payload')
  assert.equal(env.calls.length, 0)
})

test('a connected row is running or idle by the live tool count, which wins over the prefix count', async (t) => {
  const rows = [
    row({ entryId: 'include:demo', patchId: 'demo' }),
    row({ entryId: 'include:idle', patchId: 'idle', toolCount: 0 }),
  ]
  const entries = [
    liveEntry('include:demo', { state: 'connected', toolCount: 7, connectedAt: 1_700_000_000_000 }).entry,
    liveEntry('include:idle', { state: 'connected', toolCount: 0, connectedAt: 1_700_000_000_000 }).entry,
  ]
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  const response = await request(env, STATE)
  assert.equal(response.status, 200)
  const byName = new Map(response.body.servers.map((server) => [server.serverName, server]))

  const demo = byName.get('demo')
  assert.equal(demo.status, 'running')
  assert.equal(demo.toolCount, 7, 'the live generation count wins over the 3 prefix matches')
  assert.equal(demo.live.toolCount, 7)
  assert.equal(demo.statusDetail, null)

  const idle = byName.get('idle')
  assert.equal(idle.status, 'idle')
  assert.equal(idle.toolCount, 0)
  assert.equal(idle.statusDetail, null)
})

test('a failed live status is an error and a disabled row stays stopped', async (t) => {
  const rows = [
    row({ entryId: 'include:broken', patchId: 'broken', toolCount: 0 }),
    row({ entryId: 'include:off', patchId: 'off', enabled: false, fiberPhase: null, toolCount: 0 }),
  ]
  const entries = [
    liveEntry('include:broken', { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' }).entry,
    liveEntry('include:off', { state: 'connected', toolCount: 4, connectedAt: 1 }).entry,
  ]
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  const response = await request(env, STATE)
  assert.equal(response.status, 200)
  const byName = new Map(response.body.servers.map((server) => [server.serverName, server]))

  const broken = byName.get('broken')
  assert.equal(broken.status, 'error')
  assert.equal(broken.statusDetail, 'failed: gave-up · spawn ENOENT')
  assert.equal(broken.live.reason, 'gave-up')
  assert.equal(broken.live.lastError, 'spawn ENOENT')

  const off = byName.get('off')
  assert.equal(off.status, 'stopped', 'a row configured off never reports the live state')
  assert.equal(off.statusDetail, null)
  assert.equal(off.live.state, 'connected', 'its last cell is still reported as data')
})

test('a Loader entry without a usable live-status seam falls back cleanly (older DSH)', async (t) => {
  const config = { config: { serverName: 'demo', command: 'node' } }
  const entries = [
    // No module namespace at all (a Loader this version does not expose).
    { id: 'include:plain', options: config },
    // A namespace without the seam (group/builtin rows look like this).
    { id: 'include:ns', options: config, moduleNamespace: { apply() {} }, fiber: { ctx: { fiber: {} } } },
    // The seam exists but is not a function.
    { id: 'include:notfn', options: config, moduleNamespace: { connectionStatusOf: 'nope' }, fiber: { ctx: { fiber: {} } } },
  ]
  const rows = ['plain', 'ns', 'notfn'].map((name) => row({ entryId: `include:${name}`, patchId: name }))
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  const response = await request(env, STATE)
  assert.equal(response.status, 200)
  for (const server of response.body.servers) {
    assert.equal(server.live, null, `${server.serverName} has no live status`)
    assert.equal(server.statusDetail, null)
    assert.equal(server.status, 'running', 'the pre-1.3 inference is unchanged')
    assert.equal(server.toolCount, 3)
  }
  assert.equal(env.calls.length, 0)
})

test('a throwing or empty live read falls back instead of failing the request', async (t) => {
  const config = () => ({ config: { serverName: 'demo', command: 'node' } })
  const entries = [
    {
      id: 'include:throws',
      options: config(),
      moduleNamespace: {
        connectionStatusOf() {
          throw new Error('synthetic read failure')
        },
      },
      fiber: { ctx: { fiber: {} } },
    },
    { id: 'include:undef', options: config(), moduleNamespace: { connectionStatusOf: () => undefined }, fiber: { ctx: { fiber: {} } } },
    { id: 'include:nocurrent', options: config(), moduleNamespace: { connectionStatusOf: () => ({}) }, fiber: { ctx: { fiber: {} } } },
    liveEntry('include:currentthrows', () => {
      throw new Error('cell exploded')
    }, { options: config() }).entry,
    liveEntry('include:garbage', { state: 42 }, { options: config() }).entry,
  ]
  const rows = ['throws', 'undef', 'nocurrent', 'currentthrows', 'garbage']
    .map((name) => row({ entryId: `include:${name}`, patchId: name }))
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  const response = await request(env, STATE)
  assert.equal(response.status, 200)
  for (const server of response.body.servers) {
    assert.equal(server.live, null, `${server.serverName} fell back`)
    assert.equal(server.statusDetail, null)
    assert.equal(server.status, 'running', 'the inference still answers')
  }

  // The raw helper itself never throws either, and a fiber without `ctx` is
  // passed through unchanged.
  const plainFiber = { plain: true }
  let received = null
  const direct = liveStatusOf({
    fiber: plainFiber,
    moduleNamespace: {
      connectionStatusOf(fiber) {
        received = fiber
        return { current: () => ({ state: 'closed' }) }
      },
    },
  })
  assert.deepEqual(direct, { state: 'closed' })
  assert.equal(received, plainFiber, 'a fiber that has no ctx is passed through as-is')
})

test('presentServer carries live and statusDetail without changing the rest of the contract', () => {
  const presented = presentServer({
    entryId: 'include:demo',
    id: 'demo',
    serverName: 'demo',
    transport: 'stdio',
    target: 'node',
    enabled: true,
    fiberPhase: 'active',
    toolCount: 0,
    live: { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' },
    diagnostic: null,
  })
  assert.deepEqual(presented, {
    entryId: 'include:demo',
    id: 'demo',
    serverName: 'demo',
    transport: 'stdio',
    target: 'node',
    enabled: true,
    fiberPhase: 'active',
    live: { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' },
    toolCount: 0,
    status: 'error',
    statusDetail: 'failed: gave-up · spawn ENOENT',
    diagnostic: null,
  })

  const plain = presentServer({
    entryId: null, id: 'x', serverName: 'x', transport: 'stdio', target: '', enabled: true, fiberPhase: 'active', toolCount: 2,
  })
  assert.equal(plain.live, null)
  assert.equal(plain.statusDetail, null)
  assert.equal(plain.status, 'running')
})

test('the model-facing text appends the live status detail', async (t) => {
  const { entry } = liveEntry('include:demo', { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' })
  const env = await createManagementEnv({ rows: [row()], entries: [entry] })
  t.after(() => env.dispose())

  const list = env.ctx.tools.definitions().find((candidate) => candidate.name === 'mcp_servers')
  const text = await list.execute({})
  assert.match(text, /^MCP servers \(1\):$/m)
  assert.match(text, /- demo \(row demo\): error — failed: gave-up · spawn ENOENT, 3 tools — stdio node/)

  const detail = liveStatusView({
    enabled: true,
    live: { state: 'reconnecting', attempt: 1, maxAttempts: 3, nextRetryAtMs: Date.now() + 5000, lastError: 'connect ECONNREFUSED' },
  })
  const rendered = renderServerList([{
    id: 'demo',
    serverName: 'demo',
    transport: 'stdio',
    target: '',
    enabled: true,
    fiberPhase: 'active',
    toolCount: 0,
    live: { state: 'reconnecting', attempt: 1, maxAttempts: 3, nextRetryAtMs: Date.now() + 5000, lastError: 'connect ECONNREFUSED' },
  }])
  assert.ok(rendered.includes(`starting — ${detail.detail}`))
  assert.equal(rendered.split('\n').length, 3, 'the detail is one line and the list keeps its shape')
})

test('the mcp_server result text carries the live detail in its trailing list', async (t) => {
  const { entry } = liveEntry('include:demo', { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' })
  const env = await createManagementEnv({
    rows: [row({ enabled: false, fiberPhase: null, toolCount: 0 })],
    entries: [entry],
    mutate(fakeRow, enabled) {
      fakeRow.enabled = enabled
      fakeRow.fiberPhase = enabled ? 'active' : null
      return { application: 'applied' }
    },
  })
  t.after(() => env.dispose())

  const definition = env.ctx.tools.definitions().find((candidate) => candidate.name === 'mcp_server')
  const text = await definition.execute({ server: 'demo', action: 'start' })
  assert.match(text, /start: applied; observed error/)
  assert.match(text, /- demo \(row demo\): error — failed: gave-up · spawn ENOENT/)
})

test('reading live status never reaches a write path', async (t) => {
  const { entry } = liveEntry('include:demo', { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' })
  const env = await createManagementEnv({ rows: [row()], entries: [entry] })
  t.after(() => env.dispose())
  const patchBefore = fs.readFileSync(env.patchPath, 'utf8')

  for (let index = 0; index < 3; index += 1) await request(env, STATE)

  assert.equal(env.calls.length, 0, 'no setPluginEnabled call may follow a read')
  assert.equal(env.row.enabled, true)
  assert.equal(fs.readFileSync(env.patchPath, 'utf8'), patchBefore, 'no patch write may follow a read')
})

test('F3: a failed fiber outranks a stale live cell', async (t) => {
  // The 1.3 review repro: a colliding re-apply disposes the old supervisor
  // before the new apply throws, so the surviving cell says "closed" while the
  // fiber is failed. The failed fiber (and its diagnostic) must own the row.
  const diagnostic = 'mcp-client: serverName "demo" is already in use by another mcp-client instance'
  const rows = [row({ entryId: 'include:demo', fiberPhase: 'failed', diagnostic })]
  const entries = [liveEntry('include:demo', { state: 'closed' }).entry]
  const env = await createManagementEnv({ rows, entries })
  t.after(() => env.dispose())

  // The pure helpers agree before the route is involved.
  for (const stale of [{ state: 'closed' }, { state: 'waiting-credentials', lastError: 'missing token' }, { state: 'connected', toolCount: 2 }]) {
    assert.equal(liveStatusView({ enabled: true, fiberPhase: 'failed', live: stale }), null)
    assert.equal(serverStatus({ enabled: true, fiberPhase: 'failed', toolCount: 0, live: stale }), 'error')
  }

  const response = await request(env, STATE)
  assert.equal(response.status, 200)
  const server = response.body.servers[0]
  assert.equal(server.status, 'error', 'the failed fiber is reported as an error, not as "starting"')
  assert.equal(server.statusDetail, null, 'a stale cell supplies no detail for a failed fiber')
  assert.deepEqual(server.live, { state: 'closed' }, 'the cell is still reported as data, without overriding')
  assert.equal(server.diagnostic, diagnostic)

  const list = env.ctx.tools.definitions().find((candidate) => candidate.name === 'mcp_servers')
  const text = await list.execute({})
  assert.match(text, /: error,/)
  assert.match(text, /; diagnostic: mcp-client: serverName "demo" is already in use/)
  assert.ok(!text.includes('— closed'), 'the stale "closed" detail must not reach the model')
})

test('F5: a hand-built non-string lastError cannot make the detail throw', () => {
  const hostile = {
    toString() {
      throw new Error('boom')
    },
  }
  const view = (live) => liveStatusView({ enabled: true, live })

  // Nothing here may throw, and every detail stays one bounded line.
  for (const lastError of [{ code: 'X' }, 42, true, 10n, hostile, null, undefined, ['a', 'b']]) {
    assert.doesNotThrow(() => view({ state: 'failed', reason: 'gave-up', lastError }))
    const failed = view({ state: 'failed', reason: 'gave-up', lastError })
    assert.equal(failed.status, 'error')
    assert.equal(typeof failed.detail, 'string')
    assert.ok(failed.detail.length <= 180, `bounded detail for ${String(typeof lastError)} (length ${failed.detail.length})`)
    assert.ok(!failed.detail.includes('\n'))
    assert.doesNotThrow(() => view({ state: 'reconnecting', attempt: 1, maxAttempts: 2, lastError }))
  }

  // Primitives stay readable; objects are dropped instead of coerced.
  assert.equal(view({ state: 'failed', reason: 'gave-up', lastError: 42 }).detail, 'failed: gave-up · 42')
  assert.equal(view({ state: 'failed', reason: 'gave-up', lastError: hostile }).detail, 'failed: gave-up')
  assert.equal(view({ state: 'failed', reason: 'gave-up', lastError: { code: 'X' } }).detail, 'failed: gave-up')
  assert.equal(
    view({ state: 'reconnecting', attempt: 1, maxAttempts: 2, lastError: { code: 'X' } }).detail,
    'reconnecting (attempt 1/2)',
  )
})
