#!/usr/bin/env node
/**
 * Measure the tool-definition payload of two DSH session captures (an A/B pair).
 *
 * A DSH session records the request header it sent to the model provider as a
 * `request/header` event; its `data.header.tools` array is the tool-definition
 * payload the provider was billed for. This script reads such a capture (plain
 * `.jsonl` or `.jsonl.zstd`), picks the event with the **largest** tools array
 * (the fullest view of the session), and reports the payload size split into
 *
 *   - MCP tools      — names starting with the `mcp__` prefix,
 *   - meta tools     — `mcp_search` / `mcp_load` / `mcp_call` / `mcp_servers` /
 *                      `mcp_server` (the plugin's own replacement for the hidden
 *                      schemas),
 *   - everything else — the non-MCP, non-meta tools.
 *
 * It never prints message or prompt text: only tool/server names, counts and
 * sizes.
 *
 * Usage:
 *   node scripts/measure-tools-payload.mjs --before <capture> --after <capture>
 *   node scripts/measure-tools-payload.mjs --before <capture> --after <capture> --json
 *   node scripts/measure-tools-payload.mjs --self-test
 *
 * `<capture>` is a session JSONL file or a session directory (a directory picks
 * up `session.v4.jsonl.zstd`, `session.v4.jsonl`, `session.jsonl.zstd` or
 * `session.jsonl`).
 *
 * The "chars" metric
 * ------------------
 * `chars` is the length of the tool-definition JSON **as `json.dumps(obj)`
 * writes it in Python**: `", "` / `": "` separators and every non-ASCII
 * character written as a `\uXXXX` escape. This is the yardstick the earlier
 * README snapshot was measured with, so the numbers stay comparable with it.
 * `JSON.stringify` writes the same content compactly and leaves non-ASCII raw,
 * so `referenceJson()` applies those two differences explicitly.
 *
 * Tokens use the ratio measured for this block: **3.224 chars/token** (a flat
 * 4 chars/token understates it by about 24 %).
 *
 * The script assumes the default `mcp__` tool-name prefix (the plugin's
 * `prefix` config default).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Chars per token, measured for the tool-definition block (README → Cost). */
const CHARS_PER_TOKEN = 3.224

/** The plugin's meta tools — what replaces the hidden MCP schemas. */
const META_TOOL_NAMES = ['mcp_search', 'mcp_load', 'mcp_call', 'mcp_servers', 'mcp_server']

/** The default tool-name prefix that marks a hidden MCP tool (`prefix` config). */
const MCP_PREFIX = 'mcp__'

/** Every non-ASCII UTF-16 code unit — each one is written as a `\uXXXX` escape. */
const NON_ASCII = new RegExp('[\\u0080-\\uffff]', 'g')

/**
 * Serialize a value the way Python's `json.dumps(obj)` does.
 *
 * `JSON.stringify` differs in exactly two ways: it writes compact separators
 * and leaves non-ASCII characters raw. Both are corrected here, so the length
 * of the result is the same number Python reports.
 */
const referenceJson = (value) => {
  const compact = JSON.stringify(value)
  if (compact === undefined) return ''
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < compact.length; index += 1) {
    const ch = compact[index]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',' || ch === ':') {
      out += `${ch} `
      continue
    }
    out += ch
  }
  // One \uXXXX escape (6 chars) per non-ASCII UTF-16 code unit.
  return out.replace(NON_ASCII, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The size of a tool subset: 0 for an empty subset, otherwise its JSON length. */
const charsOf = (tools) => (tools.length === 0 ? 0 : referenceJson(tools).length)

const isMcpTool = (tool) => typeof tool?.name === 'string' && tool.name.startsWith(MCP_PREFIX)

const isMetaTool = (tool) => typeof tool?.name === 'string' && META_TOOL_NAMES.includes(tool.name)

/**
 * Measure one tool array.
 *
 * The three size buckets add up to the total exactly: a JSON array costs two
 * brackets plus one separator per item, and the subsets split the same items,
 * so `mcpChars + metaChars + nonMcpChars === totalChars` always holds.
 */
const measure = (tools) => {
  const mcp = tools.filter(isMcpTool)
  const meta = tools.filter(isMetaTool)
  const other = tools.filter((tool) => !isMcpTool(tool) && !isMetaTool(tool))
  const servers = {}
  for (const tool of mcp) {
    const server = tool.name.slice(MCP_PREFIX.length).split('__')[0]
    servers[server] = (servers[server] ?? 0) + 1
  }
  const totalChars = charsOf(tools)
  const mcpChars = charsOf(mcp)
  const metaChars = charsOf(meta)
  const nonMcpChars = charsOf(other)
  return {
    tools: tools.length,
    mcpTools: mcp.length,
    metaTools: meta.length,
    otherTools: other.length,
    servers,
    totalChars,
    mcpChars,
    metaChars,
    nonMcpChars,
    totalTokens: Math.round(totalChars / CHARS_PER_TOKEN),
    mcpTokens: Math.round(mcpChars / CHARS_PER_TOKEN),
    metaTokens: Math.round(metaChars / CHARS_PER_TOKEN),
    nonMcpTokens: Math.round(nonMcpChars / CHARS_PER_TOKEN),
  }
}

/** Resolve a capture argument to the JSONL file that holds the session. */
const resolveCapture = (input) => {
  const resolved = path.resolve(input)
  if (!fs.existsSync(resolved)) {
    throw new Error(`no such file or directory: ${resolved}`)
  }
  if (!fs.statSync(resolved).isDirectory()) return resolved
  const candidates = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']
  for (const name of candidates) {
    const candidate = path.join(resolved, name)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`${resolved} is a directory but holds no session JSONL (looked for ${candidates.join(', ')})`)
}

/** Read a capture as text; `.zstd` files are decompressed with the `zstd` binary. */
const readCapture = (file) => {
  if (!file.endsWith('.zstd')) return fs.readFileSync(file, 'utf8')
  const result = spawnSync('zstd', ['-dc', file], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        `zstd is not installed, but ${file} is zstd-compressed — install zstd, or decompress the capture to a plain .jsonl first`,
      )
    }
    throw new Error(`zstd failed on ${file}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const diagnostic = (result.stderr ?? '').trim()
    throw new Error(`zstd exited with ${result.status} on ${file}${diagnostic ? `: ${diagnostic}` : ''}`)
  }
  return result.stdout ?? ''
}

/**
 * Find the `request/header` event with the largest tools array.
 *
 * A session records one such event per request that carried a tool array; the
 * largest one is the fullest view of the session's tool payload.
 */
const pickHeaderEvent = (text, label) => {
  let best = null
  let headerEvents = 0
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`${label}: line ${index + 1} is not valid JSON: ${error.message}`)
    }
    if (event?.type !== 'request/header') continue
    const tools = event?.data?.header?.tools
    if (!Array.isArray(tools)) continue
    headerEvents += 1
    if (best === null || tools.length > best.tools.length) {
      best = { tools, seq: typeof event.seq === 'number' ? event.seq : null }
    }
  }
  if (best === null) {
    throw new Error(`${label}: no request/header event with a tools array was found in the capture`)
  }
  return { ...best, headerEvents }
}

/** Read one side of the pair: the file, the event and the measured numbers. */
const readSide = (input, label) => {
  const file = resolveCapture(input)
  const event = pickHeaderEvent(readCapture(file), label)
  return {
    label,
    file,
    seq: event.seq,
    headerEvents: event.headerEvents,
    ...measure(event.tools),
  }
}

const int = (value) => value.toLocaleString('en-US')

const signed = (value) => (value > 0 ? `+${int(value)}` : int(value))

const percent = (before, after) => {
  if (before === 0) return after === 0 ? '0 %' : 'n/a'
  const change = ((after - before) / before) * 100
  return `${change.toFixed(1)} %`
}

/** Render the markdown table and the deltas for one pair. */
const renderMarkdown = (before, after) => {
  const lines = []
  lines.push('# Tool-definition payload (session-pair measurement)')
  lines.push('')
  lines.push(`chars/token ratio: **${CHARS_PER_TOKEN}**`)
  lines.push('')
  lines.push('| metric | before | after | delta |')
  lines.push('|---|---:|---:|---:|')
  const rows = [
    ['tools', before.tools, after.tools],
    ['MCP tools', before.mcpTools, after.mcpTools],
    ['meta tools', before.metaTools, after.metaTools],
    ['other (non-MCP, non-meta) tools', before.otherTools, after.otherTools],
    ['total chars', before.totalChars, after.totalChars],
    ['total tokens', before.totalTokens, after.totalTokens],
    ['MCP chars', before.mcpChars, after.mcpChars],
    ['MCP tokens', before.mcpTokens, after.mcpTokens],
    ['meta chars', before.metaChars, after.metaChars],
    ['meta tokens', before.metaTokens, after.metaTokens],
    ['non-MCP chars', before.nonMcpChars, after.nonMcpChars],
    ['non-MCP tokens', before.nonMcpTokens, after.nonMcpTokens],
  ]
  for (const [label, left, right] of rows) {
    lines.push(`| ${label} | ${int(left)} | ${int(right)} | ${signed(right - left)} |`)
  }
  lines.push('')
  lines.push('| server | before | after |')
  lines.push('|---|---:|---:|')
  const servers = [...new Set([...Object.keys(before.servers), ...Object.keys(after.servers)])].sort()
  if (servers.length === 0) lines.push('| _(no MCP server tools)_ | 0 | 0 |')
  for (const server of servers) {
    lines.push(`| ${server} | ${int(before.servers[server] ?? 0)} | ${int(after.servers[server] ?? 0)} |`)
  }
  lines.push('')
  lines.push('## Deltas')
  lines.push('')
  lines.push(
    `- MCP block: ${int(before.mcpChars)} chars (${int(before.mcpTokens)} tokens) → ${int(after.mcpChars)} chars (${int(after.mcpTokens)} tokens), ${signed(after.mcpChars - before.mcpChars)} chars (${percent(before.mcpChars, after.mcpChars)})`,
  )
  lines.push(
    `- meta tools (the replacement): ${int(before.metaChars)} chars (${int(before.metaTokens)} tokens) → ${int(after.metaChars)} chars (${int(after.metaTokens)} tokens), ${signed(after.metaChars - before.metaChars)} chars`,
  )
  lines.push(
    `- total: ${int(before.totalChars)} chars (${int(before.totalTokens)} tokens) → ${int(after.totalChars)} chars (${int(after.totalTokens)} tokens), ${signed(after.totalChars - before.totalChars)} chars (${percent(before.totalChars, after.totalChars)})`,
  )
  lines.push(
    `- non-MCP tools moved on their own: ${int(before.nonMcpChars)} → ${int(after.nonMcpChars)} chars, ${signed(after.nonMcpChars - before.nonMcpChars)} chars — the two captures are not the same build`,
  )
  lines.push('')
  lines.push(`- before capture: \`${before.file}\` (request/header event #${before.seq}, ${before.headerEvents} header event(s) in the session)`)
  lines.push(`- after capture: \`${after.file}\` (request/header event #${after.seq}, ${after.headerEvents} header event(s) in the session)`)
  lines.push('')
  return lines.join('\n')
}

/** Render the machine-readable form. */
const renderJson = (before, after) =>
  JSON.stringify(
    {
      tool: 'measure-tools-payload',
      charsPerToken: CHARS_PER_TOKEN,
      metaTools: META_TOOL_NAMES,
      mcpPrefix: MCP_PREFIX,
      before,
      after,
      delta: {
        tools: after.tools - before.tools,
        mcpTools: after.mcpTools - before.mcpTools,
        metaTools: after.metaTools - before.metaTools,
        totalChars: after.totalChars - before.totalChars,
        totalTokens: after.totalTokens - before.totalTokens,
        mcpChars: after.mcpChars - before.mcpChars,
        mcpTokens: after.mcpTokens - before.mcpTokens,
        metaChars: after.metaChars - before.metaChars,
        nonMcpChars: after.nonMcpChars - before.nonMcpChars,
      },
    },
    null,
    2,
  )

/**
 * Self-test: build synthetic headers and assert the arithmetic.
 *
 * Exits 1 with the failing assertion when something is off.
 */
const selfTest = () => {
  const failures = []
  let assertions = 0
  const check = (label, actual, expected) => {
    assertions += 1
    if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`)
  }

  const tool = (name, description) => ({ name, description, parameters: { type: 'object', properties: {} } })
  const synthetic = [
    tool('mcp__alpha__one', 'first tool'),
    tool('mcp__alpha__two', 'second tool'),
    tool('mcp__beta__only', 'third tool'),
    tool('mcp_search', 'find tools in the hidden catalog'),
    tool('mcp_load', 'load the selected tools'),
    tool('bash', 'run a command'),
  ]
  const measured = measure(synthetic)

  check('tool count', measured.tools, 6)
  check('mcp tool count', measured.mcpTools, 3)
  check('meta tool count', measured.metaTools, 2)
  check('other tool count', measured.otherTools, 1)
  check('alpha server count', measured.servers.alpha, 2)
  check('beta server count', measured.servers.beta, 1)

  check('total chars', measured.totalChars, referenceJson(synthetic).length)
  check('mcp chars', measured.mcpChars, referenceJson(synthetic.slice(0, 3)).length)
  check('meta chars', measured.metaChars, referenceJson(synthetic.slice(3, 5)).length)
  check('non-mcp chars', measured.nonMcpChars, referenceJson(synthetic.slice(5)).length)
  check(
    'the three buckets add up to the total',
    measured.mcpChars + measured.metaChars + measured.nonMcpChars,
    measured.totalChars,
  )
  check('total tokens', measured.totalTokens, Math.round(measured.totalChars / CHARS_PER_TOKEN))
  check('mcp tokens', measured.mcpTokens, Math.round(measured.mcpChars / CHARS_PER_TOKEN))
  check('meta tokens', measured.metaTokens, Math.round(measured.metaChars / CHARS_PER_TOKEN))
  check('non-mcp tokens', measured.nonMcpTokens, Math.round(measured.nonMcpChars / CHARS_PER_TOKEN))

  // The reference serialization is Python's `json.dumps` default: spaced
  // separators and non-ASCII escaped.
  check('separators are spaced', referenceJson({ a: 1, b: [2, 3] }), '{"a": 1, "b": [2, 3]}')
  check('non-ascii is escaped', referenceJson({ a: '中' }), '{"a": "\\u4e2d"}')
  check('an empty subset is 0 chars', charsOf([]), 0)

  // The largest request/header event wins.
  const lines = [
    JSON.stringify({ type: 'request/header', seq: 1, data: { header: { tools: synthetic } } }),
    JSON.stringify({ type: 'request/header', seq: 2, data: { header: { tools: synthetic.slice(0, 4) } } }),
    JSON.stringify({ type: 'user/message', seq: 3, data: { content: 'not a header' } }),
  ]
  const picked = pickHeaderEvent(`${lines.join('\n')}\n`, 'self-test')
  check('the largest header event wins', picked.tools.length, 6)
  check('the header event count is reported', picked.headerEvents, 2)

  // A capture without a usable event is an error, not a silent zero.
  let threw = false
  try {
    pickHeaderEvent(`${JSON.stringify({ type: 'user/message', seq: 1 })}\n`, 'self-test')
  } catch {
    threw = true
  }
  check('a capture without a header event throws', threw, true)

  if (failures.length > 0) {
    console.error('self-test: FAILED')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`self-test: OK (${assertions} assertions)`)
}

const usage = () => {
  console.error(
    [
      'Usage:',
      '  node scripts/measure-tools-payload.mjs --before <capture> --after <capture> [--json]',
      '  node scripts/measure-tools-payload.mjs --self-test',
      '',
      '<capture> is a session JSONL file (.jsonl or .jsonl.zstd) or a session directory.',
    ].join('\n'),
  )
}

const main = () => {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    selfTest()
    return
  }
  const flag = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined
  }
  const beforeInput = flag('--before')
  const afterInput = flag('--after')
  if (!beforeInput || !afterInput) {
    usage()
    process.exit(2)
  }
  const wantJson = argv.includes('--json')
  const before = readSide(beforeInput, '--before')
  const after = readSide(afterInput, '--after')
  console.log(wantJson ? renderJson(before, after) : renderMarkdown(before, after))
}

try {
  main()
} catch (error) {
  console.error(`measure-tools-payload: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
