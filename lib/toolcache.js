/**
 * On-disk tool metadata cache for connection-layer lazy MCP servers.
 *
 * A server listed in `lazyConnect` is expected to be configured `disabled: true`
 * so its child process does not run at boot. `mcp_search` still needs to name
 * its tools, so the Host keeps a small JSON snapshot of the model-facing tool
 * metadata (name/description/parameters — never env, headers or callbacks) and
 * merges it into the catalog until the first `mcp_load`/`mcp_call` starts the
 * row for real.
 *
 * Everything here is pure filesystem + data shaping: no Cordis context, no
 * management calls. Writes are atomic (tmp file, mode 0600, rename) so a crash
 * can never leave a half-written cache that a later read would trust.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { parseName, signatureOf } from './search.js'

/** Format version; a mismatch is treated as "no cache" rather than migrated. */
export const CACHE_VERSION = 1

/** The empty cache value (fresh object, never shared). */
const emptyCache = () => ({ version: CACHE_VERSION, servers: {} })

/** Define an own enumerable property without triggering a prototype setter. */
const defineOwn = (target, key, value) => {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

/** One tool entry reduced to the three fields the model-facing definition needs. */
const toolRecord = (tool) => {
  if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') return undefined
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : {},
  }
}

/**
 * Read one cache file.
 *
 * Missing files, unreadable paths, invalid JSON, a different `CACHE_VERSION`
 * and malformed entries all degrade to the empty cache. This function never
 * throws: a corrupt cache must never keep the plugin from activating.
 *
 * @param {string} file cache path
 * @returns {{version: number, servers: Record<string, {updatedAt: number, tools: object[]}>}}
 */
export function readCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(String(file), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) return emptyCache()
    const servers = parsed.servers
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return emptyCache()
    const out = {}
    for (const [server, bucket] of Object.entries(servers)) {
      if (typeof server !== 'string' || server === '') continue
      if (bucket === null || typeof bucket !== 'object') continue
      const tools = []
      const seen = new Set()
      for (const raw of Array.isArray(bucket.tools) ? bucket.tools : []) {
        const tool = toolRecord(raw)
        if (tool === undefined || seen.has(tool.name)) continue
        seen.add(tool.name)
        tools.push(tool)
      }
      if (tools.length === 0) continue
      const updatedAt = Number.isFinite(bucket.updatedAt) ? bucket.updatedAt : 0
      defineOwn(out, server, { updatedAt, tools })
    }
    return { version: CACHE_VERSION, servers: out }
  } catch {
    return emptyCache()
  }
}

/**
 * Write one cache atomically.
 *
 * Creates the parent directory, writes a uniquely named tmp file with mode
 * 0600 and renames it over the target. Failures are reported as `false` (the
 * caller keeps running with the in-memory cache); a leftover tmp file is
 * removed on failure.
 *
 * @param {string} file cache path
 * @param {object} cache cache value
 * @returns {boolean} whether the rename committed
 */
export function writeCache(file, cache) {
  let tmp
  try {
    const target = String(file)
    mkdirSync(path.dirname(target), { recursive: true })
    tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const payload = JSON.stringify(cache ?? emptyCache())
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, target)
    return true
  } catch {
    try {
      if (tmp !== undefined) unlinkSync(tmp)
    } catch {
      // Best effort: the original failure is the reportable one.
    }
    return false
  }
}

/**
 * Build a cache snapshot from currently registered tool definitions.
 *
 * Only `mcp__<server>__<tool>` definitions participate, and each tool keeps
 * exactly `{name, description, parameters}` — registration callbacks, env
 * blocks and other host data are never written to disk.
 *
 * @param {object[]} definitions tool definitions (global registry view)
 * @param {string} [prefix] tool-name prefix
 * @param {number} [now] timestamp for the per-server `updatedAt` (tests)
 * @returns {{version: number, servers: Record<string, {updatedAt: number, tools: object[]}>}}
 */
export function cacheFromDefinitions(definitions, prefix = 'mcp__', now = Date.now()) {
  const servers = {}
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const name = definition?.name
    if (typeof name !== 'string' || !name.startsWith(prefix)) continue
    const { server, tool } = parseName(name, prefix)
    if (server === '' || tool === '') continue
    let bucket = servers[server]
    if (bucket === undefined) {
      bucket = { updatedAt: now, tools: [] }
      defineOwn(servers, server, bucket)
    }
    bucket.tools.push({
      name,
      description: typeof definition.description === 'string' ? definition.description : '',
      parameters: definition.parameters !== null && typeof definition.parameters === 'object' ? definition.parameters : {},
    })
    bucket.updatedAt = now
  }
  for (const bucket of Object.values(servers)) {
    bucket.tools.sort((left, right) => left.name.localeCompare(right.name))
  }
  return { version: CACHE_VERSION, servers }
}

/**
 * Merge cached catalog entries into the live catalog.
 *
 * Live entries win per tool name and are returned untouched; cache-only tools
 * are appended as search-only entries (`cached`/`lazy`, `adopted: true`,
 * `taskRequired: false`) so the renderer can mark them and no disclosure code
 * mistakes them for registered tools. The caller decides which servers' cached
 * buckets may participate (the Host passes only `lazyConnect` servers).
 *
 * @param {object[]} liveEntries entries built from the live registry
 * @param {object} cache cache value from `readCache`
 * @param {string} [prefix] tool-name prefix
 * @returns {object[]} a new array; inputs are never mutated
 */
export function mergeCatalog(liveEntries, cache, prefix = 'mcp__') {
  const merged = Array.isArray(liveEntries) ? [...liveEntries] : []
  const servers = cache?.servers
  if (servers === null || typeof servers !== 'object') return merged
  const seen = new Set(merged.map((entry) => entry?.name).filter((name) => typeof name === 'string'))
  for (const bucket of Object.values(servers)) {
    if (bucket === null || typeof bucket !== 'object') continue
    for (const tool of Array.isArray(bucket.tools) ? bucket.tools : []) {
      if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') continue
      if (seen.has(tool.name)) continue
      const parsed = parseName(tool.name, prefix)
      if (parsed.server === '' || parsed.tool === '') continue
      seen.add(tool.name)
      const parameters = tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : {}
      merged.push({
        name: tool.name,
        server: parsed.server,
        tool: parsed.tool,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters,
        signature: signatureOf(parameters),
        taskRequired: false,
        adopted: true,
        cached: true,
        lazy: true,
      })
    }
  }
  return merged
}

/**
 * Drop cache buckets for servers that are no longer configured.
 *
 * Used by the auto-prime scanner after a successful `listServers()`: a removed
 * server must not keep advertising its old tools. Pure: the input cache (and
 * every kept bucket) is returned by reference, never mutated; `version` is
 * preserved and an unknown/`undefined` cache degrades to the empty value.
 *
 * @param {object} cache cache value from `readCache`
 * @param {Iterable<string>} knownServers configured server names
 * @returns {{version: number, servers: Record<string, object>}}
 */
export function pruneCache(cache, knownServers) {
  const known = knownServers instanceof Set ? knownServers : new Set(knownServers ?? [])
  const servers = {}
  const source = cache?.servers
  if (source !== null && typeof source === 'object') {
    for (const [server, bucket] of Object.entries(source)) {
      if (!known.has(server) || bucket === null || typeof bucket !== 'object') continue
      defineOwn(servers, server, bucket)
    }
  }
  return { version: cache?.version ?? CACHE_VERSION, servers }
}
