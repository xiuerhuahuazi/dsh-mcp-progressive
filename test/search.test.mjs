/**
 * Search / schema regression for `mcp_search`.
 *
 * Pure: every case imports `lib/search.js` directly, so no Cordis context,
 * runtime or network is involved. The catalog fixture mirrors the real shape
 * (rea 170 + bilibili 31 + blender 9 = 210 tools, mixed English/Chinese
 * descriptions) so the review's measured queries can be asserted one by one.
 * The real 210-tool catalog from the private review probes is optional: set
 * `MCP_REVIEW_CATALOG` to a local copy to run the real-catalog cases, otherwise
 * they skip (CI has no such file, and no home-directory path is committed).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  MAX_SEARCH_LIMIT,
  MAX_SIGNATURE_CHARS,
  MCP_SEARCH_DESCRIPTION,
  countHidden,
  fitDetailSchema,
  fitSchema,
  parseName,
  rankCatalog,
  renderSearch,
  scoreEntry,
  signatureOf,
  summarizeServers,
  tokenize,
} from '../lib/search.js'

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** One catalog entry, shaped exactly like `catalogOf()` in index.js. */
function entry(server, tool, description, parameters) {
  const schema = parameters ?? {
    type: 'object',
    properties: { [tool]: { type: 'string', description: `${tool} input` } },
    required: [],
  }
  return {
    name: `mcp__${server}__${tool}`,
    server,
    tool,
    description,
    parameters: schema,
    signature: signatureOf(schema),
  }
}

/** Named rea tools whose names/descriptions make the sample queries meaningful. */
const REA_SPECIFIC = [
  ['capture_web_screenshot', 'Capture a screenshot of a web page inside a browser session'],
  ['browser_navigate', 'Navigate a browser page to a URL'],
  ['capture_browser_scenario', 'Capture a browser scenario with screenshots and console output'],
  ['inspect_web_page', 'Inspect a web page DOM and its network requests'],
  ['analyze_web_bundle', 'Analyze a bundled web application'],
  ['decompile_function', 'Decompile one function from a native binary'],
  ['evaluate_reconstruction_coverage', 'Evaluate reconstruction coverage for a source bundle'],
  ['build_reconstruction_obligation_ledger', 'Build a reconstruction obligation ledger'],
  ['observe_native_calls', 'Observe native calls made by a process at runtime'],
  ['compare_web_captures', 'Compare two web captures visually'],
  ['render_hud', 'Render a HUD overlay around the subject'],
  ['update_unknown', 'Update one unknown record'],
  ['record_unknown', 'Record one unknown item'],
  ['capture_process_scenario', 'Capture a process scenario'],
]

/** Chinese-described bilibili tools (the real server keeps its descriptions in Chinese). */
const BILIBILI_SPECIFIC = [
  ['bilibili_video_download', '下载 B 站视频到本地'],
  ['bilibili_article_download', '下载 B 站专栏文章'],
  ['bilibili_video_info', '获取视频详情与播放地址'],
  ['bilibili_live_screenshot', '对直播间画面截图'],
  ['bilibili_search_video', '搜索视频'],
  ['bilibili_search_user', '搜索用户'],
  ['bilibili_audio_download', '下载音频'],
  ['bilibili_live_info', '获取直播信息'],
  ['bilibili_favorite_list', '获取用户收藏列表'],
  ['bilibili_comment_list', '获取视频评论'],
]

/** English-described blender tools — 渲染/导出 must reach them through the gloss table. */
const BLENDER_SPECIFIC = [
  ['render_image', 'Render the current scene to an image'],
  ['render_scene', 'Render a scene with the configured engine'],
  ['render_animation', 'Render an animation as a video'],
  ['export_gltf', 'Export the scene as glTF'],
  ['export_fbx', 'Export the scene as FBX'],
  ['import_model', 'Import a 3D model'],
  ['set_material', 'Assign a PBR material to an object'],
  ['add_light', 'Add a light to the scene'],
  ['set_camera', 'Set up the camera and framing'],
]

const REA_VERBS = ['create', 'read', 'update', 'delete', 'list', 'get', 'set', 'run', 'start', 'stop', 'export', 'import', 'search', 'filter', 'merge', 'split', 'validate', 'translate', 'summarize', 'generate']
const REA_NOUNS = ['record', 'target', 'session', 'context', 'report', 'ledger', 'layer', 'group', 'asset', 'bundle', 'function', 'symbol', 'process', 'module', 'schema', 'snapshot', 'profile', 'workflow', 'dataset', 'metric']

/** Build the 210-entry fixture catalog (rea 170 / bilibili 31 / blender 9). */
function buildCatalog() {
  const entries = []
  for (const [tool, description] of REA_SPECIFIC) entries.push(entry('rea', tool, description))
  for (let index = entries.length; index < 170; index += 1) {
    const verb = REA_VERBS[index % REA_VERBS.length]
    const noun = REA_NOUNS[Math.floor(index / REA_VERBS.length) % REA_NOUNS.length]
    entries.push(entry('rea', `${verb}_${noun}_${index}`, `${verb} one ${noun} in the current project`))
  }
  for (const [tool, description] of BILIBILI_SPECIFIC) entries.push(entry('bilibili', tool, description))
  for (let index = BILIBILI_SPECIFIC.length; index < 31; index += 1) {
    const noun = REA_NOUNS[index % REA_NOUNS.length]
    entries.push(entry('bilibili', `bilibili_${noun}_${index}`, `获取${noun}相关信息`))
  }
  for (const [tool, description] of BLENDER_SPECIFIC) entries.push(entry('blender', tool, description))
  return entries
}

const CATALOG = buildCatalog()

/**
 * Optional real 210-tool catalog from the private review probes. The real
 * catalog is ~745 KB of private setup data, so it is not committed; point
 * `MCP_REVIEW_CATALOG` at a local copy to exercise the real-catalog cases.
 */
const REVIEW_CATALOG =
  typeof process.env.MCP_REVIEW_CATALOG === 'string' && process.env.MCP_REVIEW_CATALOG.trim() !== ''
    ? process.env.MCP_REVIEW_CATALOG.trim()
    : undefined

const namesOf = (result) => result.entries.map((item) => item.name)

// ---------------------------------------------------------------------------
// Tokenization.
// ---------------------------------------------------------------------------

test('tokenize keeps cased input lowercase and splits on whitespace', () => {
  const tokens = tokenize('Browser Navigate')
  assert.equal(tokens.length, 2)
  assert.deepEqual(tokens[0].variants, ['browser'])
  assert.deepEqual(tokens[1].variants, ['navigate'])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize(''), [])
})

test('tokenize bridges CJK queries to English tool names', () => {
  const browser = tokenize('浏览器')
  assert.equal(browser.length, 1)
  assert.ok(browser[0].variants.includes('browser'), '浏览器 must carry the English gloss')

  // Chinese without spaces: two concepts glued into one run.
  const glued = tokenize('浏览器截图')
  assert.equal(glued.length, 1)
  assert.ok(glued[0].variants.includes('browser'))
  assert.ok(glued[0].variants.includes('screenshot'))

  const download = tokenize('b站 下载')
  assert.equal(download.length, 2)
  assert.ok(download[0].variants.includes('bilibili'), 'b站 must reach bilibili tools')
  assert.ok(download[1].variants.includes('download'))
})

test('tokenize keeps an exact tool name usable as one token', () => {
  const name = 'mcp__rea__decompile_function'
  const tokens = tokenize(name)
  assert.equal(tokens.length, 1)
  const { matched, score } = scoreEntry(CATALOG.find((item) => item.name === name), tokens, name)
  assert.equal(matched, 1)
  assert.ok(score >= 1000, 'an exact full name must outrank every partial match')
})

test('parseName splits on the first __ and accepts a custom prefix', () => {
  assert.deepEqual(parseName('mcp__rea__decompile_function'), { server: 'rea', tool: 'decompile_function' })
  assert.deepEqual(parseName('mcp__foo__bar__tool'), { server: 'foo', tool: 'bar__tool' })
  assert.deepEqual(parseName('x__srv__tool', 'x__'), { server: 'srv', tool: 'tool' })
  assert.deepEqual(parseName('mcp__server-only'), { server: 'server-only', tool: '' })
})

// ---------------------------------------------------------------------------
// Recall: the review's measured queries.
// ---------------------------------------------------------------------------

test('the fixture is the real 210-tool shape', () => {
  assert.equal(CATALOG.length, 210)
  assert.deepEqual(summarizeServers(CATALOG), [
    ['bilibili', 31],
    ['blender', 9],
    ['rea', 170],
  ])
})

/** The review's measured queries: each row names the tools it must retrieve. */
const MEASURED_QUERIES = [
  {
    query: '浏览器',
    includes: ['mcp__rea__browser_navigate', 'mcp__rea__capture_browser_scenario'],
    first: 'mcp__rea__browser_navigate',
  },
  {
    query: '渲染',
    includes: ['mcp__blender__render_image'],
    firstPattern: /^mcp__blender__render_/,
  },
  {
    query: '截图',
    includes: ['mcp__bilibili__bilibili_live_screenshot', 'mcp__rea__capture_web_screenshot'],
  },
  {
    // 「下载 B 站视频」 has spaces inside; the CJK token must still match.
    query: 'b站 下载',
    includes: [
      'mcp__bilibili__bilibili_video_download',
      'mcp__bilibili__bilibili_article_download',
      'mcp__bilibili__bilibili_audio_download',
    ],
  },
  {
    query: 'browser navigate',
    includes: ['mcp__rea__browser_navigate'],
    first: 'mcp__rea__browser_navigate',
  },
]

test('the review\'s measured queries all recall the expected tools (S9, table-driven)', () => {
  for (const row of MEASURED_QUERIES) {
    const result = rankCatalog(CATALOG, { query: row.query })
    assert.ok(result.matched > 0, `"${row.query}" must no longer be zero`)
    const names = namesOf(result)
    for (const name of row.includes) assert.ok(names.includes(name), `"${row.query}" must retrieve ${name}`)
    if (row.first) assert.equal(result.entries[0].name, row.first, `"${row.query}" must rank ${row.first} first`)
    if (row.firstPattern) assert.match(result.entries[0].name, row.firstPattern)
  }
})

test('server filter is case-insensitive (S9, table-driven)', () => {
  const rows = [
    { server: 'Rea', query: 'screenshot' },
    { server: 'REA', query: 'screenshot' },
    { server: 'rea', query: 'screenshot' },
    { server: 'Rea', query: '' },
    { server: 'BILIBILI', query: '下载' },
  ]
  for (const row of rows) {
    const result = rankCatalog(CATALOG, row)
    assert.ok(result.available > 0, `server:"${row.server}" must match its server`)
    assert.ok(result.total === 210)
    const expectedServer = row.server.toLowerCase()
    for (const item of result.entries) assert.equal(item.server, expectedServer)
    if (row.query !== '') assert.ok(result.matched > 0, `server:"${row.server}" + "${row.query}" must match`)
  }
  assert.equal(rankCatalog(CATALOG, { query: '', server: 'Rea' }).available, 170)
})

test('OR semantics: one unmatched token does not zero the result (S9)', () => {
  const result = rankCatalog(CATALOG, { query: 'screenshot zzzznotatool' })
  assert.ok(result.matched > 0)
  assert.ok(result.entries.length > 0)
  assert.ok(namesOf(result).includes('mcp__rea__capture_web_screenshot'))
  // A token that matches nothing must not drag irrelevant entries in either.
  for (const item of result.entries) {
    assert.ok(item.name.toLowerCase().includes('screenshot') || item.description.toLowerCase().includes('screenshot'))
  }
})

test('a single token hit ranks by position then precision (S9)', () => {
  const result = rankCatalog(CATALOG, { query: 'screenshot' })
  const toolNameHits = result.entries.filter((item) => item.tool.includes('screenshot'))
  assert.ok(toolNameHits.length >= 2)
  assert.equal(result.entries[0].name, toolNameHits[0].name, 'tool-name hits outrank description-only hits')
})

test('no query still lists servers and tools (S9)', () => {
  const result = rankCatalog(CATALOG, { query: '', limit: 12 })
  assert.equal(result.total, 210)
  assert.equal(result.available, 210)
  assert.equal(result.entries.length, 12, 'the configured page size applies')
  assert.equal(result.matched, 210)
  const text = renderSearch(result, { hiddenCount: 210 })
  assert.match(text, /MCP servers: bilibili \(31 tools\), blender \(9 tools\), rea \(170 tools\)/)
  assert.match(text, /Showing 12 of 210 tools/)
})

test('limit is clamped to the documented page range', () => {
  assert.equal(rankCatalog(CATALOG, { query: '', limit: 1 }).entries.length, 1)
  assert.equal(rankCatalog(CATALOG, { query: '', limit: 0 }).entries.length, 1)
  assert.equal(rankCatalog(CATALOG, { query: '', limit: 9999 }).entries.length, MAX_SEARCH_LIMIT)
})

// ---------------------------------------------------------------------------
// Empty states and the hidden-count denominator (S9 + P2-2/P2-6).
// ---------------------------------------------------------------------------

test('empty state (a): no catalog at all says so', () => {
  const result = rankCatalog([], { query: '' })
  assert.equal(result.total, 0)
  const text = renderSearch(result, {})
  assert.match(text, /No MCP tools are registered right now/)
  assert.doesNotMatch(text, /No MCP tools found for server/)
})

test('empty state (b): a misspelled server lists the known servers (P2-6)', () => {
  const result = rankCatalog(CATALOG, { query: '', server: 'nope' })
  assert.equal(result.available, 0)
  assert.equal(result.total, 210)
  const text = renderSearch(result, { hiddenCount: 0 })
  assert.match(text, /No MCP tools found for server "nope"/)
  assert.match(text, /Servers with tools right now: bilibili \(31 tools\), blender \(9 tools\), rea \(170 tools\)/)
  assert.match(text, /server:"bilibili"/)
  assert.doesNotMatch(text, /No MCP tools are registered right now/, 'tools exist, so this must never be claimed')
})

test('empty state (c): an unmatched query lists examples and the English hint', () => {
  const result = rankCatalog(CATALOG, { query: 'zzzznope' })
  assert.equal(result.matched, 0)
  const text = renderSearch(result, { hiddenCount: 5 })
  assert.match(text, /No tool matched "zzzznope"/)
  assert.match(text, /Tool names and most descriptions are English, so English keywords usually retrieve better/)
  assert.match(text, /Example tools here: mcp__rea__capture_web_screenshot, mcp__rea__browser_navigate, mcp__rea__capture_browser_scenario\./)
  assert.doesNotMatch(text, /No MCP tools are registered right now/)
})

test('hidden count shares the server-filtered scope (no more "201 of 170")', () => {
  const allNames = new Set(CATALOG.map((item) => item.name))
  const rea = rankCatalog(CATALOG, { query: '', server: 'rea' })
  const hiddenCount = countHidden(rea.availableNames, allNames)
  assert.equal(hiddenCount, 170)
  const text = renderSearch(rea, { hiddenCount })
  const match = text.match(/Hidden until loaded: (\d+) of (\d+) tools/)
  assert.ok(match, 'the line still appears while everything is hidden')
  assert.equal(match[2], '170')
  assert.equal(match[1], '170', 'numerator is the hidden subset of the searched scope')
  assert.doesNotMatch(text, /210 of 170/)
})

test('hidden line is dropped when nothing is hidden (P2-2)', () => {
  const result = rankCatalog(CATALOG, { query: '', server: 'bilibili' })
  const text = renderSearch(result, { hiddenCount: 0 })
  assert.doesNotMatch(text, /Hidden until loaded/)
})

test('hidden count never exceeds its own denominator for any server scope', () => {
  const allNames = new Set(CATALOG.map((item) => item.name))
  for (const [server] of summarizeServers(CATALOG)) {
    const result = rankCatalog(CATALOG, { query: '', server })
    const hiddenCount = countHidden(result.availableNames, allNames)
    assert.ok(hiddenCount <= result.available)
    const match = renderSearch(result, { hiddenCount }).match(/Hidden until loaded: (\d+) of (\d+) tools/)
    assert.ok(match)
    assert.ok(Number(match[1]) <= Number(match[2]))
  }
})

test('countHidden only counts names inside the searched scope', () => {
  assert.equal(countHidden(['a', 'b', 'c'], new Set(['b', 'c', 'z'])), 2)
  assert.equal(countHidden([], new Set(['a'])), 0)
  assert.equal(countHidden(['a'], undefined), 0)
})

// ---------------------------------------------------------------------------
// Result rendering.
// ---------------------------------------------------------------------------

test('rendered matches carry count, loaded marker and truncation hint', () => {
  const result = rankCatalog(CATALOG, { query: 'record', limit: 2 })
  assert.ok(result.matched > result.entries.length)
  const loaded = new Set([result.entries[0].name])
  const text = renderSearch(result, { loadedNames: loaded, hiddenCount: 0, summaryChars: 40 })
  assert.match(text, /Matches \d+ of 210:/)
  assert.match(text, new RegExp(`- ${result.entries[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.* \\[loaded\\]`))
  assert.match(text, /more not shown; narrow the query or raise limit up to 40/)
})

// ---------------------------------------------------------------------------
// Signature cap (P2-3).
// ---------------------------------------------------------------------------

test('signatureOf stays short and honest', () => {
  assert.equal(signatureOf({ type: 'object', properties: { a: { type: 'string' } } }), 'a?: string')
  const wide = { type: 'object', properties: {}, required: [] }
  for (let index = 0; index < 40; index += 1) {
    wide.properties[`option_${index}`] = { type: 'string', enum: ['alpha', 'beta', 'gamma'] }
    wide.required.push(`option_${index}`)
  }
  const signature = signatureOf(wide)
  assert.ok(signature.length <= MAX_SIGNATURE_CHARS, `signature length ${signature.length}`)
  assert.ok(signature.endsWith('…'), 'a capped signature says so')
})

// ---------------------------------------------------------------------------
// Schema fitting (S10).
// ---------------------------------------------------------------------------

/** A schema whose bulk is annotations, so stripping alone fits a small budget. */
function annotatedSchema(count = 25) {
  const properties = {}
  for (let index = 0; index < count; index += 1) {
    properties[`field_${index}`] = { type: 'string', description: 'x'.repeat(30), examples: ['one example value'] }
  }
  return { type: 'object', properties, required: ['field_0'], additionalProperties: false }
}

/** A big schema whose bulk survives annotation stripping, so it must compact. */
function nestedSchema(nested = 100) {
  const inner = { type: 'object', properties: {}, additionalProperties: false }
  for (let index = 0; index < nested; index += 1) inner.properties[`deep_${index}`] = { type: 'string', description: 'nested field' }
  return {
    type: 'object',
    properties: { payload: inner, url: { type: 'string', description: 'target url' } },
    required: ['payload'],
  }
}

/** A schema that cannot fit any budget even compacted. */
function unfittableSchema(count = 400) {
  const properties = {}
  const required = []
  for (let index = 0; index < count; index += 1) {
    properties[`parameter_${index}`] = { type: 'integer' }
    required.push(`parameter_${index}`)
  }
  return { type: 'object', properties, required }
}

test('fitSchema returns the original JSON when it already fits', () => {
  const schema = { type: 'object', properties: { q: { type: 'string', description: 'query' } } }
  const fitted = fitDetailSchema(schema, 6000)
  assert.equal(fitted.mode, 'full')
  assert.equal(fitted.omitted, false)
  assert.deepEqual(JSON.parse(fitted.text), schema)
})

test('fitSchema strips annotations before cutting structure', () => {
  const schema = annotatedSchema()
  const size = JSON.stringify(schema).length
  assert.ok(size > 1500, `fixture must be big enough (was ${size})`)
  const fitted = fitDetailSchema(schema, 1000)
  assert.equal(fitted.mode, 'stripped')
  assert.equal(fitted.omitted, false)
  assert.ok(fitted.text.length <= 1000)
  const parsed = JSON.parse(fitted.text)
  assert.equal(parsed.properties.field_0.description, undefined)
  assert.equal(parsed.required[0], 'field_0', 'constraints survive annotation stripping')
})

test('fitSchema compacts nested schemas into valid JSON', () => {
  const schema = nestedSchema()
  const fitted = fitDetailSchema(schema, 700)
  assert.equal(fitted.mode, 'compact')
  assert.equal(fitted.omitted, false)
  const parsed = JSON.parse(fitted.text)
  assert.equal(parsed.type, 'object')
  assert.deepEqual(parsed.properties.payload, { type: 'object' })
  assert.deepEqual(parsed.required, ['payload'])
})

test('fitSchema keeps enum, oneOf, array items and $defs reachable in compact form', () => {
  const schema = {
    type: 'object',
    $defs: {
      Mode: { enum: ['fast', 'slow'] },
      Target: { type: 'object', properties: { id: { type: 'string' } } },
    },
    properties: {
      mode: { $ref: '#/$defs/Mode' },
      target: { $ref: '#/$defs/Target' },
      pick: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      tags: { type: 'array', items: { type: 'string' } },
      nestedLists: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
    },
    required: ['mode'],
  }
  assert.ok(JSON.stringify(schema).length > 300)
  const fitted = fitDetailSchema(schema, 400)
  assert.equal(fitted.mode, 'compact')
  const parsed = JSON.parse(fitted.text)
  assert.deepEqual(parsed.properties.mode, { enum: ['fast', 'slow'] })
  assert.deepEqual(parsed.properties.target, { type: 'object' })
  assert.deepEqual(parsed.properties.pick, { oneOf: [{ type: 'string' }, { type: 'integer' }] })
  assert.deepEqual(parsed.properties.tags, { type: 'array', items: { type: 'string' } })
  assert.deepEqual(parsed.properties.nestedLists, { type: 'array', items: { type: 'array', items: { type: 'integer' } } })
  assert.deepEqual(parsed.required, ['mode'])
})

test('fitSchema omits the JSON when even the compact form is too large', () => {
  const schema = unfittableSchema()
  const fitted = fitDetailSchema(schema, 300)
  assert.equal(fitted.omitted, true)
  assert.equal(fitted.mode, 'omitted')
  assert.equal(fitted.text, undefined, 'nothing unparseable is ever returned')
  assert.equal(fitted.chars, JSON.stringify(schema).length)
  assert.deepEqual(fitted.required.slice(0, 3), ['parameter_0', 'parameter_1', 'parameter_2'])
})

test('fitSchema never mutates the caller schema', () => {
  const schema = nestedSchema(20)
  const before = JSON.stringify(schema)
  fitDetailSchema(schema, 200)
  assert.equal(JSON.stringify(schema), before)
  assert.equal(fitSchema, fitDetailSchema, 'the old name stays an alias')
})

test('synthetic 2k and 8k schemas degrade without printing invalid JSON (S10)', () => {
  const twoKilobytes = annotatedSchema(20)
  const eightKilobytes = nestedSchema(140)
  assert.ok(JSON.stringify(twoKilobytes).length > 2000)
  assert.ok(JSON.stringify(eightKilobytes).length > 8000)

  // 2k of description-heavy schema: stripping annotations alone is enough.
  const stripped = fitDetailSchema(twoKilobytes, 900)
  assert.equal(stripped.mode, 'stripped')
  assert.equal(stripped.omitted, false)
  assert.ok(stripped.text.length <= 900)
  JSON.parse(stripped.text)

  // 8k of structure-heavy schema: must be compacted, never sliced.
  const compacted = fitDetailSchema(eightKilobytes, 900)
  assert.equal(compacted.mode, 'compact')
  assert.equal(compacted.omitted, false)
  assert.ok(compacted.text.length <= 900)
  assert.equal(JSON.parse(compacted.text).properties.payload.type, 'object')
})

test('every printed schema parses and fits its budget (synthetic matrix)', () => {
  const schemas = [annotatedSchema(), nestedSchema(10), nestedSchema(80), unfittableSchema(120), unfittableSchema(400)]
  for (const budget of [40, 200, 700, 1500, 3000, 6000]) {
    for (const schema of schemas) {
      const fitted = fitDetailSchema(schema, budget)
      if (fitted.omitted) {
        assert.equal(fitted.text, undefined)
        continue
      }
      assert.ok(fitted.text.length <= budget, `len ${fitted.text.length} > budget ${budget}`)
      JSON.parse(fitted.text)
    }
  }
})

test('detail:"full" prints at most two schemas within the total budget', () => {
  const first = entry('blender', 'render_image', 'Render the current scene to an image', nestedSchema(200))
  const second = entry('rea', 'capture_web_screenshot', 'Capture a screenshot', annotatedSchema(60))
  const result = {
    query: 'render screenshot',
    entries: [first, second],
    matched: 2,
    available: 2,
    total: 2,
    servers: [['blender', 1], ['rea', 1]],
    availableNames: [first.name, second.name],
    examples: [],
  }
  const text = renderSearch(result, { detail: 'full', hiddenCount: 0, loadedNames: new Set() })
  const schemaLines = text.split('\n').filter((line) => line.startsWith('{'))
  assert.equal(schemaLines.length, 2)
  let printed = 0
  for (const line of schemaLines) {
    JSON.parse(line)
    printed += line.length
  }
  assert.ok(printed <= 6000, `printed ${printed} schema chars`)
  assert.match(text, /schema for mcp__blender__render_image \(compact: description and nested detail trimmed/)
  assert.match(text, /schema for mcp__rea__capture_web_screenshot \(annotations trimmed to fit\)/)
})

test('detail:"full" omits oversized schemas and prints signature plus required names', () => {
  const first = entry('rea', 'huge_one', 'First huge tool', unfittableSchema(400))
  const second = entry('rea', 'huge_two', 'Second huge tool', unfittableSchema(400))
  const result = {
    query: 'huge',
    entries: [first, second],
    matched: 2,
    available: 2,
    total: 2,
    servers: [['rea', 2]],
    availableNames: [first.name, second.name],
    examples: [],
  }
  const text = renderSearch(result, { detail: 'full', hiddenCount: 0 })
  assert.equal(text.split('\n').filter((line) => line.startsWith('{')).length, 0, 'no half-JSON may be printed')
  assert.match(text, /schema omitted: too large \(\d+ chars\); signature: mcp__rea__huge_one\(parameter_0: integer/)
  assert.match(text, /Required: parameter_0, parameter_1, parameter_2,/)
  assert.match(text, /… \(380 more\)/, 'the omitted notice lists a bounded number of required names')
  for (const line of text.split('\n')) {
    assert.ok(line.length < 700, `the omitted notice must stay small, got ${line.length} chars`)
  }
})

test('a single match gets the whole page budget for its schema', () => {
  const parameters = { type: 'object', properties: {}, required: [] }
  for (let index = 0; index < 100; index += 1) {
    parameters.properties[`parameter_${index}`] = { type: 'integer' }
    parameters.required.push(`parameter_${index}`)
  }
  const only = entry('rea', 'wide_tool', 'A wide tool', parameters)
  const single = {
    query: 'wide',
    entries: [only],
    matched: 1,
    available: 1,
    total: 1,
    servers: [['rea', 1]],
    availableNames: [only.name],
    examples: [],
  }
  const singleText = renderSearch(single, { detail: 'full' })
  assert.match(singleText, /schema for mcp__rea__wide_tool/, 'the compact schema fits the single-tool budget')

  const pair = { ...single, entries: [only, { ...only, name: 'mcp__rea__wide_tool_two', tool: 'wide_tool_two' }], matched: 2, available: 2, total: 2, availableNames: ['mcp__rea__wide_tool', 'mcp__rea__wide_tool_two'] }
  const pairText = renderSearch(pair, { detail: 'full' })
  assert.match(pairText, /schema omitted: too large/, 'two tools split the page budget')
})

// ---------------------------------------------------------------------------
// The real 210-tool catalog from the review probes (skips when absent).
// ---------------------------------------------------------------------------

const hasReviewCatalog = REVIEW_CATALOG !== undefined && fs.existsSync(REVIEW_CATALOG)
const NO_REVIEW_CATALOG = 'set MCP_REVIEW_CATALOG to a local copy of the review catalog to run this case'
const readReviewCatalog = () => JSON.parse(fs.readFileSync(REVIEW_CATALOG, 'utf8')).tools
const toEntry = (schema) => {
  const { server, tool } = parseName(schema.name)
  return {
    name: schema.name,
    server,
    tool,
    description: schema.description ?? '',
    parameters: schema.parameters,
    signature: signatureOf(schema.parameters),
  }
}

test('real catalog: measured queries all recall (S9)', (t) => {
  if (!hasReviewCatalog) {
    t.skip(NO_REVIEW_CATALOG)
    return
  }
  const catalog = readReviewCatalog().map(toEntry)
  assert.equal(catalog.length, 210)

  // The real catalog has no tool literally named browser_*/render_*; recall
  // comes from descriptions plus the CJK glosses.
  const measured = [
    { query: '浏览器', includes: ['mcp__rea__capture_browser_scenario'] },
    { query: '渲染', includes: ['mcp__blender__look'] },
    { query: '截图', includes: ['mcp__rea__capture_web_screenshot'] },
    {
      query: 'b站 下载',
      includes: ['mcp__bilibili__bilibili_video_download', 'mcp__bilibili__bilibili_article_download'],
    },
    { query: 'browser navigate', includes: ['mcp__rea__capture_browser_scenario', 'mcp__rea__capture_web_screenshot'] },
  ]
  for (const row of measured) {
    const result = rankCatalog(catalog, { query: row.query, limit: MAX_SEARCH_LIMIT })
    assert.ok(result.matched > 0, `"${row.query}" must not be zero on the real catalog`)
    const names = namesOf(result)
    for (const name of row.includes) assert.ok(names.includes(name), `"${row.query}" must retrieve ${name} on the real catalog`)
  }
  // 渲染 only reaches English descriptions through the gloss ('render' appears
  // inside them), so assert that path rather than a render-named tool.
  const render = rankCatalog(catalog, { query: '渲染' })
  assert.ok(render.entries.some((item) => item.description.toLowerCase().includes('render')))

  for (const spelling of ['Rea', 'rea']) {
    const result = rankCatalog(catalog, { query: '', server: spelling })
    assert.equal(result.available, 170, `server:"${spelling}" must be case-insensitive`)
    const text = renderSearch(result, { hiddenCount: countHidden(result.availableNames, catalog.map((item) => item.name)) })
    assert.match(text, /Hidden until loaded: 170 of 170 tools/)
  }
})

test('real catalog: the 57,175-char compare_web_captures schema always parses (S10)', (t) => {
  if (!hasReviewCatalog) {
    t.skip(NO_REVIEW_CATALOG)
    return
  }
  const catalog = readReviewCatalog().map(toEntry)
  const target = catalog.find((item) => item.name === 'mcp__rea__compare_web_captures')
  assert.ok(target, 'the review catalog must still contain compare_web_captures')
  assert.ok(JSON.stringify(target.parameters).length > 50_000)

  for (const budget of [1500, 3000, 6000]) {
    const fitted = fitDetailSchema(target.parameters, budget)
    assert.equal(fitted.omitted, false, `the compact form must fit ${budget} chars`)
    assert.ok(fitted.text.length <= budget)
    JSON.parse(fitted.text)
  }
  assert.equal(fitDetailSchema(target.parameters, 6000).mode, 'compact')
})

test('real catalog: every schema either parses within budget or is explicitly omitted (S10)', (t) => {
  if (!hasReviewCatalog) {
    t.skip(NO_REVIEW_CATALOG)
    return
  }
  const catalog = readReviewCatalog().map(toEntry)
  let omitted = 0
  for (const item of catalog) {
    for (const budget of [1500, 3000]) {
      const fitted = fitDetailSchema(item.parameters, budget)
      if (fitted.omitted) {
        omitted += 1
        continue
      }
      assert.ok(fitted.text.length <= budget, `${item.name}: ${fitted.text.length} > ${budget}`)
      JSON.parse(fitted.text)
    }
    assert.ok(item.signature.length <= MAX_SIGNATURE_CHARS, `${item.name}: signature ${item.signature.length}`)
  }
  assert.equal(omitted, 0, 'every real schema has a valid compact form inside the page budget')
})

// ---------------------------------------------------------------------------
// The tool description must not promise a truncatable schema (S10 + hint).
// ---------------------------------------------------------------------------

test('mcp_search description states the English hint and the two-schema cap', () => {
  assert.match(MCP_SEARCH_DESCRIPTION, /English, so English keywords retrieve better/)
  assert.match(MCP_SEARCH_DESCRIPTION, /detail:"full" adds the input schema of up to two matches/)
  assert.match(MCP_SEARCH_DESCRIPTION, /compact schema or signature when a schema is too large/)
  assert.doesNotMatch(MCP_SEARCH_DESCRIPTION, /copy|paste the schema|exact schema/i)
})
