#!/usr/bin/env node
/**
 * Review-defect regression gate (and the 1.2.0 "before" evidence generator).
 *
 * The 2026-11-19 review reproduced six defect families against
 * dsh-mcp-progressive 1.2.0. Every family maps to one finding:
 *
 *   A  S3    the hand-written YAML rewrite corrupts a valid patch file
 *   B  S1/S2 the management routes have no admission and coerce `enabled`
 *   C  S5    a stop and a start issued together execute only the stop
 *   D  S11   a failed panel action is cleared by the next poll
 *   E  S9    the catalog search is AND-shaped and case-sensitive
 *   F  S10   `detail:"full"` prints an invalid JSON schema
 *
 * Modes
 * -----
 * `--expect fixed` (default) is the regression gate: exit 0 when NONE of the
 * six families reproduces, and exit 1 with a `REGRESSION: <families>` line
 * when one does. Where a family can observe the repaired outcome (management
 * admission, the control queue, the rendered panel message, search recall,
 * schema fitting), the gate also requires that outcome, so a partial
 * regression cannot hide behind "not reproduced". A family that cannot be
 * verified without the DSH runtime is reported as `skip` with its reason
 * instead of silently passing.
 *
 * `--expect baseline` keeps the original behaviour: exit 0 when all six
 * families ARE reproduced. It only matches a v1.2.0 checkout — on a repaired
 * checkout it reports honestly that the checkout is not 1.2.0 and exits 1.
 *
 * Usage: node scripts/repro-review.mjs [--expect fixed|baseline] [--json] [--catalog <file>]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml, parseDocument } from 'yaml'

import { createManagementEnv, findNode, mountClientPanel, request } from '../test/harness.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = process.env.DSH_RUNTIME ?? '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai'
const PLUGIN = await import(path.join(REPO_ROOT, 'index.js'))

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const expectation = flag('--expect', 'fixed')
if (expectation !== 'fixed' && expectation !== 'baseline') {
  console.error(`repro-review: --expect must be "fixed" or "baseline", got ${JSON.stringify(expectation)}`)
  process.exit(2)
}
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

async function probeYaml() {
  const { setPatchDisabled, patchDeclares } = PLUGIN.__test
  const base = [{ id: 'demo', name: '@deepseek-ai/dsh-mcp-client', disabled: false }]

  // Part of this family is the *effective* composition, which only the real
  // platform rule can decide (an `insert` entry's own overrides are skipped).
  // Without the DSH runtime the family is skipped rather than guessed: a local
  // approximation could hide a real regression, which is exactly what a
  // regression gate must not do.
  let composer
  try {
    const include = await import(path.join(RUNTIME, 'cordis-plugin-include', 'lib', 'index.js'))
    if (typeof include.applyEntryPatches === 'function') {
      composer = (data, patches) => include.applyEntryPatches(data, patches, () => {})
    }
  } catch {
    // Reported as a skip below.
  }
  if (composer === undefined) {
    return {
      finding: 'S3 — hand-written YAML rewrite corrupts a valid patch file',
      skip: `the DSH runtime (${RUNTIME}) is not installed; the platform insert/override rule cannot be verified without it (set DSH_RUNTIME)`,
    }
  }
  const composerSource = 'real @deepseek-ai/cordis-plugin-include'

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
    fixed: broken.length === 0 && duplicated.length === 0 && insertIgnored.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Probe B — the management routes (findings S1 and S2).
// ---------------------------------------------------------------------------

const ROUTE_STATE = '/dsh-mcp-hub/state'
const ROUTE_TOGGLE = '/dsh-mcp-hub/toggle'
/** Review probe cookie: the fake stub only tells "has a browser credential"
 * from "has none"; the real signature is validated by scripts/live-boot.mjs
 * against the platform's own browser auth. */
const PROBE_COOKIE = 'dsh-auth-review-probe=1'

/**
 * Mirror of the platform admission fence (`dsh-client-connection`'s
 * `isTrustedApiRequest` + browser auth) for the fake management context:
 * fenced Host/Origin → 403, trusted Host without a cookie → 401. This is a
 * stub: the real-platform authority is `scripts/live-boot.mjs`, which boots the
 * real web app and uses the platform's own fence.
 */
function platformFence(req) {
  const host = String(req.headers?.host ?? '')
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return 403
  if (String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  const origin = req.headers?.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  return typeof req.headers?.cookie === 'string' && req.headers.cookie !== '' ? undefined : 401
}

/** Run one probe against a fresh fake environment (state never leaks between probes). */
async function withEnv(run) {
  const env = await createManagementEnv({ rejection: platformFence })
  try {
    return await run(env)
  } finally {
    await env.dispose()
  }
}

/** Uppercase tokens of an `Allow` response header. */
function allowOf(response) {
  const raw = response.headers?.allow
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token !== '')
}

/** Whether a response body is the JSON refusal both the panel and the model need. */
function isJsonRefusal(response) {
  const body = response.body
  return body !== null && typeof body === 'object' && body.ok === false && typeof body.error === 'string'
}

async function probeManagementAdmission() {
  const cookie = { cookie: PROBE_COOKIE }
  const unauthenticated = await withEnv((env) => request(env, ROUTE_STATE))
  const authenticated = await withEnv((env) => request(env, ROUTE_STATE, { headers: cookie }))
  const badHost = await withEnv((env) =>
    request(env, ROUTE_STATE, { headers: { host: 'attacker.invalid:3080', ...cookie } }),
  )
  const textPlain = await withEnv((env) =>
    request(env, ROUTE_TOGGLE, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...cookie },
      body: { server: 'demo', enabled: false },
    }),
  )
  const getToggle = await withEnv((env) => request(env, ROUTE_TOGGLE, { headers: cookie }))
  const deleteState = await withEnv((env) => request(env, ROUTE_STATE, { method: 'DELETE', headers: cookie }))
  const postState = await withEnv((env) => request(env, ROUTE_STATE, { method: 'POST', headers: cookie }))

  const coercions = []
  for (const enabled of ['true', undefined, null, 1]) {
    const entry = await withEnv(async (env) => {
      const response = await request(env, ROUTE_TOGGLE, {
        method: 'POST',
        headers: cookie,
        body: enabled === undefined ? { server: 'demo' } : { server: 'demo', enabled },
      })
      return {
        sent: enabled === undefined ? '<missing>' : JSON.stringify(enabled),
        status: response.status,
        jsonRefusal: isJsonRefusal(response),
        calls: env.calls.map((call) => ({ ...call })),
        finalEnabled: env.row.enabled,
      }
    })
    coercions.push(entry)
  }

  // The repaired behaviour (1.2.1). `enabled` must be a boolean, the write
  // routes must demand JSON, and an unauthenticated / untrusted peer must get a
  // JSON refusal before any handler body runs.
  const fixed =
    [401, 403].includes(unauthenticated.status) &&
    isJsonRefusal(unauthenticated) &&
    badHost.status === 403 &&
    isJsonRefusal(badHost) &&
    textPlain.status === 415 &&
    isJsonRefusal(textPlain) &&
    getToggle.status === 405 &&
    allowOf(getToggle).includes('POST') &&
    isJsonRefusal(getToggle) &&
    deleteState.status === 405 &&
    ['GET', 'HEAD'].every((method) => allowOf(deleteState).includes(method)) &&
    postState.status === 405 &&
    ['GET', 'HEAD'].every((method) => allowOf(postState).includes(method)) &&
    isJsonRefusal(postState) &&
    authenticated.status === 200 &&
    coercions.every((entry) => entry.status === 400 && entry.jsonRefusal && entry.calls.length === 0 && entry.finalEnabled === true)

  // The 1.2.0 defects: no admission, any media type reaches the handler, and an
  // invalid `enabled` is coerced into "stop".
  const reproduced =
    unauthenticated.status === 200 &&
    badHost.status === 200 &&
    textPlain.status === 200 &&
    coercions.every(
      (entry) =>
        entry.status === 200 &&
        entry.calls.length === 1 &&
        entry.calls[0].enabled === false &&
        entry.finalEnabled === false,
    )

  return {
    finding: 'S1/S2 — the management routes have no admission and coerce `enabled`',
    verifiedBy: 'fake connection stub mirroring the platform fence; the real-platform authority is scripts/live-boot.mjs',
    admission: {
      unauthenticatedState: { status: unauthenticated.status, jsonRefusal: isJsonRefusal(unauthenticated) },
      authenticatedState: { status: authenticated.status },
      badHostState: { status: badHost.status, jsonRefusal: isJsonRefusal(badHost) },
      textPlainToggle: { status: textPlain.status, jsonRefusal: isJsonRefusal(textPlain) },
      getOnToggle: { status: getToggle.status, allow: allowOf(getToggle) },
      deleteOnState: { status: deleteState.status, allow: allowOf(deleteState) },
      postOnState: { status: postState.status, allow: allowOf(postState) },
    },
    enabledCoercion: coercions,
    reproduced,
    fixed,
  }
}

// ---------------------------------------------------------------------------
// Probe C — the control queue (finding S5).
// ---------------------------------------------------------------------------

async function probeControlQueue() {
  // An authenticated panel request: the queue is what is under test here, not
  // admission (probe B covers that), but driving the same path the panel uses
  // keeps the two concurrent calls realistic.
  const env = await createManagementEnv({ rejection: platformFence })
  try {
    const headers = { cookie: PROBE_COOKIE }
    const [stop, start] = await Promise.all([
      request(env, '/dsh-mcp-hub/toggle', { method: 'POST', headers, body: { server: 'demo', enabled: false } }),
      request(env, '/dsh-mcp-hub/toggle', { method: 'POST', headers, body: { server: 'demo', enabled: true } }),
    ])
    const managerCalls = env.calls.map((call) => ({ ...call }))
    return {
      finding: 'S5 — a stop and a start issued together execute only the stop',
      stopStatus: stop.status,
      startStatus: start.status,
      managerCalls,
      finalEnabled: env.row.enabled,
      reproduced: managerCalls.length === 1 && managerCalls[0]?.enabled === false && env.row.enabled === false,
      // Repaired: both queued operations run, in issue order, and the last one wins.
      fixed:
        managerCalls.length === 2 &&
        managerCalls[0]?.enabled === false &&
        managerCalls[1]?.enabled === true &&
        env.row.enabled === true,
    }
  } finally {
    await env.dispose()
  }
}

// ---------------------------------------------------------------------------
// Probe D — the client panel (finding S11).
// ---------------------------------------------------------------------------

/** Flatten a render tree to its visible text. */
function renderText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children ?? []).map(renderText).join(' ')
}

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

  // Observe the *rendered* panel, not a React hook slot: the 1.2.1 client split
  // the action outcome out of the load-error state, so a hook index would read
  // the wrong value and could report a false "not reproduced". What a user can
  // see is the contract: after a failed action the message must stay on screen,
  // even after a following successful poll (which must not clear it).
  let posts = 0
  const panel = mountClientPanel({
    locale: { active: 'en' },
    fetch: async (_url, init) => {
      if (init?.method === 'POST') {
        posts += 1
        throw new Error('SYNTHETIC restart failure')
      }
      return okResponse()
    },
  })
  try {
    await panel.flush()
    const restart = findNode(panel.render(), (node) => node.props.className === 'dsh-mcp-icon-btn')
    await restart.props.onClick()
    await panel.flush()
    const failureAfterAction = renderText(panel.render()).includes('SYNTHETIC restart failure')
    await panel.poll()
    await panel.flush()
    const failureAfterPoll = renderText(panel.render()).includes('SYNTHETIC restart failure')
    return {
      finding: 'S11 — a failed panel action is cleared by the next poll',
      posts,
      failureAfterAction,
      failureAfterPoll,
      // 1.2.0 wiped the action failure on the refresh that follows it; the fixed
      // client keeps it until the next action.
      reproduced: !(failureAfterAction && failureAfterPoll),
      fixed: failureAfterAction && failureAfterPoll,
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

    const queries = {
      '浏览器': browser.matches,
      'b站 下载': bili.matches,
      'browser navigate': navigate.matches,
      'server:"Rea"': serverCase.matches,
      screenshot: english.matches,
    }
    const serverCaseEmptyState = serverCase.answer.includes('No MCP tools are registered right now')
    return {
      finding: 'S9 — the catalog search is AND-shaped and case-sensitive',
      catalog: catalog.source,
      catalogSize: catalog.tools.length,
      queries,
      serverCaseEmptyState,
      reproduced: browser.matches === 0 && bili.matches === 0 && navigate.matches === 0 && serverCase.matches === 0,
      // Repaired: every probed query recalls something, and a server-scoped
      // query never claims the catalog is empty.
      fixed: Object.values(queries).every((count) => count > 0) && serverCaseEmptyState === false,
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
  const target = catalog.tools.find((tool) => tool.name.endsWith('__compare_web_captures'))
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
    const answer = await search.execute({ query: 'compare_web_captures', detail: 'full' }, { agent: { id: 'probe' } })
    const lines = answer.split('\n')
    // The repaired contract has two honest outcomes: a printed schema that
    // parses, or an explicit "schema omitted: too large … signature: …" notice.
    // 1.2.0 printed a hard-cut JSON string, which is the defect.
    const marker = lines.findIndex((line) => line.startsWith('schema for '))
    const omissionLine = lines.find((line) => line.startsWith('schema omitted: too large'))
    // The notice is only honest when it names a callable signature.
    const omitted = marker < 0 && omissionLine !== undefined && omissionLine.includes('signature:')
    const schemaText = marker >= 0 ? (lines[marker + 1] ?? '') : ''
    let parses = null
    let parseError = null
    if (marker >= 0) {
      try {
        JSON.parse(schemaText)
        parses = true
      } catch (cause) {
        parses = false
        parseError = cause?.message ?? String(cause)
      }
    }
    const mode = marker >= 0 ? 'printed' : omitted ? 'omitted' : 'none'
    return {
      finding: 'S10 — `detail:"full"` prints an invalid JSON schema',
      source,
      schemaChars,
      mode,
      printedChars: schemaText.length,
      parses,
      parseError,
      tail: schemaText.slice(-60),
      // 1.2.0: a printed schema that does not parse.
      reproduced: marker >= 0 && parses === false,
      // Repaired: either a parseable printed schema, or the explicit omission
      // notice instead of half a JSON document.
      fixed: (marker >= 0 && parses === true) || omitted,
    }
  } finally {
    await env.dispose()
  }
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

const FAMILIES = [
  ['yaml', probeYaml],
  ['managementAdmission', probeManagementAdmission],
  ['controlQueue', probeControlQueue],
  ['client', probeClient],
  ['search', probeSearch],
  ['fullSchema', probeFullSchema],
]

const probes = {}
for (const [key, probe] of FAMILIES) probes[key] = await probe()

/**
 * One family's verdict for the selected mode.
 *
 *   skip            cannot be verified without the DSH runtime (never a pass).
 *   ok              fixed: the defect does not reproduce and the repaired
 *                   outcome (where the family can assert it) is observed.
 *                   baseline: the 1.2.0 defect reproduces.
 *   regression      fixed: the defect reproduces, or the repair is missing.
 *   not-reproduced  baseline: this checkout is not 1.2.0.
 */
function verdictOf(probe) {
  if (typeof probe.skip === 'string') return 'skip'
  if (expectation === 'fixed') return probe.reproduced === false && probe.fixed !== false ? 'ok' : 'regression'
  return probe.reproduced === true ? 'ok' : 'not-reproduced'
}

const entries = Object.entries(probes).map(([key, probe]) => ({ key, probe, verdict: verdictOf(probe) }))
const reproduced = entries.filter((entry) => entry.probe.reproduced === true).length
const skipped = entries.filter((entry) => entry.verdict === 'skip').length
const failures = entries.filter((entry) => entry.verdict !== 'ok' && entry.verdict !== 'skip')
// A skip never fails the fixed-mode gate (it is printed as a skip), but the
// baseline mode only passes when all six families really reproduced.
const pass = expectation === 'fixed' ? failures.length === 0 : failures.length === 0 && skipped === 0

const result = {
  plugin: 'dsh-mcp-progressive',
  expectation,
  gate: expectation === 'fixed' ? 'regression (no reviewed defect may reproduce)' : 'baseline (1.2.0 only; all six must reproduce)',
  generatedAt: new Date().toISOString(),
  reproduced,
  evaluated: entries.length - skipped,
  skipped,
  total: entries.length,
  pass,
  families: Object.fromEntries(entries.map((entry) => [entry.key, entry.verdict])),
  probes,
}

if (wantJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const modeLabel = expectation === 'fixed' ? 'expect fixed — regression gate' : 'expect baseline — 1.2.0 evidence only'
  const width = Math.max(...entries.map((entry) => entry.key.length))
  console.log(`\ndsh-mcp-progressive — review defect reproduction (${modeLabel})\n`)
  for (const entry of entries) {
    const verdict = entry.verdict === 'ok' ? 'ok  ' : entry.verdict === 'skip' ? 'skip' : 'FAIL'
    console.log(`  ${verdict.padEnd(5)}  ${entry.key.padEnd(width)}  ${entry.probe.finding}`)
    if (entry.verdict === 'skip') console.log(`         skip: ${entry.probe.skip}`)
  }
  console.log('')

  if (probes.yaml.validInputsTurnedUnparseable !== undefined) {
    console.log(`  A  YAML rewrite      valid inputs turned unparseable : ${probes.yaml.validInputsTurnedUnparseable}/${probes.yaml.fixtures}`)
    console.log(`                        duplicate disabled keys        : ${probes.yaml.duplicateDisabledKeys}`)
    console.log(`                        insert-group override ignored  : ${probes.yaml.insertGroupIgnore}`)
  } else {
    console.log('  A  YAML rewrite      skip (no DSH runtime for the platform composition rule)')
  }
  const admission = probes.managementAdmission.admission
  console.log(`  B  management routes unauthenticated /state          : ${admission.unauthenticatedState.status}${admission.unauthenticatedState.jsonRefusal ? ' (JSON refusal)' : ''}`)
  console.log(`                        bad Host /state                 : ${admission.badHostState.status}`)
  console.log(`                        text/plain POST /toggle         : ${admission.textPlainToggle.status}`)
  console.log(`                        GET /toggle                     : ${admission.getOnToggle.status} allow=[${admission.getOnToggle.allow.join(', ')}]`)
  console.log(`                        DELETE /state                   : ${admission.deleteOnState.status} allow=[${admission.deleteOnState.allow.join(', ')}]`)
  console.log(`                        POST /state                     : ${admission.postOnState.status} allow=[${admission.postOnState.allow.join(', ')}]`)
  for (const entry of probes.managementAdmission.enabledCoercion) {
    console.log(`                        enabled=${entry.sent.padEnd(10)} -> status ${entry.status}, manager calls ${entry.calls.length}, row enabled ${entry.finalEnabled}`)
  }
  console.log(`  C  control queue     manager calls for stop+start     : ${probes.controlQueue.managerCalls.length} (${JSON.stringify(probes.controlQueue.managerCalls)})`)
  console.log(`  D  client panel      failure after action / after poll: ${probes.client.failureAfterAction} / ${probes.client.failureAfterPoll}`)
  console.log(`  E  search            matches per query                : ${JSON.stringify(probes.search.queries)}`)
  const schemaOutcome =
    probes.fullSchema.mode === 'omitted'
      ? 'omitted with a signature (too large to print in full)'
      : probes.fullSchema.mode === 'printed'
        ? probes.fullSchema.parses
          ? 'valid JSON'
          : 'INVALID JSON'
        : 'no schema printed'
  console.log(`  F  full schema       ${probes.fullSchema.schemaChars} chars -> ${schemaOutcome}`)
  console.log(`\n  ${reproduced}/${entries.length} defect families reproduced (${entries.length - skipped} evaluated, ${skipped} skipped)`)

  if (pass && expectation === 'fixed') {
    console.log('  PASS — no reviewed defect reproduces (regression gate)\n')
  } else if (pass) {
    console.log('  PASS — every reviewed 1.2.0 defect reproduces (this checkout is 1.2.0)\n')
  } else if (expectation === 'fixed') {
    console.log(`  REGRESSION: ${failures.map((entry) => entry.key).join(', ')}\n`)
  } else if (failures.length > 0) {
    console.log(`  NOT A 1.2.0 CHECKOUT: ${failures.map((entry) => entry.key).join(', ')} no longer reproduce\n`)
  } else {
    console.log(`  CANNOT DOCUMENT 1.2.0: ${entries.filter((entry) => entry.verdict === 'skip').map((entry) => entry.key).join(', ')} skipped (no DSH runtime)\n`)
  }
}

process.exit(pass ? 0 : 1)
