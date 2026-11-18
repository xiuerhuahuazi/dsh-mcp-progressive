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
 *    instead of a bare unknown-tool error.
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

  /** Loaded tool names per live agent id; absent = only the eager baseline. */
  const loadedByAgent = new Map()
  /** Assembled request payloads produced by mcp_call, keyed by its outer execution. */
  const pendingContent = new WeakMap()
  /** Monotonic correlator for nested dispatches. */
  let nestedSeq = 0

  const agentKey = (agent) => (agent === undefined || agent === null ? undefined : agent.id)

  /** Names loaded for one agent (falls back to the configuration baseline). */
  const loadedSet = (agent) => {
    const key = agentKey(agent)
    if (key === undefined) return eagerTools
    let set = loadedByAgent.get(key)
    if (set === undefined) {
      set = new Set(eagerTools)
      loadedByAgent.set(key, set)
    }
    return set
  }

  /** Whether a name belongs to the hidden MCP catalog at all. */
  const isCatalogName = (toolName) =>
    typeof toolName === 'string' && toolName.startsWith(prefix) && !META_TOOLS.has(toolName)

  /** Whether one schema must stay out of the assembled prompt for this agent. */
  const isHidden = (toolName, agent) =>
    isCatalogName(toolName) && !allowVisible(toolName) && !loadedSet(agent).has(toolName)

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
        const { server, tool } = parseName(schema.name, prefix)
        return {
          name: schema.name,
          server,
          tool,
          description: schema.description ?? '',
          parameters: schema.parameters,
          signature: signatureOf(schema.parameters),
        }
      })

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
  /** Per-agent disclosure state: the restriction and the scope-local shadows. */
  const disclosures = new Map()
  /** `restrict()`/`register()` emit `tools/change`; do not re-enter it. */
  let mutating = false
  /** A reconcile asked for while `mutating`; replayed after the mutation. */
  let reconcilePending = false
  /** Warn at most once per kind instead of once per agent. */
  const warned = new Set()
  const warnOnce = (kind, text) => {
    if (warned.has(kind)) return
    warned.add(kind)
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
  const stateOf = (key) => {
    let state = disclosures.get(key)
    if (state === undefined) {
      state = { restriction: undefined, deniedKey: undefined, shadows: new Map(), temps: new Set() }
      disclosures.set(key, state)
    }
    return state
  }

  /** Drop every disclosure effect owned for one agent. */
  const dropDisclosure = (key) => {
    const state = disclosures.get(key)
    if (state === undefined) return
    disclosures.delete(key)
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
    if (mutating) {
      reconcilePending = true
      return
    }
    const scope = scopeFor(agent)
    if (scope === undefined) {
      warnOnce('scope', 'mcp-progressive: agent scope unavailable; MCP tool schemas are not hidden for that agent')
      return
    }
    mutating = true
    reconcilePending = false
    try {
      const state = stateOf(key)
      const catalog = catalogDefinitions()
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
          warnOnce('shadow', `mcp-progressive: could not load one MCP tool into the agent scope: ${messageOf(error)}`)
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
      if (state.restriction === undefined || state.deniedKey !== deniedKey) {
        // Install first, dispose last: restrictions intersect, so the overlap is
        // still fully masked, and a rejected `restrict()` leaves the old mask on.
        const installed = deny.length === 0 ? undefined : scope.tools.restrict({ deny })
        const previous = state.restriction
        state.restriction = installed
        state.deniedKey = deny.length === 0 ? undefined : deniedKey
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
      // notification; the next reconcile retries.
      ctx.logger?.warn?.(`mcp-progressive: disclosure reconcile failed: ${messageOf(error)}`)
    } finally {
      mutating = false
      if (reconcilePending) {
        reconcilePending = false
        queueMicrotask(() => reconcile(agent))
      }
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
  // Safety net for a step of an agent this instance has not reconciled yet
  // (plugin loaded mid-Session, or an agent whose creation raced activation).
  // The provider has already collected this assembly's schemas, so this covers
  // the next step; nothing here may fail a model request.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    try {
      const key = agentKey(context?.scope)
      if (key !== undefined && !disclosures.has(key)) reconcile(context.scope)
    } catch {
      // Disclosure bookkeeping must never break prompt assembly.
    }
    return next()
  })
  ctx.effect(
    () => () => {
      for (const key of [...disclosures.keys()]) dropDisclosure(key)
    },
    'mcp-progressive: disclosure restrictions',
  )
  // Agents that already existed when this plugin activated (HMR, resume).
  reconcileAll()

  // ---------------------------------------------------------------------------
  // Corrective answer for hallucinated MCP tool names.
  // ---------------------------------------------------------------------------
  if (config.correctiveUnknownTool !== false) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (typeof exec?.name !== 'string' || !isCatalogName(exec.name)) return await next()
        if (ctx.tools.get(exec.name, exec.agent) !== undefined) return await next()
        return {
          kind: 'deny',
          reason:
            `MCP tool "${exec.name}" is not registered on this Harness (MCP tools are discovered at runtime). ` +
            'Call mcp_search to find the right tool, then mcp_load or mcp_call.',
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
      const key = agentKey(payload?.agent)
      if (key === undefined) return
      loadedByAgent.delete(key)
      dropDisclosure(key)
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
          const result = rankCatalog(catalogOf(), { query, server, limit })
          // The hidden count shares the searched scope with its denominator, so a
          // `server` filter cannot produce "201 of 170".
          const hiddenCount = countHidden(result.availableNames, deniedNames(exec.agent))
          return renderSearch(result, {
            summaryChars,
            detail,
            loadedNames: loadedSet(exec.agent),
            hiddenCount,
            enableLoad,
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
          const accepted = []
          const rejected = []
          for (const toolName of names) {
            if (!isCatalogName(toolName)) {
              rejected.push(`${toolName} (not an MCP tool)`)
              continue
            }
            if (!known.has(toolName)) {
              rejected.push(`${toolName} (not in the current MCP catalog)`)
              continue
            }
            if (unload) {
              if (loaded.delete(toolName)) accepted.push(toolName)
              else rejected.push(`${toolName} (was not loaded)`)
            } else if (loaded.has(toolName)) {
              rejected.push(`${toolName} (already loaded)`)
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
          if (accepted.length === 0 && rejected.length > 0) {
            lines.push('Use mcp_search to confirm exact tool names.')
          }
          return lines.join('\n')
        },
      }),
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
          // dispatch (and for nothing else) without lifting the mask.
          const scope = scopeFor(exec.agent)
          const state = disclosures.get(agentKey(exec.agent))
          const alreadyShadowed = state?.shadows.has(toolName) === true
          let shadow
          if (scope !== undefined && !alreadyShadowed) {
            try {
              shadow = scope.tools.register(definition)
              state?.temps.add(toolName)
            } catch (error) {
              warnOnce('call-shadow', `mcp-progressive: mcp_call could not shadow its target: ${messageOf(error)}`)
            }
          }
          let batch
          try {
            batch = await ctx.tools.execute({
              calls: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(callArguments) }],
              signal: exec.signal,
              agent: exec.agent,
            })
          } catch (error) {
            const message = messageOf(error)
            // The PTC preset only allows `run_code` at the top level; a nested raw
            // batch is rejected there, so say what works instead of failing raw.
            if (/run_code/.test(message)) {
              return (
                'Error: this agent runs in PTC mode, where mcp_call cannot dispatch a tool directly. ' +
                `Use mcp_load for ${toolName}, then call it inside run_code.`
              )
            }
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
            return `Error: MCP tool "${toolName}" produced no result.`
          }
          if (outcome.isError === true) {
            throw new Error(outcome.error?.message ?? `MCP tool "${toolName}" failed`)
          }
          // Deferred context belongs to the nested batch; forward it to the caller.
          if (Array.isArray(batch?.additionalContexts)) {
            for (const context of batch.additionalContexts) exec.deferContext(context)
          }
          if (batch?.concluded === true) exec.concludeTurn()
          const content = Array.isArray(outcome.content) ? outcome.content : []
          if (content.length > 0) pendingContent.set(exec, content)
          const text = content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
          if (text.trim() !== '') return text
          const imageCount = content.filter((block) => block?.type === 'image').length
          return imageCount > 0 ? `(${toolName} returned ${imageCount} image(s).)` : `(${toolName} completed with no output.)`
        },
        // Replace the text fallback with the exact blocks the MCP tool produced,
        // preserving images and their admission-owned attachment references.
        projectContent(exec, result) {
          const content = pendingContent.get(exec)
          if (content === undefined) return undefined
          pendingContent.delete(exec)
          if (result?.isError === true) return undefined
          return content
        },
      }),
    )
  }

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
