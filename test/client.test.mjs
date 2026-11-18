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
  const row = serverRow({
    status: 'starting',
    toolCount: 0,
    live: { state: 'reconnecting', attempt: 2, maxAttempts: 5, nextRetryAtMs: 3001 },
  })
  const fetch = async (url, init) =>
    response(stateBody([row], init !== undefined && init.method === 'POST' ? { now: 3001 } : { now: 1 }))
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

    // An in-flight action keeps its own verb; only the settled state speaks live.
    const pending = toggleButton(tree).props.onClick()
    assert.equal(textOf(byClass(mounted.panel.render(), 'dsh-mcp-tag')), 'Stopping…')
    await pending
    await flushMicrotasks()
    assert.equal(textOf(byClass(mounted.panel.render(), 'dsh-mcp-tag')), 'reconnecting (attempt 2/5)')
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
