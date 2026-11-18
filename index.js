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
 * No npm dependencies: tools are plain definitions registered on `ctx.tools`,
 * which also means the bundle is installable from a linked workspace directory.
 *
 * The optional management half (below) also lists / starts / stops the MCP server
 * rows themselves. It is registered only when the desktop profile services exist,
 * so a headless profile keeps the disclosure half alone.
 */

import { messageOf } from './lib/util.js'
import { oneLine, compileAllowlist, signatureOf, typeLabel, fitSchema, MAX_DETAIL_CHARS } from './lib/search.js'
import { setPatchDisabled, patchDeclares, yamlScalar } from './lib/patch.js'
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

/** Hard cap for one search page, independent of configuration. */
const MAX_SEARCH_LIMIT = 40

/** Hard cap for full-schema detail pages. */
const MAX_DETAIL_TOOLS = 2

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
 * @property {boolean} [enableLoad] register mcp_load
 * @property {boolean} [enableCall] register mcp_call
 * @property {boolean} [correctiveUnknownTool] answer unregistered mcp names with guidance
 * @property {boolean} [manageServers] register MCP server list/start/stop (tools + Plugins tab)
 */
const CONFIG_DEFAULTS = {
  prefix: 'mcp__',
  alwaysVisible: [],
  eagerTools: [],
  searchLimit: 12,
  summaryChars: 160,
  enableLoad: true,
  enableCall: true,
  correctiveUnknownTool: true,
  manageServers: true,
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

  /** Whether one schema must stay out of the assembled prompt for this agent. */
  const isHidden = (toolName, agent) =>
    isCatalogName(toolName) && !allowVisible(toolName) && !loadedSet(agent).has(toolName)

  /** Split `mcp__<server>__<tool>` into its parts. */
  const parseName = (toolName) => {
    const rest = toolName.slice(prefix.length)
    const separator = rest.indexOf('__')
    if (separator <= 0) return { server: rest, tool: '' }
    return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) }
  }

  /**
   * The MCP catalog as the unrestricted global registry sees it. It must not be
   * read through the agent scope: the disclosure restriction installed for that
   * agent removes exactly these names from the scoped view.
   */
  const catalogOf = () =>
    ctx.tools
      .schemas()
      .filter((schema) => isCatalogName(schema.name))
      .map((schema) => {
        const { server, tool } = parseName(schema.name)
        return {
          name: schema.name,
          server,
          tool,
          description: schema.description ?? '',
          parameters: schema.parameters,
          signature: signatureOf(schema.parameters),
        }
      })

  /** Score one catalog entry against lowercased query tokens. */
  const scoreEntry = (entry, tokens, query) => {
    if (tokens.length === 0) return 0
    const name = entry.name.toLowerCase()
    const short = entry.tool.toLowerCase()
    const description = String(entry.description).toLowerCase()
    let score = 0
    if (query.length > 0 && name === query) score += 1000
    if (query.length > 0 && short === query) score += 900
    for (const token of tokens) {
      let hit = 0
      if (short === token) hit = 60
      else if (short.startsWith(token)) hit = 40
      else if (short.includes(token)) hit = 30
      else if (name.includes(token)) hit = 20
      else if (entry.server.toLowerCase().includes(token)) hit = 12
      else if (description.includes(token)) hit = 8
      if (hit === 0) return 0
      score += hit
    }
    return score
  }

  /** Rank the catalog for one query. */
  const searchCatalog = (query, server, limit) => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const entries = catalogOf().filter((entry) => server === undefined || entry.server === server)
    const ranked = []
    for (const entry of entries) {
      const score = scoreEntry(entry, tokens, query.toLowerCase())
      if (tokens.length > 0 && score === 0) continue
      ranked.push({ entry, score })
    }
    ranked.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    return {
      entries: ranked.slice(0, limit).map((item) => item.entry),
      matched: ranked.length,
      servers: summarizeServers(entries),
      available: entries.length,
    }
  }

  /** Server names with tool counts, stable order. */
  const summarizeServers = (entries) => {
    const counts = new Map()
    for (const entry of entries) counts.set(entry.server, (counts.get(entry.server) ?? 0) + 1)
    return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))
  }

  /** Render one search result as compact text. */
  const renderSearch = (result, { query, detail, agent }) => {
    const lines = []
    if (result.servers.length === 0) {
      return (
        'No MCP tools are registered right now. Check that the MCP server rows are connected and enabled; ' +
        'when a server reconnects its tools become searchable again.'
      )
    }
    lines.push(`MCP servers: ${result.servers.map(([server, count]) => `${server} (${count} tools)`).join(', ')}`)
    const hiddenCount = deniedNames(agent).length
    if (hiddenCount > 0) lines.push(`Hidden until loaded: ${hiddenCount} of ${result.available} tools (not in your tool set).`)
    const emptyQuery = query.trim() === ''
    if (result.entries.length === 0) {
      lines.push(`No tool matched "${query}".`)
    } else if (emptyQuery) {
      lines.push(`Showing ${result.entries.length} of ${result.available} tools (pass query words or server to narrow):`)
    } else {
      lines.push(`Matches ${result.matched} of ${result.available}:`)
    }
    if (result.entries.length > 0) {
      for (const entry of result.entries) {
        const signature = entry.signature ? `(${entry.signature})` : '()'
        const summary = oneLine(entry.description, summaryChars)
        const marker = loadedSet(agent).has(entry.name) ? ' [loaded]' : ''
        lines.push(`- ${entry.name}${signature}${marker}${summary ? ` — ${summary}` : ''}`)
      }
      if (!emptyQuery && result.matched > result.entries.length) {
        lines.push(`(${result.matched - result.entries.length} more not shown; narrow the query or raise limit up to ${MAX_SEARCH_LIMIT}.)`)
      }
      if (detail === 'full') {
        const detailed = result.entries.slice(0, MAX_DETAIL_TOOLS)
        for (const entry of detailed) {
          const fitted = fitSchema(entry.parameters, MAX_DETAIL_CHARS)
          lines.push(`schema for ${entry.name}${fitted.truncated ? ' (annotations trimmed to fit)' : ''}:`)
          lines.push(fitted.text)
        }
        if (result.entries.length > detailed.length) {
          lines.push(`(full schemas shown for the first ${MAX_DETAIL_TOOLS} matches only.)`)
        }
      } else if (emptyQuery) {
        lines.push(
          `${enableLoad ? 'mcp_load makes tools native; ' : ''}mcp_call runs one directly without loading.`,
        )
      } else {
        lines.push(
          `detail:"full" shows input schemas. ${enableLoad ? 'mcp_load adds tools as native tools; ' : ''}mcp_call runs one without loading.`,
        )
      }
    }
    return lines.join('\n')
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
  /** Warn at most once per (kind, agent) instead of once per kind globally. */
  const warned = new Set()
  const warnOnce = (kind, agent, text) => {
    const key = `${kind}:${String(agentKey(agent))}`
    if (warned.has(key)) return
    warned.add(key)
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

  /** Names this agent must not see: catalog tools neither loaded nor allowed. */
  const deniedNames = (agent) => catalogNames().filter((toolName) => isHidden(toolName, agent))

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
        if (loaded.has(name) && current !== undefined && current === shadow.definition) continue
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
        try {
          state.shadows.set(name, { dispose: scope.tools.register(definition), definition })
        } catch (error) {
          warnOnce('shadow', agent, `mcp-progressive: could not load one MCP tool into the agent scope: ${messageOf(error)}`)
        }
      }
      // The restriction only has to deny what configuration never shows.
      const deny = catalog
        .reduce((names, definition) => {
          if (!allowVisible(definition.name)) names.push(definition.name)
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
        if (isCatalogName(definition?.name)) names.push(definition.name)
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

  const liveAgents = () => {
    try {
      return ctx.get('agents')?.list?.() ?? []
    } catch {
      return []
    }
  }

  const reconcileAll = () => {
    for (const agent of liveAgents()) reconcile(agent)
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
  ctx.on('tools/change', scheduleReconcileAll)
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
              'Call mcp_search to find it, then mcp_load it (or mcp_call it directly).'
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
        return {
          kind: 'ask',
          reason: `mcp_server will ${action} MCP server "${server}", changing which MCP tools exist for every session.`,
          displayReason: `${action === 'stop' ? 'Stop' : action === 'restart' ? 'Restart' : 'Start'} MCP server "${server}"?`,
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
      description:
        'Search the MCP tool catalog. MCP tools are not listed in your tool set to save context, so search before using one. ' +
        'Returns each match\'s full tool name, a one-line summary, and its parameter signature; detail:"full" adds the input schema. ' +
        'Then call mcp_load to make matches native tools, or mcp_call to run one directly.',
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
          const result = searchCatalog(query, server, limit)
          return renderSearch(result, { query, detail, agent: exec.agent })
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
          'Load MCP tools into this conversation so they become native tools (available from your next step), or unload them again. ' +
          'Use after mcp_search when you plan to call a tool more than once; for a single call prefer mcp_call. ' +
          'Call with no tools to list what is currently loaded.',
        parameters: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exact MCP tool names from mcp_search results (for example mcp__server__tool).',
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

          const known = new Set(catalogOf().map((entry) => entry.name))
          const state = disclosures.get(agent)
          /** Whether a loaded name is actually visible (not just booked). */
          const visible = (toolName) => allowVisible(toolName) || state?.shadows.has(toolName) === true
          const accepted = []
          const rejected = []
          let searchHint = false
          for (const toolName of names) {
            if (!isCatalogName(toolName)) {
              rejected.push(`${toolName} (not an MCP tool)`)
              searchHint = true
              continue
            }
            if (!known.has(toolName)) {
              rejected.push(`${toolName} (not in the current MCP catalog)`)
              searchHint = true
              continue
            }
            if (unload) {
              if (loaded.delete(toolName)) accepted.push(toolName)
              else rejected.push(`${toolName} (was not loaded)`)
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
            }
          }

          // Re-derive this agent's restriction now, so the change is in force for
          // the next prompt assembly instead of one step later.
          if (accepted.length > 0) reconcile(agent)

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

  /**
   * The current `{ turn, step }` of one agent, when its session log exposes an
   * open step (the last event between `step/start` and `step/end`). Nested
   * `ctx.tools.execute` needs this to record its own `tool/call`/`tool/result`.
   * Absent session internals are not an error: the caller falls back to an
   * in-result audit line.
   */
  const currentStep = (agent) => {
    try {
      const log = agent?.session?.log
      if (!Array.isArray(log)) return undefined
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const event = log[index]
        if (event?.type === 'step/end') return undefined
        if (event?.type !== 'step/start') continue
        const turn = event.data?.turn
        const step = event.data?.step
        if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return undefined
        return { turn, step }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /** One-line audit trail for a nested call whose step cannot be logged. */
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
          'Prefer this for one-off calls; use mcp_load when you will call the same tool repeatedly. ' +
          'The tool must appear in mcp_search results.',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Exact MCP tool name from mcp_search results (for example mcp__server__tool).' },
            arguments: {
              type: 'object',
              additionalProperties: true,
              description: 'JSON arguments for the MCP tool, matching the schema that mcp_search detail:"full" prints.',
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
          const definition = ctx.tools.get(toolName)
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
          // dispatch (and for nothing else) without lifting the mask. An
          // alwaysVisible target is never restricted, so it needs no shadow.
          const scope = scopeFor(exec.agent)
          const state = disclosures.get(exec.agent)
          const alreadyShadowed = state?.shadows.has(toolName) === true
          const needsShadow = scope !== undefined && !alreadyShadowed && !allowVisible(toolName)
          let shadow
          if (needsShadow) {
            try {
              shadow = scope.tools.register(definition)
              state?.temps.add(toolName)
            } catch (error) {
              warnOnce('call-shadow', exec.agent, `mcp-progressive: mcp_call could not shadow its target: ${messageOf(error)}`)
            }
          }
          // The nested dispatch is a real tool call; record it like one when the
          // session's current step is readable. Otherwise the transcript only
          // shows the outer mcp_call, so at least describe the target in the result.
          const log = currentStep(exec.agent)
          const audit = log === undefined ? auditLine(toolName, callArguments) : undefined
          const withAudit = (text) => (audit === undefined ? text : `${text}\n${audit}`)
          let batch
          try {
            batch = await ctx.tools.execute({
              calls: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(callArguments) }],
              signal: exec.signal,
              agent: exec.agent,
              ...(log === undefined ? {} : { log }),
            })
          } catch (error) {
            const refusal = ptcRefusalGuidance(toolName, messageOf(error))
            if (refusal !== undefined) return refusal
            throw error
          } finally {
            try {
              shadow?.()
            } catch {
              // The calling scope is already gone.
            }
            state?.temps.delete(toolName)
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
            if (refusal !== undefined) return refusal
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
          if (content.length > 0 || audit !== undefined) pendingResults.set(exec, { content, audit })
          const text = contentText(content)
          if (text.trim() !== '') return withAudit(text)
          const imageCount = content.filter((block) => block?.type === 'image').length
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
          const blocks = pending.audit === undefined ? [] : [{ type: 'text', text: pending.audit }]
          if (pending.content.length === 0) return blocks.length > 0 ? blocks : undefined
          return blocks.length > 0 ? [...pending.content, ...blocks] : pending.content
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
        for (const entry of catalogOf()) counts.set(entry.server, (counts.get(entry.server) ?? 0) + 1)
        if (counts.size === 0) return ''
        const servers = [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))
        const shown = servers.slice(0, 4).map(([server, count]) => `${server} (${count} tool${count === 1 ? '' : 's'})`)
        const more = servers.length > shown.length ? `, +${servers.length - shown.length} more` : ''
        return `MCP catalog: ${shown.join(', ')}${more}; not loaded by default — mcp_search to find one.`
      },
    })
  })

  // ---------------------------------------------------------------------------
  // Optional management half: list / start / stop MCP server rows.
  // The dependency scope stays inactive (and costs nothing) on hosts that do
  // not provide the desktop profile services.
  // ---------------------------------------------------------------------------
  if (manageServers) {
    ctx.inject(['pluginManager', 'profileContext', 'webServer', 'loader'], (managementCtx) => {
      registerServerManagement(managementCtx)
    })
  }

  ctx.logger?.info?.(
    `mcp-progressive: hiding "${prefix}*" tool schemas with a per-agent scope restriction; meta-tools ${['mcp_search', enableLoad ? 'mcp_load' : '', enableCall ? 'mcp_call' : '']
      .filter(Boolean)
      .join(', ')}${manageServers ? '; MCP server management enabled' : ''}`,
  )
}

/** Pure helpers exported for the local test harness (not a plugin API). */
export const __test = {
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
