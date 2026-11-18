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
import test from 'node:test'

import {
  PLUGIN_ENTRY,
  callTool,
  createFakeContext,
  createFakeToolsService,
  flushMicrotasks,
  hasRuntime,
  makeAgent,
  mountPlugin,
  registerTool,
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

runtimeTest('P1-11: the nested dispatch carries the derived step and logs both events', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('logged-agent')
  const appended = []
  agent.session.log = [
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 3 } },
  ]
  agent.session.append = (type, data) => {
    appended.push({ type, name: data?.name })
    return { seq: appended.length }
  }

  const { result } = await callTool(mounted.root, agent, 'mcp_call', { tool: 'mcp__rea__search', arguments: { q: 'x' } })
  assert.equal(resultText(result), 'ok', 'no audit line is needed when the step is loggable')

  const nested = mounted.nested.find((batch) => (batch?.calls ?? []).some((call) => call.name === 'mcp__rea__search'))
  assert.deepEqual(nested?.log, { turn: 2, step: 3 }, 'the nested execute receives log {turn, step}')
  assert.deepEqual(appended.map((entry) => entry.type), ['tool/call', 'tool/result'], 'both nested events are recorded')
  assert.equal(appended[0]?.name, 'mcp__rea__search', 'the nested tool name is the logged name')
})

runtimeTest('P1-11: an underivable step falls back to an in-result audit line', async () => {
  const mounted = await mountPlugin()
  const agent = await mounted.createAgent('unlogged-agent')
  // A closed step: the last boundary is step/end, so no open step exists.
  agent.session.log = [
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ]
  const { result } = await callTool(mounted.root, agent, 'mcp_call', {
    tool: 'mcp__rea__search',
    arguments: { q: 'x', limit: 2 },
  })
  const nested = mounted.nested.find((batch) => (batch?.calls ?? []).some((call) => call.name === 'mcp__rea__search'))
  assert.equal(nested?.log, undefined, 'a closed step is not logged as the current one')
  const text = resultText(result)
  assert.match(text, /^ok\n\(audit: dispatched mcp__rea__search/, 'the result starts with the output, then the audit line')
  assert.match(text, /argument keys: q, limit/, 'the audit line names the argument keys')

  // Session internals missing entirely must not crash the call.
  const orphan = await mountPlugin()
  const orphanAgent = await orphan.createAgent('orphan-agent')
  orphanAgent.session = undefined
  const orphanCall = await callTool(orphan.root, orphanAgent, 'mcp_call', { tool: 'mcp__bili__video', arguments: {} })
  assert.notEqual(orphanCall.result?.isError, true, 'a missing session does not break mcp_call')
  assert.match(resultText(orphanCall.result), /\(audit: dispatched mcp__bili__video; argument keys: none\)/)
})

// ---------------------------------------------------------------------------
// P1-12 — warnOnce is per agent.
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
// P1-7 — approval gate for mcp_server writes only.
// ---------------------------------------------------------------------------

runtimeTest('P1-7: mcp_server writes ask for approval while mcp_servers stays ungated', async () => {
  const mounted = await mountPlugin()
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
  const agent = await mounted.createAgent('approval-agent')

  await callTool(mounted.root, agent, 'mcp_server', { server: 'rea', action: 'restart' })
  assert.equal(requests.length, 1, 'a write action asks for approval')
  assert.equal(requests[0].toolName, 'mcp_server')
  assert.match(requests[0].displayReason, /Restart MCP server "rea"/, 'the human sees the concrete action')
  assert.match(requests[0].reason, /changing which MCP tools exist/, 'the model-facing reason explains the effect')

  await callTool(mounted.root, agent, 'mcp_servers', {})
  assert.equal(requests.length, 1, 'the read tool is not gated')

  const rejected = await mountPlugin()
  rejected.root.reflect.provide('approval', { async request() { return 'rejected' } }, () => true)
  const rejectedAgent = await rejected.createAgent('rejected-agent')
  const { result } = await callTool(rejected.root, rejectedAgent, 'mcp_server', { server: 'rea', action: 'stop' })
  assert.equal(result?.isError, true, 'a rejection stops the write')
  assert.match(resultText(result), /rejected tool "mcp_server"/, 'the pipeline denial is surfaced')
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
