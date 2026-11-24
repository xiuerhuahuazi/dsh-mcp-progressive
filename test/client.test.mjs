/**
 * Client-panel regression for dsh-mcp-progressive.
 *
 * Everything runs through `mountClientPanel`, the harness fake browser: a `vm`
 * sandbox with stub React hooks, a stub module loader and a `fetch` stub. It
 * deliberately ships no browser-only globals, so `mountPanel` adds the two the
 * panel legitimately needs in a browser — `AbortController` and a controllable
 * `setTimeout`/`clearTimeout` — by wrapping `vm.runInNewContext` for the
 * duration of the mount. `test/harness.mjs` stays untouched.
 *
 * This is not a rendering test: it drives hooks and callbacks and asserts the
 * element tree the panel returns, so it covers state, wiring and a11y props,
 * not pixels.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { findNode, flushMicrotasks, mountClientPanel } from './harness.mjs'

const TOGGLE_URL = '/dsh-mcp-hub/toggle'
const RESTART_URL = '/dsh-mcp-hub/restart'

/** One default server row as the management half presents it. */
function serverRow(overrides = {}) {
  return {
    entryId: 'include:rea',
    id: 'rea',
    serverName: 'rea',
    transport: 'stdio',
    target: 'node server.js',
    enabled: true,
    toolCount: 2,
    status: 'running',
    ...overrides,
  }
}

/** The state body `GET /dsh-mcp-hub/state` answers with. */
function stateBody(servers, extra = {}) {
  return { ok: true, now: 1, servers, ...extra }
}

/** A minimal `fetch` response. */
function response(body) {
  return { ok: true, status: 200, json: async () => body }
}

/**
 * Mount the panel with the browser globals the fake browser omits.
 *
 * `AbortController` and the timers are injected into the sandbox the harness
 * builds, so the panel's deadline and unmount-abort paths are exercised with
 * real signals and deterministic timers instead of being skipped.
 *
 * @param {object} [options] `mountClientPanel` options (`fetch`, `locale`, `language`)
 * @returns {{panel: object, timerList: () => object[], fireTimers: () => void}}
 */
function mountPanel(options = {}) {
  const deadlines = new Map()
  let nextTimerId = 1
  const browserGlobals = {
    AbortController,
    setTimeout(fn, ms) {
      const id = nextTimerId
      nextTimerId += 1
      deadlines.set(id, { fn, ms, cleared: false })
      return id
    },
    clearTimeout(id) {
      const timer = deadlines.get(id)
      if (timer === undefined) return
      timer.cleared = true
      deadlines.delete(id)
    },
  }
  const runInNewContext = vm.runInNewContext
  vm.runInNewContext = (code, sandbox, runOptions) =>
    runInNewContext(code, Object.assign(sandbox, browserGlobals), runOptions)
  try {
    const panel = mountClientPanel(options)
    return {
      panel,
      timerList: () => [...deadlines.values()],
      fireTimers() {
        const pending = [...deadlines.values()]
        deadlines.clear()
        for (const timer of pending) if (!timer.cleared) timer.fn()
      },
    }
  } finally {
    vm.runInNewContext = runInNewContext
  }
}

/** Concatenated text of a fake-React node. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children ?? []).map(textOf).join(' ')
}

/** Every node matching `predicate` (depth first). */
function findAll(tree, predicate) {
  const found = []
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return
    if (predicate(node)) found.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return found
}

const byClass = (tree, className) => findNode(tree, (node) => node.props && node.props.className === className)
const allByClass = (tree, className) => findAll(tree, (node) => node.props && node.props.className === className)
const toggleButton = (tree) => findNode(tree, (node) => node.props && node.props.role === 'switch')
const restartButton = (tree) => findNode(tree, (node) => node.props && node.props.className === 'dsh-mcp-icon-btn')
const detailLine = (tree) => byClass(tree, 'dsh-mcp-card-detail')
const liveRegion = (tree) => findNode(tree, (node) => node.props && node.props['aria-live'] === 'polite')
const batchButton = (tree, action) =>
  findNode(
    tree,
    (node) => node.props && typeof node.props.className === 'string' && node.props.className.includes('dsh-mcp-batch-' + action),
  )

test('a failed action stays visible after a following successful poll', async () => {
  const fetch = async (url, init) => {
    if (init !== undefined && init.method === 'POST') throw new Error('SYNTHETIC restart failure')
    return response(stateBody([serverRow()]))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    await restartButton(mounted.panel.render()).props.onClick()
    await flushMicrotasks()

    let live = liveRegion(mounted.panel.render())
    assert.ok(live !== undefined, 'action results need a live region')
    assert.equal(live.props['aria-live'], 'polite')
    assert.match(textOf(live), /SYNTHETIC restart failure/)

    await mounted.panel.poll()
    await flushMicrotasks()
    live = liveRegion(mounted.panel.render())
    assert.match(textOf(live), /SYNTHETIC restart failure/, 'a successful poll must not clear the action error')
    assert.equal(byClass(mounted.panel.render(), 'dsh-mcp-failure'), undefined, 'an action failure is not a load failure')
  } finally {
    mounted.panel.unmount()
  }
})

test('an older poll response cannot overwrite a newer action snapshot', async () => {
  let resolvePoll = null
  let reads = 0
  const fetch = (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      return Promise.resolve(response(stateBody([serverRow({ enabled: false, status: 'stopped' })], { now: 3 })))
    }
    reads += 1
    if (reads === 1) return Promise.resolve(response(stateBody([serverRow()], { now: 1 })))
    return new Promise((resolve) => {
      resolvePoll = () => resolve(response(stateBody([serverRow()], { now: 2 })))
    })
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    // The poll that carries the pre-action snapshot is still in flight.
    const poll = mounted.panel.poll()
    await flushMicrotasks()
    await toggleButton(mounted.panel.render()).props.onClick()
    await flushMicrotasks()
    assert.equal(toggleButton(mounted.panel.render()).props['aria-checked'], 'false')

    resolvePoll()
    await poll
    await flushMicrotasks()
    assert.equal(
      toggleButton(mounted.panel.render()).props['aria-checked'],
      'false',
      'the stale GET must be discarded, not applied over the action result',
    )
  } finally {
    mounted.panel.unmount()
  }
})

test('a hung request is aborted at its deadline and polling recovers', async () => {
  const signals = []
  let respond = false
  const fetch = (url, init) => {
    signals.push(init === undefined ? undefined : init.signal)
    if (!respond) return new Promise(() => {})
    return Promise.resolve(response(stateBody([serverRow()])))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    assert.equal(signals.length, 1)
    assert.ok(signals[0] !== undefined, 'every request must carry an abort signal')
    assert.equal(signals[0].aborted, false)
    const deadlines = mounted.timerList()
    assert.ok(deadlines.length >= 1, 'every request must arm a deadline')
    assert.ok(deadlines.some((timer) => timer.ms > 0 && timer.ms <= 10_000))

    mounted.fireTimers()
    assert.equal(signals[0].aborted, true, 'a hung request must be aborted at the deadline')

    respond = true
    await mounted.panel.poll()
    await flushMicrotasks()
    assert.ok(signals.length >= 2, 'a hung request must not block the next poll')
    assert.equal(toggleButton(mounted.panel.render()).props['aria-checked'], 'true')
  } finally {
    mounted.panel.unmount()
  }
})

test('unmount aborts requests that are still in flight', async () => {
  let signal = null
  const mounted = mountPanel({
    fetch: (url, init) => {
      signal = init === undefined ? null : init.signal
      return new Promise(() => {})
    },
  })
  await flushMicrotasks()
  assert.ok(signal !== null)
  assert.equal(signal.aborted, false)
  mounted.panel.unmount()
  assert.equal(signal.aborted, true)
})

test('a server whose id is "constructor" toggles without staying busy', async () => {
  const before = serverRow({ entryId: 'include:ctor', id: 'constructor', serverName: 'constructor' })
  const after = serverRow({
    entryId: 'include:ctor',
    id: 'constructor',
    serverName: 'constructor',
    enabled: false,
    status: 'stopped',
  })
  const fetch = async (url, init) =>
    init !== undefined && init.method === 'POST' ? response(stateBody([after], { now: 2 })) : response(stateBody([before]))
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    let toggle = toggleButton(mounted.panel.render())
    assert.equal(toggle.props.disabled, false, 'an inherited object key must not mark the row busy')
    await toggle.props.onClick()
    await flushMicrotasks()
    toggle = toggleButton(mounted.panel.render())
    assert.equal(toggle.props.disabled, false, 'the row must stop being busy once the action settles')
    assert.equal(toggle.props['aria-checked'], 'false')
  } finally {
    mounted.panel.unmount()
  }
})

test('the panel reads the platform locale snapshot "active"', async () => {
  const mounted = mountPanel({ locale: { active: 'zh' } })
  try {
    await flushMicrotasks()
    const title = findNode(mounted.panel.render(), (node) => node.type === 'h3')
    assert.equal(title.children[0], 'MCP 服务器')
  } finally {
    mounted.panel.unmount()
  }
})

test('the panel keeps the browser-language fallback', async () => {
  const mounted = mountPanel({ locale: {}, language: 'zh-CN' })
  try {
    await flushMicrotasks()
    const title = findNode(mounted.panel.render(), (node) => node.type === 'h3')
    assert.equal(title.children[0], 'MCP 服务器')
  } finally {
    mounted.panel.unmount()
  }
})

test('toggle and restart POST address the row by entryId as JSON', async () => {
  const posts = []
  const fetch = async (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      posts.push({ url, init })
      return response(stateBody([serverRow()]))
    }
    return response(stateBody([serverRow()]))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    await toggleButton(mounted.panel.render()).props.onClick()
    await flushMicrotasks()
    await restartButton(mounted.panel.render()).props.onClick()
    await flushMicrotasks()
    assert.equal(posts.length, 2)

    const toggle = posts[0]
    assert.equal(toggle.url, TOGGLE_URL)
    assert.equal(toggle.init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(toggle.init.body), { entryId: 'include:rea', enabled: false })

    const restart = posts[1]
    assert.equal(restart.url, RESTART_URL)
    assert.equal(restart.init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(restart.init.body), { entryId: 'include:rea' })
  } finally {
    mounted.panel.unmount()
  }
})

test('addressing falls back to id when a row has no entryId', async () => {
  const row = serverRow({ entryId: undefined })
  const posts = []
  const fetch = async (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      posts.push(JSON.parse(init.body))
      return response(stateBody([row]))
    }
    return response(stateBody([row]))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    await toggleButton(mounted.panel.render()).props.onClick()
    await flushMicrotasks()
    assert.deepEqual(posts[0], { id: 'rea', enabled: false })
  } finally {
    mounted.panel.unmount()
  }
})

test('a stopping row uses a different tone than a starting row', async () => {
  const rows = [
    serverRow(),
    serverRow({ entryId: 'include:off', id: 'off', serverName: 'off', enabled: false, status: 'stopped' }),
  ]
  const releases = []
  const fetch = (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      return new Promise((resolve) => {
        releases.push(() => resolve(response(stateBody(rows))))
      })
    }
    return Promise.resolve(response(stateBody(rows)))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const toggles = findAll(mounted.panel.render(), (node) => node.props && node.props.role === 'switch')
    assert.equal(toggles.length, 2)
    toggles[0].props.onClick()
    toggles[1].props.onClick()

    const tags = allByClass(mounted.panel.render(), 'dsh-mcp-tag')
    assert.equal(tags.length, 2)
    assert.match(textOf(tags[0]), /Stopping/)
    assert.match(textOf(tags[1]), /Starting/)
    assert.equal(tags[0].props['data-tone'], 'neutral', 'stopping must not reuse the starting warning tone')
    assert.equal(tags[1].props['data-tone'], 'warning')
    assert.notEqual(tags[0].props['data-tone'], tags[1].props['data-tone'])

    for (const release of releases) release()
    await flushMicrotasks()
  } finally {
    mounted.panel.unmount()
  }
})

test('a restart-required outcome is informational, not a success state', async () => {
  const fetch = async (url, init) =>
    init !== undefined && init.method === 'POST'
      ? response({ ...stateBody([serverRow()]), result: { application: 'restart-required' } })
      : response(stateBody([serverRow()]))
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    await restartButton(mounted.panel.render()).props.onClick()
    await flushMicrotasks()
    const live = liveRegion(mounted.panel.render())
    assert.match(textOf(live), /restart DeepSeek Harness/)
    assert.equal(live.props['data-tone'], 'info')
    const tag = byClass(mounted.panel.render(), 'dsh-mcp-tag')
    assert.equal(tag.props['data-tone'], 'success', 'the server itself is still running; only the save is pending a restart')
  } finally {
    mounted.panel.unmount()
  }
})

test('a server diagnostic is rendered on the card', async () => {
  const diagnostic = 'spawn node ENOENT'
  const mounted = mountPanel({
    fetch: async () => response(stateBody([serverRow({ enabled: true, status: 'error', diagnostic })])),
  })
  try {
    await flushMicrotasks()
    const description = byClass(mounted.panel.render(), 'dsh-mcp-card-desc')
    assert.match(textOf(description), /spawn node ENOENT/)
    assert.match(String(description.props.title), /spawn node ENOENT/)
  } finally {
    mounted.panel.unmount()
  }
})

test('controls carry readable accessible names and a polite live region', async () => {
  const mounted = mountPanel({ fetch: async () => response(stateBody([serverRow()])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const toggle = toggleButton(tree)
    assert.match(String(toggle.props['aria-label']), /rea/)
    assert.match(String(toggle.props['aria-label']), /availability/)
    assert.equal(toggle.props['aria-checked'], 'true')

    const restart = restartButton(tree)
    assert.match(String(restart.props['aria-label']), /Restart rea/)

    const live = liveRegion(tree)
    assert.equal(live.props['aria-live'], 'polite')
    assert.equal(live.props.role, 'status')
  } finally {
    mounted.panel.unmount()
  }
})

test('a failed load keeps the banner and Retry', async () => {
  let failing = true
  const fetch = async () => {
    if (failing) throw new Error('connect ECONNREFUSED')
    return response(stateBody([serverRow()]))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    let banner = byClass(mounted.panel.render(), 'dsh-mcp-failure')
    assert.ok(banner !== undefined, 'a failed load must keep its banner')
    assert.match(textOf(banner), /connect ECONNREFUSED/)

    failing = false
    await byClass(mounted.panel.render(), 'dsh-mcp-btn').props.onClick()
    await flushMicrotasks()
    banner = byClass(mounted.panel.render(), 'dsh-mcp-failure')
    assert.equal(banner, undefined)
    assert.equal(toggleButton(mounted.panel.render()).props['aria-checked'], 'true')
  } finally {
    mounted.panel.unmount()
  }
})

test('a running row without live data renders exactly as before', async () => {
  const row = serverRow({ live: null, statusDetail: null })
  const mounted = mountPanel({ fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const tag = byClass(tree, 'dsh-mcp-tag')
    assert.equal(textOf(tag), 'running')
    assert.equal(tag.props['data-tone'], 'success')
    assert.equal(textOf(byClass(tree, 'dsh-mcp-card-desc')), 'stdio · node server.js · 2 tools')
    assert.equal(detailLine(tree), undefined, 'no second line without a Host detail')
    assert.equal(tag.props.title, 'status: running')
  } finally {
    mounted.panel.unmount()
  }
})

test('an older Host row without live/statusDetail fields still renders', async () => {
  const row = serverRow()
  delete row.live
  delete row.statusDetail
  const mounted = mountPanel({ fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(textOf(byClass(tree, 'dsh-mcp-tag')), 'running')
    assert.equal(detailLine(tree), undefined)
    assert.doesNotMatch(textOf(tree), /\bundefined\b/)
    assert.equal(toggleButton(tree).props['aria-checked'], 'true')
  } finally {
    mounted.panel.unmount()
  }
})

test('a reconnecting starting row names the attempt and hints the retry', async () => {
  const reconnecting = serverRow({
    status: 'starting',
    toolCount: 0,
    live: { state: 'reconnecting', attempt: 2, maxAttempts: 5, nextRetryAtMs: 3001 },
  })
  const running = serverRow({ entryId: 'include:busy', id: 'busy', serverName: 'busy', target: 'node busy.js' })
  const rows = [reconnecting, running]
  const releases = []
  const fetch = (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      return new Promise((resolve) => {
        releases.push(() => resolve(response(stateBody(rows, { now: 3001 }))))
      })
    }
    return Promise.resolve(response(stateBody(rows, { now: 1 })))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const tag = byClass(tree, 'dsh-mcp-tag')
    assert.equal(textOf(tag), 'reconnecting (attempt 2/5)')
    assert.equal(tag.props['data-tone'], 'warning', 'a reconnect is still a start, not a new tone')

    const detail = detailLine(tree)
    assert.ok(detail !== undefined, 'the next retry must be visible')
    assert.equal(textOf(detail), 'retry in 3s')
    assert.equal(detail.props.title, 'retry in 3s')
    assert.equal(String(tag.props.title), 'status: reconnecting (attempt 2/5) — retry in 3s')

    // The reconnect row may still be spawning, so its switch is blocked; an
    // in-flight action over a settled row keeps its own verb ("Stopping…").
    const toggles = findAll(tree, (node) => node.props && node.props.role === 'switch')
    assert.equal(toggles[0].props.disabled, true)
    const pending = toggles[1].props.onClick()
    assert.equal(textOf(allByClass(mounted.panel.render(), 'dsh-mcp-tag')[1]), 'Stopping…')
    for (const release of releases) release()
    await pending
    await flushMicrotasks()
    assert.equal(textOf(allByClass(mounted.panel.render(), 'dsh-mcp-tag')[1]), 'running')
  } finally {
    mounted.panel.unmount()
  }
})

test('a starting row waiting for credentials says so', async () => {
  const row = serverRow({
    status: 'starting',
    live: { state: 'waiting-credentials', lastError: 'missing ${credential:token}' },
  })
  const mounted = mountPanel({ fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const tag = byClass(tree, 'dsh-mcp-tag')
    assert.equal(textOf(tag), 'waiting for credentials')
    assert.equal(tag.props['data-tone'], 'warning')

    const detail = detailLine(tree)
    assert.ok(detail !== undefined, 'the credential problem must be visible')
    assert.match(textOf(detail), /\$\{credential:token\}/)
    assert.equal(String(tag.props.title), 'status: waiting for credentials — missing ${credential:token}')
  } finally {
    mounted.panel.unmount()
  }
})

test('an error row shows the Host detail on the card and in the tag hint', async () => {
  const statusDetail = 'failed: gave-up · spawn ENOENT'
  const row = serverRow({
    status: 'error',
    live: { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' },
    statusDetail,
  })
  const mounted = mountPanel({ fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const tag = byClass(tree, 'dsh-mcp-tag')
    assert.equal(textOf(tag), 'error')
    assert.equal(tag.props['data-tone'], 'danger')
    assert.equal(String(tag.props.title), 'status: error — ' + statusDetail)

    const detail = detailLine(tree)
    assert.ok(detail !== undefined)
    assert.equal(textOf(detail), statusDetail)
    assert.equal(detail.props.title, statusDetail, 'the full string stays available to the tooltip')
    assert.doesNotMatch(textOf(tree), /\bundefined\b/)
  } finally {
    mounted.panel.unmount()
  }
})

test('an error row without a Host detail falls back to live.lastError', async () => {
  const row = serverRow({
    status: 'error',
    diagnostic: undefined,
    statusDetail: null,
    live: { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' },
  })
  const mounted = mountPanel({ fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const detail = detailLine(tree)
    assert.ok(detail !== undefined, 'an old Host still explains the failure')
    assert.equal(textOf(detail), 'failed: gave-up · spawn ENOENT')
    assert.equal(String(byClass(tree, 'dsh-mcp-tag').props.title), 'status: error — failed: gave-up · spawn ENOENT')
  } finally {
    mounted.panel.unmount()
  }
})

test('a detail that disappears between polls is removed cleanly', async () => {
  let polls = 0
  const fetch = async () => {
    polls += 1
    return polls === 1
      ? response(stateBody([serverRow({ live: { state: 'connected', toolCount: 2 }, statusDetail: 'connected · 2 tools' })]))
      : response(stateBody([serverRow({ live: null, statusDetail: null })]))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    assert.equal(textOf(detailLine(mounted.panel.render())), 'connected · 2 tools')

    await mounted.panel.poll()
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(detailLine(tree), undefined)
    assert.equal(textOf(byClass(tree, 'dsh-mcp-tag')), 'running')
    assert.doesNotMatch(textOf(tree), /\bundefined\b/)
    assert.doesNotMatch(textOf(tree), /\bnull\b/)
    assert.equal(toggleButton(tree).props['aria-checked'], 'true')
  } finally {
    mounted.panel.unmount()
  }
})

test('a stopped or stopping row does not inherit a stale live failure detail', async () => {
  const rows = [
    serverRow({
      entryId: 'include:off',
      id: 'off',
      serverName: 'off',
      enabled: false,
      status: 'stopped',
      statusDetail: null,
      live: { state: 'failed', reason: 'gave-up', lastError: 'stale X' },
    }),
    serverRow({
      entryId: 'include:bye',
      id: 'bye',
      serverName: 'bye',
      enabled: false,
      status: 'stopping',
      statusDetail: null,
      live: { state: 'failed', reason: 'gave-up', lastError: 'stale X' },
    }),
  ]
  const mounted = mountPanel({ fetch: async () => response(stateBody(rows)) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const tags = allByClass(tree, 'dsh-mcp-tag')
    assert.deepEqual(tags.map(textOf), ['stopped', 'stopping'])
    assert.equal(detailLine(tree), undefined, 'a stopped row must not borrow its last live cell')
    assert.doesNotMatch(textOf(tree), /failed|stale X/)
    assert.deepEqual(tags.map((tag) => tag.props.title), ['status: stopped', 'status: stopping'])
  } finally {
    mounted.panel.unmount()
  }
})

test('a stopped row still shows the statusDetail the Host sent', async () => {
  const statusDetail = 'stopped by the user · saved to the profile patch'
  const row = serverRow({ enabled: false, status: 'stopped', statusDetail, live: { state: 'failed', lastError: 'stale X' } })
  const mounted = mountPanel({ fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const tag = byClass(tree, 'dsh-mcp-tag')
    assert.equal(textOf(tag), 'stopped')
    const detail = detailLine(tree)
    assert.ok(detail !== undefined, "the Host's own detail is always shown")
    assert.equal(textOf(detail), statusDetail)
    assert.equal(String(tag.props.title), 'status: stopped — ' + statusDetail)
    assert.doesNotMatch(textOf(tree), /stale X/)
  } finally {
    mounted.panel.unmount()
  }
})

const HAZARD_HINT = 'Wait for the server to finish starting before stopping or restarting it'

/** Collect POST bodies made through `fetch` (any method/URL). */
function recordingFetch(rows) {
  const posts = []
  const fetch = async (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) })
      return response(stateBody(rows))
    }
    return response(stateBody(rows))
  }
  return { posts, fetch }
}

test('a starting row disables stop and restart and explains why', async () => {
  const row = serverRow({ status: 'starting', toolCount: 0, live: { state: 'connecting', attempt: 0 } })
  const { posts, fetch } = recordingFetch([row])
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const toggle = toggleButton(tree)
    const restart = restartButton(tree)

    assert.equal(toggle.props.disabled, true, 'the switch must not stop a spawning row')
    assert.equal(restart.props.disabled, true, 'restart must not dispose a spawning row')
    assert.match(String(toggle.props.title), new RegExp(HAZARD_HINT))
    assert.match(String(toggle.props['aria-label']), new RegExp(HAZARD_HINT))
    assert.match(String(restart.props.title), new RegExp(HAZARD_HINT))
    assert.match(String(restart.props['aria-label']), new RegExp(HAZARD_HINT))

    // The row itself still reads as "starting"; only the controls are blocked.
    assert.equal(textOf(byClass(tree, 'dsh-mcp-tag')), 'starting')
    assert.equal(toggle.props['aria-checked'], 'true')

    // An activation that reaches the disabled control must not hit the wire.
    await toggle.props.onClick()
    await restart.props.onClick()
    await flushMicrotasks()
    assert.deepEqual(posts, [], 'a blocked control must never POST')
  } finally {
    mounted.panel.unmount()
  }
})

test('the starting hazard hint is localized', async () => {
  const row = serverRow({ status: 'starting', live: { state: 'connecting' } })
  const mounted = mountPanel({ locale: { active: 'zh' }, fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const toggle = toggleButton(tree)
    const restart = restartButton(tree)
    assert.equal(toggle.props.disabled, true)
    assert.equal(restart.props.disabled, true)
    assert.match(String(toggle.props.title), /启动完成后再停止或重启/)
    assert.match(String(toggle.props['aria-label']), /启动完成后再停止或重启/)
    assert.match(String(restart.props.title), /启动完成后再停止或重启/)
    assert.match(String(restart.props['aria-label']), /启动完成后再停止或重启/)
    assert.equal(textOf(byClass(tree, 'dsh-mcp-tag')), '启动中')
  } finally {
    mounted.panel.unmount()
  }
})

test('reconnecting and waiting-credentials starting rows are blocked too', async () => {
  const rows = [
    serverRow({
      entryId: 'include:retry',
      id: 'retry',
      serverName: 'retry',
      status: 'starting',
      live: { state: 'reconnecting', attempt: 2, maxAttempts: 5, nextRetryAtMs: 3001 },
    }),
    serverRow({
      entryId: 'include:creds',
      id: 'creds',
      serverName: 'creds',
      status: 'starting',
      live: { state: 'waiting-credentials', lastError: 'missing ${credential:token}' },
    }),
  ]
  const mounted = mountPanel({ fetch: async () => response(stateBody(rows)) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const toggles = findAll(tree, (node) => node.props && node.props.role === 'switch')
    const restarts = allByClass(tree, 'dsh-mcp-icon-btn')
    assert.equal(toggles.length, 2)
    assert.equal(restarts.length, 2)
    for (const node of [...toggles, ...restarts]) {
      assert.equal(node.props.disabled, true)
      assert.match(String(node.props.title), new RegExp(HAZARD_HINT))
    }
  } finally {
    mounted.panel.unmount()
  }
})

test('a closed transport is not a spawn hazard, so the row stays controllable', async () => {
  const row = serverRow({ status: 'starting', toolCount: 0, live: { state: 'closed' } })
  const { posts, fetch } = recordingFetch([row])
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const toggle = toggleButton(tree)
    const restart = restartButton(tree)
    assert.equal(toggle.props.disabled, false, 'a closed transport is settled: the escape hatch stays open')
    assert.equal(restart.props.disabled, false)
    assert.doesNotMatch(String(restart.props.title), /finish starting/)

    await restart.props.onClick()
    await flushMicrotasks()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, RESTART_URL)
    assert.deepEqual(posts[0].body, { entryId: 'include:rea' })
  } finally {
    mounted.panel.unmount()
  }
})

test('a starting row without live data falls back to the hazard lock', async () => {
  const row = serverRow({ status: 'starting' })
  delete row.live
  const mounted = mountPanel({ fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(toggleButton(tree).props.disabled, true)
    assert.equal(restartButton(tree).props.disabled, true)
  } finally {
    mounted.panel.unmount()
  }
})

test('running, idle, error and stopped rows keep their controls enabled', async () => {
  const rows = [
    serverRow(),
    serverRow({ entryId: 'include:idle', id: 'idle', serverName: 'idle', status: 'idle', live: { state: 'connected', toolCount: 0 } }),
    serverRow({ entryId: 'include:bad', id: 'bad', serverName: 'bad', status: 'error', live: { state: 'failed', reason: 'gave-up' } }),
    serverRow({ entryId: 'include:off', id: 'off', serverName: 'off', enabled: false, status: 'stopped' }),
  ]
  const mounted = mountPanel({ fetch: async () => response(stateBody(rows)) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const toggles = findAll(tree, (node) => node.props && node.props.role === 'switch')
    const restarts = allByClass(tree, 'dsh-mcp-icon-btn')
    assert.equal(toggles.length, 4)
    assert.equal(restarts.length, 4)
    for (const node of [...toggles, ...restarts]) {
      assert.equal(node.props.disabled, false)
      assert.doesNotMatch(String(node.props.title), /finish starting/)
    }
  } finally {
    mounted.panel.unmount()
  }
})

test('a stopped row is still startable', async () => {
  const row = serverRow({ enabled: false, status: 'stopped' })
  const { posts, fetch } = recordingFetch([row])
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const toggle = toggleButton(mounted.panel.render())
    assert.equal(toggle.props.disabled, false)
    assert.equal(toggle.props['aria-checked'], 'false')
    await toggle.props.onClick()
    await flushMicrotasks()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, TOGGLE_URL)
    assert.deepEqual(posts[0].body, { entryId: 'include:rea', enabled: true })
  } finally {
    mounted.panel.unmount()
  }
})

test('a pending action still disables every control', async () => {
  const row = serverRow()
  const releases = []
  const fetch = (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      return new Promise((resolve) => {
        releases.push(() => resolve(response(stateBody([row]))))
      })
    }
    return Promise.resolve(response(stateBody([row])))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    toggleButton(mounted.panel.render()).props.onClick()
    const tree = mounted.panel.render()
    assert.equal(toggleButton(tree).props.disabled, true)
    assert.equal(restartButton(tree).props.disabled, true)
    assert.equal(textOf(byClass(tree, 'dsh-mcp-tag')), 'Stopping…')

    for (const release of releases) release()
    await flushMicrotasks()
    assert.equal(toggleButton(mounted.panel.render()).props.disabled, false)
  } finally {
    mounted.panel.unmount()
  }
})

test('a pending action wins over the hazard hint when the row turns starting', async () => {
  // Start from a settled row so a Stop is allowed and held open; the next poll
  // then reports the same row as `starting` + `connecting`, i.e. a row the
  // hazard valve would block. Busy must win: the pending action keeps its own
  // verb and the "finish starting" reason must not ride along.
  const running = serverRow()
  const starting = serverRow({ status: 'starting', toolCount: 0, live: { state: 'connecting', attempt: 0 } })
  let rows = [running]
  const posts = []
  const releases = []
  const fetch = (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) })
      return new Promise((resolve) => {
        releases.push(() => resolve(response(stateBody(rows))))
      })
    }
    return Promise.resolve(response(stateBody(rows)))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const stopping = toggleButton(mounted.panel.render()).props.onClick()

    rows = [starting]
    await mounted.panel.poll()
    await flushMicrotasks()

    const tree = mounted.panel.render()
    const toggle = toggleButton(tree)
    const restart = restartButton(tree)
    // The tag follows the in-flight verb, not the new `starting` status.
    assert.equal(textOf(byClass(tree, 'dsh-mcp-tag')), 'Stopping…')
    assert.equal(byClass(tree, 'dsh-mcp-card').props['data-state'], 'stopping')
    // The hazard reason only rides along while nothing else disables the row.
    assert.equal(toggle.props.title, undefined, 'a busy switch must not grow a hazard title')
    assert.doesNotMatch(String(toggle.props['aria-label']), new RegExp(HAZARD_HINT))
    assert.doesNotMatch(String(restart.props.title), new RegExp(HAZARD_HINT))
    assert.doesNotMatch(String(restart.props['aria-label']), new RegExp(HAZARD_HINT))
    // Both controls stay disabled — by the pending action, not by the hazard.
    assert.equal(toggle.props.disabled, true)
    assert.equal(restart.props.disabled, true)
    // The poll that revealed the hazard shape did not POST; only the held Stop did.
    assert.equal(posts.length, 1, 'the busy presentation must not issue an extra POST')
    assert.equal(posts[0].url, TOGGLE_URL)

    for (const release of releases) release()
    await stopping
    await flushMicrotasks()
    assert.equal(toggleButton(mounted.panel.render()).props.disabled, true, 'the row is still starting')
  } finally {
    mounted.panel.unmount()
  }
})

// ---------------------------------------------------------------------------
// v1.5 hidden-footprint block, status filter and batch controls.
// ---------------------------------------------------------------------------

/** A state body with the v1.5 disclosure/loaded snapshots attached. */
function disclosureState(servers, disclosure, loaded) {
  return stateBody(servers, { disclosure, loaded })
}

test('the disclosure block summarizes this window and lists the loaded agents', async () => {
  const disclosure = {
    tools: 40,
    hiddenTools: 7,
    hiddenTokens: 1500,
    hiddenChars: 4836,
    // The panel snapshot is cold (no agent): the live loaded view must win.
    loadedTools: 0,
    notAdopted: [
      { name: 'mcp__rea__always', reason: 'always visible (config)' },
      { name: 'mcp__bili__always', reason: 'always visible (config)' },
      { name: 'mcp__rea__task', reason: 'task support required' },
      { name: 'mcp__x__task', reason: 'task support required' },
      { name: 'mcp__y__shape', reason: 'unrecognized name shape' },
      { name: 'mcp__z__shape', reason: 'unrecognized name shape' },
      { name: 'mcp__w__other', reason: 'repeated name' },
    ],
  }
  const loaded = {
    agents: [
      { id: 'agent-1', title: null, delegationDepth: 0, loaded: ['mcp__rea__search', 'mcp__rea__capture_web_screenshot'] },
      { id: 'agent-2', title: 'Research worker', delegationDepth: 1, loaded: ['mcp__bili__video'] },
    ],
  }
  const mounted = mountPanel({ fetch: async () => response(disclosureState([serverRow()], disclosure, loaded)) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    const block = byClass(tree, 'dsh-mcp-disclosure')
    assert.ok(block !== undefined, 'a non-empty snapshot must render the disclosure block')

    const summary = byClass(tree, 'dsh-mcp-disclosure-summary')
    assert.equal(textOf(summary), 'By default: 7 hidden ≈ 1.5k tokens · 3 loaded in this window')

    const details = findNode(block, (node) => node.type === 'details')
    assert.ok(details !== undefined, 'loaded agents live in a collapsible block')
    assert.equal(textOf(findNode(details, (node) => node.type === 'summary')), 'Loaded in this window (3 tools)')
    const agentLines = allByClass(tree, 'dsh-mcp-disclosure-agent')
    assert.equal(agentLines.length, 2)
    assert.match(textOf(agentLines[0]), /agent-1: mcp__rea__search, mcp__rea__capture_web_screenshot/)
    assert.match(textOf(agentLines[1]), /Research worker: mcp__bili__video/)

    const kept = allByClass(tree, 'dsh-mcp-disclosure-kept')
    assert.deepEqual(kept.map(textOf), [
      'Kept visible: always visible (config) (2)',
      'Kept visible: task support required (2)',
      'Kept visible: unrecognized name shape (2)',
    ])
  } finally {
    mounted.panel.unmount()
  }
})

test('a loaded agent line caps at 12 tool names and counts the rest', async () => {
  const names = Array.from({ length: 14 }, (_, index) => 'mcp__rea__tool_' + index)
  const mounted = mountPanel({
    fetch: async () => response(disclosureState([serverRow()], { hiddenTools: 1, hiddenTokens: 10 }, {
      agents: [{ id: 'agent-1', title: null, delegationDepth: 0, loaded: names }],
    })),
  })
  try {
    await flushMicrotasks()
    const line = byClass(mounted.panel.render(), 'dsh-mcp-disclosure-agent')
    assert.ok(line !== undefined)
    const text = textOf(line)
    assert.match(text, /mcp__rea__tool_11/)
    assert.doesNotMatch(text, /mcp__rea__tool_12/)
    assert.match(text, / \+2 more$/)
  } finally {
    mounted.panel.unmount()
  }
})

test('the loaded summary falls back to disclosure.loadedTools without a loaded view', async () => {
  const mounted = mountPanel({
    fetch: async () => response(disclosureState([serverRow()], { hiddenTools: 3, hiddenTokens: 900, loadedTools: 2 }, null)),
  })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(textOf(byClass(tree, 'dsh-mcp-disclosure-summary')), 'By default: 3 hidden ≈ 900 tokens · 2 loaded in this window')
    assert.equal(findNode(tree, (node) => node.type === 'details'), undefined, 'no loaded agents, no collapsible block')
  } finally {
    mounted.panel.unmount()
  }
})

test('the loaded summary counts a tool loaded by two agents once', async () => {
  const loaded = {
    agents: [
      { id: 'a', title: null, delegationDepth: 0, loaded: ['mcp__rea__search', 'mcp__rea__capture'] },
      { id: 'b', title: null, delegationDepth: 0, loaded: ['mcp__rea__capture'] },
    ],
  }
  const mounted = mountPanel({
    fetch: async () => response(disclosureState([serverRow()], { hiddenTools: 0, hiddenTokens: 0 }, loaded)),
  })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(textOf(byClass(tree, 'dsh-mcp-disclosure-summary')), 'By default: 0 hidden ≈ 0 tokens · 2 loaded in this window')
    const summary = findNode(tree, (node) => node.type === 'summary')
    assert.equal(textOf(summary), 'Loaded in this window (2 tools)')
    assert.equal(allByClass(tree, 'dsh-mcp-disclosure-agent').length, 2, 'the per-agent list still shows both agents')
  } finally {
    mounted.panel.unmount()
  }
})

test('an older Host payload has no disclosure block and keeps the 1.4 meta line', async () => {
  const mounted = mountPanel({ fetch: async () => response(stateBody([serverRow({ live: null, statusDetail: null })])) })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(byClass(tree, 'dsh-mcp-disclosure'), undefined)
    assert.equal(textOf(byClass(tree, 'dsh-mcp-card-desc')), 'stdio · node server.js · 2 tools')
  } finally {
    mounted.panel.unmount()
  }
})

test('a card appends its hidden tool count and token estimate', async () => {
  const mounted = mountPanel({
    fetch: async () => response(stateBody([serverRow({ hiddenTools: 5, hiddenTokens: 1600 })])),
  })
  try {
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(
      textOf(byClass(tree, 'dsh-mcp-card-desc')),
      'stdio · node server.js · 2 tools · 5 hidden by default ≈ 1.6k tokens',
    )
    assert.equal(byClass(tree, 'dsh-mcp-disclosure'), undefined, 'per-server data alone does not open the block')
  } finally {
    mounted.panel.unmount()
  }
})

test('the status filter renders only matching cards and survives a poll', async () => {
  const rows = [
    serverRow(),
    serverRow({ entryId: 'include:off', id: 'off', serverName: 'off', enabled: false, status: 'stopped' }),
    serverRow({ entryId: 'include:bad', id: 'bad', serverName: 'bad', status: 'error', diagnostic: 'boom' }),
  ]
  const mounted = mountPanel({ fetch: async () => response(stateBody(rows)) })
  try {
    await flushMicrotasks()
    let tree = mounted.panel.render()
    let select = byClass(tree, 'dsh-mcp-filter')
    assert.ok(select !== undefined, 'the toolbar must carry a status filter')
    assert.equal(select.props['aria-label'], 'Filter by status')
    const options = findAll(select, (node) => node.type === 'option')
    assert.deepEqual(options.map((option) => option.props.value), ['all', 'running', 'stopped', 'error'])
    assert.deepEqual(options.map(textOf), ['All', 'running', 'stopped', 'error'])
    assert.equal(allByClass(tree, 'dsh-mcp-card').length, 3)

    select.props.onChange({ target: { value: 'stopped' } })
    tree = mounted.panel.render()
    let cards = allByClass(tree, 'dsh-mcp-card')
    assert.equal(cards.length, 1)
    assert.match(textOf(cards[0]), /off/)

    await mounted.panel.poll()
    await flushMicrotasks()
    assert.equal(allByClass(mounted.panel.render(), 'dsh-mcp-card').length, 1, 'the filter is not reset by a poll')

    byClass(mounted.panel.render(), 'dsh-mcp-filter').props.onChange({ target: { value: 'all' } })
    cards = allByClass(mounted.panel.render(), 'dsh-mcp-card')
    assert.equal(cards.length, 3)
  } finally {
    mounted.panel.unmount()
  }
})

test('a filter that matches nothing shows the filtered-empty note and disables batch', async () => {
  const running = serverRow()
  const stopped = serverRow({ entryId: 'include:off', id: 'off', serverName: 'off', enabled: false, status: 'stopped' })
  let rows = [running, stopped]
  const mounted = mountPanel({ fetch: async () => response(stateBody(rows)) })
  try {
    await flushMicrotasks()
    byClass(mounted.panel.render(), 'dsh-mcp-filter').props.onChange({ target: { value: 'stopped' } })
    assert.equal(allByClass(mounted.panel.render(), 'dsh-mcp-card').length, 1)

    // The row that justified the filter disappears on the next poll.
    rows = [running]
    await mounted.panel.poll()
    await flushMicrotasks()
    const tree = mounted.panel.render()
    assert.equal(allByClass(tree, 'dsh-mcp-card').length, 0)
    const empty = byClass(tree, 'dsh-mcp-empty')
    assert.ok(empty !== undefined, 'an empty filtered list needs an explanation')
    assert.equal(textOf(empty), 'No servers match this filter.')
    assert.equal(byClass(tree, 'dsh-mcp-filter').props.value, 'stopped', 'the selection stays visible')
    assert.equal(batchButton(tree, 'stop').props.disabled, true)
    assert.equal(batchButton(tree, 'restart').props.disabled, true)

    byClass(tree, 'dsh-mcp-filter').props.onChange({ target: { value: 'all' } })
    const restored = mounted.panel.render()
    assert.equal(allByClass(restored, 'dsh-mcp-card').length, 1)
    assert.equal(batchButton(restored, 'stop').props.disabled, false)
  } finally {
    mounted.panel.unmount()
  }
})

test('the card hidden line and the filtered-empty note are localized', async () => {
  const row = serverRow({ hiddenTools: 5, hiddenTokens: 1600 })
  const mounted = mountPanel({ locale: { active: 'zh' }, fetch: async () => response(stateBody([row])) })
  try {
    await flushMicrotasks()
    assert.match(textOf(byClass(mounted.panel.render(), 'dsh-mcp-card-desc')), /默认隐藏 5 个 ≈ 1\.6k tokens/)
    byClass(mounted.panel.render(), 'dsh-mcp-filter').props.onChange({ target: { value: 'stopped' } })
    assert.equal(textOf(byClass(mounted.panel.render(), 'dsh-mcp-empty')), '没有符合筛选条件的服务器。')
    assert.equal(batchButton(mounted.panel.render(), 'stop').props.disabled, true)
  } finally {
    mounted.panel.unmount()
  }
})

test('a lazy row carries a localized marker in the existing meta line', async () => {
  const mounted = mountPanel({ fetch: async () => response(stateBody([serverRow({ lazy: true })])) })
  try {
    await flushMicrotasks()
    assert.equal(
      textOf(byClass(mounted.panel.render(), 'dsh-mcp-card-desc')),
      'stdio · node server.js · 2 tools · lazy',
    )
  } finally {
    mounted.panel.unmount()
  }

  const zh = mountPanel({ locale: { active: 'zh' }, fetch: async () => response(stateBody([serverRow({ lazy: true })])) })
  try {
    await flushMicrotasks()
    assert.match(textOf(byClass(zh.panel.render(), 'dsh-mcp-card-desc')), /个工具 · 按需$/)
  } finally {
    zh.panel.unmount()
  }
})

test('a non-lazy row keeps the exact pre-1.6 meta line', async () => {
  const mounted = mountPanel({ fetch: async () => response(stateBody([serverRow({ lazy: false })])) })
  try {
    await flushMicrotasks()
    assert.equal(textOf(byClass(mounted.panel.render(), 'dsh-mcp-card-desc')), 'stdio · node server.js · 2 tools')
  } finally {
    mounted.panel.unmount()
  }
})

test('batch stop posts one toggle per eligible row and counts skipped rows', async () => {
  const rows = [
    serverRow(),
    serverRow({ entryId: 'include:idle', id: 'idle', serverName: 'idle', status: 'idle', toolCount: 0 }),
    serverRow({ entryId: 'include:start', id: 'start', serverName: 'start', status: 'starting', toolCount: 0, live: { state: 'connecting' } }),
    serverRow({ entryId: 'include:off', id: 'off', serverName: 'off', enabled: false, status: 'stopped' }),
    serverRow({ entryId: 'include:bye', id: 'bye', serverName: 'bye', status: 'stopping' }),
  ]
  const posts = []
  const fetch = async (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) })
      return response(stateBody(rows))
    }
    return response(stateBody(rows))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const done = batchButton(mounted.panel.render(), 'stop').props.onClick()
    await done
    await flushMicrotasks()

    assert.deepEqual(posts.map((post) => post.url), [TOGGLE_URL, TOGGLE_URL], 'only the running and idle rows')
    assert.deepEqual(posts.map((post) => post.body), [
      { entryId: 'include:rea', enabled: false },
      { entryId: 'include:idle', enabled: false },
    ])
    const live = liveRegion(mounted.panel.render())
    assert.match(textOf(live), /Done: 2 applied, 0 failed, 3 skipped/)
    assert.equal(live.props['data-tone'], 'info')
  } finally {
    mounted.panel.unmount()
  }
})

test('batch restart posts one restart per eligible row and skips stopped+disabled rows', async () => {
  const rows = [
    serverRow(),
    serverRow({ entryId: 'include:bad', id: 'bad', serverName: 'bad', status: 'error', live: { state: 'failed', reason: 'gave-up' } }),
    serverRow({ entryId: 'include:start', id: 'start', serverName: 'start', status: 'starting', toolCount: 0, live: { state: 'connecting' } }),
    serverRow({ entryId: 'include:off', id: 'off', serverName: 'off', enabled: false, status: 'stopped' }),
  ]
  const posts = []
  const fetch = async (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) })
      return response(stateBody(rows))
    }
    return response(stateBody(rows))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    await batchButton(mounted.panel.render(), 'restart').props.onClick()
    await flushMicrotasks()

    assert.deepEqual(posts.map((post) => post.url), [RESTART_URL, RESTART_URL])
    assert.deepEqual(posts.map((post) => post.body), [
      { entryId: 'include:rea' },
      { entryId: 'include:bad' },
    ])
    assert.match(textOf(liveRegion(mounted.panel.render())), /Done: 2 applied, 0 failed, 2 skipped/)
  } finally {
    mounted.panel.unmount()
  }
})

test('a failed batch request is counted and makes the outcome an error', async () => {
  const rows = [
    serverRow(),
    serverRow({ entryId: 'include:bad', id: 'bad', serverName: 'bad', status: 'error', live: { state: 'failed', reason: 'gave-up' } }),
    serverRow({ entryId: 'include:start', id: 'start', serverName: 'start', status: 'starting', toolCount: 0, live: { state: 'connecting' } }),
  ]
  const fetch = async (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.entryId === 'include:bad') throw new Error('SYNTHETIC batch failure')
      return response(stateBody(rows))
    }
    return response(stateBody(rows))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    await batchButton(mounted.panel.render(), 'restart').props.onClick()
    await flushMicrotasks()
    const live = liveRegion(mounted.panel.render())
    assert.match(textOf(live), /Done: 1 applied, 1 failed, 1 skipped/)
    assert.equal(live.props['data-tone'], 'error')
  } finally {
    mounted.panel.unmount()
  }
})

test('batch buttons stay disabled while any row is pending', async () => {
  const rows = [
    serverRow(),
    serverRow({ entryId: 'include:two', id: 'two', serverName: 'two' }),
  ]
  const releases = []
  const fetch = (url, init) => {
    if (init !== undefined && init.method === 'POST') {
      return new Promise((resolve) => {
        releases.push(() => resolve(response(stateBody(rows))))
      })
    }
    return Promise.resolve(response(stateBody(rows)))
  }
  const mounted = mountPanel({ fetch })
  try {
    await flushMicrotasks()
    const done = batchButton(mounted.panel.render(), 'stop').props.onClick()

    let tree = mounted.panel.render()
    assert.equal(batchButton(tree, 'stop').props.disabled, true)
    assert.equal(batchButton(tree, 'restart').props.disabled, true)

    releases[0]()
    await flushMicrotasks()
    assert.equal(releases.length, 2, 'the next request starts only after the first settles')
    tree = mounted.panel.render()
    assert.equal(batchButton(tree, 'stop').props.disabled, true, 'the remaining row keeps the buttons disabled')

    releases[1]()
    await done
    await flushMicrotasks()
    tree = mounted.panel.render()
    assert.equal(batchButton(tree, 'stop').props.disabled, false)
    assert.equal(batchButton(tree, 'restart').props.disabled, false)
    assert.match(textOf(liveRegion(tree)), /Done: 2 applied, 0 failed, 0 skipped/)
  } finally {
    mounted.panel.unmount()
  }
})
