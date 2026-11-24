/**
 * Pure search and JSON-Schema helpers behind the `mcp_search` meta-tool.
 *
 * Nothing here touches Cordis or the plugin's per-agent state: the caller
 * passes the catalog entries, the loaded/hidden bookkeeping and the render
 * options, so every branch is directly unit-testable (`test/search.test.mjs`).
 */

/** Hard cap for one search page, independent of configuration. */
export const MAX_SEARCH_LIMIT = 40

/** How many matches may carry a full input schema in one `detail:"full"` page. */
export const MAX_DETAIL_TOOLS = 2

/** Total JSON schema characters a `detail:"full"` page may print across those tools. */
export const DETAIL_SCHEMA_BUDGET = 6000

/** Longest parameter signature one result line may print. */
export const MAX_SIGNATURE_CHARS = 200

/** How many required names the omitted-schema notice may list. */
const MAX_REQUIRED_NAMES = 20

/** Collapse whitespace and clip one description line without splitting a word. */
export function oneLine(text, maxChars) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const head = collapsed.slice(0, Math.max(0, maxChars - 1))
  const boundary = head.lastIndexOf(' ')
  const cut = boundary > maxChars * 0.6 ? head.slice(0, boundary) : head
  return `${cut}…`
}

/**
 * Compile allow patterns: an entry ending in `*` is a prefix match, otherwise
 * the exact tool name matches. Returns a predicate.
 */
export function compileAllowlist(entries) {
  const exact = new Set()
  const prefixes = []
  for (const raw of entries ?? []) {
    const entry = String(raw ?? '').trim()
    if (!entry) continue
    if (entry.endsWith('*')) prefixes.push(entry.slice(0, -1))
    else exact.add(entry)
  }
  if (exact.size === 0 && prefixes.length === 0) return () => false
  return (toolName) => exact.has(toolName) || prefixes.some((prefix) => toolName.startsWith(prefix))
}

/** Split `mcp__<server>__<tool>` into its parts for a configurable prefix. */
export function parseName(toolName, prefix = 'mcp__') {
  const rest = String(toolName ?? '').slice(prefix.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return { server: rest, tool: '' }
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) }
}

/** Resolve a local JSON Pointer (`#/$defs/x`, `#/definitions/x`) against one tool's schema root. */
export function resolveRef(node, root, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return node
  const ref = node.$ref
  if (typeof ref !== 'string') return node
  let target
  if (ref.startsWith('#/$defs/')) target = root?.$defs?.[ref.slice(8)]
  else if (ref.startsWith('#/definitions/')) target = root?.definitions?.[ref.slice(14)]
  if (target === undefined) return node
  return resolveRef(target, root, depth + 1)
}

/** Render one JSON Schema parameter node as a short type signature. */
export function typeLabel(node, root) {
  const resolved = resolveRef(node, root)
  if (resolved === null || typeof resolved !== 'object') return 'any'
  if (typeof resolved.const !== 'undefined') return JSON.stringify(resolved.const)
  if (Array.isArray(resolved.enum)) return resolved.enum.map((value) => JSON.stringify(value)).join('|')
  if (Array.isArray(resolved.oneOf)) {
    const labels = [...new Set(resolved.oneOf.map((branch) => typeLabel(branch, root)))]
    return labels.length > 0 && labels.length <= 3 ? labels.join('|') : 'any'
  }
  switch (resolved.type) {
    case 'array':
      return resolved.items === undefined ? 'any[]' : `${typeLabel(resolved.items, root)}[]`
    case 'object':
      return 'object'
    case 'integer':
      return 'integer'
    default:
      return typeof resolved.type === 'string' ? resolved.type : 'any'
  }
}

/**
 * Render `name: type` pairs for one tool's object parameters, capped so one
 * result line cannot grow without bound on tools with many/enormous enums.
 */
export function signatureOf(parameters) {
  const properties = resolveRef(parameters, parameters)?.properties
  if (properties === null || typeof properties !== 'object') return ''
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : [])
  const parts = []
  for (const [key, node] of Object.entries(properties)) {
    const optional = required.has(key) ? '' : '?'
    parts.push(`${key}${optional}: ${typeLabel(node, parameters)}`)
  }
  return oneLine(parts.join(', '), MAX_SIGNATURE_CHARS)
}

// ---------------------------------------------------------------------------
// Query tokenization.
//
// The catalog is dominated by English tool names and descriptions while the
// model (and the user) often search in Chinese. Without a segmenter dependency
// the cheapest honest bridge is a small gloss table: each CJK token carries its
// English equivalents as *match variants*, so 浏览器 still reaches `browser_*`
// tools. CJK tokens are also matched against whitespace/punctuation-stripped
// text, so `b站` finds 「下载 B 站视频」 and `浏览器截图` finds both concepts.
// ---------------------------------------------------------------------------

/** One CJK word in a query maps to zero or more English words used by tool names. */
const CJK_GLOSSARY = [
  ['浏览器', ['browser']],
  ['浏览', ['browse']],
  ['渲染', ['render']],
  ['截图', ['screenshot', 'capture']],
  ['抓取', ['capture', 'fetch']],
  ['采集', ['capture']],
  ['下载', ['download']],
  ['上传', ['upload']],
  ['视频', ['video']],
  ['图片', ['image', 'picture']],
  ['图像', ['image']],
  ['音频', ['audio']],
  ['音乐', ['music']],
  ['文件', ['file']],
  ['目录', ['directory']],
  ['文件夹', ['folder']],
  ['搜索', ['search']],
  ['查找', ['find', 'search']],
  ['网页', ['web', 'page']],
  ['页面', ['page']],
  ['导航', ['navigate']],
  ['点击', ['click']],
  ['输入', ['input', 'type']],
  ['滚动', ['scroll']],
  ['分析', ['analyze', 'analysis']],
  ['调试', ['debug']],
  ['编译', ['compile']],
  ['反编译', ['decompile']],
  ['代码', ['code']],
  ['函数', ['function']],
  ['二进制', ['binary']],
  ['进程', ['process']],
  ['内存', ['memory']],
  ['网络', ['network']],
  ['请求', ['request']],
  ['响应', ['response']],
  ['服务器', ['server']],
  ['工具', ['tool']],
  ['用户', ['user']],
  ['评论', ['comment']],
  ['收藏', ['favorite']],
  ['直播', ['live']],
  ['动画', ['animation']],
  ['场景', ['scene']],
  ['相机', ['camera']],
  ['灯光', ['light']],
  ['材质', ['material']],
  ['模型', ['model']],
  ['导出', ['export']],
  ['导入', ['import']],
  ['b站', ['bilibili']],
]

/** Whether a string contains a CJK codepoint (chooses the matching strategy). */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * Lowercase and drop whitespace/punctuation, so `b站` matches 「下载 B 站视频」
 * and `browser navigate` matches `browser_navigate`.
 */
const compact = (text) => String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/**
 * Split a query into matchable tokens. Each token keeps the raw word plus every
 * variant worth testing (English glosses for CJK, the compaction for CJK runs).
 *
 * @param {string} query raw user query
 * @returns {{text: string, variants: string[]}[]} tokens; empty for a blank query
 */
export function tokenize(query) {
  const text = String(query ?? '').toLowerCase().trim()
  if (text === '') return []
  const tokens = []
  for (const raw of text.split(/[\s,，、;；/|]+/u).filter(Boolean)) {
    const variants = new Set([raw])
    const stripped = compact(raw)
    if (stripped !== '' && stripped !== raw) variants.add(stripped)
    if (CJK_PATTERN.test(raw)) {
      // A CJK run may be one word (`浏览器`) or several glued together
      // (`浏览器截图`); add the gloss of every word the run contains.
      for (const [word, glosses] of CJK_GLOSSARY) {
        if (raw.includes(word)) for (const gloss of glosses) variants.add(gloss)
      }
    }
    tokens.push({ text: raw, variants: [...variants] })
  }
  return tokens
}

/**
 * Field labels the renderer prints, in the ranking priority order. A token's
 * best hit decides its label; when two fields tie, the higher-priority field
 * wins.
 */
const FIELD_PRIORITY = ['name', 'server', 'desc']

/**
 * Best score one token earns against one entry's name/tool/server/description,
 * plus the field label that produced that best hit.
 *
 * `name` covers both the tool segment and the full public name (the name embeds
 * the server), which is exactly how the ranking already weighted those hits.
 *
 * @returns {{score: number, field: string|undefined}}
 */
const matchOneToken = (token, fields) => {
  let best = 0
  let bestField
  const consider = (score, field) => {
    if (score > best || (score === best && score > 0 && FIELD_PRIORITY.indexOf(field) < FIELD_PRIORITY.indexOf(bestField))) {
      best = score
      bestField = field
    }
  }
  for (const variant of token.variants) {
    if (variant === '') continue
    if (CJK_PATTERN.test(variant)) {
      const word = compact(variant)
      if (word === '') continue
      if (fields.compactTool === word) consider(60, 'name')
      else if (fields.compactTool.includes(word)) consider(38, 'name')
      if (fields.compactName.includes(word)) consider(25, 'name')
      if (fields.compactServer.includes(word)) consider(15, 'server')
      if (fields.compactDescription.includes(word)) consider(12, 'desc')
    } else {
      if (fields.tool === variant) consider(60, 'name')
      else if (fields.tool.startsWith(variant)) consider(48, 'name')
      else if (fields.tool.includes(variant)) consider(38, 'name')
      if (fields.name.includes(variant)) consider(25, 'name')
      if (fields.server.includes(variant)) consider(15, 'server')
      if (fields.description.includes(variant)) consider(12, 'desc')
    }
  }
  return { score: best, field: bestField }
}

/**
 * Score one catalog entry for a tokenized query.
 *
 * OR semantics: a token that matches nothing lowers `matched` instead of
 * zeroing the entry, so one typo cannot hide every otherwise-relevant tool.
 *
 * @param {object} entry catalog entry (`name`, `tool`, `server`, `description`)
 * @param {{text: string, variants: string[]}[]} tokens from `tokenize`
 * @param {string} query raw query, for exact-name and order-insensitive phrase bonuses
 * @returns {{score: number, matched: number, fields: string[]}}
 *   ranking score, matched token count and the matched field labels in
 *   stable `name` > `server` > `desc` priority order (deduped)
 */
export function scoreEntry(entry, tokens, query) {
  const name = String(entry?.name ?? '').toLowerCase()
  const tool = String(entry?.tool ?? '').toLowerCase()
  const server = String(entry?.server ?? '').toLowerCase()
  const description = String(entry?.description ?? '').toLowerCase()
  const fields = {
    name,
    tool,
    server,
    description,
    compactName: compact(name),
    compactTool: compact(tool),
    compactServer: compact(server),
    compactDescription: compact(description),
  }
  const rawQuery = String(query ?? '').toLowerCase().trim()
  let score = 0
  if (rawQuery !== '' && name === rawQuery) score += 1000
  if (rawQuery !== '' && tool === rawQuery) score += 900
  // One compound phrase ranks `browser_navigate` above tools that only match
  // one of the two words.
  const phrase = compact(rawQuery)
  if (tokens.length > 1 && phrase !== '' && fields.compactName.includes(phrase)) score += 300
  let matched = 0
  const hitFields = new Set()
  for (const token of tokens) {
    const hit = matchOneToken(token, fields)
    if (hit.score > 0) {
      matched += 1
      score += hit.score
      if (hit.field !== undefined) hitFields.add(hit.field)
    }
  }
  const ordered = FIELD_PRIORITY.filter((field) => hitFields.has(field))
  return { score, matched, fields: ordered }
}

/** Server names with tool counts, stable order. */
export function summarizeServers(entries) {
  const counts = new Map()
  for (const entry of entries ?? []) counts.set(entry.server, (counts.get(entry.server) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))
}

/**
 * Rank the catalog for one query. Ranking puts the number of matched tokens
 * first (a two-word hit beats a one-word hit), then field position/precision,
 * then the name for a stable order.
 *
 * @param {object[]} entries catalog entries
 * @param {{query?: string, server?: string, limit?: number}} options
 *   `server` filters case-insensitively; `limit` caps the returned page
 * @returns {object} page plus the counts the caller/renderer needs
 */
export function rankCatalog(entries, options = {}) {
  const all = Array.isArray(entries) ? entries : []
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  const rawServer = typeof options.server === 'string' ? options.server.trim() : ''
  const serverFilter = rawServer === '' ? undefined : rawServer.toLowerCase()
  const requested = Number.isFinite(options.limit) ? Math.trunc(options.limit) : MAX_SEARCH_LIMIT
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, requested))
  const tokens = tokenize(query)
  const scoped = serverFilter === undefined
    ? all
    : all.filter((entry) => String(entry?.server ?? '').toLowerCase() === serverFilter)
  const ranked = []
  for (const entry of scoped) {
    const { score, matched, fields } = scoreEntry(entry, tokens, query)
    // A non-empty query keeps only entries with at least one token hit.
    if (tokens.length > 0 && matched === 0) continue
    ranked.push({ entry, score, matched, fields })
  }
  ranked.sort(
    (left, right) =>
      right.matched - left.matched ||
      right.score - left.score ||
      String(left.entry.name).localeCompare(String(right.entry.name)),
  )
  return {
    query,
    server: rawServer === '' ? undefined : rawServer,
    // Copies, not the caller's entries: the hit labels are added per page only.
    entries: ranked
      .slice(0, limit)
      .map((item) => ({ ...item.entry, matchedFields: item.fields })),
    matched: ranked.length,
    available: scoped.length,
    total: all.length,
    servers: summarizeServers(all),
    // Every name in the searched scope, for the hidden-count denominator.
    availableNames: scoped.map((entry) => entry.name),
    // A few concrete names for the "query matched nothing" state.
    examples: scoped.slice(0, 3).map((entry) => entry.name),
  }
}

/** Count hidden tools inside the searched scope, so numerator and denominator agree. */
export function countHidden(availableNames, hiddenNames) {
  const hidden = hiddenNames instanceof Set ? hiddenNames : new Set(hiddenNames ?? [])
  let count = 0
  for (const name of availableNames ?? []) if (hidden.has(name)) count += 1
  return count
}

// ---------------------------------------------------------------------------
// JSON Schema fitting for `detail:"full"`.
//
// The model is told these schemas are usable for arguments, so printing a
// half-cut JSON string is worse than printing nothing: every printed schema
// must parse, and when even the compact form does not fit the caller prints the
// signature plus an explicit "schema omitted" notice instead.
// ---------------------------------------------------------------------------

/** JSON Schema annotation keywords that carry no machine-readable constraint. */
const ANNOTATION_KEYS = [
  'description',
  'title',
  'examples',
  'default',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
  '$schema',
  '$id',
]

/** Deep copy minus annotation keywords (the original schema is never mutated). */
const stripAnnotations = (node) => {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(stripAnnotations)
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATION_KEYS.includes(key)) continue
    out[key] = stripAnnotations(value)
  }
  return out
}

/**
 * Compact one JSON Schema node to the parts that determine valid arguments:
 * type, enum/const, 3-way type unions, and array item types. Returns a valid
 * schema fragment (an empty object means "any").
 */
const compactNode = (node, root, depth) => {
  const resolved = resolveRef(node, root)
  if (resolved === null || typeof resolved !== 'object') return {}
  if (typeof resolved.const !== 'undefined') return { const: resolved.const }
  if (Array.isArray(resolved.enum)) return { enum: resolved.enum }
  if (Array.isArray(resolved.oneOf)) {
    const types = []
    for (const branch of resolved.oneOf) {
      const candidate = resolveRef(branch, root)
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.type === 'string' && !types.includes(candidate.type)) {
        types.push(candidate.type)
      }
    }
    return types.length > 0 && types.length <= 3 ? { oneOf: types.map((type) => ({ type })) } : {}
  }
  if (resolved.type === 'array') {
    const compact = { type: 'array' }
    if (depth < 4 && resolved.items !== undefined) {
      const items = compactNode(resolved.items, root, depth + 1)
      if (Object.keys(items).length > 0) compact.items = items
    }
    return compact
  }
  if (resolved.type === 'object') return { type: 'object' }
  return typeof resolved.type === 'string' ? { type: resolved.type } : {}
}

/** Compact an object-parameter schema: top-level properties and the required list. */
const compactSchema = (schema) => {
  const root = resolveRef(schema, schema)
  if (root === null || typeof root !== 'object') return { type: 'object' }
  const compact = {}
  if (typeof root.type === 'string') compact.type = root.type
  const properties = root.properties !== null && typeof root.properties === 'object' ? root.properties : undefined
  if (properties !== undefined) {
    const out = {}
    for (const [key, node] of Object.entries(properties)) out[key] = compactNode(node, root, 0)
    compact.properties = out
  } else if (typeof compact.type !== 'string') {
    compact.type = 'object'
  }
  if (Array.isArray(root.required)) {
    const keys = properties === undefined ? [] : Object.keys(properties)
    const required = root.required.filter((key) => typeof key === 'string' && (keys.length === 0 || keys.includes(key)))
    if (required.length > 0) compact.required = required
  }
  if (typeof root.additionalProperties === 'boolean') compact.additionalProperties = root.additionalProperties
  return compact
}

/**
 * Fit one tool's parameter schema into a character budget.
 *
 * Order of degradation: full JSON → annotations stripped → compact valid
 * schema → omitted (no JSON at all). `text` is always parseable JSON when it is
 * present; `required` is returned so the caller can print the required names
 * for the omitted case.
 *
 * @param {object} schema tool input schema
 * @param {number} budget character budget for the printed text
 * @returns {{text: string|undefined, mode: 'full'|'stripped'|'compact'|'omitted', omitted: boolean, chars: number, required: string[]}}
 */
export function fitDetailSchema(schema, budget) {
  const source = schema === undefined || schema === null ? {} : schema
  const original = JSON.stringify(source) ?? '{}'
  const root = resolveRef(source, source)
  const required = Array.isArray(root?.required) ? root.required.filter((key) => typeof key === 'string') : []
  if (original.length <= budget) return { text: original, mode: 'full', omitted: false, chars: original.length, required }
  const stripped = JSON.stringify(stripAnnotations(source))
  if (stripped.length <= budget) return { text: stripped, mode: 'stripped', omitted: false, chars: original.length, required }
  const compact = JSON.stringify(compactSchema(source))
  if (compact.length <= budget) return { text: compact, mode: 'compact', omitted: false, chars: original.length, required }
  return { text: undefined, mode: 'omitted', omitted: true, chars: original.length, required }
}

/** Backwards-compatible name for `__test` and the previous call sites. */
export const fitSchema = fitDetailSchema

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/** Canonical order for the "kept visible" reasons (stable output). */
const ADOPT_REASONS = ['task support required', 'always visible (config)', 'unrecognized name shape']

/** How many tool names one reason may list in the bounded kept-visible line. */
const MAX_NOT_ADOPTED_NAMES = 3

/** Hard cap for that whole line, so a long catalog cannot bloat a page. */
const MAX_NOT_ADOPTED_CHARS = 400

/**
 * Group the searched scope by server with loaded/hidden counts.
 *
 * `parseName` splits at the FIRST `__`, so a server name that itself contains
 * `__` is bucketed as the part before that first separator — a documented
 * limitation of the tool-name shape, not a claim of full correctness. Reading
 * the prefix from the caller (instead of hardcoding it) keeps a configured
 * tool-name prefix accurate.
 *
 * @param {string[]} availableNames names in the searched scope
 * @param {string} prefix tool-name prefix (`mcp__` by default)
 * @param {Set<string>} loadedNames names already loaded for this agent
 * @param {Set<string>} hiddenNames names hidden for this agent
 * @returns {{server: string, tools: number, loaded: number, hidden: number}[]}
 */
const serverFootprint = (availableNames, prefix, loadedNames, hiddenNames) => {
  const buckets = new Map()
  for (const name of availableNames ?? []) {
    const { server } = parseName(name, prefix)
    if (server === '') continue
    let bucket = buckets.get(server)
    if (bucket === undefined) {
      bucket = { server, tools: 0, loaded: 0, hidden: 0 }
      buckets.set(server, bucket)
    }
    bucket.tools += 1
    if (loadedNames.has(name)) bucket.loaded += 1
    if (hiddenNames.has(name)) bucket.hidden += 1
  }
  return [...buckets.values()].sort((left, right) => left.server.localeCompare(right.server))
}

/**
 * One bounded line for catalog tools the plugin deliberately does not mask
 * (task support required, always visible by config, unrecognized name shape).
 *
 * @param {{name: string, reason: string}[]|undefined} notAdopted
 * @returns {string|undefined} the line, or `undefined` when nothing is kept visible
 */
const renderNotAdopted = (notAdopted) => {
  if (!Array.isArray(notAdopted) || notAdopted.length === 0) return undefined
  const groups = new Map()
  for (const item of notAdopted) {
    const name = typeof item?.name === 'string' ? item.name : ''
    if (name === '') continue
    const reason = typeof item?.reason === 'string' && item.reason !== '' ? item.reason : 'unknown'
    const names = groups.get(reason) ?? []
    names.push(name)
    groups.set(reason, names)
  }
  if (groups.size === 0) return undefined
  const reasons = [...groups.keys()].sort((left, right) => {
    const leftIndex = ADOPT_REASONS.indexOf(left)
    const rightIndex = ADOPT_REASONS.indexOf(right)
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex
    if (leftIndex >= 0) return -1
    if (rightIndex >= 0) return 1
    return left.localeCompare(right)
  })
  const parts = reasons.map((reason) => {
    const names = groups.get(reason)
    const shown = names.slice(0, MAX_NOT_ADOPTED_NAMES).join(', ')
    const more = names.length > MAX_NOT_ADOPTED_NAMES ? `, … (+${names.length - MAX_NOT_ADOPTED_NAMES} more)` : ''
    return `${reason}: ${names.length} (${shown}${more})`
  })
  const line = `Kept visible (not masked): ${parts.join('; ')}.`
  return line.length > MAX_NOT_ADOPTED_CHARS ? `${line.slice(0, MAX_NOT_ADOPTED_CHARS - 1)}…` : line
}

/**
 * Render one search result as compact text.
 *
 * Empty states are kept distinct on purpose: "no catalog at all", "the server
 * filter matched nothing" and "the query matched nothing" need different
 * recovery hints, and claiming the catalog is empty when tools exist sends the
 * model looking for the wrong problem.
 *
 * @param {object} result from `rankCatalog`
 * @param {object} options
 * @param {number} [options.summaryChars] one-line description budget per result
 * @param {'brief'|'full'} [options.detail] `full` prints up to two input schemas
 * @param {Set<string>} [options.loadedNames] names already loaded for this agent
 * @param {Set<string>} [options.hiddenNames] names hidden for this agent
 * @param {number} [options.hiddenCount] hidden tools inside the searched scope
 * @param {{name: string, reason: string}[]} [options.notAdopted] visible catalog tools and why
 * @param {string} [options.prefix] tool-name prefix used to parse server names
 * @returns {string} the tool result text
 */
export function renderSearch(result, options = {}) {
  const summaryChars = Number.isFinite(options.summaryChars) ? options.summaryChars : 160
  const detail = options.detail === 'full' ? 'full' : 'brief'
  const loadedNames = options.loadedNames instanceof Set ? options.loadedNames : new Set(options.loadedNames ?? [])
  const hiddenNames = options.hiddenNames instanceof Set ? options.hiddenNames : new Set(options.hiddenNames ?? [])
  const hiddenCount = Number.isFinite(options.hiddenCount) ? options.hiddenCount : 0
  const namePrefix = typeof options.prefix === 'string' && options.prefix !== '' ? options.prefix : 'mcp__'
  const notAdoptedLine = renderNotAdopted(options.notAdopted)
  const query = typeof result?.query === 'string' ? result.query : ''
  const server = typeof result?.server === 'string' ? result.server : undefined
  const emptyQuery = query === ''
  const lines = []

  if (result.total === 0) {
    return (
      'No MCP tools are registered right now. Check that the MCP server rows are connected and enabled; ' +
      'when a server reconnects its tools become searchable again.'
    )
  }

  const serversText = result.servers.map(([name, count]) => `${name} (${count} tools)`).join(', ')
  // The server filter matched no server: say which servers exist instead of
  // implying the catalog is empty.
  if (server !== undefined && result.available === 0) {
    lines.push(`No MCP tools found for server "${server}". Servers with tools right now: ${serversText}.`)
    lines.push(`Try one of those names as server:"${result.servers[0]?.[0] ?? 'name'}".`)
    if (notAdoptedLine !== undefined) lines.push(notAdoptedLine)
    return lines.join('\n')
  }

  if (emptyQuery) {
    // One line per server so the model can pick a `server:"name"` scope without
    // a second search; counts come from the searched scope, not from all tools.
    const perServer = serverFootprint(result.availableNames, namePrefix, loadedNames, hiddenNames)
    lines.push(`MCP servers (${perServer.length}) — pass server:"name" to narrow:`)
    for (const bucket of perServer) {
      lines.push(`- ${bucket.server}: ${bucket.tools} tools, ${bucket.loaded} loaded, ${bucket.hidden} hidden`)
    }
  } else {
    lines.push(`MCP servers: ${serversText}`)
  }
  if (hiddenCount > 0) {
    lines.push(`Hidden until loaded: ${hiddenCount} of ${result.available} tools (not in your tool set).`)
  }
  if (notAdoptedLine !== undefined) lines.push(notAdoptedLine)
  if (result.entries.length === 0) {
    // The catalog exists but the query matched nothing; spell out the recovery
    // path and what the descriptions actually look like.
    lines.push(`No tool matched "${query}"${server === undefined ? '' : ` in server "${server}"`}.`)
    lines.push('Tool names and most descriptions are English, so English keywords usually retrieve better (for example "screenshot", "navigate", "render").')
    if (result.examples.length > 0) lines.push(`Example tools here: ${result.examples.join(', ')}.`)
    lines.push('Pass server:"<name>" to narrow, or an empty query to list every server and its tools.')
    return lines.join('\n')
  }
  if (emptyQuery) {
    lines.push(`Showing ${result.entries.length} of ${result.available} tools (pass query words or server to narrow):`)
  } else {
    lines.push(`Matches ${result.matched} of ${result.available}:`)
  }
  for (const entry of result.entries) {
    const signature = entry.signature ? `(${entry.signature})` : '()'
    const summary = oneLine(entry.description, summaryChars)
    const tags = Array.isArray(entry.matchedFields) && entry.matchedFields.length > 0
      ? entry.matchedFields.map((field) => `[${field}]`).join('')
      : ''
    // Cache-only entries for a lazy server are searchable but not registered.
    const lazy = entry.lazy === true ? '[lazy]' : ''
    const marker = loadedNames.has(entry.name) ? '[loaded]' : ''
    const badges = `${tags}${lazy}${marker}`
    lines.push(`- ${entry.name}${signature}${badges === '' ? '' : ` ${badges}`}${summary ? ` — ${summary}` : ''}`)
  }
  if (!emptyQuery && result.matched > result.entries.length) {
    lines.push(`(${result.matched - result.entries.length} more not shown; narrow the query or raise limit up to ${MAX_SEARCH_LIMIT}.)`)
  }
  if (detail === 'full') {
    const detailed = result.entries.slice(0, MAX_DETAIL_TOOLS)
    // Split the page budget evenly, so `detail:"full"` cannot print two big
    // schemas and blow the intended total.
    const perToolBudget = detailed.length > 1 ? Math.floor(DETAIL_SCHEMA_BUDGET / MAX_DETAIL_TOOLS) : DETAIL_SCHEMA_BUDGET
    for (const entry of detailed) {
      const fitted = fitDetailSchema(entry.parameters, perToolBudget)
      if (fitted.omitted) {
        const signature = entry.signature ? `${entry.name}(${entry.signature})` : `${entry.name}()`
        lines.push(`schema omitted: too large (${fitted.chars} chars); signature: ${signature}`)
        if (fitted.required.length > 0) {
          // The notice replaces a too-large schema, so it must stay small too.
          const shown = fitted.required.slice(0, MAX_REQUIRED_NAMES).join(', ')
          const more = fitted.required.length - Math.min(fitted.required.length, MAX_REQUIRED_NAMES)
          lines.push(`Required: ${shown}${more > 0 ? `, … (${more} more)` : ''}.`)
        }
      } else {
        const note = fitted.mode === 'compact'
          ? ' (compact: description and nested detail trimmed, types and enums kept)'
          : fitted.mode === 'stripped'
            ? ' (annotations trimmed to fit)'
            : ''
        lines.push(`schema for ${entry.name}${note}:`)
        lines.push(fitted.text)
      }
    }
    if (result.entries.length > detailed.length) {
      lines.push(`(full schemas shown for the first ${MAX_DETAIL_TOOLS} matches only.)`)
    }
  }
  return lines.join('\n')
}

/**
 * The `mcp_search` tool description. It lives here so the hint is covered by
 * the pure tests next to the code it describes.
 */
export const MCP_SEARCH_DESCRIPTION =
  'Find unknown MCP tool names or arguments. Call tools already in your tool set directly. ' +
  'Names and descriptions are mostly English, so English keywords retrieve better. ' +
  'Results include names, summaries and signatures; detail:"full" adds the input schema of up to two matches ' +
  '(a compact schema or signature when a schema is too large).'
