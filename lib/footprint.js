/**
 * Hidden-footprint accounting for the management snapshot.
 *
 * The panel shows "hidden N tools ≈ Xk tokens" per server, so this module must
 * answer one question without touching per-agent state: given the catalog and
 * the names that are hidden/loaded for one agent, how much model-facing JSON do
 * those tool definitions cost?
 *
 * Pure by construction: the caller passes the entries and the two name sets,
 * nothing here mutates them or reads a Cordis context.
 */

/**
 * Average characters per token for JSON tool definitions (ASCII-heavy prose).
 * The same constant the README's cost formula uses; the panel labels it as an
 * estimate and real prompt_tokens remains the authoritative measure.
 */
export const TOKEN_CHARS = 3.224

/**
 * Exact character cost of one tool definition as the model receives it: the
 * name/description/parameters triple, in stable key order.
 *
 * @param {object} entry catalog entry (`name`, `description`, `parameters`)
 * @returns {number} JSON character count
 */
export function toolJsonChars(entry) {
  return JSON.stringify({
    name: entry?.name,
    description: entry?.description,
    parameters: entry?.parameters,
  }).length
}

/** Zeroed bucket shared by `total` and every `byServer` entry. */
const emptyBucket = () => ({ tools: 0, hiddenTools: 0, hiddenTokens: 0, hiddenChars: 0, loadedTools: 0 })

/**
 * Sum hidden/loaded footprints for one agent's catalog slice.
 *
 * Only entries with a non-empty `name` and `server` participate, so a
 * malformed registration cannot create an unnamed bucket. Names are looked up
 * in the passed sets by exact match.
 *
 * @param {object[]} entries catalog entries (`name`, `server`, `description`, `parameters`)
 * @param {{hiddenNames?: Set<string>|string[], loadedNames?: Set<string>|string[]}} [options]
 * @returns {{total: object, byServer: Record<string, object>}}
 */
export function footprintOf(entries, options = {}) {
  const hidden = options.hiddenNames instanceof Set ? options.hiddenNames : new Set(options.hiddenNames ?? [])
  const loaded = options.loadedNames instanceof Set ? options.loadedNames : new Set(options.loadedNames ?? [])
  const total = emptyBucket()
  // A null-prototype table: `SERVER_NAME_PATTERN` admits names such as
  // `constructor`, and a plain `{}` would read `Object.prototype.constructor`
  // instead of creating a bucket (mutating the global constructor function on
  // assignment). Own keys still serialize as a plain JSON/YAML object.
  const byServer = Object.create(null)
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = entry?.name
    const server = entry?.server
    if (typeof name !== 'string' || name === '' || typeof server !== 'string' || server === '') continue
    let bucket = byServer[server]
    if (bucket === undefined) {
      bucket = emptyBucket()
      byServer[server] = bucket
    }
    const isHidden = hidden.has(name)
    const isLoaded = loaded.has(name)
    total.tools += 1
    bucket.tools += 1
    if (isHidden) {
      const chars = toolJsonChars(entry)
      total.hiddenTools += 1
      total.hiddenChars += chars
      bucket.hiddenTools += 1
      bucket.hiddenChars += chars
    }
    if (isLoaded) {
      total.loadedTools += 1
      bucket.loadedTools += 1
    }
  }
  total.hiddenTokens = Math.round(total.hiddenChars / TOKEN_CHARS)
  for (const bucket of Object.values(byServer)) {
    bucket.hiddenTokens = Math.round(bucket.hiddenChars / TOKEN_CHARS)
  }
  return { total, byServer }
}
