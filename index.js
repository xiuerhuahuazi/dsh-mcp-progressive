/**
 * MCP progressive disclosure — Host half.
 *
 * MCP servers register one model-facing tool per remote tool (`mcp__<server>__<tool>`),
 * and every one of those schemas is sent on every request. With a few servers that is
 * tens of thousands of tokens of tool definitions that the model may never use.
 *
 * This plugin keeps the registry untouched (so connections, approvals, cancellation,
 * images and presentation keep working) and instead:
 *
 * 1. keeps unloaded `mcp__*` schemas out of each agent's registry view with a
 *    per-agent scope restriction (`agent.ctx.tools.restrict({ deny })`). dsh 0.2.2
 *    detached tool declarations from the `system-prompt/assemble` waterfall — the
 *    tools array is provider-owned and re-attached after it, so a prompt-level
 *    filter would be inert (0.1.x behaviour). A scope restriction removes the
 *    schemas from `schemas(agent)` (the exact list the prompt provider reads) and
 *    from `get`/`executable`, so hidden tools leave both the prompt and dispatch;
 * 2. loads a tool back as a scope-local registration in the same agent scope,
 *    which restrictions leave visible — so a loaded tool is a real native tool
 *    without ever re-deriving the restriction list;
 * 3. registers three tiny meta-tools:
 *      mcp_search  find tools in the hidden catalog (name, summary, signature)
 *      mcp_load    mark selected tools as loaded for this agent, so they become
 *                  ordinary native tools from the next step (and can be unloaded)
 *      mcp_call    run one hidden tool directly through the full tool pipeline
 * 4. answers a guessed-but-unregistered `mcp__*` call with a corrective message
 *    instead of a bare unknown-tool error;
 * 5. advertises the hidden catalog in one short prompt section, so the model
 *    knows it exists without every schema being sent.
 *
 * State is per live Agent (Session); unloading is explicit. Loaded tools are native:
 * they go through policy/approval/timeout/post-execute exactly like first-party tools.
 *
 * The only runtime dependency is `yaml`, used for patch-file editing; the tool
 * definitions themselves are plain `ctx.tools` registrations, so the disclosure
 * half needs nothing else from the workspace.
 *
 * The optional management half (below) also lists / starts / stops the MCP server
 * rows themselves. It is registered only when the desktop profile services exist,
 * so a headless profile keeps the disclosure half alone.
 */

import os from 'node:os'
import path from 'node:path'

import { messageOf } from './lib/util.js'
import {
  oneLine,
  compileAllowlist,
  signatureOf,
  typeLabel,
  fitSchema,
  parseName,
  rankCatalog,
  renderSearch,
  countHidden,
  MCP_SEARCH_DESCRIPTION,
  MAX_SEARCH_LIMIT,
} from './lib/search.js'
import { setPatchDisabled, patchDeclares, yamlScalar } from './lib/patch.js'
import { footprintOf } from './lib/footprint.js'
import { CACHE_VERSION, cacheFromDefinitions, mergeCatalog, pruneCache, readCache, writeCache } from './lib/toolcache.js'
import {
  registerServerManagement,
  serverStatus,
  targetSummary,
  findServer,
  createControlQueue,
  resolveToggleTarget,
  readJsonBody,
} from './lib/management.js'

/** Loader identity for this plugin. */
export const name = 'mcp-progressive'

/** Services that must exist before this plugin activates. */
export const inject = ['tools']

/** Meta-tool names; never hidden, never loadable. */
const META_TOOLS = new Set(['mcp_search', 'mcp_load', 'mcp_call'])

/**
 * Test-only injectable seams; never a plugin API and null in production.
 *
 * - `timers` lets a test drive the 1 s cache debounce and the warm-idle timers
 *   without waiting wall-clock minutes (`{ setTimeout, clearTimeout }`).
 * - `serverControl` supplies a stub for the management control object when the
 *   desktop half is absent, so the lazy-resolve path is testable through the
 *   real meta-tools without reaching into `lib/management.js`.
 */
const testHooks = { serverControl: null, timers: null }

/**
 * Configuration defaults. This bundle declares no Config schema because it is
 * installed from a linked workspace directory without resolvable dependencies;
 * every field is optional and validated defensively in `apply`.
 *
 * @typedef {object} McpLazyConfig
 * @property {string} [prefix] tool-name prefix that identifies hidden MCP tools
 * @property {string[]} [alwaysVisible] exact names or trailing-`*` prefixes never hidden
 * @property {string[]} [eagerTools] names loaded for every agent from the start
 * @property {number} [searchLimit] default search page size, 1..40
 * @property {number} [summaryChars] one-line description budget per result
 * @property {number} [catalogServers] servers named in the prompt catalog line, 1..8
 * @property {boolean} [enableLoad] register mcp_load
 * @property {boolean} [enableCall] register mcp_call
 * @property {boolean} [correctiveUnknownTool] answer unregistered mcp names with guidance
 * @property {boolean} [manageServers] register MCP server list/start/stop (tools + Plugins tab)
 * @property {string[]} [lazyConnect] servers whose row is started on first use; `['*']` = every configured server
 * @property {number} [warmIdleMs] stop a lazy server after this idle time (0 = keep warm)
 * @property {number} [lazyStartTimeoutMs] how long a lazy start may take before it fails
 * @property {number} [autoPrimeMs] let an already-running lazy row warm up this long, then stop it once (0 = off)
 * @property {string} [cachePath] cache file override (tests); empty picks `<profile>/mcp-progressive/tool-cache.json`
 */
const CONFIG_DEFAULTS = {
  prefix: 'mcp__',
  alwaysVisible: [],
  eagerTools: [],
  searchLimit: 12,
  summaryChars: 160,
  catalogServers: 4,
  enableLoad: true,
  enableCall: true,
  correctiveUnknownTool: true,
  manageServers: true,
  lazyConnect: [],
  warmIdleMs: 600000,
  lazyStartTimeoutMs: 30000,
  autoPrimeMs: 15000,
  cachePath: '',
}

/**
 * The Host plugin body.
 * @param ctx - plugin context carrying the tool registry and prompt assembly.
 * @param rawConfig - optional row configuration merged over CONFIG_DEFAULTS.
 */
export function apply(ctx, rawConfig) {
  const config = { ...CONFIG_DEFAULTS, ...(rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}) }
  const prefix = typeof config.prefix === 'string' && config.prefix.length > 0 ? config.prefix : CONFIG_DEFAULTS.prefix
  const summaryChars = Number.isFinite(config.summaryChars)
    ? Math.min(600, Math.max(24, Math.trunc(config.summaryChars)))
    : CONFIG_DEFAULTS.summaryChars
  const defaultLimit = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, Number.isFinite(config.searchLimit) ? Math.trunc(config.searchLimit) : CONFIG_DEFAULTS.searchLimit),
  )
  const catalogServers = Number.isFinite(config.catalogServers)
    ? Math.min(8, Math.max(1, Math.trunc(config.catalogServers)))
    : CONFIG_DEFAULTS.catalogServers
  /**
   * Lazy-connect configuration (v1.6 MVP / P1.1).
   *
   * A name in `lazyConnect` is expected to be configured `disabled: true`; the
   * plugin does NOT stop a running row at boot. Its cached tool metadata keeps
   * the catalog searchable, and the first `mcp_load`/`mcp_call` on one of its
   * tools asks the management half to start the row and waits for the tool.
   *
   * `['*']` applies that to every configured server, including rows added
   * later; a wildcard-configured install lets the auto-prime scanner stop rows
   * that are already running once they have warmed up (see below).
   */
  const lazyConnect = new Set(
    Array.isArray(config.lazyConnect) ? config.lazyConnect.filter((item) => typeof item === 'string' && item !== '') : [],
  )
  /** Wildcard or exact membership: the one lazy predicate used everywhere. */
  const isLazyServer = (serverName) =>
    typeof serverName === 'string' && serverName !== '' && (lazyConnect.has('*') || lazyConnect.has(serverName))
  /** 0 keeps the server warm; a positive value is clamped to 60 s .. 24 h. */
  const warmIdleMs = config.warmIdleMs === 0
    ? 0
    : Number.isFinite(config.warmIdleMs) && config.warmIdleMs > 0
      ? Math.min(86_400_000, Math.max(60_000, Math.trunc(config.warmIdleMs)))
      : CONFIG_DEFAULTS.warmIdleMs
  const lazyStartTimeoutMs = Number.isFinite(config.lazyStartTimeoutMs)
    ? Math.min(120_000, Math.max(5_000, Math.trunc(config.lazyStartTimeoutMs)))
    : CONFIG_DEFAULTS.lazyStartTimeoutMs
  /** How long an already-running lazy row warms before its one auto-primed stop. */
  const autoPrimeMs = Number.isFinite(config.autoPrimeMs)
    ? Math.min(300_000, Math.max(0, Math.trunc(config.autoPrimeMs)))
    : CONFIG_DEFAULTS.autoPrimeMs
  /**
   * Cache location: the profile's patch directory when the Host exposes it, so
   * two profiles cannot clobber each other's lazy buckets; then the profile
   * home, then DSH_HOME, then ~/.dsh. `config.cachePath` overrides everything.
   */
  let profile
  try {
    profile = ctx.get('profileContext')
  } catch {
    profile = undefined
  }
  const profileDir =
    typeof profile?.patchPath === 'string' && profile.patchPath !== ''
      ? path.dirname(profile.patchPath)
      : profile?.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const cachePath = typeof config.cachePath === 'string' && config.cachePath !== ''
    ? config.cachePath
    : path.join(profileDir, 'mcp-progressive', 'tool-cache.json')
  // Timer indirection so tests can drive the cache debounce and warm timers.
  const timers = testHooks.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  }
  const allowVisible = compileAllowlist(Array.isArray(config.alwaysVisible) ? config.alwaysVisible : [])
  const eagerTools = new Set(Array.isArray(config.eagerTools) ? config.eagerTools.filter((item) => typeof item === 'string') : [])
  const enableLoad = config.enableLoad !== false
  const enableCall = config.enableCall !== false
  const manageServers = config.manageServers !== false

  /**
   * Loaded tool names per live Agent. Keyed by object identity, not by
   * `agent.id`: the disclosure restriction is owned by the agent's own scope
   * object, so two agents that ever share an id (a raced disposal, a resumed
   * session) must never share a mask. A WeakMap also lets the registry drop
   * state with the agent instead of leaking it until an explicit event.
   */
  const loadedByAgent = new WeakMap()
  /** Assembled request payloads produced by mcp_call, keyed by its outer execution. */
  const pendingResults = new WeakMap()
  /** Monotonic correlator for nested dispatches. */
  let nestedSeq = 0
  /** Cache snapshot; only read from disk when lazy servers are configured. */
  let cache = lazyConnect.size === 0 ? { version: CACHE_VERSION, servers: {} } : readCache(cachePath)
  /** Debounced cache write handle. */
  let cacheWriteTimer
  /** Management control object (`ensureServer`/`releaseServer`) once available. */
  let serverControl = null
  /** Per lazy server: in-flight operations and the warm-idle timer. */
  const activity = new Map()
  /** Servers the auto-prime scanner already handled (one stop, or on-demand use). */
  const autoPrimed = new Set()
  /** Scheduled single auto-prime stop per server. */
  const autoPrimeStops = new Map()
  /** Recursive auto-prime scanner handle and overlap guard. */
  let autoPrimeScanTimer
  let autoPrimeScanning = false
  const AUTO_PRIME_SCAN_MS = 2000
  /** Servers whose release failure was already logged. */
  const releaseWarned = new Set()
  /** Consecutive `starting` release refusals per server. */
  const releaseRetries = new Map()
  /** A row still spawning refuses release with `starting`; retry briefly. */
  const RELEASE_RETRY_MS = 5000
  const MAX_RELEASE_RETRIES = 5

  const agentKey = (agent) => (agent === undefined || agent === null ? undefined : agent.id)

  /**
   * Whether one agent is a delegated subagent. Subagents start from a smaller
   * baseline: `eagerTools` is a root-conversation decision (it buys a stable
   * prompt for the whole session), and every subagent inheriting it pays the
   * cost again in a short-lived context. When the session metadata is not
   * available the agent is treated as a root, the pre-1.2.1 behaviour.
   */
  const isSubagent = (agent) => {
    try {
      const header = agent?.session?.header
      if (header === null || typeof header !== 'object') return false
      if (header.origin === 'subagent') return true
      return Number.isSafeInteger(header.delegationDepth) && header.delegationDepth > 0
    } catch {
      return false
    }
  }

  /** Names loaded for one agent (falls back to the configuration baseline). */
  const loadedSet = (agent) => {
    if (agentKey(agent) === undefined) return eagerTools
    let set = loadedByAgent.get(agent)
    if (set === undefined) {
      set = new Set(isSubagent(agent) ? [] : eagerTools)
      loadedByAgent.set(agent, set)
    }
    return set
  }

  /** Whether a name belongs to the hidden MCP catalog at all. */
  const isCatalogName = (toolName) =>
    typeof toolName === 'string' && toolName.startsWith(prefix) && !META_TOOLS.has(toolName)

  /**
   * Adoption verdict for one registered catalog definition.
   *
   * Fail-open where the plugin can prove it: `alwaysVisible` names are a
   * configuration promise, and a name that does not parse into
   * `<server>__<tool>` cannot be scoped to a server — both stay natively
   * visible and carry the reason for the panel.
   *
   * `taskRequired` is checked forward-compatibly, but the official
   * `@deepseek-ai/dsh-mcp-client` 0.2.2 bridge does NOT copy that flag onto the
   * definition it registers: it only reads its own `options.taskRequired`
   * inside the executor closure (`createMcpToolDefinition()` returns
   * `{name, description, parameters, output, execute, projectContent}`). In
   * production this first branch therefore does NOT fire for task-required
   * tools: they are treated like normal catalog tools and hidden. The runtime
   * test pins that limitation; if a bridge starts exposing the field, the test
   * fails and the disclosure behaviour must be updated deliberately.
   */
  const adoptionOf = (definition) => {
    if (definition.taskRequired === true) return { adopted: false, reason: 'task support required' }
    if (allowVisible(definition.name)) return { adopted: false, reason: 'always visible (config)' }
    const { server, tool } = parseName(definition.name, prefix)
    if (server === '' || tool === '') return { adopted: false, reason: 'unrecognized name shape' }
    return { adopted: true }
  }

  /** Adoption verdict for one catalog name, via a single global lookup. */
  const adoptedName = (toolName) => {
    const definition = ctx.tools.get(toolName)
    return definition === undefined ? true : adoptionOf(definition).adopted
  }

  /** Whether one schema must stay out of the assembled prompt for this agent. */
  const isHidden = (toolName, agent) =>
    isCatalogName(toolName) && adoptedName(toolName) && !loadedSet(agent).has(toolName)

  /**
   * The MCP catalog as the unrestricted global registry sees it. It must not be
   * read through the agent scope: the disclosure restriction installed for that
   * agent removes exactly these names from the scoped view.
   *
   * `definitions()` (not `schemas()`) so an eventual `taskRequired` field would
   * reach the adoption verdict; the official dsh-mcp-client 0.2.2 bridge does
   * not put that field on the definition it registers (see `adoptionOf`), so the
   * flag is effectively absent in production. The entry keeps `taskRequired`
   * for forward compatibility and as panel evidence.
   */
  const catalogOf = () => {
    let definitions
    try {
      definitions = ctx.tools.definitions()
    } catch {
      return []
    }
    const live = definitions
      .filter((definition) => isCatalogName(definition?.name))
      .map((definition) => {
        const { server, tool } = parseName(definition.name, prefix)
        const adoption = adoptionOf(definition)
        return {
          name: definition.name,
          server,
          tool,
          description: definition.description ?? '',
          parameters: definition.parameters,
          signature: signatureOf(definition.parameters),
          taskRequired: definition.taskRequired === true,
          adopted: adoption.adopted,
          adoptReason: adoption.reason,
        }
      })
    // Cached tools are search-only entries for lazy servers that are not live.
    // They carry `cached`/`lazy` and never reach the registry, deny or shadow
    // lists; live entries win per tool name (see lib/toolcache.js).
    return mergeCatalog(live, lazyCache(), prefix)
  }

  // ---------------------------------------------------------------------------
  // Disclosure: keep unloaded catalog schemas out of each agent's tool view.
  //
  // dsh >= 0.2.2 assembles tool declarations from `systemPrompt.tools()`
  // providers *before* the `system-prompt/assemble` waterfall and re-attaches
  // them afterwards, so that hook cannot remove a schema. The supported seam is
  // the registry view itself:
  //
  // 1. one scope restriction per agent (`agent.ctx.tools.restrict({ deny })`)
  //    removes every catalog tool that is not permanently visible from
  //    `schemas(agent)` — the exact list the prompt provider reads — and from
  //    `get`/`executable`;
  // 2. a loaded tool comes back as a scope-local registration in the same agent
  //    scope, which restrictions leave visible. Loaded tools are native again
  //    without re-deriving (and re-committing) the restriction list;
  // 3. `mcp_call` shadows exactly its one target definition for the nested
  //    dispatch, so no window exposes the rest of the catalog.
  //
  // The deny list only changes when the catalog changes (a server connects or
  // disconnects), which keeps the prompt's tool array stable per session.
  // ---------------------------------------------------------------------------
  /**
   * Per-agent disclosure state: the restriction and the scope-local shadows,
   * keyed by the Agent the restriction is installed for. WeakMap identity is
   * what keeps a mask attached to the scope that owns it (see `loadedByAgent`).
   */
  const disclosures = new WeakMap()
  /** Live states in creation order; a WeakMap is not iterable for teardown. */
  const liveStates = new Set()
  /** Warn at most once per (kind, Agent) instead of once per kind globally. */
  const warned = new WeakMap()
  /** Kinds already warned for agents that are not usable WeakMap keys. */
  const warnedUnkeyed = new Set()
  const warnOnce = (kind, agent, text) => {
    // Object identity, not `agent.id`: two agents that share an id must not
    // silence each other, and a disposed agent's set is collected with it.
    let kinds
    if (agent !== null && typeof agent === 'object') {
      kinds = warned.get(agent)
      if (kinds === undefined) {
        kinds = new Set()
        warned.set(agent, kinds)
      }
    } else {
      kinds = warnedUnkeyed
    }
    if (kinds.has(kind)) return
    kinds.add(kind)
    ctx.logger?.warn?.(text)
  }

  /** Catalog definitions from the unrestricted global view. */
  const catalogDefinitions = () => {
    try {
      return ctx.tools.definitions().filter((definition) => isCatalogName(definition?.name))
    } catch {
      return []
    }
  }

  /** Catalog names only. */
  const catalogNames = () => catalogDefinitions().map((definition) => definition.name)

  /** Names this agent must not see: adopted catalog tools neither loaded nor allowed. */
  const deniedNames = (agent) => new Set(catalogNames().filter((toolName) => isHidden(toolName, agent)))

  /** Own-property bucket lookup: a server named `constructor` must not read `Object`. */
  const ownBucket = (table, server) =>
    table !== null && typeof table === 'object' && Object.prototype.hasOwnProperty.call(table, server)
      ? table[server]
      : undefined

  /** Cached buckets may only serve servers the user marked lazy (all, on `*`). */
  const lazyCache = () => {
    const servers = {}
    const names = lazyConnect.has('*') ? Object.keys(cache.servers ?? {}) : [...lazyConnect]
    for (const server of names) {
      const bucket = ownBucket(cache.servers, server)
      if (bucket !== undefined) {
        Object.defineProperty(servers, server, { value: bucket, enumerable: true, configurable: true, writable: true })
      }
    }
    return { version: CACHE_VERSION, servers }
  }

  /** Names that exist only in the lazy cache (never in the live registry). */
  const cachedNames = () => {
    const names = new Set()
    for (const entry of catalogOf()) if (entry.cached === true) names.add(entry.name)
    return names
  }

  /**
   * Hidden names for `mcp_search`: the live deny set plus cache-only entries.
   * Cached names are absent from the registry, so they never enter the real
   * deny/shadow lists — this union is search bookkeeping only.
   */
  const searchHiddenNames = (agent) => {
    const hidden = deniedNames(agent)
    for (const name of cachedNames()) hidden.add(name)
    return hidden
  }

  /**
   * Persist currently live catalog definitions.
   *
   * Live buckets are rebuilt from the registry; old buckets for lazy servers
   * that are currently disconnected are copied over, so stopping a lazy row
   * does not erase its search metadata. Writes are skipped entirely when no
   * lazy server is configured (no reason to touch the profile directory).
   *
   * Limitation: a live lazy server that reconnects with ZERO tools looks the
   * same as a disconnected one here, so its previous bucket is preserved; a
   * zero-tool generation cannot clear the cache. That is deliberate — dropping
   * the bucket on a transient empty generation would erase the only metadata a
   * disabled row has.
   */
  const persistCache = () => {
    try {
      if (cacheWriteTimer !== undefined) {
        timers.clearTimeout(cacheWriteTimer)
        cacheWriteTimer = undefined
      }
      if (lazyConnect.size === 0) return
      const fresh = cacheFromDefinitions(catalogDefinitions(), prefix)
      // With `['*']` every old bucket may belong to a configured-but-disconnected
      // server; otherwise only the explicitly named lazy servers are preserved.
      const preserved = lazyConnect.has('*') ? Object.keys(cache.servers ?? {}) : [...lazyConnect]
      for (const server of preserved) {
        if (ownBucket(fresh.servers, server) === undefined) {
          const previous = ownBucket(cache.servers, server)
          if (previous !== undefined) {
            Object.defineProperty(fresh.servers, server, {
              value: previous,
              enumerable: true,
              configurable: true,
              writable: true,
            })
          }
        }
      }
      cache = fresh
      writeCache(cachePath, cache)
    } catch {
      // Cache persistence is best-effort and must never break activation or teardown.
    }
  }

  /** Debounced cache write (1 s) so a connecting server's registrations coalesce. */
  const scheduleCacheWrite = () => {
    if (lazyConnect.size === 0) return
    try {
      if (cacheWriteTimer !== undefined) timers.clearTimeout(cacheWriteTimer)
      cacheWriteTimer = timers.setTimeout(() => {
        cacheWriteTimer = undefined
        persistCache()
      }, 1000)
      cacheWriteTimer?.unref?.()
    } catch {
      // Timer failures must never break a tools/change notification.
    }
  }

  /** The agent's own Cordis scope, which may install a tool restriction. */
  const scopeFor = (agent) => {
    const scope = agent?.ctx
    return scope && typeof scope === 'object' && typeof scope.tools?.restrict === 'function' ? scope : undefined
  }

  /** Read (or create) one agent's disclosure state. */
  const stateOf = (agent) => {
    let state = disclosures.get(agent)
    if (state === undefined) {
      state = { restriction: undefined, deniedKey: undefined, masked: false, shadows: new Map(), temps: new Set() }
      disclosures.set(agent, state)
      liveStates.add(state)
    }
    return state
  }

  /** Drop every disclosure effect owned for one agent. */
  const dropDisclosure = (agent) => {
    const state = disclosures.get(agent)
    if (state === undefined) return
    disclosures.delete(agent)
    liveStates.delete(state)
    try {
      state.restriction?.()
    } catch {
      // The scope is already gone; nothing is left to lift.
    }
    for (const shadow of state.shadows.values()) {
      try {
        shadow.dispose()
      } catch {
        // Same: the owning scope is being torn down.
      }
    }
    state.shadows.clear()
    state.temps.clear()
  }

  /** Bring one agent's restriction and shadow set in line with the registry. */
  const reconcile = (agent) => {
    const key = agentKey(agent)
    if (key === undefined) return
    const scope = scopeFor(agent)
    const state = stateOf(agent)
    if (scope === undefined) {
      warnOnce('scope', agent, `mcp-progressive: agent scope unavailable for "${String(key)}"; MCP tool schemas are not hidden for that agent`)
      return
    }
    // `restrict()`/`register()` only queue the coalesced reconcile microtask, so
    // this body cannot re-enter itself (the old `mutating` flags were dead code).
    let catalogSize = 0
    try {
      const catalog = catalogDefinitions()
      catalogSize = catalog.length
      const definitions = new Map(catalog.map((definition) => [definition.name, definition]))
      const loaded = loadedSet(agent)
      // Refresh loaded shadows; a reconnected server replaces its definition.
      for (const [name, shadow] of [...state.shadows]) {
        const current = definitions.get(name)
        if (loaded.has(name) && current !== undefined && adoptionOf(current).adopted && current === shadow.definition) continue
        state.shadows.delete(name)
        try {
          shadow.dispose()
        } catch {
          // Scope already gone.
        }
      }
      for (const name of loaded) {
        // A permanently visible tool needs no shadow: the restriction never hides it.
        if (allowVisible(name)) continue
        const definition = definitions.get(name)
        if (definition === undefined || state.shadows.has(name)) continue
        // A non-adopted tool stays natively visible; a shadow would duplicate it.
        if (!adoptionOf(definition).adopted) continue
        try {
          state.shadows.set(name, { dispose: scope.tools.register(definition), definition })
        } catch (error) {
          warnOnce('shadow', agent, `mcp-progressive: could not load one MCP tool into the agent scope: ${messageOf(error)}`)
        }
      }
      // The restriction only has to deny what is safely maskable and never shown.
      const deny = catalog
        .reduce((names, definition) => {
          if (adoptionOf(definition).adopted) names.push(definition.name)
          return names
        }, [])
        .sort()
      const deniedKey = deny.join('\u0000')
      // `masked` records that a restriction is actually in force, not merely that
      // state exists: a failed install must stay retryable (the assemble safety
      // net keys off this flag, so fail-open can self-heal).
      if (!state.masked || state.restriction === undefined || state.deniedKey !== deniedKey) {
        // Install first, dispose last: restrictions intersect, so the overlap is
        // still fully masked, and a rejected `restrict()` leaves the old mask on.
        const installed = deny.length === 0 ? undefined : scope.tools.restrict({ deny })
        const previous = state.restriction
        state.restriction = installed
        state.deniedKey = deny.length === 0 ? undefined : deniedKey
        state.masked = true
        try {
          previous?.()
        } catch {
          // A stale disposer cannot keep the new restriction from applying.
        }
      }
      // The scoped view is exactly what the prompt provider reads. Loaded tools
      // (shadows) and the one transient `mcp_call` shadow are the only catalog
      // names that may appear there.
      const visible = ctx.tools.definitions(agent).reduce((names, definition) => {
        if (isCatalogName(definition?.name) && adoptionOf(definition).adopted) names.push(definition.name)
        return names
      }, [])
      const leaked = visible.filter((name) => !state.shadows.has(name) && !state.temps.has(name) && !allowVisible(name))
      if (leaked.length > 0) {
        ctx.logger?.warn?.(`mcp-progressive: ${leaked.length} MCP schema(s) stay visible for one agent: ${leaked.slice(0, 3).join(', ')}`)
      }
    } catch (error) {
      // Never let disclosure bookkeeping break agent creation or a tools/change
      // notification. Clear `masked` so the next assemble retries instead of
      // trusting state that was never installed.
      state.masked = false
      ctx.logger?.warn?.(
        `mcp-progressive: disclosure reconcile failed for agent "${String(key)}" with ${catalogSize} catalog tool(s): ${messageOf(error)}`,
      )
    }
  }

  /**
   * Live agents, or `null` when the agent list cannot be read.
   *
   * Callers that must not act on an unknown set (warm release, loaded view)
   * treat `null` as "unreadable" and fail closed instead of as "no agents".
   */
  const liveAgents = () => {
    try {
      const service = ctx.get('agents')
      // Missing service is an unknown live view, not an empty one: the warm
      // timer must fail closed rather than free a server that may still be in use.
      if (service === undefined || service === null) return null
      const list = typeof service.list === 'function' ? service.list() : undefined
      return Array.isArray(list) ? list : null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Lazy sessions: start on first use, stop after idle.
  //
  // Best effort: the warm timer is suppressed while a tool is loaded by a live
  // agent or an operation is in flight. A release already requested can still
  // land after a new call starts — there is deliberately no cross-layer lock.
  // `loadedByAgent.get` never creates state.
  // ---------------------------------------------------------------------------
  const activityOf = (server) => {
    let entry = activity.get(server)
    if (entry === undefined) {
      entry = { activeCalls: 0, timer: undefined }
      activity.set(server, entry)
    }
    return entry
  }

  const clearWarmTimer = (server) => {
    const entry = activity.get(server)
    if (entry === undefined || entry.timer === undefined) return
    try {
      timers.clearTimeout(entry.timer)
    } catch {
      // A stale timer handle is harmless.
    }
    entry.timer = undefined
  }

  /** Whether any live agent still has a loaded tool from this server. */
  const serverHasLoadedTool = (server) => {
    try {
      const agents = liveAgents()
      // Fail closed: an unreadable live view must never look like "nothing loaded".
      if (agents === null) return true
      for (const agent of agents) {
        if (agent === null || typeof agent !== 'object') continue
        const loaded = loadedByAgent.get(agent)
        if (loaded === undefined) continue
        for (const name of loaded) {
          if (isCatalogName(name) && parseName(name, prefix).server === server) return true
        }
      }
    } catch {
      // Same: never stop a server under an unreadable live view.
      return true
    }
    return false
  }

  const warnRelease = (server, error) => {
    if (releaseWarned.has(server)) return
    releaseWarned.add(server)
    ctx.logger?.warn?.(`mcp-progressive: could not release lazy MCP server "${server}": ${messageOf(error)}`)
  }

  /** Re-arm the idle timer as a short retry after a `starting` refusal. */
  const scheduleReleaseRetry = (server) => {
    const entry = activityOf(server)
    clearWarmTimer(server)
    entry.timer = timers.setTimeout(() => {
      entry.timer = undefined
      releaseLazy(server)
    }, RELEASE_RETRY_MS)
    entry.timer?.unref?.()
  }

  /** Ask the management half to stop one lazy row; failures are logged once. */
  const releaseLazy = (server) => {
    if (serverControl === null || typeof serverControl.releaseServer !== 'function') return
    const report = (result) => {
      if (result !== null && typeof result === 'object' && result.ok === true) {
        releaseRetries.delete(server)
        return
      }
      const reason = result !== null && typeof result === 'object' && typeof result.reason === 'string' ? result.reason : 'failed'
      // The 1.4 start valve refuses while the row is still spawning; retry a few
      // times instead of leaving the row warm forever.
      if (reason === 'starting') {
        const attempts = (releaseRetries.get(server) ?? 0) + 1
        if (attempts <= MAX_RELEASE_RETRIES) {
          releaseRetries.set(server, attempts)
          scheduleReleaseRetry(server)
          return
        }
        releaseRetries.delete(server)
        warnRelease(server, new Error('still starting after retries'))
        return
      }
      // Expected refusals, not failures: the row is in use, not lazy, unknown
      // (e.g. after a failed start), or the row was disabled meanwhile.
      if (reason === 'in-use' || reason === 'not-lazy' || reason === 'unknown-server') return
      releaseRetries.delete(server)
      warnRelease(server, new Error(typeof result?.message === 'string' ? result.message : reason))
    }
    try {
      const result = serverControl.releaseServer(server)
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.then(report, (error) => warnRelease(server, error))
      } else {
        report(result)
      }
    } catch (error) {
      warnRelease(server, error)
    }
  }

  const scheduleWarm = (server) => {
    if (warmIdleMs === 0) return
    const entry = activityOf(server)
    clearWarmTimer(server)
    entry.timer = timers.setTimeout(() => {
      entry.timer = undefined
      if (entry.activeCalls > 0) return
      // Loaded tools keep the server warm on purpose; `mcp_load` with
      // `unload:true` re-arms a timer once the last tool is released.
      if (serverHasLoadedTool(server)) return
      releaseLazy(server)
    }, warmIdleMs)
    entry.timer?.unref?.()
  }

  /** Mark an operation in flight; suppresses the warm-idle release. */
  const beginActivity = (server) => {
    const entry = activityOf(server)
    entry.activeCalls += 1
    clearWarmTimer(server)
  }

  /**
   * Mark an operation finished. `warm` arms the idle timer — including after a
   * failed ensure, because the row may still have been started (e.g. timeout).
   */
  const endActivity = (server, warm) => {
    const entry = activityOf(server)
    entry.activeCalls = Math.max(0, entry.activeCalls - 1)
    if (entry.activeCalls > 0) return
    if (warm) scheduleWarm(server)
    else clearWarmTimer(server)
  }

  // ---------------------------------------------------------------------------
  // Auto-prime (P1.1): make every configured MCP lazy without manual stops.
  //
  // The scanner only OBSERVES rows that are already enabled: it never starts
  // anything. A row that is running (or spawning) when first seen gets one
  // stop after `autoPrimeMs`, with the tool cache persisted just before the
  // stop so the row stays searchable while disabled. On-demand starts mark the
  // server handled, so their warm-idle timer owns the stop instead.
  //
  // Boundary: a server added already disabled has no registered tools to
  // observe/cache; it only becomes searchable after its first on-demand start.
  // ---------------------------------------------------------------------------
  const clearAutoPrimeStop = (server) => {
    const handle = autoPrimeStops.get(server)
    if (handle === undefined) return
    try {
      timers.clearTimeout(handle)
    } catch {
      // A stale handle is harmless.
    }
    autoPrimeStops.delete(server)
  }

  /** Persist the warm row's tools, then stop it once unless it is in use. */
  const autoPrimeStop = async (server) => {
    autoPrimeStops.delete(server)
    try {
      // Cache first: the tools exist only while the row is running.
      persistCache()
      const entry = activity.get(server)
      if (entry !== undefined && entry.activeCalls > 0) return
      if (serverHasLoadedTool(server)) return
      if (serverControl === null || typeof serverControl.releaseServer !== 'function') return
      try {
        await serverControl.releaseServer(server)
      } catch {
        // Best effort; marked handled so the scanner will not loop on it.
      }
    } catch {
      // An auto-prime timer must never throw into the event loop.
    }
  }

  /** Schedule the one auto-primed stop for a server the scanner just observed. */
  const armAutoPrimeStop = (server) => {
    autoPrimed.add(server)
    clearAutoPrimeStop(server)
    if (autoPrimeMs === 0) return
    const handle = timers.setTimeout(() => {
      void autoPrimeStop(server)
    }, autoPrimeMs)
    handle?.unref?.()
    autoPrimeStops.set(server, handle)
  }

  /** One observer pass: prune vanished servers, stop newly seen lazy rows once. */
  const scanAutoPrime = async () => {
    if (autoPrimeScanning || autoPrimeMs === 0) return
    const control = serverControl
    if (control === null || typeof control.listServers !== 'function') return
    autoPrimeScanning = true
    try {
      let rows
      try {
        rows = await control.listServers()
      } catch {
        rows = null
      }
      // A failed scan changes nothing: no prune, no priming.
      if (!Array.isArray(rows)) return
      const known = new Set()
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        if (typeof row.serverName === 'string' && row.serverName !== '') known.add(row.serverName)
      }
      // Prune unconfigured buckets only after the control answered.
      const pruned = pruneCache(cache, known)
      const before = Object.keys(cache.servers ?? {}).sort().join('\u0000')
      const after = Object.keys(pruned.servers).sort().join('\u0000')
      if (before !== after) {
        cache = pruned
        persistCache()
      }
      // Forget handled names that are no longer configured, so a removal plus a
      // later re-add primes again.
      for (const name of [...autoPrimed]) {
        if (!known.has(name)) autoPrimed.delete(name)
      }
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const server = row.serverName
        if (typeof server !== 'string' || server === '') continue
        if (!isLazyServer(server)) continue
        if (row.status !== 'running' && row.status !== 'starting') continue
        if (autoPrimed.has(server)) continue
        armAutoPrimeStop(server)
      }
    } finally {
      autoPrimeScanning = false
      scheduleAutoPrimeScan()
    }
  }

  /** Chain the next observer pass, only while a control with `listServers` exists. */
  const scheduleAutoPrimeScan = (delay = AUTO_PRIME_SCAN_MS) => {
    if (autoPrimeMs === 0 || lazyConnect.size === 0) return
    if (serverControl === null || typeof serverControl.listServers !== 'function') return
    if (autoPrimeScanTimer !== undefined) {
      try {
        timers.clearTimeout(autoPrimeScanTimer)
      } catch {
        // Replacing a stale handle is safe.
      }
    }
    autoPrimeScanTimer = timers.setTimeout(() => {
      autoPrimeScanTimer = undefined
      void scanAutoPrime()
    }, delay)
    autoPrimeScanTimer?.unref?.()
  }

  /** Idempotent scanner start (management may activate after `apply`). */
  const startAutoPrimeScanner = () => {
    if (autoPrimeMs === 0 || lazyConnect.size === 0) return
    if (autoPrimeScanTimer !== undefined) return
    scheduleAutoPrimeScan()
  }

  /**
   * Start one lazy server and wait for the requested tool.
   *
   * Codes against the management contract only:
   * `ensureServer(serverName, { toolName, timeoutMs })`. That API never throws:
   * it answers `{ok:true, started}` or
   * `{ok:false, reason:'timeout'|'failed'|'not-lazy'|'unknown-server', message?}`,
   * and the real reason must reach the model (a generic "not registered" would
   * hide a timeout). A throw is still tolerated for hand-built stubs.
   */
  const ensureLazyServer = async (server, toolName) => {
    // On-demand start: the warm-idle timer owns the stop from here, so the
    // auto-prime scanner must not schedule a second one.
    autoPrimed.add(server)
    clearAutoPrimeStop(server)
    if (serverControl === null || typeof serverControl.ensureServer !== 'function') {
      return { ok: false, reason: 'lazy server needs the desktop management half' }
    }
    try {
      const result = await serverControl.ensureServer(server, { toolName, timeoutMs: lazyStartTimeoutMs })
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        const reason = result?.message ?? result?.reason ?? 'could not start its lazy MCP server'
        return { ok: false, reason: String(reason) }
      }
      return { ok: true, started: result.started === true }
    } catch (error) {
      return { ok: false, reason: `could not start its lazy MCP server: ${messageOf(error)}` }
    }
  }

  /** Ensure one cached entry is live, with activity bookkeeping around the start. */
  const resolveLazyEntry = async (entry, toolName) => {
    const server = entry.server
    beginActivity(server)
    let warm = false
    try {
      const resolution = await ensureLazyServer(server, toolName)
      // A failed ensure may still have enabled the row (e.g. `timeout` after a
      // successful start whose tool never registered). Arm the idle timer on
      // every attempt; releasing a never-started row is a harmless no-op.
      warm = true
      return resolution
    } finally {
      endActivity(server, warm)
    }
  }

  const reconcileAll = () => {
    const agents = liveAgents()
    if (agents === null) return
    for (const agent of agents) reconcile(agent)
  }

  /**
   * Coalesce registry notifications: a connecting MCP server registers one tool
   * at a time, and each registration would otherwise drop/reinstall every
   * agent's mask. One microtask later all of them are handled once.
   */
  let reconcileScheduled = false
  const scheduleReconcileAll = () => {
    if (reconcileScheduled) return
    reconcileScheduled = true
    queueMicrotask(() => {
      reconcileScheduled = false
      reconcileAll()
    })
  }

  ctx.on('agent/created', ({ agent }) => {
    reconcile(agent)
    return undefined
  })
  ctx.on('tools/change', () => {
    scheduleReconcileAll()
    scheduleCacheWrite()
  })
  // Safety net for a step of an agent without a mask in force (plugin loaded
  // mid-Session, an agent whose creation raced activation, or a reconcile that
  // failed to install). `masked` — not "state exists" — is the test, so a
  // fail-open reconcile is retried here. The provider has already collected
  // this assembly's schemas, so this covers the next step; nothing here may
  // fail a model request.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    try {
      const agent = context?.scope ?? context?.agent
      if (agentKey(agent) !== undefined && disclosures.get(agent)?.masked !== true) reconcile(agent)
    } catch {
      // Disclosure bookkeeping must never break prompt assembly.
    }
    return next()
  })
  ctx.effect(
    () => () => {
      for (const state of [...liveStates]) {
        try {
          state.restriction?.()
        } catch {
          // The scope is already gone; nothing is left to lift.
        }
        for (const shadow of state.shadows.values()) {
          try {
            shadow.dispose()
          } catch {
            // Same: the owning scope is being torn down.
          }
        }
        state.shadows.clear()
        state.temps.clear()
      }
      liveStates.clear()
    },
    'mcp-progressive: disclosure restrictions',
  )
  // Lazy sessions own two kinds of timer; both must be dropped on teardown, and
  // the last cache snapshot is flushed synchronously (best effort, never throws).
  ctx.effect(
    () => () => {
      try {
        if (autoPrimeScanTimer !== undefined) timers.clearTimeout(autoPrimeScanTimer)
        autoPrimeScanTimer = undefined
        for (const handle of autoPrimeStops.values()) timers.clearTimeout(handle)
        autoPrimeStops.clear()
        autoPrimed.clear()
        for (const entry of activity.values()) {
          if (entry.timer !== undefined) timers.clearTimeout(entry.timer)
          entry.timer = undefined
        }
        activity.clear()
        releaseRetries.clear()
        persistCache()
      } catch {
        // Teardown must not fail because the cache directory went away.
      }
    },
    'mcp-progressive: lazy sessions and tool cache',
  )
  // Agents that already existed when this plugin activated (HMR, resume).
  reconcileAll()

  // ---------------------------------------------------------------------------
  // Corrective answer for a tool the model called directly: not loaded yet, or
  // loaded by mcp_load earlier in the SAME step (the step's admission set was
  // resolved before the load, so dispatch would fail as unknown tool).
  // ---------------------------------------------------------------------------
  if (config.correctiveUnknownTool !== false) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (typeof exec?.name !== 'string' || !isCatalogName(exec.name)) return await next()
        const agent = exec.agent
        const visible = ctx.tools.get(exec.name, agent) !== undefined
        if (visible) {
          if (exec.toolSet !== undefined && exec.toolSet.view(agent).get(exec.name) === undefined) {
            return {
              kind: 'deny',
              reason:
                `MCP tool "${exec.name}" was loaded in this step; call it in the next step — ` +
                'do not batch mcp_load with the call.',
            }
          }
          return await next()
        }
        const globallyRegistered = ctx.tools.get(exec.name) !== undefined
        return {
          kind: 'deny',
          reason: globallyRegistered
            ? `MCP tool "${exec.name}" is registered but not loaded in this conversation. ` +
              (enableCall ? 'Use mcp_call with this name.' : enableLoad ? 'Use mcp_load with this name.' : 'Loading and direct dispatch are disabled.')
            : `MCP tool "${exec.name}" is not in this MCP catalog right now (MCP tools register when a server connects). ` +
              'Call mcp_search to find the right tool name.',
        }
      } catch {
        return await next()
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Approval gate for model-facing MCP server writes. The three browser routes
  // stay ungated on purpose: a human clicking in the panel is the consent.
  // ---------------------------------------------------------------------------
  if (manageServers) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (exec?.name !== 'mcp_server') return await next()
        const action = exec.arguments?.action
        if (action !== 'start' && action !== 'stop' && action !== 'restart') return await next()
        const server = typeof exec.arguments?.server === 'string' && exec.arguments.server !== ''
          ? exec.arguments.server
          : 'the target server'
        const verb = action === 'stop' ? 'Stop' : action === 'restart' ? 'Restart' : 'Start'
        const zhVerb = action === 'stop' ? '停止' : action === 'restart' ? '重启' : '启动'
        return {
          kind: 'ask',
          reason: `mcp_server will ${action} MCP server "${server}", changing which MCP tools exist for every session.`,
          // `PreToolDecision.ask.displayReason` is a locale record resolved by
          // `locale.resolveText` (`en` required, other locales fall back to
          // it), so ship English and Chinese rather than a bare string.
          displayReason: {
            en: `${verb} MCP server "${server}"?`,
            zh: `${zhVerb} MCP 服务器「${server}」？`,
          },
        }
      } catch {
        return await next()
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Per-agent state cleanup.
  // ---------------------------------------------------------------------------
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      if (agentKey(agent) === undefined) return
      loadedByAgent.delete(agent)
      dropDisclosure(agent)
    } catch {
      // Cleanup is best-effort; a malformed payload must not disturb disposal.
    }
  })

  // ---------------------------------------------------------------------------
  // Meta tools.
  // ---------------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'mcp_search',
      description: MCP_SEARCH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Words to match against tool names and descriptions. Empty lists the connected servers and their tool counts.',
          },
          server: { type: 'string', description: 'Only search tools from this MCP server name.' },
          limit: { type: 'integer', description: `Maximum matches to return (1-${MAX_SEARCH_LIMIT}); defaults to the configured page size.` },
          detail: {
            type: 'string',
            enum: ['brief', 'full'],
            description: 'brief (default) prints summaries and signatures; full also prints the input schema of up to two matches.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const query = typeof args?.query === 'string' ? args.query.trim() : ''
          const server = typeof args?.server === 'string' && args.server.trim() !== '' ? args.server.trim() : undefined
          const requested = Number.isFinite(args?.limit) ? Math.trunc(args.limit) : defaultLimit
          const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, requested))
          const detail = args?.detail === 'full' ? 'full' : 'brief'
          const catalog = catalogOf()
          const result = rankCatalog(catalog, { query, server, limit })
          // The hidden count shares the searched scope with its denominator, so a
          // `server` filter cannot produce "201 of 170". Non-adopted tools are
          // natively visible, so they are never part of this set; cache-only lazy
          // entries are added because they are searchable but not in the toolset.
          const hiddenNames = searchHiddenNames(exec.agent)
          const hiddenCount = countHidden(result.availableNames, hiddenNames)
          // Keep the kept-visible line in the same scope as the search: a
          // `server` filter must not report another server's visible tools.
          const availableNames = new Set(result.availableNames)
          const notAdopted = catalog
            .filter((entry) => !entry.adopted && availableNames.has(entry.name))
            .map((entry) => ({ name: entry.name, reason: entry.adoptReason }))
          return renderSearch(result, {
            summaryChars,
            detail,
            loadedNames: loadedSet(exec.agent),
            hiddenNames,
            hiddenCount,
            notAdopted,
            prefix,
          })
        } catch (error) {
          return `Error: mcp_search failed internally: ${messageOf(error)}`
        }
      },
    }),
  )

  if (enableLoad) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'mcp_load',
        description:
          'Load hidden tools for sustained reuse; call them natively from the next step. Keep them loaded across pauses in this task. ' +
          'Unload when finished with them; omit tools to list loaded names.',
        parameters: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exact catalog names (for example mcp__server__tool).',
            },
            unload: { type: 'boolean', description: 'true removes the named tools instead of loading them.' },
          },
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const agent = exec.agent
          const loaded = loadedSet(agent)
          const names = Array.isArray(args?.tools) ? args.tools.filter((item) => typeof item === 'string') : []
          const unload = args?.unload === true

          if (names.length === 0) {
            const current = [...loaded].filter((toolName) => isCatalogName(toolName))
            if (current.length === 0) {
              return 'No MCP tools are loaded for this conversation. Use mcp_search to find tools, then pass their names here.'
            }
            return `Currently loaded (${current.length}): ${current.join(', ')}`
          }

          const catalog = new Map(catalogOf().map((entry) => [entry.name, entry]))
          const state = disclosures.get(agent)
          /** Whether a loaded name is actually visible (not just booked). */
          const visible = (toolName) => allowVisible(toolName) || state?.shadows.has(toolName) === true
          const accepted = []
          const rejected = []
          const unloadedServers = new Set()
          const loadedServers = new Set()
          let searchHint = false
          for (const toolName of names) {
            if (!isCatalogName(toolName)) {
              rejected.push(`${toolName} (not an MCP tool)`)
              searchHint = true
              continue
            }
            let entry = catalog.get(toolName)
            if (entry === undefined) {
              rejected.push(`${toolName} (not in the current MCP catalog)`)
              searchHint = true
              continue
            }
            // Cache-only entry: start its lazy row, wait for the tool, then read
            // the live definition. The name is booked only after it is live.
            if (!unload && entry.cached === true) {
              if (!isLazyServer(entry.server)) {
                rejected.push(`${toolName} (cached tool is not on a lazyConnect server)`)
                continue
              }
              const resolution = await resolveLazyEntry(entry, toolName)
              if (!resolution.ok) {
                rejected.push(`${toolName} (${resolution.reason})`)
                continue
              }
              const live = catalogOf().find((candidate) => candidate.name === toolName)
              if (live === undefined || live.cached === true) {
                rejected.push(`${toolName} (did not register after the lazy server started)`)
                continue
              }
              entry = live
            }
            // Fail-open adoption: a task-required / always-visible / malformed
            // tool is already native, so "loading" it would be a lie.
            if (!unload && !entry.adopted) {
              rejected.push(`${toolName} (already visible: ${entry.adoptReason}; call it directly)`)
              continue
            }
            if (unload) {
              if (loaded.delete(toolName)) {
                accepted.push(toolName)
                unloadedServers.add(parseName(toolName, prefix).server)
              } else {
                rejected.push(`${toolName} (was not loaded)`)
              }
            } else if (loaded.has(toolName)) {
              // Already booked: say whether it is actually native right now. A
              // missing shadow happens when its registration failed, and unload
              // then load is the only way to retry it.
              rejected.push(
                visible(toolName)
                  ? `${toolName} (already loaded: it is a native tool in this conversation; call it directly)`
                  : `${toolName} (already loaded but not visible in this conversation; pass it with unload:true, then load it again)`,
              )
            } else {
              loaded.add(toolName)
              accepted.push(toolName)
              loadedServers.add(parseName(toolName, prefix).server)
            }
          }

          // Re-derive this agent's restriction now, so the change is in force for
          // the next prompt assembly instead of one step later.
          if (accepted.length > 0) reconcile(agent)
          // A warm timer that fired while a tool was loaded deliberately skipped
          // its release; unloading re-arms it so the server can still stop.
          for (const server of unloadedServers) {
            if (isLazyServer(server)) scheduleWarm(server)
          }
          // Loading from a lazy server is activity too (idle time restarts).
          for (const server of loadedServers) {
            if (isLazyServer(server)) scheduleWarm(server)
          }

          const lines = []
          if (accepted.length > 0) {
            lines.push(
              unload
                ? `Unloaded ${accepted.length} tool(s): ${accepted.join(', ')}. They leave your tool set from the next step.`
                : `Loaded ${accepted.length} tool(s): ${accepted.join(', ')}. They are native tools from your next step; call them directly.`,
            )
          }
          if (rejected.length > 0) lines.push(`Skipped: ${rejected.join('; ')}`)
          if (accepted.length === 0 && searchHint) {
            lines.push('Use mcp_search to confirm exact tool names.')
          }
          return lines.join('\n')
        },
      }),
    )
  }

  /** One-line in-result audit trail for the nested dispatch (no session event). */
  const auditLine = (toolName, callArguments) => {
    const keys = Object.keys(callArguments ?? {})
    return `(audit: dispatched ${toolName}; argument keys: ${keys.length > 0 ? keys.join(', ') : 'none'})`
  }

  /** Text blocks of one MCP result, joined the way the caller sees them. */
  const contentText = (content) =>
    (Array.isArray(content) ? content : [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')

  /**
   * Guidance for a PTC refusal. The PTC executor answers a direct nested call
   * with an error RESULT ("only run_code is callable directly"), not a throw,
   * so both the result text and a thrown message are checked.
   */
  const ptcRefusalGuidance = (toolName, text) => {
    if (typeof text !== 'string' || !/run_code/.test(text)) return undefined
    return (
      'Error: this agent runs in PTC mode, where mcp_call cannot dispatch a tool directly. ' +
      `Use mcp_load for ${toolName}, then call it inside run_code.`
    )
  }

  if (enableCall) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'mcp_call',
        description:
          'Run one MCP tool directly without loading it, through the normal permission, timeout and result pipeline. ' +
          'Prefer this for one-off calls or short tasks when the exact name and arguments are known; no search or load needed.',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Exact catalog name (for example mcp__server__tool).' },
            arguments: {
              type: 'object',
              additionalProperties: true,
              description: 'JSON arguments for the MCP tool, matching the schema or signature that mcp_search detail:"full" prints.',
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const toolName = typeof args?.tool === 'string' ? args.tool.trim() : ''
          if (toolName === '') return 'Error: mcp_call requires the exact "tool" name; use mcp_search to find it.'
          if (!isCatalogName(toolName)) {
            return `Error: "${toolName}" is not an MCP tool. Use mcp_search to find the tool name.`
          }
          let definition = ctx.tools.get(toolName)
          let lazyServer = null
          let lazyActive = false
          if (definition === undefined) {
            // A cache-only entry: start its lazy row and wait for the real tool
            // before dispatching. Activity stays marked until the call settles.
            const cached = catalogOf().find((entry) => entry.name === toolName && entry.cached === true)
            if (cached !== undefined) {
              if (!isLazyServer(cached.server)) {
                return `Error: "${toolName}" is only cached for a server not in lazyConnect; it cannot be started.`
              }
              lazyServer = cached.server
              beginActivity(lazyServer)
              lazyActive = true
              const resolution = await ensureLazyServer(lazyServer, toolName)
              if (!resolution.ok) {
                // The failed ensure may still have started the row; arm the idle
                // timer so a timed-out start cannot run forever.
                endActivity(lazyServer, true)
                return `Error: "${toolName}" cannot be called: ${resolution.reason}.`
              }
              definition = ctx.tools.get(toolName)
              if (definition === undefined) {
                endActivity(lazyServer, true)
                return `Error: "${toolName}" did not register after its lazy server started; mcp_search again after it connects.`
              }
            }
          }
          if (definition === undefined) {
            return `Error: "${toolName}" is not in the current MCP catalog. Use mcp_search to find the right name.`
          }
          const callArguments =
            args?.arguments !== null && typeof args?.arguments === 'object' && !Array.isArray(args.arguments)
              ? args.arguments
              : {}
          nestedSeq += 1
          const callId = `${String(exec.callId)}:mcp-progressive:${nestedSeq}`
          // A scope-local registration is exempt from the disclosure restriction,
          // so shadowing exactly this one definition admits it for the nested
          // dispatch (and for nothing else) without lifting the mask. A target
          // that is already visible (alwaysVisible or non-adopted) is never
          // restricted, so it needs no shadow.
          const scope = scopeFor(exec.agent)
          const state = disclosures.get(exec.agent)
          const alreadyShadowed = state?.shadows.has(toolName) === true
          const needsShadow = scope !== undefined && !alreadyShadowed && isHidden(toolName, exec.agent)
          let shadow
          if (needsShadow) {
            try {
              shadow = scope.tools.register(definition)
              state?.temps.add(toolName)
            } catch (error) {
              warnOnce('call-shadow', exec.agent, `mcp-progressive: mcp_call could not shadow its target: ${messageOf(error)}`)
            }
          }
          // The nested dispatch is a real tool call, but it must not append
          // session events: a surface `tool/result` for a call that no assistant
          // message declares leaves an orphan tool message in
          // `session.deriveMessages()`, and the DeepSeek adapter rejects that on
          // the next request (INVALID_REQUEST "tool result has no matching
          // call"). The audit trail is the in-result line instead.
          const audit = auditLine(toolName, callArguments)
          const withAudit = (text) => `${text}\n${audit}`
          // A live tool from a lazy server still counts as activity: mark the
          // call before dispatch so the warm timer is suppressed for its length.
          // Best effort: a release already requested can still land later.
          if (!lazyActive && isLazyServer(parseName(toolName, prefix).server)) {
            lazyServer = parseName(toolName, prefix).server
            beginActivity(lazyServer)
            lazyActive = true
          }
          let batch
          try {
            batch = await ctx.tools.execute({
              calls: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(callArguments) }],
              signal: exec.signal,
              agent: exec.agent,
            })
          } catch (error) {
            const refusal = ptcRefusalGuidance(toolName, messageOf(error))
            if (refusal !== undefined) return withAudit(refusal)
            throw error
          } finally {
            try {
              shadow?.()
            } catch {
              // The calling scope is already gone.
            }
            state?.temps.delete(toolName)
            if (lazyActive) {
              endActivity(lazyServer, true)
              lazyActive = false
            }
          }
          const outcome = Array.isArray(batch?.results) ? batch.results[0]?.result : undefined
          if (outcome === undefined) {
            return withAudit(`Error: MCP tool "${toolName}" produced no result.`)
          }
          // Deferred context belongs to the nested batch; forward it to the caller
          // on both success and failure.
          if (Array.isArray(batch?.additionalContexts)) {
            for (const context of batch.additionalContexts) exec.deferContext(context)
          }
          if (batch?.concluded === true) exec.concludeTurn()
          const content = Array.isArray(outcome.content) ? outcome.content : []
          if (outcome.isError === true) {
            const text = contentText(content).trim()
            const message = typeof outcome.error?.message === 'string' ? outcome.error.message : ''
            const refusal = ptcRefusalGuidance(toolName, text !== '' ? text : message)
            if (refusal !== undefined) return withAudit(refusal)
            // Return the MCP error as readable text instead of a bare thrown
            // message: the content blocks carry the server's own explanation.
            // The native executor wraps a thrown tool message as "Error: <message>";
            // when the content is exactly that wrapper, the message alone is the
            // server's text. `outcome.meta` (presentation) has no seam here — a
            // tool's `meta` can only come from its own output.presentationMeta, so
            // the outer mcp_call card keeps the text rendering.
            const detail = text === '' ? (message !== '' ? message : 'no error message') : (text === `Error: ${message}` ? message : text)
            return withAudit(`Error from MCP tool "${toolName}": ${detail}`)
          }
          // Only project when the nested call produced a payload worth showing:
          // real text or at least one image block. An empty OR whitespace-only
          // result keeps the returned fallback string + audit line as the outer
          // content, so the "no output" sentence is not dropped by the
          // projection (F12).
          const text = contentText(content)
          const imageCount = content.filter((block) => block?.type === 'image').length
          if (text.trim() !== '' || imageCount > 0) pendingResults.set(exec, { content, audit })
          if (text.trim() !== '') return withAudit(text)
          return withAudit(
            imageCount > 0 ? `(${toolName} returned ${imageCount} image(s).)` : `(${toolName} completed with no output.)`,
          )
        },
        // Replace the text fallback with the exact blocks the MCP tool produced,
        // preserving images and their admission-owned attachment references. An
        // in-result audit line is appended as one extra text block so it survives
        // the projection.
        projectContent(exec, result) {
          const pending = pendingResults.get(exec)
          if (pending === undefined) return undefined
          pendingResults.delete(exec)
          if (result?.isError === true) return undefined
          return [...pending.content, { type: 'text', text: pending.audit }]
        },
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Catalog discoverability: one short prompt section so the model knows the
  // hidden catalog exists at all. `text` recomputes per assembly from the
  // global catalog, and an empty catalog contributes nothing. This section is
  // placed just before the platform's own MCP_SERVERS section.
  // ---------------------------------------------------------------------------
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'mcp-progressive:catalog',
      order: 3050,
      text: () => {
        const counts = new Map()
        for (const entry of catalogOf()) {
          // Kept-visible (not adopted) tools are already native, so advertising
          // them as "not loaded by default" would be false.
          if (!entry.adopted) continue
          counts.set(entry.server, (counts.get(entry.server) ?? 0) + 1)
        }
        if (counts.size === 0) return ''
        const servers = [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))
        const shown = servers.slice(0, catalogServers).map(([server, count]) => `${server} (${count} tool${count === 1 ? '' : 's'})`)
        const more = servers.length > shown.length ? `, +${servers.length - shown.length} more` : ''
        return `MCP catalog: ${shown.join(', ')}${more}; not loaded by default — mcp_search to find one.`
      },
    })
  })

  // ---------------------------------------------------------------------------
  // Optional management half: list / start / stop MCP server rows.
  // The dependency scope stays inactive (and costs nothing) on hosts that do
  // not provide the desktop profile services. `connection` is part of the list
  // on purpose: the routes are fenced by Connection's trust check, so a host
  // that had webServer without Connection must not expose them at all.
  // ---------------------------------------------------------------------------
  if (manageServers) {
    ctx.inject(['pluginManager', 'profileContext', 'webServer', 'loader', 'connection'], (managementCtx) => {
      // Read-only seams for the panel. `lib/management.js` stays independent of
      // this module's catalog/adoption rules: it only consumes the argument.
      // The management half returns the lazy control object
      // `{ ensureServer(server, {toolName, timeoutMs}), releaseServer(server) }`.
      const control = registerServerManagement(managementCtx, {
        lazyConnect: [...lazyConnect],
        warmIdleMs,
        lazyStartTimeoutMs,
        autoPrimeMs,
        footprint(agent) {
          try {
            const entries = catalogOf()
            const hidden = new Set(entries.filter((entry) => isHidden(entry.name, agent)).map((entry) => entry.name))
            const loaded = new Set(entries.filter((entry) => loadedSet(agent).has(entry.name)).map((entry) => entry.name))
            const footprint = footprintOf(entries, { hiddenNames: hidden, loadedNames: loaded })
            footprint.total.notAdopted = entries
              .filter((entry) => !entry.adopted)
              .map((entry) => ({ name: entry.name, reason: entry.adoptReason }))
            return footprint
          } catch {
            return {
              total: { tools: 0, hiddenTools: 0, hiddenTokens: 0, hiddenChars: 0, loadedTools: 0, notAdopted: [] },
              byServer: {},
            }
          }
        },
        loadedView() {
          try {
            const live = liveAgents()
            // Signal an unreadable agent list instead of an empty (safe-looking)
            // one; management treats it as in-use while deciding a release.
            if (live === null) return { agents: [], unreadable: true }
            const agents = []
            for (const agent of live) {
              if (agent === null || typeof agent !== 'object') continue
              const loaded = loadedByAgent.get(agent)
              if (loaded === undefined) continue
              const names = [...loaded].filter((name) => isCatalogName(name)).sort()
              if (names.length === 0) continue
              agents.push({
                id: String(agent.id ?? ''),
                title: typeof agent.session?.header?.title === 'string' ? agent.session.header.title : null,
                delegationDepth: Number.isSafeInteger(agent.session?.header?.delegationDepth)
                  ? agent.session.header.delegationDepth
                  : 0,
                loaded: names,
              })
            }
            return { agents }
          } catch {
            return { agents: [], unreadable: true }
          }
        },
      })
      if (control !== undefined && control !== null) serverControl = control
      // Test-only override wins so lazy tests never depend on the real panel half.
      if (testHooks.serverControl !== null) serverControl = testHooks.serverControl
      // Management may activate after `apply`; start the observer chain here too.
      startAutoPrimeScanner()
    })
  }

  // Starts only when lazy servers are configured, a control exists and
  // autoPrimeMs > 0; otherwise it is a no-op and no timer is armed.
  startAutoPrimeScanner()

  ctx.logger?.info?.(
    `mcp-progressive: hiding "${prefix}*" tool schemas with a per-agent scope restriction; meta-tools ${['mcp_search', enableLoad ? 'mcp_load' : '', enableCall ? 'mcp_call' : '']
      .filter(Boolean)
      .join(', ')}${manageServers ? '; MCP server management enabled' : ''}`,
  )
}

/** Pure helpers exported for the local test harness (not a plugin API). */
export const __test = {
  testHooks,
  setPatchDisabled,
  patchDeclares,
  serverStatus,
  targetSummary,
  yamlScalar,
  oneLine,
  compileAllowlist,
  signatureOf,
  typeLabel,
  fitSchema,
  findServer,
  createControlQueue,
  resolveToggleTarget,
  messageOf,
  readJsonBody,
}
