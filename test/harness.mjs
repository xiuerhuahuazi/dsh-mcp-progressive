/**
 * Regression harness for dsh-mcp-progressive.
 *
 * Three independent worlds live here, because the plugin has three halves:
 *
 * 1. **Real runtime** — a real Cordis `Context`, the real `dsh-tools`
 *    `ToolsService` and the real native tool executor, loaded from the
 *    unpacked DSH runtime. Every runtime-dependent test must skip itself when
 *    the runtime is absent (CI has none), and the runtime import always
 *    happens *after* the existence check.
 * 2. **Fake plugin context** — a plain object that speaks the small part of
 *    the Cordis surface the plugin uses (`on` / `effect` / `get` / `inject` /
 *    `tools` / `logger` / `webServer` / `pluginManager` / `profileContext` /
 *    `loader` / `connection`). It drives the management half with no DSH
 *    runtime at all, so CI can cover the HTTP routes.
 * 3. **Fake browser** — a `vm` sandbox with stub React hooks, a stub
 *    `window.__ModuleLoader__`, a stub `document` and a captured
 *    `setInterval`, enough to drive `client.js` without a browser.
 *
 * Everything is hermetic: temp directories only, no `~/.dsh`, no real MCP
 * server, no fixed port.
 */

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { registerServerManagement } from '../lib/management.js'

/** Repository root (the directory that holds index.js). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Absolute path of the plugin entry point. */
export const PLUGIN_ENTRY = path.join(REPO_ROOT, 'index.js')

/** Absolute path of the plugin client half. */
export const PLUGIN_CLIENT = path.join(REPO_ROOT, 'client.js')

/**
 * Directory that holds the unpacked `@deepseek-ai/*` runtime packages.
 * Override with `DSH_RUNTIME`; the default is the unpacked app.asar tree the
 * review probes used. This path is ephemeral — every runtime-dependent test
 * must skip when it is gone.
 */
export const DSH_RUNTIME = process.env.DSH_RUNTIME ?? '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai'

/** Runtime packages the harness needs; all must exist for the runtime world. */
const RUNTIME_PACKAGES = ['cordis', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-scope']

/** Whether the unpacked DSH runtime is available on this machine. */
export function hasRuntime() {
  return RUNTIME_PACKAGES.every((name) => fs.existsSync(path.join(DSH_RUNTIME, name, 'package.json')))
}

/**
 * Import one package from the unpacked DSH runtime by absolute path.
 * The package's own `exports`/`main` decides the entry file, so this keeps
 * working when the runtime is repacked.
 *
 * @param {string} pkg package name inside the runtime scope directory
 * @returns {Promise<object>} the package namespace
 */
export async function runtimeImport(pkg) {
  const dir = path.join(DSH_RUNTIME, pkg)
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`DSH runtime package not found: ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const entry =
    manifest.exports?.['.']?.default ??
    (typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : undefined) ??
    manifest.main ??
    'lib/index.js'
  return import(pathToFileURL(path.resolve(dir, entry)).href)
}

let runtimePromise = null

/**
 * Load (once) the runtime modules the harness needs.
 * @returns {Promise<{cordis: object, tools: object, executor: object, scope: object}>}
 */
export function loadRuntime() {
  if (runtimePromise === null) {
    runtimePromise = (async () => {
      const [cordis, tools, executor, scope] = await Promise.all([
        runtimeImport('cordis'),
        runtimeImport('dsh-tools'),
        runtimeImport('dsh-tool-executor-native'),
        runtimeImport('dsh-scope'),
      ])
      return { cordis, tools, executor, scope }
    })()
  }
  return runtimePromise
}

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

/** Drain the microtask queue a few times. */
export async function flushMicrotasks(times = 50) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/** Sleep for real milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a temporary directory that outlives the current call.
 * @returns {Promise<{dir: string, remove: () => Promise<void>}>}
 */
export async function makeTempDir(prefix = 'dsh-mcp-harness-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  return { dir, remove: () => fsp.rm(dir, { recursive: true, force: true }) }
}

/**
 * Run `fn` with a fresh temporary directory and remove it afterwards.
 * @template T
 * @param {(dir: string) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTempDir(fn) {
  const { dir, remove } = await makeTempDir()
  try {
    return await fn(dir)
  } finally {
    await remove()
  }
}

/**
 * Run `fn` with a virtual clock: `Date.now()` jumps forward by `stepMs` on
 * every call. The plugin polls the server phase against `Date.now()`, so a
 * virtual clock turns the 30 s production deadline into a few hundred
 * milliseconds of real time without touching the plugin source.
 *
 * @template T
 * @param {number} stepMs milliseconds added per `Date.now()` call
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withVirtualClock(stepMs, fn) {
  const realNow = Date.now
  let calls = 0
  Date.now = () => realNow() + (calls += 1) * stepMs
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

// ---------------------------------------------------------------------------
// World 1 — the real DSH runtime.
// ---------------------------------------------------------------------------

/**
 * Minimal systemPrompt stand-in: the ToolsService only needs `tools()` and
 * `section()`.
 */
export function fakeSystemPrompt() {
  const toolsProviders = []
  const sections = []
  return {
    tools(fn) {
      toolsProviders.push(fn)
      return () => {
        const index = toolsProviders.indexOf(fn)
        if (index >= 0) toolsProviders.splice(index, 1)
      }
    },
    section(cfg) {
      sections.push(cfg)
      return () => {
        const index = sections.indexOf(cfg)
        if (index >= 0) sections.splice(index, 1)
      }
    },
    getSectionOrder() {
      return 100
    },
    _toolsProviders: toolsProviders,
    _sections: sections,
  }
}

/**
 * Build a root Cordis context with the real tool registry and executor.
 * @returns {Promise<{root: object, tools: object, systemPrompt: object}>}
 */
export async function makeRoot() {
  const runtime = await loadRuntime()
  const root = new runtime.cordis.Context()
  const systemPrompt = fakeSystemPrompt()
  root.reflect.provide('systemPrompt', systemPrompt, () => true)
  const tools = new runtime.tools.ToolsService(root)
  root.tools.setExecutor(new runtime.executor.NativeToolExecutor(root))
  return { root, tools, systemPrompt }
}

/**
 * Build one agent-like object with a real scoped Cordis context.
 * @param {object} root the root context
 * @param {string} id agent id
 */
export async function makeAgent(root, id) {
  const runtime = await loadRuntime()
  const agent = { id, session: { id }, requests: [], scope: undefined, ctx: undefined }
  const scope = runtime.scope.createScope(root, agent)
  agent.ctx = scope.ctx
  agent.scope = scope
  return agent
}

/**
 * Register one tool definition in the global layer.
 * @returns {() => void} the disposer
 */
export function registerTool(root, name, extra = {}) {
  return root.tools.register({
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      return 'ok'
    },
    ...extra,
  })
}

/** Names visible to one scope (sorted). */
export function visibleNames(root, scope) {
  return root.tools
    .definitions(scope)
    .map((definition) => definition.name)
    .sort()
}

/** Names the prompt provider reads for one scope (sorted). */
export function promptTools(root, scope) {
  return root.tools
    .schemas(scope)
    .map((schema) => schema.name)
    .sort()
}

/** Default fake MCP catalog used by the runtime harness. */
export const DEFAULT_CATALOG = [
  'mcp__rea__search',
  'mcp__rea__capture_web_screenshot',
  'mcp__bili__video',
  'mcp__bili__live_screenshot',
  'mcp__blender__render_scene',
]

/**
 * Let a caller replace a service the harness already provided.
 *
 * Cordis refuses to register the same service twice, so a test that wants its
 * own implementation of a harness-provided service would fail on the second
 * `reflect.provide`. The harness swaps the implementation in place instead:
 * the service identity — and every fiber that already holds it — stays
 * stable, which is what a Host that provided the service once looks like.
 *
 * @param {object} root the root context
 * @param {string} name the service name that may be re-provided
 */
function allowReprovide(root, name) {
  const reflect = root.reflect
  const provide = reflect.provide.bind(reflect)
  let registered = false
  reflect.provide = (serviceName, value, check) => {
    if (serviceName === name && registered) {
      const current = reflect.get(name, false)
      if (current !== undefined && current !== null && typeof current === 'object' && value !== null && typeof value === 'object') {
        Object.assign(current, value)
        return () => {}
      }
    }
    const disposer = provide(serviceName, value, check)
    if (serviceName === name) registered = true
    return disposer
  }
}

/**
 * Boot the real plugin against the real DSH runtime.
 *
 * The plugin is applied on the root context (the same seam the review probes
 * used); every agent then owns a scoped child context on which the plugin
 * installs its disclosure restriction. The management half is activated too:
 * the services it injects are provided as fakes so `mcp_servers`,
 * `mcp_server` and the three HTTP routes exist.
 *
 * @param {object} [options]
 * @param {object} [options.config] plugin configuration
 * @param {string[]} [options.catalog] fake MCP tool names
 * @param {object} [options.manager] fake pluginManager implementation
 * @param {boolean} [options.connection] provide the Host `connection` service (default `true`)
 * @returns {Promise<object>} the mounted environment
 */
export async function mountPlugin(options = {}) {
  const { root, tools, systemPrompt } = await makeRoot()
  const agents = []
  const routes = new Map()
  const nested = []

  root.reflect.provide('agents', { list: () => [...agents] }, () => true)
  root.reflect.provide(
    'pluginManager',
    {
      async listPlugins() {
        return []
      },
      async setPluginEnabled() {
        return { application: 'applied' }
      },
      ...(options.manager ?? {}),
    },
    () => true,
  )
  root.reflect.provide('profileContext', { home: null, patchPath: null }, () => true)
  root.reflect.provide(
    'webServer',
    {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    () => true,
  )
  root.reflect.provide('loader', { entries: () => [] }, () => true)
  if (options.connection !== false) {
    // The management half injects the Host `connection` service; a desktop
    // host always has it, so the fixture provides one that admits everything.
    allowReprovide(root, 'connection')
    root.reflect.provide('connection', { requestRejection: () => undefined }, () => true)
  }

  const catalog = options.catalog ?? DEFAULT_CATALOG
  for (const name of catalog) registerTool(root, name)

  // Capture the nested dispatch `mcp_call` performs.
  const originalExecute = root.tools.execute.bind(root.tools)
  root.tools.execute = (input) => {
    nested.push(input)
    return originalExecute(input)
  }

  const { apply } = await import(PLUGIN_ENTRY)
  apply(root, options.config ?? {})

  const createAgent = async (id) => {
    const agent = await makeAgent(root, id)
    agents.push(agent)
    await root.events.emit('agent/created', { agent })
    return agent
  }

  const disposeAgent = async (agent) => {
    await root.events.emit('agent/disposed', { agent })
    const index = agents.indexOf(agent)
    if (index >= 0) agents.splice(index, 1)
    try {
      agent.scope?.dispose?.()
    } catch {
      // The scope is already gone.
    }
  }

  return {
    root,
    tools,
    systemPrompt,
    agents,
    routes,
    nested,
    createAgent,
    disposeAgent,
    /** What the prompt provider reads for one agent. */
    promptTools: (agent) => promptTools(root, agent),
    visibleNames: (agent) => visibleNames(root, agent),
  }
}

/**
 * Run one tool call through the real executor and return its first result.
 * @returns {Promise<{result: object, batch: object}>}
 */
export async function callTool(root, agent, name, args = {}) {
  const batch = await root.tools.execute({
    calls: [{ id: `call-${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) }],
    agent,
    signal: new AbortController().signal,
  })
  return { result: batch.results[0]?.result, batch }
}

// ---------------------------------------------------------------------------
// World 2 — a fake Cordis plugin context.
// ---------------------------------------------------------------------------

/**
 * A fake tool registry: enough of `dsh-tools` for the plugin's pure paths.
 * `schemas()` feeds `mcp_search`; `definitions()` feeds the disclosure logic.
 */
export function createFakeToolsService(initial = []) {
  const definitions = new Map()
  for (const definition of initial) definitions.set(definition.name, definition)
  return {
    schemas() {
      return [...definitions.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }))
    },
    definitions() {
      return [...definitions.values()]
    },
    get(name) {
      return definitions.get(name)
    },
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
    restrict() {
      return () => {}
    },
    async execute() {
      return { results: [] }
    },
  }
}

/**
 * Build a fake plugin context.
 *
 * The context models the Cordis surface the plugin touches. `inject()` only
 * runs its callback when every named service is present, so a plugin that
 * declares a service the environment does not provide stays inactive — the
 * same rule the real runtime applies.
 *
 * @param {object} [options]
 * @returns {object} the fake context plus its recorded side effects
 */
export function createFakeContext(options = {}) {
  const services = new Map(Object.entries(options.services ?? {}))
  const listeners = new Map()
  const disposers = []
  const logs = []
  const routes = new Map()
  const injected = []

  const tools = options.tools ?? createFakeToolsService()

  const logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
    debug: (message) => logs.push({ level: 'debug', message }),
  }

  const ctx = {
    tools,
    logger,
    get(name) {
      return services.get(name)
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    once(event, handler) {
      return ctx.on(event, handler)
    },
    async emit(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) await handler(payload)
    },
    effect(fn, label) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push({ label, disposer })
      return () => {}
    },
    inject(dependencies, callback) {
      const names = Array.isArray(dependencies) ? dependencies : Object.keys(dependencies ?? {})
      injected.push(names)
      if (!names.every((name) => services.has(name))) return { dispose() {} }
      const fiber = {
        dispose() {
          for (const entry of disposers.splice(0)) entry.disposer?.()
        },
      }
      callback(ctx)
      return fiber
    },
  }

  for (const [name, value] of services) {
    if (name === 'tools') continue
    ctx[name] = value
  }

  return { ctx, services, listeners, disposers, logs, routes, injected }
}

// ---------------------------------------------------------------------------
// World 2b — the management environment.
// ---------------------------------------------------------------------------

/** Route paths the plugin registers. */
export const MANAGEMENT_ROUTES = ['/dsh-mcp-hub/state', '/dsh-mcp-hub/toggle', '/dsh-mcp-hub/restart']

/** Default fake loader rows. */
function defaultEntries() {
  return [
    {
      id: 'include:demo',
      options: { config: { serverName: 'demo', command: 'node', args: ['server.js'], transport: 'stdio' } },
    },
  ]
}

/** Default fake plugin-manager rows. */
function defaultRows() {
  return [
    {
      entryId: 'include:demo',
      patchId: 'demo',
      moduleName: '@deepseek-ai/dsh-mcp-client',
      enabled: true,
      fiberPhase: 'active',
      toolCount: 3,
      readOnlyReason: null,
    },
  ]
}

/**
 * Build the temp fixtures and fake context for a management environment.
 *
 * The caller activates the management half afterwards: `createManagementEnv`
 * goes through `index.js`, `createManagementEnvWithOptions` registers it
 * directly with explicit Host options.
 *
 * @param {object} [options]
 * @param {object[]} [options.rows] fake `pluginManager.listPlugins()` rows
 * @param {object[]} [options.entries] fake `loader.entries()` rows
 * @param {(row: object, enabled: boolean) => any} [options.mutate] manager side effect
 * @param {object} [options.manager] extra pluginManager methods
 * @param {'allow'|'reject'|function} [options.rejection] connection admission stub
 * @param {string} [options.home] home directory (defaults to a fresh temp dir)
 * @param {string} [options.patchPath] profile patch file
 * @returns {Promise<object>} the management environment
 */
async function buildManagementEnv(options = {}) {
  const { dir: temp, remove } = await makeTempDir('dsh-mcp-harness-mgmt-')
  const home = options.home ?? path.join(temp, 'home')
  const profileDir = path.join(temp, 'profile')
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(profileDir, { recursive: true })
  const patchPath = options.patchPath ?? path.join(profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(patchPath)) await fsp.writeFile(patchPath, '[]\n', 'utf8')

  const rows = (options.rows ?? defaultRows()).map((row) => ({ ...row }))
  const calls = []
  const row = rows[0]

  const pluginManager = {
    async listPlugins() {
      return rows.map((entry) => ({ ...entry }))
    },
    async setPluginEnabled(id, enabled) {
      calls.push({ id, enabled })
      if (options.mutate) return options.mutate(row, enabled)
      row.enabled = enabled
      row.fiberPhase = enabled ? 'active' : null
      return { application: 'applied' }
    },
    ...(options.manager ?? {}),
  }

  const rejectionMode = options.rejection ?? 'allow'
  const connection = {
    requestRejection(request) {
      if (typeof rejectionMode === 'function') return rejectionMode(request)
      if (rejectionMode === 'reject') return 403
      if (rejectionMode === 'allow') return undefined
      return undefined
    },
  }

  const fake = createFakeContext({
    tools: createFakeToolsService(
      ['alpha', 'beta', 'gamma'].map((tool) => ({
        name: `mcp__demo__${tool}`,
        description: `fake MCP tool ${tool}`,
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      })),
    ),
    services: {
      pluginManager,
      loader: { entries: () => options.entries ?? defaultEntries() },
      profileContext: { home, patchPath },
      webServer: {
        register(route) {
          fake.routes.set(route.path, route.handler)
          return () => fake.routes.delete(route.path)
        },
      },
      connection,
      agents: { list: () => [] },
    },
  })

  return {
    ...fake,
    rows,
    row,
    calls,
    temp,
    home,
    patchPath,
    routes: fake.routes,
    /** Remove the temporary directory this environment owns. */
    dispose: async () => {
      await remove()
    },
  }
}

/**
 * Build the management environment and activate it through `index.js`.
 *
 * @param {object} [options] see `buildManagementEnv`
 * @returns {Promise<object>} the management environment
 */
export async function createManagementEnv(options = {}) {
  const env = await buildManagementEnv(options)
  const { apply } = await import(PLUGIN_ENTRY)
  apply(env.ctx, options.config ?? { manageServers: true })
  await flushMicrotasks()
  return env
}

/**
 * Build the management environment and register the management half directly
 * with explicit options.
 *
 * `index.js` owns the real wiring of the Host `footprint` / `loadedView`
 * callbacks; a test that needs a hand-built snapshot (or a throwing callback)
 * registers `registerServerManagement` itself, bypassing that wiring and
 * keeping the fixture independent of the Host lane.
 *
 * @param {object} [managementOptions] second argument of `registerServerManagement`
 * @param {object} [options] see `buildManagementEnv`
 * @returns {Promise<object>} the management environment
 */
export async function createManagementEnvWithOptions(managementOptions = {}, options = {}) {
  const env = await buildManagementEnv(options)
  registerServerManagement(env.ctx, managementOptions)
  await flushMicrotasks()
  return env
}

/**
 * Drive one registered route with a mock request/response pair.
 *
 * @param {object} env a management environment
 * @param {string} routePath the exact route path
 * @param {object} [options]
 * @param {string} [options.method] HTTP method
 * @param {any} [options.body] JSON body (object or raw string)
 * @param {object} [options.headers] request headers
 * @returns {Promise<{status: number|undefined, body: any, headers: object, destroyed: boolean}>}
 */
export async function request(env, routePath, options = {}) {
  const handler = env.routes.get(routePath)
  if (handler === undefined) throw new Error(`route not registered: ${routePath}`)
  const method = options.method ?? 'GET'
  const headers = { host: '127.0.0.1:53809', ...(options.headers ?? {}) }
  // A JSON body carries the JSON media type. Callers that exercise a missing or
  // different content type pass their own header explicitly.
  const declaresContentType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  if (options.body !== undefined && !declaresContentType) headers['content-type'] = 'application/json'
  const req = new EventEmitter()
  Object.assign(req, {
    headers,
    method,
    url: routePath,
    destroyed: false,
    destroy() {
      this.destroyed = true
    },
  })
  const responseHeaders = {}
  const res = {
    statusCode: undefined,
    headersSent: false,
    writeHead(status, head) {
      this.statusCode = status
      this.headersSent = true
      Object.assign(responseHeaders, head ?? {})
      return this
    },
    setHeader(name, value) {
      responseHeaders[String(name).toLowerCase()] = value
    },
    getHeader(name) {
      return responseHeaders[String(name).toLowerCase()]
    },
    getHeaders() {
      return { ...responseHeaders }
    },
    end(body) {
      this.body = body
      this.ended = true
      return this
    },
  }

  const running = handler(req, res)
  if (method !== 'GET' && method !== 'HEAD') {
    if (options.body !== undefined) {
      const raw = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      req.emit('data', Buffer.from(raw))
    }
    // A body-less request still ends: the handler's `readJsonBody` waits for it.
    req.emit('end')
  }
  await running

  let parsed = res.body
  if (typeof res.body === 'string') {
    try {
      parsed = JSON.parse(res.body)
    } catch {
      parsed = res.body
    }
  }
  return { status: res.statusCode, body: parsed, headers: responseHeaders, destroyed: req.destroyed === true }
}

// ---------------------------------------------------------------------------
// World 3 — the fake browser for client.js.
// ---------------------------------------------------------------------------

/**
 * Mount `client.js` in a fake browser.
 *
 * @param {object} [options]
 * @param {Function} [options.fetch] the fetch stub
 * @param {object} [options.locale] the locale snapshot returned by `getLocale()`
 * @param {string} [options.language] `navigator.language`
 * @returns {object} `{ render, poll, slots, unmount, flush, styles }`
 */
export function mountClientPanel(options = {}) {
  const source = fs.readFileSync(PLUGIN_CLIENT, 'utf8')
  const slots = []
  const effects = []
  const styles = []
  let cursor = 0
  let factory = null
  let intervalFn = null
  let intervalMs = null
  let panel = null

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(fn) {
      const index = cursor++
      if (!(index in slots)) slots[index] = fn
      return slots[index]
    },
    useEffect(fn) {
      const index = cursor++
      if (!(index in slots)) {
        slots[index] = true
        effects.push(fn)
      }
    },
  }

  const localeSnapshot = options.locale ?? { active: 'en' }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(module) {
          factory = module.factory
        },
      },
    },
    fetch:
      options.fetch ??
      (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, servers: [], now: 0 }),
      })),
    navigator: { language: options.language ?? 'en' },
    setInterval(fn, ms) {
      intervalFn = fn
      intervalMs = ms
      return 1
    },
    clearInterval() {
      intervalFn = null
    },
    document: {
      createElement() {
        return { dataset: {}, style: {}, textContent: '' }
      },
      head: {
        appendChild(node) {
          styles.push(node)
        },
      },
    },
    console,
  }

  vm.runInNewContext(source, sandbox, { filename: PLUGIN_CLIENT })
  if (typeof factory !== 'function') throw new Error('client.js did not register a module factory')

  const dictionaries = new Map()
  const plugin = factory(() => React)
  plugin.apply({
    effect(fn) {
      const disposer = fn()
      return () => {}
    },
    locale: {
      getLocale: () => localeSnapshot,
      register(namespace, dict) {
        dictionaries.set(namespace, dict)
      },
      bind(namespace) {
        const dict = dictionaries.get(namespace) ?? {}
        return (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key)
      },
    },
    slots: {
      inject(_slot, register) {
        register()
      },
      register(_slot, component) {
        panel = component
      },
    },
  })

  const render = () => {
    cursor = 0
    return panel({})
  }

  render()
  const cleanups = effects.map((effect) => effect())

  return {
    slots,
    styles,
    render,
    /** Run the captured poll callback once. */
    poll: () => (intervalFn === null ? undefined : intervalFn()),
    pollIntervalMs: () => intervalMs,
    /** Drain pending promises so the panel's state settles. */
    flush: async (times = 30) => {
      for (let index = 0; index < times; index += 1) await Promise.resolve()
    },
    unmount: () => {
      for (const cleanup of cleanups) cleanup?.()
    },
  }
}

/**
 * Depth-first search over a fake React element tree.
 * @returns {object|undefined} the first node matching `predicate`
 */
export function findNode(tree, predicate) {
  if (tree === null || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  for (const child of tree.children ?? []) {
    const match = findNode(child, predicate)
    if (match !== undefined) return match
  }
  return undefined
}
