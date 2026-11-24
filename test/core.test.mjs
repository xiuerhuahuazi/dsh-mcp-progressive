/**
 * Core regression: disclosure state, meta-tools and the prompt hook.
 *
 * These cases lock the 1.2.1 fixes (review S12, P1-3/4/5/6/7/9/10/11/12 and the
 * P2 wording/behaviour fixes) against the real DSH runtime. Runtime-dependent
 * cases skip themselves when the unpacked runtime is absent (CI has none) —
 * see `hasRuntime()` in ./harness.mjs.
 *
 * No real MCP server, `~/.dsh`, or network listener is involved.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readCache, writeCache } from '../lib/toolcache.js'

import {
  MANAGEMENT_ROUTES,
  PLUGIN_ENTRY,
  callTool,
  createFakeContext,
  createFakeToolsService,
  flushMicrotasks,
  hasRuntime,
  makeAgent,
  mountPlugin,
  registerTool,
  request,
  runtimeImport,
} from './harness.mjs'

const plugin = await import(PLUGIN_ENTRY)

/** Run one real-runtime case, or skip when the runtime is unavailable. */
function runtimeTest(name, fn) {
  test(name, async (t) => {
    if (!hasRuntime()) {
      t.skip('no unpacked DSH runtime (set DSH_RUNTIME to enable)')
      return
    }
    await fn(t)
  })
}

/** Text blocks of a tool result, joined. */
function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Replace the nested `ctx.tools.execute` dispatch with a canned batch while the
 * outer call still runs the real pipeline. Returns the restore function.
 */
function stubNestedResult(mounted, targetName, result) {
  const original = mounted.root.tools.execute
  mounted.root.tools.execute = async (input) => {
    if ((input?.calls ?? []).some((call) => call.name === targetName)) {
      return { results: [{ callId: input.calls[0]?.id, result }], additionalContexts: [], concluded: false }
    }
    return original(input)
  }
  return () => {
    mounted.root.tools.execute = original
  }
}

/** Record how many times one tool name is registered on the scope prototype. */
function countRegistrations(mounted, toolName) {
  const proto = Object.getPrototypeOf(mounted.root.tools)
  const original = proto.register
  let count = 0
  proto.register = function register(definition) {
    if (definition?.name === toolName) count += 1
    return original.call(this, definition)
  }
  return {
    count: () => count,
    restore: () => {
      proto.register = original
    },
  }
}

/** A catalog of `count` one-tool servers, for the catalog-line cap cases. */
function manyServerCatalog(count) {
  return Array.from({ length: count }, (_, index) => `mcp__s${String(index).padStart(2, '0')}__tool`)
}

// ---------------------------------------------------------------------------
// v1.6 lazy-connect helpers: temp cache, fake timers, injectable control stub.
// ---------------------------------------------------------------------------

/** One cache-only bucket for the `lazy` server used by the lazy cases. */
function lazyCacheValue() {
  return {
    version: 1,
    servers: {
      lazy: {
        updatedAt: 1,
        tools: [
          {
            name: 'mcp__lazy__search',
            description: 'Search on the lazy server',
            parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
          },
          {
            name: 'mcp__lazy__ping',
            description: 'Ping the lazy server',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        ],
      },
    },
  }
}

/** Seed a temp cache file; returns its path and a cleanup callback. */
function seedLazyCache(t, value = lazyCacheValue()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-lazy-cache-'))
  const file = path.join(dir, 'tool-cache.json')
  writeCache(file, value)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return file
}

/** Install the plugin's test-only seams for one case; returns the restore fn. */
function useLazyHooks({ serverControl = null, timers = null } = {}) {
  const previous = {
    serverControl: plugin.__test.testHooks.serverControl,
    timers: plugin.__test.testHooks.timers,
  }
  plugin.__test.testHooks.serverControl = serverControl
  plugin.__test.testHooks.timers = timers
  return () => {
    plugin.__test.testHooks.serverControl = previous.serverControl
    plugin.__test.testHooks.timers = previous.timers
  }
}

/** Minimal fake timer API: records callbacks so a test can fire them by delay. */
function fakeTimers() {
  const scheduled = []
  let nextId = 1
  return {
    scheduled,
    setTimeout(fn, ms) {
      const item = { id: nextId, fn, ms, cleared: false, fired: false }
      nextId += 1
      scheduled.push(item)
      return item.id
    },
    clearTimeout(id) {
      const item = scheduled.find((entry) => entry.id === id)
      if (item !== undefined) item.cleared = true
    },
    pending(ms) {
      return scheduled.filter((entry) => !entry.cleared && !entry.fired && entry.ms === ms)
    },
    run(ms) {
      const items = this.pending(ms)
      for (const item of items) {
        item.fired = true
        item.fn()
      }
      return items.length
    },
  }
}

/** A cache value with one `mcp__<server>__tool` entry per server. */
function cacheWithServers(servers) {
  const cache = { version: 1, servers: {} }
  for (const server of servers) {
    cache.servers[server] = {
      updatedAt: 1,
      tools: [
        {
          name: `mcp__${server}__tool`,
          description: `${server} tool`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
    }
  }
  return cache
}

/**
 * Runtime-free management environment for the lazy control seam.
 *
 * `agents: null` omits the agents service entirely (the fail-closed cases);
 * `agents: { list }` supplies one. `config` is spread over the lazy defaults.
 * Returns the `mcp_load`/`mcp_search` definitions so a test can drive the real
 * meta-tool bodies without the executor.
 */
function fakeLazyManagement(t, { cachePath, timers, serverControl = null, agents = { list: () => [] }, config = {} }) {
  const routes = new Map()
  const services = {
    pluginManager: {
      async listPlugins() {
        return []
      },
      async setPluginEnabled() {
        return { application: 'applied' }
      },
    },
    profileContext: { home: null, patchPath: null },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    loader: { entries: () => [] },
    connection: { requestRejection: () => undefined },
  }
  if (agents !== null) services.agents = agents
  const fake = createFakeContext({ tools: createFakeToolsService([]), services })
  const restore = useLazyHooks({ serverControl, timers })
  t.after(restore)
  plugin.apply(fake.ctx, { lazyConnect: ['lazy'], cachePath, warmIdleMs: 120000, ...config })
  return {
    fake,
    routes,
    load: fake.ctx.tools.definitions().find((definition) => definition.name === 'mcp_load'),
    search: fake.ctx.tools.definitions().find((definition) => definition.name === 'mcp_search'),
  }
}

// ---------------------------------------------------------------------------
// Disclosure flow still works end to end.
// ---------------------------------------------------------------------------

runtimeTest('hide, load, next-step admission, mcp_call and unload all keep working', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('flow-agent')
  await flushMicrotasks()

  assert.equal(mounted.promptTools(agent).includes('mcp__rea__search'), false, 'catalog starts hidden')
  assert.equal(mounted.promptTools(undefined).includes('mcp__rea__search'), true, 'the global registry is untouched')

  const load = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__rea__search'] })
  assert.match(resultText(load.result), /Loaded 1 tool/, 'mcp_load reports the load')
  assert.equal(mounted.promptTools(agent).includes('mcp__rea__search'), true, 'the loaded tool is native')

  const toolSet = await mounted.root.tools.resolve({ agent, signal: new AbortController().signal })
  assert.equal(toolSet.view(agent).has('mcp__rea__search'), true, 'a fresh admission includes the loaded tool')
  const direct = await mounted.root.tools.execute({
    calls: [{ id: 'direct-1', name: 'mcp__rea__search', arguments: '{}' }],
    agent,
    signal: new AbortController().signal,
    toolSet,
  })
  assert.notEqual(direct.results[0]?.result?.isError, true, 'the loaded tool is callable through the step admission')
  toolSet.dispose()

  const called = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__bili__video', arguments: {} })
  assert.notEqual(called.result?.isError, true, 'mcp_call runs a still-hidden tool')
  assert.equal(resultText(called.result).split('\n')[0], 'ok', 'mcp_call returns the nested output')

  const unload = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__rea__search'], unload: true })
  assert.match(resultText(unload.result), /Unloaded 1 tool/, 'mcp_load unloads again')
  assert.equal(mounted.promptTools(agent).includes('mcp__rea__search'), false, 'unloaded tools hide again')
})

// ---------------------------------------------------------------------------
// S12 — per-agent state keyed by identity.
// ---------------------------------------------------------------------------

runtimeTest('S12: two agents that share an id are masked independently', async () => {
  const mounted = await mountPlugin()
  const first = await mounted.createAgent('shared-id')
  await flushMicrotasks()
  const load = await callTool(mounted.root, first, 'mcp_load', { tools: ['mcp__rea__search'] })
  assert.match(resultText(load.result), /Loaded 1 tool/)
  assert.equal(mounted.promptTools(first).includes('mcp__rea__search'), true)

  // Same id, different Agent object: the mask must attach to this object's own
  // scope, never to the id (a WeakMap key, not a string key).
  const second = await mounted.createAgent('shared-id')
  await flushMicrotasks()
  assert.equal(mounted.promptTools(second).includes('mcp__rea__search'), false, 'the new agent starts masked')
  assert.equal(mounted.visibleNames(second).includes('mcp__rea__search'), false, 'the loaded set is not shared')
  assert.equal(mounted.promptTools(first).includes('mcp__rea__search'), true, 'the first agent keeps its load')

  // Event-ordered disposal of the old object must not lift the live one's mask.
  await mounted.disposeAgent(first)
  await flushMicrotasks()
  assert.equal(mounted.promptTools(second).includes('mcp__rea__search'), false, 'disposal leaves the other agent masked')
})

// ---------------------------------------------------------------------------
// P1-9 — fail-open, then self-heal on the next assembly.
// ---------------------------------------------------------------------------

runtimeTest('P1-9: a failed restriction install is retried by the assemble safety net', async () => {
  const mounted = await mountPlugin()
  await flushMicrotasks()
  const proto = Object.getPrototypeOf(mounted.root.tools)
  const originalRestrict = proto.restrict
  let calls = 0
  proto.restrict = function restrict(filter) {
    calls += 1
    if (calls === 1) throw new Error('synthetic tools.restrict() failure')
    return originalRestrict.call(this, filter)
  }
  try {
    const agent = await mounted.createAgent('heal-agent')
    await flushMicrotasks()
    assert.equal(mounted.visibleNames(agent).includes('mcp__rea__search'), true, 'fail-open: nothing is hidden')
    assert.equal(calls, 1, 'exactly one (failed) install attempt so far')

    // The plugin's own safety net.
    await mounted.root.events.emit('system-prompt/assemble', { sections: [] }, { scope: agent }, () => undefined)
    await flushMicrotasks()
    assert.equal(calls, 2, 'the safety net retried the install instead of trusting state')
    assert.equal(mounted.visibleNames(agent).includes('mcp__rea__search'), false, 'the agent is masked after the retry')
  } finally {
    proto.restrict = originalRestrict
  }
})

test('P1-9: a failed reconcile logs the agent id and the catalog size', async () => {
  const fake = createFakeContext({
    tools: createFakeToolsService([
      {
        name: 'mcp__srv__alpha',
        description: 'fake MCP tool',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    ]),
    services: { agents: { list: () => [] } },
  })
  fake.ctx.tools.restrict = () => {
    throw new Error('synthetic restrict failure')
  }
  plugin.apply(fake.ctx, { manageServers: false })
  await flushMicrotasks()

  const agent = { id: 'failing-agent', ctx: fake.ctx }
  await fake.ctx.emit('agent/created', { agent })
  const failure = fake.logs.find((entry) => entry.level === 'warn' && entry.message.includes('reconcile failed'))
  assert.ok(failure !== undefined, 'the failure is logged')
  assert.match(failure.message, /"failing-agent"/, 'the log names the agent')
  assert.match(failure.message, /1 catalog tool/, 'the log includes the catalog size')
})

// ---------------------------------------------------------------------------
// P1-3 — same-batch load + call.
// ---------------------------------------------------------------------------

runtimeTest('P1-3: a tool loaded in this step is refused with next-step guidance', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('batch-agent')
  await flushMicrotasks()

  // The step admission is resolved BEFORE mcp_load runs (that is what the loop does).
  const toolSet = await mounted.root.tools.resolve({ agent, signal: new AbortController().signal })
  try {
    const loaded = await mounted.root.tools.execute({
      calls: [{ id: 'load-1', name: 'mcp_load', arguments: JSON.stringify({ tools: ['mcp__rea__search'] }) }],
      agent,
      signal: new AbortController().signal,
      toolSet,
    })
    assert.match(resultText(loaded.results[0]?.result), /Loaded 1 tool/)

    const sameBatchText = await mounted.root.tools
      .execute({
        calls: [{ id: 'call-1', name: 'mcp__rea__search', arguments: '{}' }],
        agent,
        signal: new AbortController().signal,
        toolSet,
      })
      .then((batch) => resultText(batch.results[0]?.result))
    assert.match(sameBatchText, /loaded in this step/, 'the model is told why the call cannot run yet')
    assert.match(sameBatchText, /next step/, 'the model is told when it can run')
    assert.match(sameBatchText, /do not batch mcp_load with the call/, 'the guidance names the mistake')
  } finally {
    toolSet.dispose()
  }

  // A fresh step admission admits it: the normal loaded-from-a-previous-step path.
  const nextStep = await mounted.root.tools.resolve({ agent, signal: new AbortController().signal })
  try {
    const result = await mounted.root.tools.execute({
      calls: [{ id: 'call-2', name: 'mcp__rea__search', arguments: '{}' }],
      agent,
      signal: new AbortController().signal,
      toolSet: nextStep,
    })
    assert.notEqual(result.results[0]?.result?.isError, true, 'the next step can call the loaded tool')
  } finally {
    nextStep.dispose()
  }
})

// ---------------------------------------------------------------------------
// P1-4 — eagerTools is a root-only baseline.
// ---------------------------------------------------------------------------

runtimeTest('P1-4: eagerTools applies to root agents only', async () => {
  const mounted = await mountPlugin({ config: { eagerTools: ['mcp__rea__search'] } })
  const rootAgent = await mounted.createAgent('root-agent')

  const subagent = await makeAgent(mounted.root, 'sub-agent')
  subagent.session.header = { origin: 'subagent' }
  mounted.agents.push(subagent)
  await mounted.root.events.emit('agent/created', { agent: subagent })

  const delegated = await makeAgent(mounted.root, 'delegated-agent')
  delegated.session.header = { delegationDepth: 1 }
  mounted.agents.push(delegated)
  await mounted.root.events.emit('agent/created', { agent: delegated })

  // No session metadata at all: keep the pre-1.2.1 root behaviour.
  const fallback = await makeAgent(mounted.root, 'fallback-agent')
  mounted.agents.push(fallback)
  await mounted.root.events.emit('agent/created', { agent: fallback })
  await flushMicrotasks()

  assert.equal(mounted.promptTools(rootAgent).includes('mcp__rea__search'), true, 'the root agent gets the eager baseline')
  assert.equal(mounted.promptTools(subagent).includes('mcp__rea__search'), false, 'a subagent starts empty')
  assert.equal(mounted.promptTools(delegated).includes('mcp__rea__search'), false, 'delegationDepth > 0 is a subagent')
  assert.equal(mounted.promptTools(fallback).includes('mcp__rea__search'), true, 'missing metadata falls back to root')
  assert.equal(mounted.promptTools(subagent).includes('mcp_search'), true, 'the meta-tools stay visible')
})

// ---------------------------------------------------------------------------
// P1-5 — catalog discovery section.
// ---------------------------------------------------------------------------

runtimeTest('P1-5: the catalog prompt section is per-assembly and contributes nothing without a catalog', async () => {
  const mounted = await mountPlugin()
  const section = mounted.systemPrompt._sections.find((entry) => entry.name === 'mcp-progressive:catalog')
  assert.ok(section !== undefined, 'the catalog section is registered')
  assert.equal(Number.isFinite(section.order), true, 'the section declares a finite order')
  const text = section.text({})
  assert.match(text, /^MCP catalog: /, 'the section names the catalog')
  assert.match(text, /rea \(2 tools\)/, 'per-server tool counts come from the global catalog')
  assert.match(text, /mcp_search/, 'the section tells the model how to reach the tools')
  assert.equal(text.includes('mcp__'), false, 'no tool names or secrets are listed')

  const empty = await mountPlugin({ catalog: [] })
  const emptySection = empty.systemPrompt._sections.find((entry) => entry.name === 'mcp-progressive:catalog')
  assert.ok(emptySection !== undefined, 'the section is still registered')
  assert.equal(emptySection.text({}), '', 'an empty catalog contributes no prompt text')
})

// ---------------------------------------------------------------------------
// v1.5 — the catalog line's server cap is configurable (default 4, clamp 1..8).
// ---------------------------------------------------------------------------

runtimeTest('catalogServers defaults to 4, honors an override and clamps to 1..8', async () => {
  const catalog = manyServerCatalog(10)
  const catalogText = async (config) => {
    const mounted = await mountPlugin({ catalog, config })
    const section = mounted.systemPrompt._sections.find((entry) => entry.name === 'mcp-progressive:catalog')
    assert.ok(section !== undefined, 'the catalog section is registered')
    return section.text({})
  }
  const shown = (text) => {
    const match = text.match(/MCP catalog: (.*); not loaded by default/)
    assert.ok(match !== null, `the catalog line is missing: ${text}`)
    return match[1]
  }

  assert.equal(
    shown(await catalogText({})),
    's00 (1 tool), s01 (1 tool), s02 (1 tool), s03 (1 tool), +6 more',
    'the default names four servers and counts the rest',
  )
  assert.equal(
    shown(await catalogText({ catalogServers: 2 })),
    's00 (1 tool), s01 (1 tool), +8 more',
    'an explicit cap is honored',
  )
  assert.equal(shown(await catalogText({ catalogServers: 0 })), 's00 (1 tool), +9 more', '0 clamps up to 1')
  assert.equal(
    shown(await catalogText({ catalogServers: 99 })),
    's00 (1 tool), s01 (1 tool), s02 (1 tool), s03 (1 tool), s04 (1 tool), s05 (1 tool), s06 (1 tool), s07 (1 tool), +2 more',
    '99 clamps down to 8',
  )
  assert.equal(
    shown(await catalogText({ catalogServers: 'not-a-number' })),
    's00 (1 tool), s01 (1 tool), s02 (1 tool), s03 (1 tool), +6 more',
    'a non-finite value falls back to the default',
  )
})

// ---------------------------------------------------------------------------
// P1-6 — mcp_call returns MCP error content.
// ---------------------------------------------------------------------------

runtimeTest('P1-6: mcp_call returns the MCP error text content instead of a bare message', async () => {
  // An MCP tool error whose content says more than the message.
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('error-agent')
  const restore = stubNestedResult(mounted, 'mcp__rea__search', {
    isError: true,
    content: [{ type: 'text', text: 'server said: bad argument' }],
    error: { message: 'bad argument' },
  })
  try {
    const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__rea__search', arguments: {} })
    assert.notEqual(result?.isError, true, 'the outer call answers instead of throwing')
    const text = resultText(result)
    assert.match(text, /server said: bad argument/, 'the MCP text content is preserved')
    assert.match(text, /^Error from MCP tool "mcp__rea__search"/, 'the failure stays readable')
  } finally {
    restore()
  }

  // A native executor error wrapper ("Error: <message>") must not be doubled.
  const wrapped = await mountPlugin()
  const wrappedAgent = await wrapped.createAgent('wrapped-error-agent')
  const restoreWrapped = stubNestedResult(wrapped, 'mcp__rea__search', {
    isError: true,
    content: [{ type: 'text', text: 'Error: deadline exceeded' }],
    error: { message: 'deadline exceeded' },
  })
  try {
    const { result } = await callTool(wrapped.root, wrappedAgent, 'mcp_call', {
      tool: 'mcp__rea__search',
      arguments: {},
    })
    const text = resultText(result).split('\n')[0]
    assert.equal(text, 'Error from MCP tool "mcp__rea__search": deadline exceeded', 'the wrapper is not doubled')
  } finally {
    restoreWrapped()
  }
})

// ---------------------------------------------------------------------------
// P1-10 — PTC refusal arrives as a result, not a throw.
// ---------------------------------------------------------------------------

runtimeTest('P1-10: a PTC refusal returned as a result yields the guidance string', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('ptc-agent')
  const refusal = 'unknown tool "mcp__rea__search": only `run_code` is callable directly'
  const restore = stubNestedResult(mounted, 'mcp__rea__search', {
    isError: true,
    content: [{ type: 'text', text: refusal }],
    error: { message: refusal },
  })
  try {
    const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__rea__search', arguments: {} })
    assert.notEqual(result?.isError, true, 'the result path is handled without throwing')
    assert.match(resultText(result), /PTC mode/, 'the plugin guidance runs')
    assert.match(resultText(result), /call it inside run_code/, 'the guidance says what works in PTC mode')
  } finally {
    restore()
  }

  // The thrown fallback is still there for executors that reject the batch.
  const throwing = await mountPlugin()
  const throwingAgent = await throwing.createAgent('ptc-throw-agent')
  const original = throwing.root.tools.execute
  throwing.root.tools.execute = async (input) => {
    if ((input?.calls ?? []).some((call) => call.name === 'mcp__rea__search')) {
      throw new Error('run_code is required for nested calls')
    }
    return original(input)
  }
  try {
    const { result } = await callTool(throwing.root, throwingAgent, 'mcp_call', {
      tool: 'mcp__rea__search',
      arguments: {},
    })
    assert.match(resultText(result), /PTC mode/, 'the thrown-message fallback still answers')
  } finally {
    throwing.root.tools.execute = original
  }
})

// ---------------------------------------------------------------------------
// P1-11 — nested call auditability.
// ---------------------------------------------------------------------------

runtimeTest('P1-11: mcp_call leaves a real Session history with no orphan tool result', async () => {
  // Real dsh-session Session, in the exact event order dsh-agent-loop uses:
  // step/start -> assistant message declaring the outer mcp_call -> tool events.
  // A nested surface tool/call + tool/result here would leave a tool message in
  // deriveMessages() that no assistant message declares, which the DeepSeek
  // adapter rejects on the next request; the regression asserts the history
  // stays valid instead of asserting the plugin's own append calls.
  const { Session } = await runtimeImport('dsh-session')
  const { createUserMessage, createAssistantMessage } = await runtimeImport('dsh-llm')
  const outerCallId = 'outer-call-1'
  const sessionId = 'core-mcp-call-history'
  const session = Session.create(
    sessionId,
    undefined,
    { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false },
    0,
  )
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'please call it' }] }),
    { surfaceOp: 'append' },
  )
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          {
            type: 'tool-call',
            id: outerCallId,
            name: 'mcp_call',
            arguments: JSON.stringify({ tool: 'mcp__rea__search', arguments: { q: 'x' } }),
          },
        ],
        source: { provider: 'deepseek', model: 'deepseek-flash' },
      }),
    },
    { surfaceOp: 'append' },
  )

  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('history-agent')
  agent.session = session

  const batch = await mounted.root.tools.execute({
    calls: [
      {
        id: outerCallId,
        name: 'mcp_call',
        arguments: JSON.stringify({ tool: 'mcp__rea__search', arguments: { q: 'x' } }),
      },
    ],
    agent,
    signal: new AbortController().signal,
    log: { turn: 1, step: 1 },
  })
  const outer = batch.results[0]?.result
  assert.notEqual(outer?.isError, true, 'mcp_call succeeds')

  // (a) The plugin appends no nested `tool/call`/`tool/result` pair at all.
  assert.equal(
    JSON.stringify(session.log).includes(':mcp-progressive:'),
    false,
    'no synthetic nested call id appears in the session log',
  )

  // (b) Every tool result in the derived history matches a declared call.
  const messages = session.deriveMessages()
  const declared = new Set()
  const orphans = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      declared.clear()
      for (const block of message.content) if (block.type === 'tool-call') declared.add(block.id)
    } else if (message.role === 'tool') {
      if (!declared.delete(message.toolCallId)) orphans.push(message.toolCallId)
    }
  }
  assert.deepEqual(orphans, [], 'every tool result has a matching tool call in the history')
  const toolMessages = messages.filter((message) => message.role === 'tool')
  assert.equal(toolMessages.length, 1, 'only the outer mcp_call is a tool message')
  assert.equal(toolMessages[0].toolCallId, outerCallId, 'the surviving tool message belongs to the declared call')

  // (c) The audit trail lives in the result, not in the session.
  assert.match(resultText(outer), /\n\(audit: dispatched mcp__rea__search; argument keys: q\)$/, 'the audit line is in the result')
})

runtimeTest('P1-11: the nested call is always reported in the result audit line', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('unlogged-agent')
  const { result } = await callTool(mounted.root, agent, 'mcp_call', {
    tool: 'mcp__rea__search',
    arguments: { q: 'x', limit: 2 },
  })
  const nested = mounted.nested.find((batch) => (batch?.calls ?? []).some((call) => call.name === 'mcp__rea__search'))
  assert.equal(nested?.log, undefined, 'the nested dispatch is never given a session log')
  const text = resultText(result)
  assert.match(text, /^ok\n\(audit: dispatched mcp__rea__search; argument keys: q, limit\)$/, 'audit line follows the output')

  // An empty nested result keeps the "no output" fallback sentence AND the audit
  // line: the projection must not replace the fallback with the audit block.
  const empty = await mountPlugin()
  const emptyAgent = await empty.createAgent('empty-agent')
  const restore = stubNestedResult(empty, 'mcp__rea__search', { isError: false, content: [], value: 'gone' })
  try {
    const emptyCall = await callTool(empty.root, emptyAgent, 'mcp_call', { tool: 'mcp__rea__search', arguments: {} })
    const emptyText = resultText(emptyCall.result)
    assert.match(emptyText, /mcp__rea__search completed with no output\./, 'the fallback sentence is kept')
    assert.match(emptyText, /\n\(audit: dispatched mcp__rea__search; argument keys: none\)$/, 'and so is the audit line')
  } finally {
    restore()
  }

  // Session internals missing entirely must not crash the call.
  const orphan = await mountPlugin()
  const orphanAgent = await orphan.createAgent('orphan-agent')
  orphanAgent.session = undefined
  const orphanCall = await callTool(orphan.root, orphanAgent, 'mcp_call', { tool: 'mcp__bili__video', arguments: {} })
  assert.notEqual(orphanCall.result?.isError, true, 'a missing session does not break mcp_call')
  assert.match(resultText(orphanCall.result), /\(audit: dispatched mcp__bili__video; argument keys: none\)/)
})

runtimeTest('F12: whitespace-only nested content keeps the no-output fallback', async () => {
  // A content block that carries only whitespace must not be treated as a
  // payload: projecting it would replace the fallback sentence with blank text.
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('whitespace-agent')
  const restore = stubNestedResult(mounted, 'mcp__rea__search', {
    isError: false,
    content: [{ type: 'text', text: '  \n' }],
    value: 'blank',
  })
  try {
    const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__rea__search', arguments: { q: 'x' } })
    const text = resultText(result)
    assert.match(text, /mcp__rea__search completed with no output\./, 'the fallback sentence survives whitespace-only content')
    assert.match(text, /\(audit: dispatched mcp__rea__search; argument keys: q\)/, 'the audit line is still there')
  } finally {
    restore()
  }

  // An image-only result is a real payload and must still project its blocks.
  const imageMounted = await mountPlugin()
  const imageAgent = await imageMounted.createAgent('image-agent')
  const imageBlock = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  const restoreImage = stubNestedResult(imageMounted, 'mcp__rea__search', {
    isError: false,
    content: [imageBlock],
    value: 'image',
  })
  try {
    const { result } = await callTool(imageMounted.root, imageAgent, 'mcp_call', {
      tool: 'mcp__rea__search',
      arguments: {},
    })
    const blocks = Array.isArray(result?.content) ? result.content : []
    assert.equal(blocks.some((block) => block?.type === 'image'), true, 'the image block is forwarded')
    assert.match(
      resultText(result),
      /\(audit: dispatched mcp__rea__search; argument keys: none\)/,
      'the projected content still carries the audit line',
    )
    assert.equal(resultText(result).includes('returned 1 image'), false, 'the projection replaces the image-count fallback')
  } finally {
    restoreImage()
  }
})

// ---------------------------------------------------------------------------
// P1-12 / F5 — warnOnce is per Agent object.
// ---------------------------------------------------------------------------

test('P1-12: warnOnce keys include the agent identity', async () => {
  const fake = createFakeContext({
    tools: createFakeToolsService([
      {
        name: 'mcp__srv__alpha',
        description: 'fake MCP tool',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    ]),
    services: { agents: { list: () => [] } },
  })
  plugin.apply(fake.ctx, { manageServers: false })
  await flushMicrotasks()

  // An agent without a usable scope makes `reconcile` warn without installing.
  await fake.ctx.emit('agent/created', { agent: { id: 'warn-a' } })
  await fake.ctx.emit('agent/created', { agent: { id: 'warn-b' } })

  const warnings = fake.logs.filter((entry) => entry.level === 'warn')
  assert.equal(warnings.length, 2, 'each agent gets its own warning instead of one silencing the other')
  assert.ok(warnings[0].message.includes('warn-a'), 'the first warning names its agent')
  assert.ok(warnings[1].message.includes('warn-b'), 'the second warning names its agent')
})

test('F5: warnOnce distinguishes two Agents that share an id', async () => {
  const fake = createFakeContext({
    tools: createFakeToolsService([
      {
        name: 'mcp__srv__alpha',
        description: 'fake MCP tool',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    ]),
    services: { agents: { list: () => [] } },
  })
  plugin.apply(fake.ctx, { manageServers: false })
  await flushMicrotasks()

  // Same id, two different Agent objects: a per-id key would let the first
  // agent's warning silence the second one.
  await fake.ctx.emit('agent/created', { agent: { id: 'reused-warn-id' } })
  await fake.ctx.emit('agent/created', { agent: { id: 'reused-warn-id' } })

  const warnings = fake.logs.filter((entry) => entry.level === 'warn')
  assert.equal(warnings.length, 2, 'both agents warn even though they share an id')
})

// ---------------------------------------------------------------------------
// P2-1 / P2-18 — mcp_load already-loaded wording: native vs pending.
// ---------------------------------------------------------------------------

runtimeTest('P2-1/P2-18: already-loaded says native, and pending says how to recover', async () => {
  const native = await mountPlugin()
  const nativeAgent = await native.createAgent('native-agent')
  await callTool(native.root, nativeAgent, 'mcp_load', { tools: ['mcp__rea__search'] })
  const again = await callTool(native.root, nativeAgent, 'mcp_load', { tools: ['mcp__rea__search'] })
  const againText = resultText(again.result)
  assert.match(againText, /already loaded: it is a native tool in this conversation/, 'the model is told it is native')
  assert.match(againText, /call it directly/, 'and told to call it')
  assert.equal(againText.includes('Use mcp_search to confirm exact tool names.'), false, 'no misleading search hint')

  // Pending: the load is booked but its shadow registration failed.
  const pending = await mountPlugin()
  const pendingAgent = await pending.createAgent('pending-agent')
  const proto = Object.getPrototypeOf(pending.root.tools)
  const originalRegister = proto.register
  let failNext = true
  proto.register = function register(definition) {
    if (failNext && definition?.name === 'mcp__rea__search') {
      failNext = false
      throw new Error('synthetic scope registration failure')
    }
    return originalRegister.call(this, definition)
  }
  try {
    const loaded = await callTool(pending.root, pendingAgent, 'mcp_load', { tools: ['mcp__rea__search'] })
    assert.match(resultText(loaded.result), /Loaded 1 tool/)
    assert.equal(pending.visibleNames(pendingAgent).includes('mcp__rea__search'), false, 'the shadow never appeared')
    const retry = await callTool(pending.root, pendingAgent, 'mcp_load', { tools: ['mcp__rea__search'] })
    const retryText = resultText(retry.result)
    assert.match(retryText, /already loaded but not visible in this conversation/, 'pending is distinguished from native')
    assert.match(retryText, /unload:true, then load it again/, 'the recovery path is stated')
  } finally {
    proto.register = originalRegister
  }
})

// ---------------------------------------------------------------------------
// P2-14 — corrective text for a tool that is registered but not loaded.
// ---------------------------------------------------------------------------

runtimeTest('P2-14: a hidden catalog call says registered-but-not-loaded, not unregistered', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('corrective-agent')
  const batch = await mounted.root.tools.execute({
    calls: [{ id: 'hidden-1', name: 'mcp__rea__search', arguments: '{}' }],
    agent,
    signal: new AbortController().signal,
  })
  const text = resultText(batch.results[0]?.result)
  assert.equal(batch.results[0]?.result?.isError, true, 'the corrective answer is an error result')
  assert.match(text, /is registered but not loaded in this conversation/, 'the factual reason is stated')
  assert.match(text, /mcp_call/, 'offer a one-off retry with the known name')
  assert.doesNotMatch(text, /mcp_search/, 'a confirmed name needs no discovery step')
  assert.equal(text.includes('not registered on this Harness'), false, 'the old false claim is gone')

  // A hallucinated name is distinguished from a hidden one.
  const unknown = await mounted.root.tools.execute({
    calls: [{ id: 'hidden-2', name: 'mcp__nope__tool', arguments: '{}' }],
    agent,
    signal: new AbortController().signal,
  })
  assert.match(resultText(unknown.results[0]?.result), /is not in this MCP catalog right now/)
})

// ---------------------------------------------------------------------------
// P2-16 — mcp_call skips the transient shadow for alwaysVisible tools.
// ---------------------------------------------------------------------------

runtimeTest('P2-16: mcp_call does not shadow an alwaysVisible target', async () => {
  const mounted = await mountPlugin({ config: { alwaysVisible: ['mcp__rea__search'] } })
  const agent = await mounted.createAgent('visible-agent')
  await flushMicrotasks()
  assert.equal(mounted.visibleNames(agent).includes('mcp__rea__search'), true, 'an alwaysVisible tool is never hidden')

  const registrations = countRegistrations(mounted, 'mcp__rea__search')
  try {
    const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__rea__search', arguments: {} })
    assert.notEqual(result?.isError, true, 'the call still goes through')
    assert.equal(resultText(result).split('\n')[0], 'ok')
    assert.equal(registrations.count(), 0, 'no transient scope registration is needed')
  } finally {
    registrations.restore()
  }
})

// ---------------------------------------------------------------------------
// v1.5 — fail-open adoption: tools the plugin cannot mask stay natively visible
// (always visible by config, unrecognized name shape), plus the forward-
// compatible `definition.taskRequired` path. The harness can inject that field;
// the official bridge does not expose it — the real-bridge test below pins that
// production limitation instead of claiming task-required tools are fail-open.
// ---------------------------------------------------------------------------

runtimeTest('v1.5: non-adopted catalog tools stay visible and are explained in mcp_search', async () => {
  const mounted = await mountPlugin({ config: { alwaysVisible: ['mcp__rea__search'] } })
  // Forward-compatible field path only: the official bridge does not copy this
  // onto its registered definitions (see the real-bridge test below).
  registerTool(mounted.root, 'mcp__rea__tasky', { taskRequired: true })
  registerTool(mounted.root, 'mcp__badtool')
  const agent = await mounted.createAgent('adopt-agent')
  await flushMicrotasks()

  assert.equal(mounted.promptTools(agent).includes('mcp__rea__tasky'), true, 'a task-required tool stays visible')
  assert.equal(mounted.promptTools(agent).includes('mcp__badtool'), true, 'a malformed name stays visible')
  assert.equal(mounted.promptTools(agent).includes('mcp__rea__search'), true, 'an alwaysVisible tool stays visible')
  assert.equal(mounted.promptTools(agent).includes('mcp__bili__video'), false, 'a normal catalog tool is still hidden')

  const direct = await mounted.root.tools.execute({
    calls: [{ id: 'non-adopted-direct', name: 'mcp__rea__tasky', arguments: '{}' }],
    agent,
    signal: new AbortController().signal,
  })
  assert.notEqual(direct.results[0]?.result?.isError, true, 'a natively visible tool is callable without loading')

  const search = await callTool(mounted.root, agent, 'mcp_search', {})
  const text = resultText(search.result)
  assert.match(
    text,
    /Kept visible \(not masked\): task support required: 1 \(mcp__rea__tasky\); always visible \(config\): 1 \(mcp__rea__search\); unrecognized name shape: 1 \(mcp__badtool\)\./,
    'each kept-visible reason is reported with its names',
  )
  // 7 catalog tools, 4 of them maskable: tasky/badtool are kept visible and
  // rea__search is alwaysVisible, so none of the three counts as hidden.
  assert.match(text, /Hidden until loaded: 4 of 7 tools/, 'non-adopted tools are excluded from the hidden count')
  const scoped = await callTool(mounted.root, agent, 'mcp_search', { server: 'bili' })
  assert.doesNotMatch(
    resultText(scoped.result),
    /Kept visible/,
    'a server-scoped search does not leak another server\'s kept-visible tools',
  )
  const taskyLine = text.split('\n').find((line) => line.startsWith('- mcp__rea__tasky'))
  assert.ok(taskyLine !== undefined, 'the kept-visible tool is still listed as a search result')
  assert.equal(taskyLine.includes('[loaded]'), false, 'it is not marked loaded')
})

runtimeTest('v1.5: mcp_load rejects an already-visible non-adopted tool', async () => {
  const mounted = await mountPlugin()
  // Injected field: this pins the forward-compatible path, not the official
  // bridge's production shape (see the real-bridge test below).
  registerTool(mounted.root, 'mcp__rea__tasky', { taskRequired: true })
  const agent = await mounted.createAgent('load-adopt-agent')
  await flushMicrotasks()

  const loaded = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__rea__tasky'] })
  const text = resultText(loaded.result)
  assert.match(text, /Skipped: mcp__rea__tasky \(already visible: task support required; call it directly\)/)
  assert.equal(text.includes('Use mcp_search to confirm exact tool names.'), false, 'no search hint for a visible tool')

  const listing = await callTool(mounted.root, agent, 'mcp_load', {})
  assert.match(resultText(listing.result), /No MCP tools are loaded/, 'the rejected name is not booked as loaded')
  assert.equal(mounted.promptTools(agent).includes('mcp__rea__tasky'), true, 'the tool stays natively visible')
})

runtimeTest('v1.5: mcp_call dispatches a task-required tool without creating a shadow', async () => {
  const mounted = await mountPlugin()
  // Injected field: forward-compatible path only (see the real-bridge test).
  registerTool(mounted.root, 'mcp__rea__tasky', { taskRequired: true })
  const agent = await mounted.createAgent('call-adopt-agent')
  await flushMicrotasks()

  const registrations = countRegistrations(mounted, 'mcp__rea__tasky')
  try {
    const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__rea__tasky', arguments: {} })
    assert.notEqual(result?.isError, true, 'the nested dispatch succeeds')
    assert.equal(resultText(result).split('\n')[0], 'ok')
    assert.equal(registrations.count(), 0, 'a visible target needs no transient scope registration')
  } finally {
    registrations.restore()
  }
})

// ---------------------------------------------------------------------------
// v1.5 — the official bridge keeps `taskRequired` inside its executor closure,
// so the plugin cannot detect task-required tools in production. This pins the
// real limitation; if a bridge starts exposing the field, the assertions here
// fail and the disclosure behaviour/docs must be updated deliberately.
// ---------------------------------------------------------------------------

runtimeTest('v1.5: the official bridge does not expose taskRequired, so the tool is hidden and refused at dispatch', async () => {
  const { createMcpToolDefinition } = await runtimeImport('dsh-mcp-client')
  const mounted = await mountPlugin()
  const definition = createMcpToolDefinition({}, {
    name: 'mcp__rea__realtasky',
    rawName: 'realtasky',
    description: 'requires task execution',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    taskRequired: true,
    call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  })
  // The bridge consumes `options.taskRequired` in createExecutor() only; the
  // registered definition never carries it.
  assert.equal('taskRequired' in definition, false, 'official bridge definition has no taskRequired field')
  mounted.root.tools.register(definition)
  const agent = await mounted.createAgent('real-task-agent')
  await flushMicrotasks()

  // Without the flag the plugin treats it as a normal catalog tool: hidden, not
  // kept visible — this is a limitation, not fail-open behaviour.
  assert.equal(mounted.promptTools(agent).includes('mcp__rea__realtasky'), false, 'the task-required tool is hidden')

  const search = await callTool(mounted.root, agent, 'mcp_search', { query: 'realtasky' })
  assert.doesNotMatch(resultText(search.result), /Kept visible/, 'the plugin does not claim to keep it visible')

  const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__rea__realtasky', arguments: {} })
  assert.match(resultText(result), /requires task-based execution/, 'the bridge\'s own refusal is surfaced')
})

// ---------------------------------------------------------------------------
// v1.5 — the prompt catalog line only advertises what it actually hides.
// ---------------------------------------------------------------------------

runtimeTest('v1.5: the prompt catalog line lists adopted tools only', async () => {
  const mounted = await mountPlugin({ config: { alwaysVisible: ['mcp__rea__search'] } })
  registerTool(mounted.root, 'mcp__badtool')
  await flushMicrotasks()
  const section = mounted.systemPrompt._sections.find((entry) => entry.name === 'mcp-progressive:catalog')
  const text = section.text({})
  assert.match(text, /^MCP catalog: /)
  assert.match(text, /bili \(2 tools\)/, 'normal catalog servers stay listed')
  assert.match(text, /blender \(1 tool\)/)
  assert.match(text, /rea \(1 tool\)/, 'the alwaysVisible tool is not counted as hidden')
  assert.doesNotMatch(text, /badtool/, 'a malformed non-adopted name is not advertised')

  const only = await mountPlugin({ catalog: ['mcp__solo__visible'], config: { alwaysVisible: ['mcp__solo__visible'] } })
  const soloSection = only.systemPrompt._sections.find((entry) => entry.name === 'mcp-progressive:catalog')
  assert.equal(soloSection.text({}), '', 'a catalog of only kept-visible tools contributes no prompt text')
})

// ---------------------------------------------------------------------------
// v1.5 — the management half consumes the Host footprint/loaded-view seams.
// ---------------------------------------------------------------------------

runtimeTest('v1.5: the state route reports the hidden footprint and the loaded view', async () => {
  const mounted = await mountPlugin({ config: { alwaysVisible: ['mcp__rea__capture_web_screenshot'] } })
  const agent = await mounted.createAgent('snapshot-agent')
  await flushMicrotasks()
  const loaded = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__rea__search'] })
  assert.match(resultText(loaded.result), /Loaded 1 tool/)
  await flushMicrotasks()

  const response = await request(mounted, '/dsh-mcp-hub/state')
  assert.equal(response.status, 200)
  const disclosure = response.body.disclosure
  // The panel request carries no live agent, so the disclosure is the cold
  // default view; the loaded view below is the truthful per-agent snapshot.
  assert.equal(disclosure.tools, 5, 'all catalog tools are counted')
  assert.equal(disclosure.hiddenTools, 4, 'the cold view hides every adopted catalog tool')
  assert.equal(disclosure.loadedTools, 0)
  assert.equal(disclosure.hiddenChars > 0, true)
  assert.equal(disclosure.hiddenTokens, Math.round(disclosure.hiddenChars / 3.224), 'tokens use the documented estimate')
  assert.deepEqual(disclosure.notAdopted, [
    { name: 'mcp__rea__capture_web_screenshot', reason: 'always visible (config)' },
  ])
  assert.deepEqual(response.body.loaded, {
    agents: [{ id: 'snapshot-agent', title: null, delegationDepth: 0, loaded: ['mcp__rea__search'] }],
  })
})

// ---------------------------------------------------------------------------
// v1.6 — connection-layer lazy loading: disk cache, first-use resolve, warm idle
//
// Every case here is runtime-gated (`runtimeTest`): it calls mountPlugin against
// the real unpacked DSH runtime and skips when DSH_RUNTIME is unavailable, which
// is why CI reports skips rather than these assertions.
// ---------------------------------------------------------------------------

runtimeTest('v1.6: cached lazy tools stay searchable with [lazy], hidden counts and cached schemas', async (t) => {
  const cachePath = seedLazyCache(t)
  const restore = useLazyHooks({ timers: fakeTimers() })
  t.after(restore)
  const mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath } })
  const agent = await mounted.createAgent('lazy-search-agent')
  await flushMicrotasks()

  // Search-only: cached entries never enter the agent's toolset or deny masks.
  assert.equal(mounted.promptTools(agent).includes('mcp__lazy__ping'), false)
  assert.equal(mounted.visibleNames(agent).includes('mcp__lazy__ping'), false)

  // The prompt catalog advertises the cached server and its tool count.
  const section = mounted.systemPrompt._sections.find((entry) => entry.name === 'mcp-progressive:catalog')
  assert.match(section.text({}), /lazy \(2 tools\)/)

  const empty = await callTool(mounted.root, agent, 'mcp_search', {})
  const emptyText = resultText(empty.result)
  assert.match(emptyText, /MCP servers \(4\) — pass server:"name" to narrow:/)
  assert.match(emptyText, /- lazy: 2 tools, 0 loaded, 2 hidden/)
  const hidden = emptyText.match(/Hidden until loaded: (\d+) of (\d+) tools/)
  assert.ok(hidden !== null, 'the hidden line is present')
  assert.equal(hidden[2], '7', 'the denominator includes the two cache-only tools')

  const match = await callTool(mounted.root, agent, 'mcp_search', { query: 'ping' })
  assert.match(resultText(match.result), /- mcp__lazy__ping\(\) \[name\]\[lazy\] — Ping the lazy server/)

  const scoped = await callTool(mounted.root, agent, 'mcp_search', { server: 'lazy', detail: 'full' })
  const scopedText = resultText(scoped.result)
  assert.match(scopedText, /schema for mcp__lazy__search/)
  assert.match(scopedText, /"q":\{"type":"string"\}/, 'detail:"full" works from the cached parameters')

  // The panel footprint counts cache-only tools as hidden (cold view).
  const state = await request(mounted, '/dsh-mcp-hub/state')
  assert.equal(state.status, 200)
  assert.equal(state.body.disclosure.tools, 7)
  assert.equal(state.body.disclosure.hiddenTools, 7)
})

runtimeTest('v1.6: a lazy server named "constructor" keeps its own cache bucket', async (t) => {
  const cachePath = seedLazyCache(t, {
    version: 1,
    servers: {
      constructor: {
        updatedAt: 1,
        tools: [{ name: 'mcp__constructor__tool', description: 'constructor bucket', parameters: { type: 'object', properties: {}, required: [] } }],
      },
    },
  })
  const restore = useLazyHooks({ timers: fakeTimers() })
  t.after(restore)
  const mounted = await mountPlugin({ config: { lazyConnect: ['constructor'], cachePath } })
  const agent = await mounted.createAgent('constructor-server-agent')
  await flushMicrotasks()

  const search = await callTool(mounted.root, agent, 'mcp_search', { query: 'constructor' })
  assert.match(resultText(search.result), /mcp__constructor__tool/)
  assert.equal('tools' in Object, false, 'reading the cache bucket never falls through to Object.prototype.constructor')
})

runtimeTest('v1.6: mcp_load starts a lazy server, waits for the tool, then books it', async (t) => {
  const cachePath = seedLazyCache(t)
  const ensured = []
  let mounted
  const stub = {
    async ensureServer(server, options) {
      ensured.push({ server, ...options })
      registerTool(mounted.root, 'mcp__lazy__search', {
        description: 'Live after start',
        async execute() {
          return 'live-ok'
        },
      })
      return { ok: true, started: true }
    },
    releaseServer() {
      return { ok: true }
    },
  }
  const restore = useLazyHooks({ serverControl: stub, timers: fakeTimers() })
  t.after(restore)
  mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, lazyStartTimeoutMs: 7000 } })
  const agent = await mounted.createAgent('lazy-load-agent')
  await flushMicrotasks()

  const load = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
  assert.match(resultText(load.result), /Loaded 1 tool/)
  assert.deepEqual(ensured, [{ server: 'lazy', toolName: 'mcp__lazy__search', timeoutMs: 7000 }])
  assert.equal(mounted.promptTools(agent).includes('mcp__lazy__search'), true, 'the started tool becomes native')
})

runtimeTest('v1.6: mcp_call starts a lazy server and dispatches the newly live tool', async (t) => {
  const cachePath = seedLazyCache(t)
  const ensured = []
  let mounted
  const stub = {
    async ensureServer(server, options) {
      ensured.push({ server, ...options })
      registerTool(mounted.root, 'mcp__lazy__ping', {
        description: 'Live ping',
        async execute() {
          return 'lazy-live'
        },
      })
      return { ok: true, started: true }
    },
    releaseServer() {
      return { ok: true }
    },
  }
  const restore = useLazyHooks({ serverControl: stub, timers: fakeTimers() })
  t.after(restore)
  mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath } })
  const agent = await mounted.createAgent('lazy-call-agent')
  await flushMicrotasks()

  const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__lazy__ping', arguments: { x: 1 } })
  const text = resultText(result)
  assert.match(text, /^lazy-live/)
  assert.match(text, /\(audit: dispatched mcp__lazy__ping; argument keys: x\)/)
  assert.deepEqual(ensured, [{ server: 'lazy', toolName: 'mcp__lazy__ping', timeoutMs: 30000 }])
})

runtimeTest('v1.6: a failed lazy start reports the management reason, not a generic miss', async (t) => {
  const cachePath = seedLazyCache(t)
  const failures = [
    { ok: false, reason: 'timeout', message: 'server "lazy" did not finish starting in time' },
    { ok: false, reason: 'timeout' },
  ]
  for (const [index, failure] of failures.entries()) {
    const restore = useLazyHooks({
      timers: fakeTimers(),
      serverControl: {
        async ensureServer() {
          return failure
        },
        releaseServer() {
          return { ok: true }
        },
      },
    })
    const mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath } })
    try {
      const agent = await mounted.createAgent(`lazy-fail-agent-${index}`)
      await flushMicrotasks()

      const load = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
      const loadText = resultText(load.result)
      assert.match(loadText, /timeout|did not finish starting in time/, 'the real reason reaches the model')
      assert.doesNotMatch(loadText, /did not register after the lazy server started/)
      assert.doesNotMatch(loadText, /not in the current MCP catalog/)

      const listing = await callTool(mounted.root, agent, 'mcp_load', {})
      assert.match(resultText(listing.result), /No MCP tools are loaded/, 'the name is not booked before it is live')

      const call = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__lazy__ping', arguments: {} })
      assert.match(resultText(call.result), /timeout|did not finish starting in time/)
    } finally {
      restore()
    }
  }
})

runtimeTest('v1.6: without the management half a lazy tool fails with a clear error', async (t) => {
  const cachePath = seedLazyCache(t)
  const restore = useLazyHooks({ timers: fakeTimers() })
  t.after(restore)
  const mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath }, connection: false })
  const agent = await mounted.createAgent('lazy-no-panel-agent')
  await flushMicrotasks()

  const load = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
  assert.match(resultText(load.result), /lazy server needs the desktop management half/)
})

runtimeTest('v1.6: the real management control is captured and reports an unknown lazy row', async (t) => {
  const cachePath = seedLazyCache(t)
  const restore = useLazyHooks({ timers: fakeTimers() })
  t.after(restore)
  const mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath } })
  const agent = await mounted.createAgent('lazy-real-control-agent')
  await flushMicrotasks()

  // mountPlugin has no loader rows, so the real ensureServer() answers
  // {ok:false, reason:'unknown-server'} — proving the returned control object is
  // wired rather than a stub, and that its reason reaches the model verbatim.
  const load = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
  assert.match(resultText(load.result), /unknown-server/)
})

runtimeTest('v1.6: warm idle keeps a loaded server and re-arms after unload', async (t) => {
  const cachePath = seedLazyCache(t)
  const timers = fakeTimers()
  const released = []
  let mounted
  const stub = {
    async ensureServer() {
      registerTool(mounted.root, 'mcp__lazy__search', {
        async execute() {
          return 'ok'
        },
      })
      return { ok: true, started: true }
    },
    releaseServer(server) {
      released.push(server)
      return { ok: true }
    },
  }
  const restore = useLazyHooks({ serverControl: stub, timers })
  t.after(restore)
  mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, warmIdleMs: 120000 } })
  const agent = await mounted.createAgent('lazy-warm-agent')
  await flushMicrotasks()

  const load = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
  assert.match(resultText(load.result), /Loaded 1 tool/)
  assert.ok(timers.pending(120000).length >= 1, 'a warm timer is armed after the start')
  timers.run(120000)
  assert.deepEqual(released, [], 'a tool loaded by a live agent keeps the server warm')

  const unload = await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'], unload: true })
  assert.match(resultText(unload.result), /Unloaded 1 tool/)
  assert.ok(timers.pending(120000).length >= 1, 'unloading re-arms the warm timer')
  timers.run(120000)
  assert.deepEqual(released, ['lazy'], 'the idle server is released once nothing is loaded')
})

runtimeTest('v1.6: warm idle cannot release a server during an in-flight call', async (t) => {
  const cachePath = seedLazyCache(t)
  const timers = fakeTimers()
  const released = []
  let releaseDispatch
  let mounted
  const stub = {
    async ensureServer() {
      registerTool(mounted.root, 'mcp__lazy__ping', {
        async execute() {
          await new Promise((resolve) => {
            releaseDispatch = resolve
          })
          return 'done'
        },
      })
      return { ok: true, started: true }
    },
    releaseServer(server) {
      released.push(server)
      return { ok: true }
    },
  }
  const restore = useLazyHooks({ serverControl: stub, timers })
  t.after(restore)
  mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, warmIdleMs: 120000 } })
  const agent = await mounted.createAgent('lazy-inflight-agent')
  await flushMicrotasks()

  const pending = callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__lazy__ping', arguments: {} })
  await flushMicrotasks()
  assert.equal(typeof releaseDispatch, 'function', 'the dispatch is in flight')
  assert.equal(timers.pending(120000).length, 0, 'no warm timer runs while the call is in flight')
  assert.deepEqual(released, [])

  releaseDispatch()
  await pending
  assert.ok(timers.pending(120000).length >= 1, 'the timer is re-armed after the call settles')
  timers.run(120000)
  assert.deepEqual(released, ['lazy'])
})

runtimeTest('v1.6: lazy timing configuration clamps', async (t) => {
  const cachePath = seedLazyCache(t)

  const timeoutCases = [
    { config: { lazyStartTimeoutMs: 1 }, expected: 5000 },
    { config: { lazyStartTimeoutMs: 999999 }, expected: 120000 },
    { config: { lazyStartTimeoutMs: 'nope' }, expected: 30000 },
  ]
  for (const [index, row] of timeoutCases.entries()) {
    const seen = []
    const restore = useLazyHooks({
      serverControl: {
        async ensureServer(_server, options) {
          seen.push(options.timeoutMs)
          return { ok: false, reason: 'timeout' }
        },
        releaseServer() {
          return { ok: true }
        },
      },
    })
    const mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, ...row.config } })
    try {
      const agent = await mounted.createAgent(`timeout-clamp-agent-${index}`)
      await flushMicrotasks()
      await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
      assert.deepEqual(seen, [row.expected])
    } finally {
      restore()
    }
  }

  const warmCases = [
    { config: { warmIdleMs: 1 }, expected: 60000 },
    { config: { warmIdleMs: 999999999 }, expected: 86400000 },
    { config: {}, expected: 600000 },
  ]
  for (const [index, row] of warmCases.entries()) {
    const timers = fakeTimers()
    let mounted
    const restore = useLazyHooks({
      serverControl: {
        async ensureServer() {
          registerTool(mounted.root, 'mcp__lazy__search', {
            async execute() {
              return 'ok'
            },
          })
          return { ok: true, started: true }
        },
        releaseServer() {
          return { ok: true }
        },
      },
      timers,
    })
    mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, ...row.config } })
    try {
      const agent = await mounted.createAgent(`warm-clamp-agent-${index}`)
      await flushMicrotasks()
      await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
      assert.ok(timers.pending(row.expected).length >= 1, `warmIdleMs clamped/kept to ${row.expected}`)
    } finally {
      restore()
    }
  }

  // 0 disables the warm stop entirely.
  const timers = fakeTimers()
  let mounted
  const restore = useLazyHooks({
    serverControl: {
      async ensureServer() {
        registerTool(mounted.root, 'mcp__lazy__search', {
          async execute() {
            return 'ok'
          },
        })
        return { ok: true, started: true }
      },
      releaseServer() {
        return { ok: true }
      },
    },
    timers,
  })
  try {
    mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, warmIdleMs: 0 } })
    const agent = await mounted.createAgent('warm-disabled-agent')
    await flushMicrotasks()
    await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
    assert.equal(timers.scheduled.some((item) => item.ms >= 60000), false, 'warmIdleMs 0 never arms a stop timer')
  } finally {
    restore()
  }
})

runtimeTest('v1.6: tools/change debounces cache writes and keeps disconnected lazy buckets', async (t) => {
  const cachePath = seedLazyCache(t)
  const timers = fakeTimers()
  const restore = useLazyHooks({ timers })
  t.after(restore)
  const mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath } })
  await flushMicrotasks()

  await mounted.root.events.emit('tools/change', {})
  assert.equal(timers.pending(1000).length, 1, 'one debounced write is armed')
  timers.run(1000)

  const cache = readCache(cachePath)
  assert.deepEqual(Object.keys(cache.servers).sort(), ['bili', 'blender', 'lazy', 'rea'])
  assert.equal(cache.servers.lazy.tools.length, 2, 'the disconnected lazy bucket survives the write')
  for (const tool of cache.servers.rea.tools) {
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'name', 'parameters'])
  }
})

test('v1.6: dispose flushes a pending cache write', (t) => {
  const cachePath = seedLazyCache(t)
  const fake = createFakeContext({
    tools: createFakeToolsService([
      { name: 'mcp__live__tool', description: 'live', parameters: { type: 'object', properties: {}, required: [] } },
    ]),
  })
  plugin.apply(fake.ctx, { manageServers: false, lazyConnect: ['lazy'], cachePath })
  for (const entry of fake.disposers) {
    try {
      entry.disposer?.()
    } catch {
      // Teardown is best effort.
    }
  }

  const cache = readCache(cachePath)
  assert.deepEqual(Object.keys(cache.servers).sort(), ['lazy', 'live'])
  assert.equal(cache.servers.lazy.tools.length, 2)
  assert.equal(cache.servers.live.tools[0].name, 'mcp__live__tool')
})

runtimeTest('v1.6: a timed-out lazy start still arms the warm timer', async (t) => {
  for (const via of ['load', 'call']) {
    const cachePath = seedLazyCache(t)
    const timers = fakeTimers()
    const released = []
    const stub = {
      async ensureServer() {
        return { ok: false, reason: 'timeout' }
      },
      releaseServer(server) {
        released.push(server)
        return { ok: true, stopped: true }
      },
    }
    const restore = useLazyHooks({ serverControl: stub, timers })
    const mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, warmIdleMs: 120000 } })
    try {
      const agent = await mounted.createAgent(`timeout-warm-agent-${via}`)
      await flushMicrotasks()
      if (via === 'load') {
        await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
      } else {
        await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__lazy__search', arguments: {} })
      }
      assert.ok(timers.pending(120000).length >= 1, `${via}: a failed start still leaves an idle timer`)
      timers.run(120000)
      assert.deepEqual(released, ['lazy'], `${via}: the may-have-started row is released when idle`)
    } finally {
      restore()
    }
  }
})

runtimeTest('v1.6: a release refused while the row is starting retries', async (t) => {
  const cachePath = seedLazyCache(t)
  const timers = fakeTimers()
  const released = []
  let attempts = 0
  let mounted
  const stub = {
    async ensureServer() {
      registerTool(mounted.root, 'mcp__lazy__search', {
        async execute() {
          return 'ok'
        },
      })
      return { ok: true, started: true }
    },
    releaseServer(server) {
      released.push(server)
      attempts += 1
      return attempts === 1 ? { ok: false, reason: 'starting' } : { ok: true, stopped: true }
    },
  }
  const restore = useLazyHooks({ serverControl: stub, timers })
  t.after(restore)
  mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, warmIdleMs: 120000 } })
  const agent = await mounted.createAgent('release-retry-agent')
  await flushMicrotasks()
  await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })
  await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'], unload: true })

  timers.run(120000)
  assert.deepEqual(released, ['lazy'], 'the first release is attempted')
  assert.ok(timers.pending(5000).length >= 1, 'a starting refusal schedules a short retry')
  timers.run(5000)
  assert.deepEqual(released, ['lazy', 'lazy'], 'the retry lands and stops the row')
  assert.equal(timers.pending(5000).length, 0, 'no further retry is queued after success')
})

runtimeTest('v1.6: an unreadable agent list suppresses release and is reported', async (t) => {
  const cachePath = seedLazyCache(t)
  const timers = fakeTimers()
  const released = []
  let mounted
  const stub = {
    async ensureServer() {
      registerTool(mounted.root, 'mcp__lazy__search', {
        async execute() {
          return 'ok'
        },
      })
      return { ok: true, started: true }
    },
    releaseServer(server) {
      released.push(server)
      return { ok: true }
    },
  }
  const restore = useLazyHooks({ serverControl: stub, timers })
  t.after(restore)
  mounted = await mountPlugin({ config: { lazyConnect: ['lazy'], cachePath, warmIdleMs: 120000 } })
  const agent = await mounted.createAgent('unreadable-agents-agent')
  await flushMicrotasks()
  await callTool(mounted.root, agent, 'mcp_load', { tools: ['mcp__lazy__search'] })

  const agentsService = mounted.root.get('agents')
  const originalList = agentsService.list
  agentsService.list = () => {
    throw new Error('synthetic agent list failure')
  }
  try {
    timers.run(120000)
    assert.deepEqual(released, [], 'an unreadable live view fails closed instead of releasing')

    const state = await request(mounted, '/dsh-mcp-hub/state')
    assert.equal(state.status, 200)
    assert.equal(state.body.loaded.unreadable, true)
    assert.deepEqual(state.body.loaded.agents, [])
  } finally {
    agentsService.list = originalList
  }
})

test('v1.6: the default cache path is scoped to the profile patch directory', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const patchPath = path.join(root, 'profiles', 'a', 'cordis.patch.yml')
  const fake = createFakeContext({
    tools: createFakeToolsService([
      { name: 'mcp__live__tool', description: 'live', parameters: { type: 'object', properties: {}, required: [] } },
    ]),
    services: { profileContext: { home, patchPath } },
  })
  plugin.apply(fake.ctx, { manageServers: false, lazyConnect: ['lazy'] })
  for (const entry of fake.disposers) {
    try {
      entry.disposer?.()
    } catch {
      // Teardown is best effort.
    }
  }

  const expected = path.join(root, 'profiles', 'a', 'mcp-progressive', 'tool-cache.json')
  assert.equal(existsSync(expected), true, 'the cache follows the profile patch directory')
  assert.equal(readCache(expected).servers.live.tools[0].name, 'mcp__live__tool')
  assert.equal(existsSync(path.join(home, 'mcp-progressive', 'tool-cache.json')), false, 'the profile home is not used')
})

test('v1.6: a missing agents service fails closed for warm release and loadedView', async (t) => {
  const cachePath = seedLazyCache(t)
  const timers = fakeTimers()
  const released = []
  const env = fakeLazyManagement(t, {
    cachePath,
    timers,
    agents: null,
    serverControl: {
      async ensureServer() {
        return { ok: true, started: true }
      },
      releaseServer(server) {
        released.push(server)
        return { ok: true }
      },
    },
  })

  // The stub "starts" without registering the tool, so mcp_load reports the
  // missing registration — but the warm timer is armed for the started row.
  const loaded = await env.load.execute({ tools: ['mcp__lazy__search'] }, { agent: { id: 'fake-agent' } })
  assert.match(String(loaded), /did not register after the lazy server started/)
  assert.ok(timers.pending(120000).length >= 1, 'the warm timer is armed')
  timers.run(120000)
  assert.deepEqual(released, [], 'a missing agents service must not look like "nothing loaded"')

  const state = await request({ routes: env.routes }, '/dsh-mcp-hub/state')
  assert.equal(state.status, 200)
  assert.deepEqual(state.body.loaded, { agents: [], unreadable: true })
})

test('v1.6: unknown-server release refusals are expected and never warned about', async (t) => {
  const cachePath = seedLazyCache(t)
  const timers = fakeTimers()
  let releases = 0
  const env = fakeLazyManagement(t, {
    cachePath,
    timers,
    serverControl: {
      async ensureServer() {
        return { ok: false, reason: 'unknown-server' }
      },
      releaseServer() {
        releases += 1
        return { ok: false, reason: 'unknown-server' }
      },
    },
  })

  const loaded = await env.load.execute({ tools: ['mcp__lazy__search'] }, { agent: { id: 'fake-agent' } })
  assert.match(String(loaded), /unknown-server/)
  assert.ok(timers.pending(120000).length >= 1, 'a failed start still arms the idle timer')

  timers.run(120000)
  assert.equal(releases, 1, 'the release is attempted once')
  assert.equal(timers.pending(5000).length, 0, 'unknown-server is not retried (only starting is)')
  const warnings = env.fake.logs.filter((entry) => entry.level === 'warn')
  assert.deepEqual(warnings, [], 'an expected refusal is not reported as a release failure')
})

// ---------------------------------------------------------------------------
// v1.6 P1.1 — wildcard lazy, auto-prime scanner, cache prune
// ---------------------------------------------------------------------------

test('v1.6: wildcard lazyConnect serves every cache bucket and starts unlisted servers', async (t) => {
  const cachePath = seedLazyCache(t, cacheWithServers(['x', 'y']))
  const ensures = []
  let env
  env = fakeLazyManagement(t, {
    cachePath,
    config: { lazyConnect: ['*'], autoPrimeMs: 0 },
    serverControl: {
      async ensureServer(server, options) {
        ensures.push({ server, ...options })
        registerTool(env.fake.ctx, `mcp__${server}__tool`)
        return { ok: true, started: true }
      },
      async releaseServer() {
        return { ok: true }
      },
    },
  })
  const agent = { id: 'wildcard-agent' }

  const search = await env.search.execute({ query: 'tool' }, { agent })
  assert.match(String(search), /mcp__x__tool/)
  assert.match(String(search), /mcp__y__tool/)
  assert.match(String(search), /\[lazy\]/)

  const loaded = await env.load.execute({ tools: ['mcp__x__tool'] }, { agent })
  assert.match(String(loaded), /Loaded 1 tool/)
  assert.deepEqual(ensures, [{ server: 'x', toolName: 'mcp__x__tool', timeoutMs: 30000 }])
})

test('v1.6: auto-prime primes each running lazy server exactly once', async (t) => {
  const cachePath = seedLazyCache(t, cacheWithServers(['a', 'b']))
  const timers = fakeTimers()
  const rows = [
    { serverName: 'a', enabled: true, status: 'running', lazy: true },
    { serverName: 'b', enabled: true, status: 'starting', lazy: true },
  ]
  const releases = []
  fakeLazyManagement(t, {
    cachePath,
    timers,
    config: { lazyConnect: ['*'], autoPrimeMs: 15000 },
    serverControl: {
      async ensureServer() {
        return { ok: true, started: true }
      },
      async releaseServer(server) {
        releases.push(server)
        return { ok: true, stopped: true }
      },
      async listServers() {
        return rows
      },
    },
  })

  assert.equal(timers.pending(2000).length, 1, 'the scanner chain starts on activation')
  timers.run(2000)
  await flushMicrotasks()
  assert.equal(timers.pending(15000).length, 2, 'running and starting rows are both primed')

  timers.run(2000)
  await flushMicrotasks()
  assert.equal(timers.pending(15000).length, 2, 'already-primed rows are not scheduled twice')

  rows.push({ serverName: 'c', enabled: true, status: 'running', lazy: true })
  timers.run(2000)
  await flushMicrotasks()
  assert.equal(timers.pending(15000).length, 3, 'a newly added row gets one stop')

  timers.run(15000)
  await flushMicrotasks()
  assert.deepEqual(releases.sort(), ['a', 'b', 'c'])

  timers.run(2000)
  await flushMicrotasks()
  assert.equal(timers.pending(15000).length, 0, 'handled rows stay handled')
})

test('v1.6: an on-demand start is not auto-primed', async (t) => {
  const cachePath = seedLazyCache(t, cacheWithServers(['d']))
  const timers = fakeTimers()
  const rows = [{ serverName: 'd', enabled: true, status: 'running', lazy: true }]
  let env
  env = fakeLazyManagement(t, {
    cachePath,
    timers,
    config: { lazyConnect: ['*'], autoPrimeMs: 15000, warmIdleMs: 120000 },
    serverControl: {
      async ensureServer() {
        registerTool(env.fake.ctx, 'mcp__d__tool')
        return { ok: true, started: true }
      },
      async releaseServer() {
        return { ok: true }
      },
      async listServers() {
        return rows
      },
    },
  })

  const loaded = await env.load.execute({ tools: ['mcp__d__tool'] }, { agent: { id: 'ondemand-agent' } })
  assert.match(String(loaded), /Loaded 1 tool/)
  assert.ok(timers.pending(120000).length >= 1, 'the warm timer owns the stop')

  timers.run(2000)
  await flushMicrotasks()
  assert.equal(timers.pending(15000).length, 0, 'the scanner leaves an on-demand server alone')
})

test('v1.6: auto-prime leaves a server whose tool is loaded alone', async (t) => {
  const cachePath = seedLazyCache(t, cacheWithServers(['a']))
  const timers = fakeTimers()
  const rows = [{ serverName: 'a', enabled: true, status: 'running', lazy: true }]
  const releases = []
  // The loaded set is keyed by the Agent object, so the fake live view must
  // include the same object used for mcp_load below.
  const agent = { id: 'loaded-agent' }
  const env = fakeLazyManagement(t, {
    cachePath,
    timers,
    agents: { list: () => [agent] },
    config: { lazyConnect: ['*'], autoPrimeMs: 15000, warmIdleMs: 120000 },
    serverControl: {
      async ensureServer() {
        return { ok: true, started: true }
      },
      async releaseServer(server) {
        releases.push(server)
        return { ok: true }
      },
      async listServers() {
        return rows
      },
    },
  })

  timers.run(2000)
  await flushMicrotasks()
  assert.equal(timers.pending(15000).length, 1)

  registerTool(env.fake.ctx, 'mcp__a__tool')
  const loaded = await env.load.execute({ tools: ['mcp__a__tool'] }, { agent })
  assert.match(String(loaded), /Loaded 1 tool/)

  timers.run(15000)
  await flushMicrotasks()
  assert.deepEqual(releases, [], 'a loaded tool suppresses the auto-prime stop')
})

test('v1.6: autoPrimeMs 0 disables the scanner entirely', (t) => {
  const timers = fakeTimers()
  fakeLazyManagement(t, {
    cachePath: seedLazyCache(t),
    timers,
    config: { lazyConnect: ['*'], autoPrimeMs: 0 },
    serverControl: {
      async ensureServer() {
        return { ok: true }
      },
      async releaseServer() {
        return { ok: true }
      },
      async listServers() {
        return []
      },
    },
  })
  assert.equal(timers.scheduled.filter((entry) => entry.ms === 2000).length, 0)
})

test('v1.6: dispose clears the scanner and every scheduled auto-prime stop', async (t) => {
  const timers = fakeTimers()
  const env = fakeLazyManagement(t, {
    cachePath: seedLazyCache(t),
    timers,
    config: { lazyConnect: ['*'], autoPrimeMs: 15000 },
    serverControl: {
      async ensureServer() {
        return { ok: true }
      },
      async releaseServer() {
        return { ok: true }
      },
      async listServers() {
        return [{ serverName: 'a', enabled: true, status: 'running', lazy: true }]
      },
    },
  })

  timers.run(2000)
  await flushMicrotasks()
  assert.ok(timers.pending(2000).length >= 1)
  assert.ok(timers.pending(15000).length >= 1)

  for (const entry of env.fake.disposers) entry.disposer?.()
  assert.equal(timers.pending(2000).length, 0)
  assert.equal(timers.pending(15000).length, 0)
})

test('v1.6: a successful scan prunes cache buckets for removed servers', async (t) => {
  const cachePath = seedLazyCache(t, cacheWithServers(['a', 'b']))
  const timers = fakeTimers()
  fakeLazyManagement(t, {
    cachePath,
    timers,
    config: { lazyConnect: ['*'], autoPrimeMs: 15000 },
    serverControl: {
      async ensureServer() {
        return { ok: true }
      },
      async releaseServer() {
        return { ok: true }
      },
      async listServers() {
        return [{ serverName: 'a', enabled: true, status: 'stopped', lazy: true }]
      },
    },
  })

  timers.run(2000)
  await flushMicrotasks()
  assert.deepEqual(Object.keys(readCache(cachePath).servers), ['a'])
})

test('v1.6: a failed scan leaves the cached buckets untouched', async (t) => {
  const cachePath = seedLazyCache(t, cacheWithServers(['a', 'b']))
  const timers = fakeTimers()
  fakeLazyManagement(t, {
    cachePath,
    timers,
    config: { lazyConnect: ['*'], autoPrimeMs: 15000 },
    serverControl: {
      async ensureServer() {
        return { ok: true }
      },
      async releaseServer() {
        return { ok: true }
      },
      async listServers() {
        throw new Error('scan failed')
      },
    },
  })

  timers.run(2000)
  await flushMicrotasks()
  assert.deepEqual(Object.keys(readCache(cachePath).servers), ['a', 'b'])
})

// ---------------------------------------------------------------------------
// P1-7 — approval gate for mcp_server writes only.
// ---------------------------------------------------------------------------

runtimeTest('P1-7: mcp_server writes ask for approval while mcp_servers stays ungated', async () => {
  const mounted = await mountPlugin()
  // Management activates only after the Host connection service appears, so
  // provide it first: the gate is exercised on the real mcp_server tool.
  mounted.root.reflect.provide('connection', { requestRejection: () => undefined }, () => true)
  const requests = []
  mounted.root.reflect.provide(
    'approval',
    {
      async request(input) {
        requests.push(input)
        return 'allowed-once'
      },
    },
    () => true,
  )
  await flushMicrotasks()
  assert.ok(
    mounted.root.tools.definitions().some((definition) => definition.name === 'mcp_server'),
    'mcp_server is registered once Connection exists',
  )
  const agent = await mounted.createAgent('approval-agent')

  for (const action of ['start', 'stop', 'restart']) {
    await callTool(mounted.root, agent, 'mcp_server', { server: 'rea', action })
  }
  assert.equal(requests.length, 3, 'every write action asks for approval')
  for (const request of requests) {
    assert.equal(request.toolName, 'mcp_server')
    assert.equal(typeof request.reason, 'string', 'reason stays the audited plain string')
    assert.match(request.reason, /changing which MCP tools exist/, 'the model-facing reason explains the effect')
    // PreToolDecision.ask.displayReason is a locale record, not a string: a
    // consumer reading `.en` must find text.
    assert.equal(typeof request.displayReason, 'object', 'displayReason is a locale record')
    assert.ok(
      request.displayReason !== null && !Array.isArray(request.displayReason),
      'displayReason is a plain locale record',
    )
    assert.equal(typeof request.displayReason.en, 'string', 'the required en entry is present')
    assert.ok(request.displayReason.en.length > 0, 'the en entry is not empty')
    assert.equal(typeof request.displayReason.zh, 'string', 'the zh translation is present')
    assert.ok(request.displayReason.zh.length > 0, 'the zh entry is not empty')
  }
  const byAction = (word) => requests.find((request) => request.reason.includes(` ${word} `))
  assert.match(byAction('start').displayReason.en, /^Start MCP server "rea"\?$/)
  assert.match(byAction('stop').displayReason.en, /^Stop MCP server "rea"\?$/)
  assert.match(byAction('restart').displayReason.en, /^Restart MCP server "rea"\?$/)
  assert.match(byAction('start').displayReason.zh, /^启动 MCP 服务器「rea」？$/)
  assert.match(byAction('stop').displayReason.zh, /^停止 MCP 服务器「rea」？$/)
  assert.match(byAction('restart').displayReason.zh, /^重启 MCP 服务器「rea」？$/)

  await callTool(mounted.root, agent, 'mcp_servers', {})
  assert.equal(requests.length, 3, 'the read tool is not gated')

  const rejected = await mountPlugin()
  rejected.root.reflect.provide('connection', { requestRejection: () => undefined }, () => true)
  rejected.root.reflect.provide('approval', { async request() { return 'rejected' } }, () => true)
  await flushMicrotasks()
  const rejectedAgent = await rejected.createAgent('rejected-agent')
  const { result } = await callTool(rejected.root, rejectedAgent, 'mcp_server', { server: 'rea', action: 'stop' })
  assert.equal(result?.isError, true, 'a rejection stops the write')
  assert.match(resultText(result), /rejected tool "mcp_server"/, 'the pipeline denial is surfaced')
})

// ---------------------------------------------------------------------------
// Management admission — Connection is required, the routes must not fail open.
// ---------------------------------------------------------------------------

test('management admission requires the Host connection service', async () => {
  const managementNames = ['mcp_server', 'mcp_servers']

  // The fake context runs an `inject()` callback only when every requested
  // service exists, exactly like Cordis, so dropping `connection` from the
  // inject list shows up as "the management half never activates".
  const createEnv = (withConnection) => {
    const routes = []
    const services = {
      pluginManager: {
        async listPlugins() {
          return []
        },
        async setPluginEnabled() {
          return { application: 'applied' }
        },
      },
      profileContext: { home: null, patchPath: null },
      webServer: {
        register(route) {
          routes.push(route.path)
          return () => {}
        },
      },
      loader: { entries: () => [] },
    }
    if (withConnection) services.connection = { requestRejection: () => undefined }
    const fake = createFakeContext({ tools: createFakeToolsService(), services })
    plugin.apply(fake.ctx, {})
    return { fake, routes }
  }

  const without = createEnv(false)
  const withoutNames = without.fake.ctx.tools.definitions().map((definition) => definition.name)
  for (const name of managementNames) {
    assert.equal(withoutNames.includes(name), false, `${name} must not register without Connection`)
  }
  assert.deepEqual(without.routes, [], 'no /dsh-mcp-hub route is registered without Connection')

  const withConnection = createEnv(true)
  const withNames = withConnection.fake.ctx.tools.definitions().map((definition) => definition.name)
  for (const name of managementNames) {
    assert.equal(withNames.includes(name), true, `${name} registers once Connection exists`)
  }
  assert.deepEqual(
    [...withConnection.routes].sort(),
    [...MANAGEMENT_ROUTES].sort(),
    'all three management routes register once Connection exists',
  )
})

// ---------------------------------------------------------------------------
// P2-15 — coalescing kept while the dead re-entrancy flags are gone.
// ---------------------------------------------------------------------------

runtimeTest('registry notifications still coalesce into one restriction install', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('coalesce-agent')
  await flushMicrotasks()

  const proto = Object.getPrototypeOf(mounted.root.tools)
  const originalRestrict = proto.restrict
  let calls = 0
  proto.restrict = function restrict(filter) {
    calls += 1
    return originalRestrict.call(this, filter)
  }
  try {
    // One connecting server registers one tool at a time; all of them land in
    // the same coalesced microtask (the old `mutating` guard would be inert).
    for (let index = 0; index < 6; index += 1) registerTool(mounted.root, `mcp__late__tool${index}`)
    await flushMicrotasks()
    assert.equal(calls, 1, 'six registrations cause ONE restriction install')
    assert.equal(mounted.visibleNames(agent).includes('mcp__late__tool0'), false, 'all late tools are hidden')
  } finally {
    proto.restrict = originalRestrict
  }
})
