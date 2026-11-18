/**
 * Smoke regression for dsh-mcp-progressive.
 *
 * These assertions hold on the 1.2.0 baseline and must keep holding after the
 * `lib/` extraction: the plugin keeps its public shape (`name`, `apply`,
 * `__test`) and the management half keeps answering on the same three routes.
 *
 * Runtime-dependent cases skip themselves when the unpacked DSH runtime is
 * absent (CI has none) — see `hasRuntime()` in ./harness.mjs.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MANAGEMENT_ROUTES,
  PLUGIN_ENTRY,
  callTool,
  createManagementEnv,
  findNode,
  flushMicrotasks,
  hasRuntime,
  mountClientPanel,
  mountPlugin,
  request,
  withVirtualClock,
} from './harness.mjs'

const plugin = await import(PLUGIN_ENTRY)

test('the plugin module loads and keeps its public shape', () => {
  assert.equal(plugin.name, 'mcp-progressive')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.__test, 'object')
})

test('__test exposes the stable pure-helper seam', () => {
  for (const helper of ['setPatchDisabled', 'patchDeclares', 'serverStatus', 'targetSummary', 'yamlScalar']) {
    assert.equal(typeof plugin.__test[helper], 'function', `__test.${helper} must be a function`)
  }
})

test('the pure helpers behave as documented', async () => {
  const { setPatchDisabled, patchDeclares, serverStatus, targetSummary, yamlScalar } = plugin.__test
  const { parse } = await import('yaml')

  // The rewrite is asserted on the parsed document, not on the exact bytes:
  // what matters is that the flag is set and the patch stays parseable.
  assert.deepEqual(parse(setPatchDisabled('- id: demo\n  disabled: false\n', 'demo', true)), [
    { id: 'demo', disabled: true },
  ])
  assert.deepEqual(parse(setPatchDisabled('- id: demo\n  disabled: true\n', 'demo', false)), [
    { id: 'demo', disabled: false },
  ])
  assert.equal(patchDeclares('- id: demo\n  disabled: false\n', 'demo'), true)
  assert.equal(patchDeclares('- id: other\n  disabled: false\n', 'demo'), false)

  assert.equal(serverStatus({ enabled: false }), 'stopped')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 3 }), 'running')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'active', toolCount: 0 }), 'idle')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'failed' }), 'error')
  assert.equal(serverStatus({ enabled: true, fiberPhase: 'pending' }), 'starting')

  assert.equal(yamlScalar('demo'), 'demo')
  assert.equal(yamlScalar('demo space'), '"demo space"')
  assert.ok(targetSummary({ command: 'node' }, 'stdio').includes('node'))
})

test('the management half registers its three routes and two tools', async (t) => {
  const env = await createManagementEnv()
  t.after(async () => env.dispose())

  assert.deepEqual([...env.routes.keys()].sort(), [...MANAGEMENT_ROUTES].sort())

  const names = env.ctx.tools
    .definitions()
    .map((definition) => definition.name)
    .filter((name) => !name.startsWith('mcp__demo__'))
    .sort()
  assert.deepEqual(names, ['mcp_call', 'mcp_load', 'mcp_search', 'mcp_server', 'mcp_servers'])
})

test('the management state route answers with the server list', async (t) => {
  const env = await createManagementEnv()
  t.after(async () => env.dispose())

  const response = await request(env, '/dsh-mcp-hub/state')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.ok(Array.isArray(response.body.servers))
  assert.equal(response.body.servers.length, 1)
  assert.equal(response.body.servers[0].serverName, 'demo')
  assert.equal(response.body.servers[0].status, 'running')
})

test('a server that never reaches its phase fails instead of hanging forever', async (t) => {
  // The plugin polls the server phase against a fixed 30 s deadline. The
  // virtual clock makes that deadline reachable in a few hundred milliseconds
  // of real time, so the case stays cheap and deterministic.
  const env = await createManagementEnv({
    rows: [
      {
        entryId: 'include:demo',
        patchId: 'demo',
        moduleName: '@deepseek-ai/dsh-mcp-client',
        enabled: false,
        fiberPhase: null,
        toolCount: 0,
        readOnlyReason: null,
      },
    ],
    mutate(row, enabled) {
      row.enabled = enabled
      row.fiberPhase = 'pending'
      return { application: 'applied' }
    },
  })
  t.after(async () => env.dispose())

  const started = Date.now()
  const response = await withVirtualClock(10_000, () =>
    request(env, '/dsh-mcp-hub/toggle', { method: 'POST', body: { server: 'demo', enabled: true } }),
  )
  const elapsed = Date.now() - started

  assert.equal(response.status, 500)
  assert.equal(response.body.ok, false)
  assert.ok(elapsed < 10_000, `the 30 s production deadline must not elapse in real time (took ${elapsed} ms)`)
})

test('the client panel mounts and renders its server list', async () => {
  const panel = mountClientPanel({
    locale: { active: 'en' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        now: 1,
        servers: [
          {
            id: 'demo',
            serverName: 'demo',
            enabled: true,
            status: 'running',
            toolCount: 1,
            transport: 'stdio',
            target: 'node server.js',
          },
        ],
      }),
    }),
  })
  try {
    await panel.flush()
    const tree = panel.render()
    const title = findNode(tree, (node) => node.type === 'h3')
    assert.equal(title.children[0], 'MCP servers')
    const toggle = findNode(tree, (node) => node.props.role === 'switch')
    assert.equal(toggle.props['aria-checked'], 'true')
    assert.equal(toggle.props.disabled, false)
  } finally {
    panel.unmount()
  }
})

test('with the real runtime: the catalog is hidden from the agent but present globally', async (t) => {
  if (!hasRuntime()) {
    t.skip('no unpacked DSH runtime (set DSH_RUNTIME to enable)')
    return
  }

  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('smoke-agent')
  await flushMicrotasks()

  const forAgent = mounted.promptTools(agent)
  assert.equal(forAgent.includes('mcp__rea__search'), false, 'catalog tools must be absent from the agent view')
  assert.equal(forAgent.includes('mcp__bili__video'), false, 'every catalog tool must be absent from the agent view')

  const globally = mounted.promptTools(undefined)
  assert.equal(globally.includes('mcp__rea__search'), true, 'the global registry must stay untouched')
  assert.equal(globally.includes('mcp__bili__video'), true)

  for (const meta of ['mcp_search', 'mcp_load', 'mcp_call', 'mcp_servers', 'mcp_server']) {
    assert.equal(forAgent.includes(meta), true, `${meta} must be registered and visible`)
  }

  assert.deepEqual([...mounted.routes.keys()].sort(), [...MANAGEMENT_ROUTES].sort())
})

test('with the real runtime: mcp_call dispatches through the tool pipeline', async (t) => {
  if (!hasRuntime()) {
    t.skip('no unpacked DSH runtime (set DSH_RUNTIME to enable)')
    return
  }

  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('mcp-call-agent')
  await flushMicrotasks()

  const { result } = await callTool(mounted.root, agent, 'mcp_call', {
    tool: 'mcp__rea__search',
    arguments: {},
  })
  assert.notEqual(result?.isError, true, 'mcp_call must not fail for a catalog tool')
  assert.ok(String(result?.content?.[0]?.text ?? '').includes('ok'), 'mcp_call returns the nested tool output')

  const nested = mounted.nested.filter((batch) =>
    (batch?.calls ?? []).some((call) => call.name === 'mcp__rea__search'),
  )
  assert.equal(nested.length, 1, 'the nested dispatch went through ctx.tools.execute exactly once')
})
