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
