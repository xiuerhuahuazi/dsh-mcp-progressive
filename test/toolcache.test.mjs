/**
 * Tool-metadata cache for connection-layer lazy MCP servers (`lib/toolcache.js`).
 *
 * Pure filesystem + data shaping: every case uses its own temp directory, never
 * the profile home. These cases pin the on-disk contract the Host relies on:
 * atomic 0600 writes, corrupt-file tolerance, per-server grouping with only the
 * model-facing fields, and live-first merging.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CACHE_VERSION,
  cacheFromDefinitions,
  mergeCatalog,
  pruneCache,
  readCache,
  writeCache,
} from '../lib/toolcache.js'
import { signatureOf } from '../lib/search.js'

/** Fresh temp directory removed after the case. */
function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-toolcache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** One catalog tool definition like the bridge registers. */
function definition(server, tool, extra = {}) {
  return {
    name: `mcp__${server}__${tool}`,
    description: `${tool} description`,
    parameters: { type: 'object', properties: { [tool]: { type: 'string' } }, required: [] },
    ...extra,
  }
}

const emptyCache = () => ({ version: CACHE_VERSION, servers: {} })

test('writeCache/readCache roundtrip is atomic and creates a 0600 file', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'nested', 'tool-cache.json')
  const cache = cacheFromDefinitions([definition('rea', 'search')], 'mcp__', 1234)

  assert.equal(writeCache(file, cache), true)
  assert.deepEqual(readCache(file), cache)
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the cache is owner-only')
  assert.deepEqual(readdirSync(path.dirname(file)), ['tool-cache.json'], 'no tmp file is left behind')
})

test('readCache degrades to empty for missing, corrupt and version-mismatched files', (t) => {
  const dir = tempDir(t)
  assert.deepEqual(readCache(path.join(dir, 'missing.json')), emptyCache())

  const corrupt = path.join(dir, 'corrupt.json')
  writeFileSync(corrupt, '{"version":1,')
  assert.deepEqual(readCache(corrupt), emptyCache())

  const wrongVersion = path.join(dir, 'old.json')
  writeFileSync(wrongVersion, JSON.stringify({ version: 99, servers: { rea: { updatedAt: 1, tools: [] } } }))
  assert.deepEqual(readCache(wrongVersion), emptyCache())

  const notAnObject = path.join(dir, 'null.json')
  writeFileSync(notAnObject, 'null')
  assert.deepEqual(readCache(notAnObject), emptyCache())
})

test('readCache keeps only valid, deduplicated tool records', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'tool-cache.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: CACHE_VERSION,
      servers: {
        srv: {
          updatedAt: 7,
          tools: [
            { name: 'mcp__srv__a', description: 42, parameters: null },
            { name: 'mcp__srv__a', description: 'duplicate', parameters: {} },
            { name: '', description: 'nameless', parameters: {} },
            null,
          ],
        },
        empty: { updatedAt: 1, tools: [{ name: '' }] },
      },
    }),
  )
  const cache = readCache(file)
  assert.deepEqual(Object.keys(cache.servers), ['srv'])
  assert.equal(cache.servers.srv.updatedAt, 7)
  assert.deepEqual(cache.servers.srv.tools, [
    { name: 'mcp__srv__a', description: '', parameters: {} },
  ])
})

test('cacheFromDefinitions groups by server and stores only name/description/parameters', () => {
  const definitions = [
    definition('rea', 'search', { execute: () => 'secret', env: { TOKEN: 'super-secret' }, adopted: false }),
    definition('rea', 'capture', { headers: { Authorization: 'Bearer super-secret' }, signature: 'x' }),
    definition('bili', 'video'),
    { name: 'mcp__broken', description: 'no tool segment' },
    { name: 'not-mcp__tool' },
  ]
  const cache = cacheFromDefinitions(definitions)
  assert.equal(cache.version, CACHE_VERSION)
  assert.deepEqual(Object.keys(cache.servers).sort(), ['bili', 'rea'])
  assert.equal(cache.servers.rea.tools.length, 2)
  assert.equal(cache.servers.bili.tools.length, 1)
  for (const bucket of Object.values(cache.servers)) {
    assert.equal(Number.isFinite(bucket.updatedAt), true)
    for (const tool of bucket.tools) {
      assert.deepEqual(Object.keys(tool).sort(), ['description', 'name', 'parameters'])
    }
  }
  const serialized = JSON.stringify(cache)
  assert.equal(serialized.includes('super-secret'), false, 'env/header secrets never reach the cache')
  assert.equal(serialized.includes('execute'), false, 'callbacks never reach the cache')
  assert.equal(serialized.includes('adopted'), false, 'host-only flags never reach the cache')
})

test('mergeCatalog keeps live precedence and appends cache-only entries', () => {
  const live = [
    {
      name: 'mcp__lazy__search',
      server: 'lazy',
      tool: 'search',
      description: 'LIVE description',
      parameters: { type: 'object' },
      signature: '',
      taskRequired: false,
      adopted: true,
    },
  ]
  const cache = {
    version: CACHE_VERSION,
    servers: {
      lazy: {
        updatedAt: 1,
        tools: [
          { name: 'mcp__lazy__search', description: 'CACHED description', parameters: {} },
          { name: 'mcp__lazy__other', description: 'cached only', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
        ],
      },
    },
  }
  const before = JSON.stringify({ live, cache })

  const merged = mergeCatalog(live, cache)
  assert.equal(merged.length, 2)
  assert.equal(merged[0], live[0], 'the live entry object is returned untouched')
  assert.equal(merged[0].description, 'LIVE description', 'live metadata wins')
  assert.equal('cached' in merged[0], false)

  const cached = merged[1]
  assert.equal(cached.name, 'mcp__lazy__other')
  assert.equal(cached.server, 'lazy')
  assert.equal(cached.tool, 'other')
  assert.equal(cached.description, 'cached only')
  assert.equal(cached.taskRequired, false)
  assert.equal(cached.adopted, true)
  assert.equal(cached.cached, true)
  assert.equal(cached.lazy, true)
  assert.equal(cached.signature, signatureOf(cached.parameters))

  assert.equal(JSON.stringify({ live, cache }), before, 'inputs are never mutated')
})

test('writeCache reports a failure instead of throwing', (t) => {
  const dir = tempDir(t)
  const blocker = path.join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  // mkdir of `blocker/deep` fails with ENOTDIR.
  assert.equal(writeCache(path.join(blocker, 'deep', 'tool-cache.json'), emptyCache()), false)
  assert.deepEqual(readdirSync(dir), ['blocker'], 'no tmp artifact survives the failure')
})

test('cacheFromDefinitions skips non-catalog names and malformed separators', () => {
  const cache = cacheFromDefinitions([
    { name: 'mcp__rea__ok', description: 'ok', parameters: {} },
    { name: 'mcp__rea', description: 'server only', parameters: {} },
    { name: 'other__x__y', description: 'wrong prefix', parameters: {} },
    { name: 'mcp__rea__', description: 'empty tool', parameters: {} },
  ])
  assert.deepEqual(Object.keys(cache.servers), ['rea'])
  assert.deepEqual(cache.servers.rea.tools.map((tool) => tool.name), ['mcp__rea__ok'])
})


test('pruneCache keeps configured buckets, drops unknown ones and never mutates the input', () => {
  const cache = {
    version: CACHE_VERSION,
    servers: {
      a: { updatedAt: 1, tools: [{ name: 'mcp__a__tool', description: 'a', parameters: {} }] },
      b: { updatedAt: 2, tools: [{ name: 'mcp__b__tool', description: 'b', parameters: {} }] },
    },
  }
  const before = JSON.stringify(cache)
  const pruned = pruneCache(cache, new Set(['a', 'c']))
  assert.equal(pruned.version, CACHE_VERSION)
  assert.deepEqual(Object.keys(pruned.servers), ['a'])
  assert.equal(pruned.servers.a, cache.servers.a, 'kept buckets are returned by reference')
  assert.equal(JSON.stringify(cache), before, 'the input cache is untouched')
})

test('pruneCache handles empty, undefined and list-shaped known sets', () => {
  const cache = {
    version: CACHE_VERSION,
    servers: { a: { updatedAt: 1, tools: [] }, b: { updatedAt: 1, tools: [] } },
  }
  assert.deepEqual(Object.keys(pruneCache(cache, new Set()).servers), [])
  assert.deepEqual(Object.keys(pruneCache(cache, ['b']).servers), ['b'])
  assert.deepEqual(pruneCache(undefined, ['a']), { version: CACHE_VERSION, servers: {} })
  assert.equal(pruneCache({ version: 7, servers: { a: {} } }, ['a']).version, 7, 'an existing version is preserved')
})
