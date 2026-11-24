/**
 * Hidden-footprint accounting (`lib/footprint.js`).
 *
 * Pure: no Cordis context, no per-agent state. The panel consumes the returned
 * totals; these cases pin the arithmetic, the field projection and the
 * no-mutation promise.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TOKEN_CHARS, footprintOf, toolJsonChars } from '../lib/footprint.js'

const schema = { type: 'object', properties: { q: { type: 'string' } }, required: [] }

const entry = (server, tool, description = `${tool} description`) => ({
  name: `mcp__${server}__${tool}`,
  server,
  tool,
  description,
  parameters: schema,
  signature: 'q?: string',
})

test('TOKEN_CHARS is the documented constant', () => {
  assert.equal(TOKEN_CHARS, 3.224)
})

test('toolJsonChars counts only name, description and parameters', () => {
  const full = { ...entry('rea', 'search'), adopted: true, adoptReason: undefined, signature: 'ignored' }
  assert.equal(
    toolJsonChars(full),
    JSON.stringify({ name: full.name, description: full.description, parameters: full.parameters }).length,
  )
  // Extra fields are never part of the model-facing definition.
  assert.equal(toolJsonChars({ ...full, extra: 'x'.repeat(1_000) }), toolJsonChars(full))
  // A missing description serializes as undefined and is dropped by JSON.
  assert.equal(
    toolJsonChars({ name: 'mcp__a__b', parameters: schema }),
    JSON.stringify({ name: 'mcp__a__b', description: undefined, parameters: schema }).length,
  )
})

test('footprintOf sums total and per-server hidden/loaded counts', () => {
  const one = entry('a', 'one')
  const two = entry('a', 'two')
  const three = entry('b', 'three')
  const entries = [one, two, three]
  const hidden = new Set([one.name, three.name])
  const loaded = new Set([two.name])
  const footprint = footprintOf(entries, { hiddenNames: hidden, loadedNames: loaded })

  const hiddenChars = toolJsonChars(one) + toolJsonChars(three)
  assert.deepEqual(footprint.total, {
    tools: 3,
    hiddenTools: 2,
    hiddenTokens: Math.round(hiddenChars / TOKEN_CHARS),
    hiddenChars,
    loadedTools: 1,
  })
  assert.deepEqual(footprint.byServer.a, {
    tools: 2,
    hiddenTools: 1,
    hiddenTokens: Math.round(toolJsonChars(one) / TOKEN_CHARS),
    hiddenChars: toolJsonChars(one),
    loadedTools: 1,
  })
  assert.deepEqual(footprint.byServer.b, {
    tools: 1,
    hiddenTools: 1,
    hiddenTokens: Math.round(toolJsonChars(three) / TOKEN_CHARS),
    hiddenChars: toolJsonChars(three),
    loadedTools: 0,
  })
})

test('hiddenTokens is the rounded hiddenChars estimate', () => {
  const one = entry('srv', 'one')
  const footprint = footprintOf([one], { hiddenNames: new Set([one.name]) })
  assert.equal(footprint.total.hiddenChars, toolJsonChars(one))
  assert.equal(footprint.total.hiddenTokens, Math.round(toolJsonChars(one) / 3.224))
})

test('entries without a name or server are skipped', () => {
  const footprint = footprintOf(
    [
      { name: '', server: 'a', description: 'no name', parameters: schema },
      { name: 'mcp__a__nameless', server: '', description: 'no server', parameters: schema },
      { name: 'mcp__a__ok', server: 'a', tool: 'ok', description: 'kept', parameters: schema },
      null,
    ],
    {},
  )
  assert.deepEqual(footprint.total.tools, 1)
  assert.deepEqual(Object.keys(footprint.byServer), ['a'])
  assert.equal(footprint.byServer.a.tools, 1)
  const empty = footprintOf(undefined)
  assert.deepEqual(empty.total, { tools: 0, hiddenTools: 0, hiddenTokens: 0, hiddenChars: 0, loadedTools: 0 })
  assert.equal(Object.keys(empty.byServer).length, 0)
})

test('a server named "constructor" gets a real bucket and cannot mutate the global Object', () => {
  const one = { name: 'mcp__constructor__tool', server: 'constructor', tool: 'tool', description: 'x', parameters: schema }
  const footprint = footprintOf([one], { hiddenNames: new Set([one.name]) })

  // The table has no Object.prototype to collide with, so the bucket is own data.
  assert.equal(Object.getPrototypeOf(footprint.byServer), null)
  assert.equal(Object.prototype.hasOwnProperty.call(footprint.byServer, 'constructor'), true)
  assert.equal(footprint.byServer.constructor.tools, 1)
  assert.equal(footprint.byServer.constructor.hiddenTools, 1)
  assert.equal(Object.keys(footprint.byServer).length, 1)

  // A plain `{}` would have read Object.prototype.constructor and then written
  // the counters onto the global Object constructor.
  assert.equal('tools' in Object, false, 'the global Object constructor is untouched')
  assert.equal('hiddenTools' in Object, false)

  // Serialization stays a plain object shape.
  assert.deepEqual(JSON.parse(JSON.stringify(footprint.byServer)), {
    constructor: { tools: 1, hiddenTools: 1, hiddenTokens: Math.round(toolJsonChars(one) / TOKEN_CHARS), hiddenChars: toolJsonChars(one), loadedTools: 0 },
  })
})

test('footprintOf never mutates the entries or the name sets', () => {
  const entries = [entry('a', 'one'), entry('b', 'two')]
  const before = JSON.stringify(entries)
  const hidden = new Set([entries[0].name])
  const loaded = new Set([entries[1].name])
  const hiddenBefore = [...hidden]
  const loadedBefore = [...loaded]

  footprintOf(entries, { hiddenNames: hidden, loadedNames: loaded })

  assert.equal(JSON.stringify(entries), before, 'entries are unchanged')
  assert.deepEqual([...hidden], hiddenBefore, 'the hidden set is unchanged')
  assert.deepEqual([...loaded], loadedBefore, 'the loaded set is unchanged')
  assert.equal('matchedFields' in entries[0], false)
})

test('array name lists work the same as sets', () => {
  const entries = [entry('a', 'one'), entry('a', 'two')]
  const fromSets = footprintOf(entries, { hiddenNames: new Set([entries[0].name]) })
  const fromArrays = footprintOf(entries, { hiddenNames: [entries[0].name] })
  assert.deepEqual(fromArrays, fromSets)
})
