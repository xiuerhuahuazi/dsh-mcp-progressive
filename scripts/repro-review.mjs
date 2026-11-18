#!/usr/bin/env node
/**
 * "Before" evidence generator for the 1.2.0 review findings.
 *
 * This script is *evidence*, not a test suite: it drives the **current**
 * plugin and reports whether the defects the 2026-11-19 review reproduced are
 * still present. Every probe family maps to one finding:
 *
 *   A  S3   the hand-written YAML rewrite corrupts a valid patch file
 *   B  S1/S2 the management routes have no admission and coerce `enabled`
 *   C  S5   a stop and a start issued together execute only the stop
 *   D  S11  a failed panel action is cleared by the next poll
 *   E  S9   the catalog search is AND-shaped and case-sensitive
 *   F  S10  `detail:"full"` prints an invalid JSON schema
 *
 * Exit code 0 means "the defects reproduced" (that is the expected outcome on
 * the 1.2.0 baseline). Exit code 1 means a defect no longer reproduces.
 *
 * Usage: node scripts/repro-review.mjs [--json] [--catalog <file>]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml, parseDocument } from 'yaml'

import { createManagementEnv, findNode, mountClientPanel, request } from '../test/harness.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = await import(path.join(REPO_ROOT, 'index.js'))

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const catalogFlag = argv.indexOf('--catalog')
const catalogOverride = catalogFlag >= 0 ? argv[catalogFlag + 1] : undefined

// ---------------------------------------------------------------------------
// Probe A — the YAML rewrite (finding S3).
// ---------------------------------------------------------------------------

/**
 * The 23 YAML boundary cases the review used. Every input is valid YAML
 * before the rewrite; the rewrite is what has to keep it valid.
 */
const YAML_FIXTURES = [
  ['plain', '- id: demo\n  disabled: false\n', 'demo'],
  ['comment', '- id: demo # target\n  disabled: false # KEEP THIS\n', 'demo'],
  ['crlf', '- id: demo\r\n  disabled: false # comment\r\n', 'demo'],
  ['quoted-id', '- id: "demo"\n  disabled: false\n', 'demo'],
  ['duplicate-overrides', '- id: demo\n  disabled: false\n- id: demo\n  disabled: false\n', 'demo'],
  ['quoted-disabled', '- id: demo\n  "disabled": false\n', 'demo'],
  ['multiline-disabled', '- id: demo\n  disabled: >-\n    false\n', 'demo'],
  ['indent-4', '-   id: demo\n    disabled: false\n', 'demo'],
  ['indented-root', '  - id: demo\n    disabled: false\n', 'demo'],
  ['empty-flow', '[]\n', 'demo'],
  ['flow-sequence', '[{id: demo, disabled: false}]\n', 'demo'],
  ['key-order', '- disabled: false\n  id: demo\n', 'demo'],
  ['top-insert', '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      disabled: false\n', 'demo'],
  [
    'insert-conflict',
    '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      group: true\n      config: []\n- id: demo\n  insert: []\n',
    'demo',
  ],
  ['nested-include', '- id: wrapper\n  config:\n    patches:\n      - id: demo\n        disabled: false\n', 'demo'],
  ['literal-fake-id', '- id: wrapper\n  config:\n    text: |\n      - id: demo\n        disabled: false\n', 'demo'],
  ['special-space', '- id: "demo space"\n  disabled: false\n', 'demo space'],
  ['special-hash', '- id: "demo#x"\n  disabled: false\n', 'demo#x'],
  ['escaped-quote', '- id: "demo\\"x"\n  disabled: false\n', 'demo"x'],
  ['single-quote-escape', "- id: 'demo''x'\n  disabled: false\n", "demo'x"],
  ['regex-chars', '- id: "demo.[x]+$"\n  disabled: false\n', 'demo.[x]+$'],
  ['end-marker', '- id: other\n  disabled: false\n...\n', 'demo'],
  ['multiline-config', '- id: demo\n  config: |\n    disabled: false\n    other: stuff\n', 'demo'],
]

/**
 * Whether one top-level entry ends up with two `disabled` keys.
 * Only the entry's own direct children count — a nested `config.patches`
 * block or a block scalar is a different mapping.
 */
function duplicateDisabledKeysIn(text) {
  let document
  try {
    document = parseDocument(text, { uniqueKeys: false })
  } catch {
    return false
  }
  const sequence = document?.contents
  const entries = Array.isArray(sequence) ? sequence : (sequence?.items ?? [])
  for (const entry of entries) {
    const pairs = entry?.items
    if (!Array.isArray(pairs)) continue
    let count = 0
    for (const pair of pairs) {
      const key = pair?.key?.value ?? pair?.key
      if (key === 'disabled') count += 1
    }
    if (count > 1) return true
  }
  return false
}

/** The platform rule an `insert` entry follows: its own overrides are skipped. */
function composeLocally(base, patches) {
  const data = structuredClone(base)
  const map = new Map()
  const build = (entries) => {
    for (const entry of entries) {
      if (entry.id) map.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) build(entry.config)
    }
  }
  build(data)
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      const clone = structuredClone(insert)
      if (id) {
        const target = map.get(id)
        if (!target?.group) continue
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...clone)
      } else {
        data.push(...clone)
      }
      build(clone)
      continue
    }
    const target = map.get(id)
    if (!target) continue
    if (name && name !== target.name) continue
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }
  return data
}

async function probeYaml() {
  const { setPatchDisabled, patchDeclares } = PLUGIN.__test
  const base = [{ id: 'demo', name: '@deepseek-ai/dsh-mcp-client', disabled: false }]

  let composer = composeLocally
  let composerSource = 'local approximation of the platform rule'
  try {
    const include = await import(
      path.join(process.env.DSH_RUNTIME ?? '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js')
    )
    if (typeof include.applyEntryPatches === 'function') {
      composer = (data, patches) => include.applyEntryPatches(data, patches, () => {})
      composerSource = 'real @deepseek-ai/cordis-plugin-include'
    }
  } catch {
    // Keep the local approximation.
  }

  const rows = []
  for (const [name, input, id] of YAML_FIXTURES) {
    let inputValid = true
    try {
      parseYaml(input)
    } catch {
      inputValid = false
    }
    const output = setPatchDisabled(input, id, true)
    let afterValid = true
    let error = null
    let effectiveDisabled
    try {
      const patches = parseYaml(output)
      const composed = composer(base, patches)
      effectiveDisabled = composed.filter((row) => row.id === id).at(-1)?.disabled
    } catch (cause) {
      afterValid = false
      error = cause?.reason ?? cause?.message ?? String(cause)
    }
    rows.push({
      name,
      inputValid,
      afterValid,
      duplicateDisabledKeys: duplicateDisabledKeysIn(output),
      declares: patchDeclares(input, id),
      effectiveDisabled: effectiveDisabled ?? null,
      error,
      output,
    })
  }

  const broken = rows.filter((row) => row.inputValid && !row.afterValid)
  const duplicated = rows.filter((row) => row.duplicateDisabledKeys)
  const insertIgnored = rows.filter((row) => row.name === 'insert-conflict' && row.effectiveDisabled !== true)

  return {
    finding: 'S3 — hand-written YAML rewrite corrupts a valid patch file',
    composer: composerSource,
    fixtures: rows.length,
    validInputsTurnedUnparseable: broken.length,
    brokenFixtures: broken.map((row) => ({ name: row.name, error: row.error })),
    duplicateDisabledKeys: duplicated.length,
    duplicateFixtures: duplicated.map((row) => row.name),
    insertGroupIgnore: insertIgnored.length,
    fixtureResults: rows.map((row) => ({
      name: row.name,
      inputValid: row.inputValid,
      afterValid: row.afterValid,
      duplicateDisabledKeys: row.duplicateDisabledKeys,
      effectiveDisabled: row.effectiveDisabled,
      error: row.error,
    })),
    reproduced: broken.length > 0 && duplicated.length > 0 && insertIgnored.length > 0,
  }
}

// ---------------------------------------------------------------------------
// Probe B — the management routes (findings S1 and S2).
// ---------------------------------------------------------------------------

async function probeManagementAdmission() {
  const env = await createManagementEnv()
  try {
    const unauthenticated = await request(env, '/dsh-mcp-hub/state')
    const badHost = await request(env, '/dsh-mcp-hub/state', { headers: { host: 'attacker.invalid:3080' } })
    const textPlain = await request(env, '/dsh-mcp-hub/toggle', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' },
      body: { server: 'demo', enabled: false },
    })
    const getToggle = await request(env, '/dsh-mcp-hub/toggle', { method: 'GET' })
    const deleteState = await request(env, '/dsh-mcp-hub/state', { method: 'DELETE' })

    const coercions = []
    for (const enabled of ['true', undefined, null, 1]) {
      const local = await createManagementEnv()
      try {
        const response = await request(local, '/dsh-mcp-hub/toggle', {
          method: 'POST',
          body: enabled === undefined ? { server: 'demo' } : { server: 'demo', enabled },
        })
        coercions.push({
          sent: enabled === undefined ? '<missing>' : JSON.stringify(enabled),
          status: response.status,
          calls: local.calls,
          finalEnabled: local.row.enabled,
          treatedAs: local.row.enabled === false ? 'stop' : 'start',
        })
      } finally {
        await local.dispose()
      }
    }

    return {
      finding: 'S1/S2 — the management routes have no admission and coerce `enabled`',
      unauthenticatedState: { status: unauthenticated.status, leaked: unauthenticated.status === 200 },
      badHostState: { status: badHost.status, accepted: badHost.status === 200 },
      textPlainToggle: { status: textPlain.status, accepted: textPlain.status === 200 },
      getOnToggle: { status: getToggle.status, accepted: getToggle.status === 200 },
      deleteOnState: { status: deleteState.status, accepted: deleteState.status === 200 },
      enabledCoercion: coercions,
      reproduced:
        unauthenticated.status === 200 &&
        badHost.status === 200 &&
        textPlain.status === 200 &&
        coercions.every((entry) => entry.treatedAs === 'stop'),
    }
  } finally {
    await env.dispose()
  }
}

// ---------------------------------------------------------------------------
// Probe C — the control queue (finding S5).
// ---------------------------------------------------------------------------

async function probeControlQueue() {
  const env = await createManagementEnv()
  try {
    const [stop, start] = await Promise.all([
      request(env, '/dsh-mcp-hub/toggle', { method: 'POST', body: { server: 'demo', enabled: false } }),
      request(env, '/dsh-mcp-hub/toggle', { method: 'POST', body: { server: 'demo', enabled: true } }),
    ])
    return {
      finding: 'S5 — a stop and a start issued together execute only the stop',
      stopStatus: stop.status,
      startStatus: start.status,
      managerCalls: env.calls,
      finalEnabled: env.row.enabled,
      reproduced: env.calls.length === 1 && env.calls[0]?.enabled === false && env.row.enabled === false,
    }
  } finally {
    await env.dispose()
  }
}

// ---------------------------------------------------------------------------
// Probe D — the client panel (finding S11).
// ---------------------------------------------------------------------------

async function probeClient() {
  const serverRow = {
    id: 'demo',
    serverName: 'demo',
    enabled: true,
    status: 'running',
    toolCount: 1,
    transport: 'stdio',
    target: 'node server.js',
  }
  const okResponse = () => ({ ok: true, status: 200, json: async () => ({ ok: true, now: 1, servers: [serverRow] }) })

  // Case 1 — the action error is wiped before the user can read it: `act()`
  // calls `setFailure(...)` and then immediately refreshes, and a successful
  // refresh resets the failure to null.
  let posts = 0
  const immediate = mountClientPanel({
    locale: { active: 'en' },
    fetch: async (_url, init) => {
      if (init?.method === 'POST') {
        posts += 1
        throw new Error('SYNTHETIC restart failure')
      }
      return okResponse()
    },
  })
  let failureAfterActionImmediate = null
  try {
    await immediate.flush()
    const restart = findNode(immediate.render(), (node) => node.props.className === 'dsh-mcp-icon-btn')
    await restart.props.onClick()
    await immediate.flush()
    failureAfterActionImmediate = immediate.slots[1]
  } finally {
    immediate.unmount()
  }

  // Case 2 — with the refresh failing as well, the error stays visible after
  // the action and is then cleared by the following poll.
  let gets = 0
  const panel = mountClientPanel({
    locale: { active: 'en' },
    fetch: async (_url, init) => {
      if (init?.method === 'POST') {
        posts += 1
        throw new Error('SYNTHETIC restart failure')
      }
      gets += 1
      if (gets === 2) throw new Error('SYNTHETIC list failure')
      return okResponse()
    },
  })
  try {
    await panel.flush()
    const restart = findNode(panel.render(), (node) => node.props.className === 'dsh-mcp-icon-btn')
    await restart.props.onClick()
    await panel.flush()
    const failureAfterAction = panel.slots[1]
    await panel.poll()
    await panel.flush()
    const failureAfterPoll = panel.slots[1]
    return {
      finding: 'S11 — a failed panel action is cleared by the next poll',
      posts,
      failureAfterActionImmediate,
      failureAfterAction,
      failureAfterPoll,
      reproduced: failureAfterAction !== null && failureAfterAction !== undefined && failureAfterPoll === null,
    }
  } finally {
    panel.unmount()
  }
}

// ---------------------------------------------------------------------------
// Probe E — the catalog search (finding S9).
// ---------------------------------------------------------------------------

/** Locate the review's real 210-tool catalog, if it is still on disk. */
function findRealCatalog() {
  const candidates = []
  if (catalogOverride) candidates.push(path.resolve(catalogOverride))
  let dir = REPO_ROOT
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(path.join(dir, 'dsh-mcp-progressive-review', '2026-11-19', 'probe', 'deepseek', 'catalog.json'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/** A small stand-in with the same shapes as the real catalog. */
const FALLBACK_CATALOG = [
  { name: 'mcp__bilibili__bilibili_article_download', description: '下载 B 站专栏为 Markdown 文件（可选择是否下载图片）。' },
  { name: 'mcp__bilibili__bilibili_live_screenshot', description: '获取 B 站直播间的截图' },
  { name: 'mcp__rea__capture_web_screenshot', description: 'Capture a screenshot of a web page with the browser' },
  { name: 'mcp__rea__compare_web_screenshots', description: 'Compare two captured web screenshots' },
  { name: 'mcp__rea__open_web_page', description: 'Open a web page in the browser and wait for it to load' },
  { name: 'mcp__rea__read_web_page', description: 'Read the text content of a web page' },
  { name: 'mcp__rea__click_web_element', description: 'Click an element on a web page by selector' },
  { name: 'mcp__rea__evaluate_in_page', description: 'Evaluate JavaScript inside the current browser page' },
  { name: 'mcp__blender__render_scene', description: 'Render the current Blender scene to an image' },
  { name: 'mcp__blender__disable_telemetry', description: 'Disable Blender telemetry' },
].map((entry) => ({
  ...entry,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
}))

function loadCatalog() {
  const file = findRealCatalog()
  if (file === undefined) return { source: 'built-in fallback catalog', tools: FALLBACK_CATALOG }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const tools = Array.isArray(parsed) ? parsed : parsed.tools
    if (!Array.isArray(tools) || tools.length === 0) throw new Error('empty catalog')
    return { source: file, tools }
  } catch {
    return { source: 'built-in fallback catalog', tools: FALLBACK_CATALOG }
  }
}

/** Count the top-level entries of a search answer. */
function countMatches(text) {
  const matches = text.match(/^- mcp__/gm)
  return matches === null ? 0 : matches.length
}

async function probeSearch() {
  const catalog = loadCatalog()
  const env = await createManagementEnv()
  try {
    // Re-point the fake registry at the real catalog (the meta-tools stay).
    const registered = env.ctx.tools.definitions()
    const catalogEntries = catalog.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
    env.ctx.tools.schemas = () => catalogEntries
    env.ctx.tools.definitions = () => [...registered, ...catalogEntries]

    const search = registered.find((definition) => definition.name === 'mcp_search')
    if (search === undefined) throw new Error('mcp_search was not registered')

    const run = async (args) => {
      const answer = await search.execute(args, { agent: { id: 'probe' } })
      return { answer, matches: countMatches(answer) }
    }

    const browser = await run({ query: '浏览器' })
    const bili = await run({ query: 'b站 下载' })
    const navigate = await run({ query: 'browser navigate' })
    const serverCase = await run({ query: '', server: 'Rea' })
    const english = await run({ query: 'screenshot' })

    return {
      finding: 'S9 — the catalog search is AND-shaped and case-sensitive',
      catalog: catalog.source,
      catalogSize: catalog.tools.length,
      queries: {
        '浏览器': browser.matches,
        'b站 下载': bili.matches,
        'browser navigate': navigate.matches,
        'server:"Rea"': serverCase.matches,
        screenshot: english.matches,
      },
      serverCaseEmptyState: serverCase.answer.includes('No MCP tools are registered right now'),
      reproduced:
        browser.matches === 0 && bili.matches === 0 && navigate.matches === 0 && serverCase.matches === 0,
    }
  } finally {
    await env.dispose()
  }
}

// ---------------------------------------------------------------------------
// Probe F — the `detail:"full"` schema (finding S10).
// ---------------------------------------------------------------------------

/**
 * A deterministic ~57 kB schema, used when the real catalog is unavailable.
 * The bulk sits in the *structure* (enums), not in the annotations, so that
 * the schema is still over the 4000-character budget after the plugin strips
 * every `description`.
 */
function syntheticLargeSchema() {
  const properties = {}
  for (let index = 0; index < 62; index += 1) {
    properties[`field_${index}`] = {
      type: 'string',
      description: `A synthetic field ${index}. ${'lorem ipsum dolor sit amet '.repeat(10)}`,
      enum: Array.from({ length: 20 }, (_unused, slot) => `value_${index}_${slot}_padding_text`),
    }
  }
  return { type: 'object', properties, required: [], additionalProperties: false }
}

async function probeFullSchema() {
  const catalog = loadCatalog()
  let target = catalog.tools.find((tool) => tool.name.endsWith('__compare_web_captures'))
  let parameters = target?.parameters
  let source = 'real catalog'
  if (parameters === undefined) {
    parameters = syntheticLargeSchema()
    source = 'synthetic 57 kB schema'
  }
  const schemaChars = JSON.stringify(parameters).length

  const env = await createManagementEnv()
  try {
    const registered = env.ctx.tools.definitions()
    const entry = { name: 'mcp__rea__compare_web_captures', description: 'Compare two captured pages', parameters }
    env.ctx.tools.schemas = () => [entry]
    env.ctx.tools.definitions = () => [...registered, entry]
    const search = registered.find((definition) => definition.name === 'mcp_search')
    const answer = await search.execute(
      { query: 'compare_web_captures', detail: 'full' },
      { agent: { id: 'probe' } },
    )
    const lines = answer.split('\n')
    const marker = lines.findIndex((line) => line.startsWith('schema for '))
    const schemaText = marker >= 0 ? (lines[marker + 1] ?? '') : ''
    let parses = true
    let parseError = null
    try {
      JSON.parse(schemaText)
    } catch (cause) {
      parses = false
      parseError = cause?.message ?? String(cause)
    }
    return {
      finding: 'S10 — `detail:"full"` prints an invalid JSON schema',
      source,
      schemaChars,
      printedChars: schemaText.length,
      parses,
      parseError,
      tail: schemaText.slice(-60),
      reproduced: !parses,
    }
  } finally {
    await env.dispose()
  }
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

const probes = {
  yaml: await probeYaml(),
  managementAdmission: await probeManagementAdmission(),
  controlQueue: await probeControlQueue(),
  client: await probeClient(),
  search: await probeSearch(),
  fullSchema: await probeFullSchema(),
}

const reproduced = Object.values(probes).filter((probe) => probe.reproduced === true).length
const result = {
  plugin: 'dsh-mcp-progressive',
  version: '1.2.0-baseline',
  generatedAt: new Date().toISOString(),
  reproduced,
  total: Object.keys(probes).length,
  probes,
}

if (wantJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const rows = Object.entries(probes).map(([key, probe]) => ({
    probe: key,
    finding: probe.finding,
    reproduced: probe.reproduced ? 'YES' : 'no',
  }))
  const width = Math.max(...rows.map((row) => row.probe.length))
  console.log('\ndsh-mcp-progressive 1.2.0 — review defect reproduction\n')
  for (const row of rows) {
    console.log(`  ${row.probe.padEnd(width)}  ${row.reproduced.padEnd(4)}  ${row.finding}`)
  }
  console.log('')
  console.log(`  A  YAML rewrite      valid inputs turned unparseable : ${probes.yaml.validInputsTurnedUnparseable}/${probes.yaml.fixtures}`)
  console.log(`                        duplicate disabled keys        : ${probes.yaml.duplicateDisabledKeys}`)
  console.log(`                        insert-group override ignored  : ${probes.yaml.insertGroupIgnore}`)
  console.log(`  B  management routes unauthenticated /state          : ${probes.managementAdmission.unauthenticatedState.status}`)
  console.log(`                        bad Host /state                 : ${probes.managementAdmission.badHostState.status}`)
  console.log(`                        text/plain POST /toggle         : ${probes.managementAdmission.textPlainToggle.status}`)
  for (const entry of probes.managementAdmission.enabledCoercion) {
    console.log(`                        enabled=${entry.sent.padEnd(10)} -> ${entry.treatedAs}`)
  }
  console.log(`  C  control queue     manager calls for stop+start     : ${probes.controlQueue.managerCalls.length} (${JSON.stringify(probes.controlQueue.managerCalls)})`)
  console.log(`  D  client panel      failure after action / after poll: ${probes.client.failureAfterAction} / ${probes.client.failureAfterPoll}`)
  console.log(`  E  search            matches per query                : ${JSON.stringify(probes.search.queries)}`)
  console.log(`  F  full schema       ${probes.fullSchema.schemaChars} chars -> valid JSON: ${probes.fullSchema.parses}`)
  console.log(`\n  ${reproduced}/${Object.keys(probes).length} defect families reproduced\n`)
}

process.exit(reproduced === Object.keys(probes).length ? 0 : 1)
