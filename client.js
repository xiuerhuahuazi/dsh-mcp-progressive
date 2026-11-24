/**
 * MCP progressive disclosure + server manager — Client half.
 *
 * Adds one tab ("MCP servers") to the Plugins page. The panel copies the host's
 * own management-list pattern (the Plugins page "installed" cards): a group head,
 * 48px icon tiles, 14px card titles, 13px descriptions, a status tag and a switch,
 * with a small restart icon button.
 *
 * Styling rules (DSH plugin guidance): theme tokens only (--dsw-*), no Harness
 * client package imports, scoped class names, light/dark handled by the tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mcp-progressive',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STATE_URL = '/dsh-mcp-hub/state'
    const TOGGLE_URL = '/dsh-mcp-hub/toggle'
    const RESTART_URL = '/dsh-mcp-hub/restart'
    const POLL_MS = 2500
    // A request that never settles must not wedge the panel: every request is
    // aborted at this deadline so the next poll can try again.
    const REQUEST_TIMEOUT_MS = 10_000
    const NS = 'dshMcpServers'
    // One agent line lists at most this many tools, then "+N more".
    const LOADED_NAME_LIMIT = 12

    const DICT = {
      en: {
        tabTitle: 'MCP servers',
        title: 'MCP servers',
        description: 'Start, stop or restart the MCP servers configured for this profile. The choice is persisted (profile patch, or the home patch for home-inserted rows) and applies to every session.',
        countUnit: 'servers',
        toolsUnit: 'tools',
        lazy: 'lazy',
        empty: 'No MCP servers are configured for this profile.',
        loading: 'Loading MCP servers…',
        failure: 'Could not load MCP servers',
        timeout: 'The request timed out',
        retry: 'Retry',
        restart: 'Restart',
        start: 'Start',
        stop: 'Stop',
        starting: 'Starting…',
        stopping: 'Stopping…',
        restarting: 'Restarting…',
        switchLabel: 'MCP server availability',
        'disclosure.summary': 'By default: {hidden} hidden ≈ {tokens} tokens · {loaded} loaded in this window',
        'disclosure.loadedAgents': 'Loaded in this window ({count} tools)',
        'disclosure.kept': 'Kept visible: {reason} ({count})',
        'card.hidden': '{hidden} hidden by default ≈ {tokens} tokens',
        'filter.label': 'Filter by status',
        'filter.all': 'All',
        'filter.empty': 'No servers match this filter.',
        'batch.stop': 'Stop shown',
        'batch.restart': 'Restart shown',
        'batch.done': 'Done: {applied} applied, {failed} failed, {skipped} skipped',
        'hazard.starting': 'Wait for the server to finish starting before stopping or restarting it',
        'action.done': 'Done',
        'action.restartRequired': 'Saved — restart DeepSeek Harness to apply',
        'action.overridden': 'Saved, but a higher-priority layer overrides it',
        'action.failed': 'The change was not applied',
        'status.running': 'running',
        'status.stopped': 'stopped',
        'status.idle': 'connected, no tools',
        'status.starting': 'starting',
        'status.reconnecting': 'reconnecting (attempt {attempt}/{maxAttempts})',
        'status.reconnectingNoAttempt': 'reconnecting',
        'status.waitingCredentials': 'waiting for credentials',
        'status.stopping': 'stopping',
        'status.error': 'error',
        'status.unknown': 'unknown',
        tagTitle: 'status: {label} — {detail}',
        tagTitlePlain: 'status: {label}',
        retryIn: 'retry in {seconds}s',
        'live.failed': 'failed',
      },
      zh: {
        tabTitle: 'MCP 服务器',
        title: 'MCP 服务器',
        description: '启动、停止或重启当前 profile 配置的 MCP 服务器；选择会持久化（profile 补丁；home 层插入的行写入 home 补丁）并对所有会话生效。',
        countUnit: '个',
        toolsUnit: '个工具',
        lazy: '按需',
        empty: '当前 profile 没有配置 MCP 服务器。',
        loading: '正在加载 MCP 服务器…',
        failure: '无法加载 MCP 服务器',
        timeout: '请求超时',
        retry: '重试',
        restart: '重启',
        start: '启动',
        stop: '停止',
        starting: '启动中…',
        stopping: '停止中…',
        restarting: '重启中…',
        switchLabel: 'MCP 服务器可用性',
        'disclosure.summary': '默认隐藏 {hidden} 个 ≈ {tokens} tokens · 本窗口已加载 {loaded} 个',
        'disclosure.loadedAgents': '本窗口已加载（{count} 个工具）',
        'disclosure.kept': '保持可见：{reason}（{count}）',
        'card.hidden': '默认隐藏 {hidden} 个 ≈ {tokens} tokens',
        'filter.label': '按状态筛选',
        'filter.all': '全部',
        'filter.empty': '没有符合筛选条件的服务器。',
        'batch.stop': '停止当前列表',
        'batch.restart': '重启当前列表',
        'batch.done': '完成：{applied} 个已应用，{failed} 个失败，{skipped} 个跳过',
        'hazard.starting': '启动完成后再停止或重启',
        'action.done': '已完成',
        'action.restartRequired': '已保存，需重启 DeepSeek Harness 后生效',
        'action.overridden': '已保存，但被更高优先级的层覆盖',
        'action.failed': '修改未生效',
        'status.running': '运行中',
        'status.stopped': '已停止',
        'status.idle': '已连接（无工具）',
        'status.starting': '启动中',
        'status.reconnecting': '重连中（第 {attempt}/{maxAttempts} 次）',
        'status.reconnectingNoAttempt': '重连中',
        'status.waitingCredentials': '等待凭据',
        'status.stopping': '停止中',
        'status.error': '错误',
        'status.unknown': '未知',
        tagTitle: '状态：{label} — {detail}',
        tagTitlePlain: '状态：{label}',
        retryIn: '{seconds} 秒后重试',
        'live.failed': '失败',
      },
    }

    const CSS = `
.dsh-mcp{display:flex;flex-direction:column;gap:32px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}
.dsh-mcp-group{display:flex;flex-direction:column;gap:8px}
.dsh-mcp-group-head{display:flex;align-items:center;gap:8px}
.dsh-mcp-group-title{flex:1;margin:0;font-size:14px;font-weight:500;line-height:22px}
.dsh-mcp-group-info{display:inline-flex;align-items:center;margin-left:8px;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);font-weight:400;vertical-align:baseline}
.dsh-mcp-intro{margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.dsh-mcp-cards{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dsh-mcp-card{min-width:0;margin:0 -8px;border-radius:var(--dsw-radius-xl)}
.dsh-mcp-card-head{display:flex;align-items:center;gap:14px;padding:8px}
.dsh-mcp-card-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:48px;height:48px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-secondary)}
.dsh-mcp-card-main{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.dsh-mcp-title-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.dsh-mcp-card-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;font-weight:500;line-height:20px}
.dsh-mcp-card[data-state=stopped] .dsh-mcp-card-title{color:var(--dsw-alias-label-secondary)}
.dsh-mcp-tag{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 8px;border-radius:999px;corner-shape:round;font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
.dsh-mcp-tag[data-tone=success]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-tag[data-tone=warning]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-mcp-tag[data-tone=danger]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-mcp-tag[data-tone=neutral]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dsh-mcp-card-desc{display:-webkit-box;overflow:hidden;-webkit-line-clamp:1;-webkit-box-orient:vertical;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:18px}
.dsh-mcp-card-detail{display:-webkit-box;overflow:hidden;-webkit-line-clamp:1;-webkit-box-orient:vertical;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);line-height:16px;overflow-wrap:anywhere}
.dsh-mcp-card-end{position:relative;z-index:1;display:inline-flex;flex:none;align-items:center;gap:8px}
.dsh-mcp-icon-btn{position:relative;box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease}
.dsh-mcp-icon-btn::after{content:'';position:absolute;inset:-2px;border-radius:inherit}
.dsh-mcp-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-icon-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dsh-mcp-icon-btn:disabled{cursor:not-allowed;opacity:.4}
.dsh-mcp-switch{position:relative;box-sizing:border-box;display:inline-flex;flex:none;align-items:center;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .12s ease}
.dsh-mcp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-mcp-switch:disabled{cursor:not-allowed;opacity:.5}
.dsh-mcp-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform .12s ease,background .12s ease}
.dsh-mcp-switch[aria-checked=true] .dsh-mcp-switch-thumb{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground)}
.dsh-mcp-icon-btn:focus-visible,.dsh-mcp-switch:focus-visible,.dsh-mcp-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-mcp-empty{margin:0;padding:4px 0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.dsh-mcp-failure{display:flex;align-items:flex-start;gap:12px;margin:0;padding:10px 12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.dsh-mcp-failure-text{flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-mcp-action{margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);overflow-wrap:anywhere}
.dsh-mcp-action:not(:empty){padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.dsh-mcp-action[data-tone=error]:not(:empty){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-mcp-disclosure{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.dsh-mcp-disclosure-summary{margin:0;color:var(--dsw-alias-label-primary)}
.dsh-mcp-disclosure-loaded{margin:0}
.dsh-mcp-disclosure-loaded summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-disclosure-agent{margin:4px 0 0;overflow-wrap:anywhere}
.dsh-mcp-disclosure-kept{margin:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-mcp-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-mcp-filter{box-sizing:border-box;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.dsh-mcp-filter:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-mcp-btn{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer}
.dsh-mcp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dsh-mcp-btn:disabled{cursor:not-allowed;opacity:.4}
.dsh-mcp-skeleton{display:block;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);animation:2s cubic-bezier(.36,0,.64,1) infinite dsh-mcp-pulse}
.dsh-mcp-skeleton-icon{flex:none;width:48px;height:48px;border-radius:var(--dsw-radius-lg)}
.dsh-mcp-skeleton-line{width:min(320px,45%);height:12px}
.dsh-mcp-skeleton-line+.dsh-mcp-skeleton-line{margin-top:6px;width:min(220px,30%)}
@keyframes dsh-mcp-pulse{0%{opacity:1}40%{opacity:.6}100%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsh-mcp-skeleton{animation:none}.dsh-mcp-icon-btn,.dsh-mcp-switch,.dsh-mcp-switch-thumb{transition:none}}
`

    function pickLocale(ctx) {
      const language = (() => {
        try {
          const snapshot = ctx.locale.getLocale()
          // The platform snapshot names the resolved language `active`; the
          // other fields stay as fallbacks for older hosts and test doubles.
          const id = snapshot && (snapshot.active || snapshot.id || snapshot.locale || snapshot.current)
          if (typeof id === 'string' && id) return id
        } catch {
          // Fall through to the browser language.
        }
        try {
          return navigator.language || 'en'
        } catch {
          return 'en'
        }
      })()
      return String(language).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function serverGlyph() {
      return h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 3.5, width: 14, height: 5.5, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.1 }),
        h('rect', { x: 3, y: 11, width: 14, height: 5.5, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.1 }),
        h('circle', { cx: 6, cy: 6.25, r: 1, fill: 'currentColor' }),
        h('circle', { cx: 6, cy: 13.75, r: 1, fill: 'currentColor' }))
    }

    function restartGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13 8a5 5 0 1 1-1.46-3.54', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M13 3v3.5H9.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /**
     * Fetch JSON, with an abort deadline and an optional tracking set so an
     * unmount can abort everything still in flight.
     *
     * Both globals are feature-detected: the real browser always has them, and
     * the panel must still mount in a minimal test double that does not.
     *
     * @param {string} url route to call
     * @param {object} [init] fetch init
     * @param {{track?: Set<AbortController>, timeoutMs?: number}} [options]
     * @returns {Promise<object>} the parsed `{ok: true, …}` body
     */
    async function requestJson(url, init, options = {}) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const tracked = controller !== null && options.track instanceof Set ? options.track : null
      const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : REQUEST_TIMEOUT_MS
      if (tracked !== null) tracked.add(controller)
      const timer = controller !== null && typeof setTimeout === 'function'
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null
      try {
        const fetchInit = Object.assign({ cache: 'no-store' }, init)
        if (controller !== null) fetchInit.signal = controller.signal
        const response = await fetch(url, fetchInit)
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok || body === null || body.ok !== true) {
          throw new Error(body && body.error ? body.error : 'HTTP ' + response.status)
        }
        return body
      } catch (error) {
        // Aborted means the deadline fired or the panel unmounted. Callers check
        // `alive` before rendering, so flagging it as a timeout is enough here.
        if (controller !== null && controller.signal.aborted) {
          const timeout = new Error('request timed out')
          timeout.timeout = true
          throw timeout
        }
        throw error
      } finally {
        if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
        if (tracked !== null) tracked.delete(controller)
      }
    }

    /** Human-readable error text, translated for the one error we produce ourselves. */
    function errorText(error, t) {
      if (error !== null && typeof error === 'object' && error.timeout === true) return t('timeout')
      return error && error.message ? error.message : String(error)
    }

    /** Status-following state of one pending action, used for the tag while busy. */
    const BUSY_STATE = { start: 'starting', stop: 'stopping', restart: 'restarting' }

    /** Row address: the management half resolves `entryId` exactly, so prefer it. */
    function addressOf(server) {
      if (typeof server.entryId === 'string' && server.entryId !== '') return server.entryId
      if (typeof server.id === 'string' && server.id !== '') return server.id
      return String(server.serverName)
    }

    /** Wire body of one action; `entryId` first, id/name only when it is missing. */
    function addressBody(server) {
      if (typeof server.entryId === 'string' && server.entryId !== '') return { entryId: server.entryId }
      if (typeof server.id === 'string' && server.id !== '') return { id: server.id }
      return { server: server.serverName }
    }

    function serverLabel(server) {
      return typeof server.serverName === 'string' && server.serverName !== '' ? server.serverName : addressOf(server)
    }

    /** The manager's `ChangeResult.application`, wherever the route puts it. */
    function applicationOf(body) {
      const result = body !== null && typeof body === 'object' ? body.result : null
      if (result !== null && typeof result === 'object' && typeof result.application === 'string') return result.application
      if (body !== null && typeof body === 'object' && typeof body.application === 'string') return body.application
      return 'applied'
    }

    /**
     * Turn one action response into the informational line under the list.
     * `restart-required` / `overridden` are reported, never shown as success.
     */
    function outcomeOf(body, server, t) {
      const application = applicationOf(body)
      const name = serverLabel(server)
      if (application === 'restart-required') return { tone: 'info', text: name + ': ' + t('action.restartRequired') }
      if (application === 'overridden') return { tone: 'info', text: name + ': ' + t('action.overridden') }
      if (application === 'failed' || application === 'cancelled') return { tone: 'error', text: name + ': ' + t('action.failed') }
      return { tone: 'info', text: name + ': ' + t('action.done') }
    }

    function statusTone(state) {
      if (state === 'running') return 'success'
      if (state === 'error') return 'danger'
      // 'stopping' keeps its own neutral tone: a shutdown in progress is not a
      // start and must not borrow the starting warning colour.
      if (state === 'starting' || state === 'restarting') return 'warning'
      return 'neutral'
    }

    /**
     * The live connection record of one row, or `null`.
     *
     * The Host half sends `live: null` when it cannot read the running
     * instance (or when it predates 1.3); anything that is not an object is
     * treated the same way so a missing field can never crash the card.
     */
    function liveOf(server) {
      const live = server !== null && typeof server === 'object' ? server.live : null
      return live !== null && typeof live === 'object' ? live : null
    }

    /**
     * Whether stopping or restarting this row could dispose a transport that is
     * still spawning its version-negotiation sibling.
     *
     * The upstream stdio transport aborts that sibling without waiting for its
     * spawn to finish; a child with no pid yet forwards the kill to pid 0, i.e.
     * the caller's whole process group (audit R1). A Stop/Restart landing in
     * that window can therefore signal the Host itself. Only a Host status of
     * `starting` sits in the window, and only a `closed` live cell proves the
     * transport already settled — a missing `live` falls back to the cautious
     * reading. Every other status is out of the window.
     */
    function spawnHazard(server) {
      if (server === null || typeof server !== 'object' || server.status !== 'starting') return false
      const live = liveOf(server)
      return live === null || live.state !== 'closed'
    }

    /** One dictionary string with its `{name}` placeholders filled in. */
    function fillTemplate(text, values) {
      return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match)
    }

    /** A whole number from the wire, or `null` when the field is absent. */
    function integerOf(value) {
      return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
    }

    /** A non-negative whole number from the wire, or `null` when absent/invalid. */
    function countOf(value) {
      const count = integerOf(value)
      return count === null || count < 0 ? null : count
    }

    /** Token estimate for the disclosure summary and the per-card line. */
    function tokenText(value) {
      const tokens = countOf(value) ?? 0
      return tokens < 1000 ? String(tokens) : (tokens / 1000).toFixed(1) + 'k'
    }

    /** Collapse and clip one disclosure line without splitting a word. */
    function clipText(text, maxChars) {
      const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
      if (collapsed.length <= maxChars) return collapsed
      const head = collapsed.slice(0, Math.max(0, maxChars - 1))
      const boundary = head.lastIndexOf(' ')
      return `${boundary > maxChars * 0.6 ? head.slice(0, boundary) : head}…`
    }

    /**
     * Whether one row is a no-op or unsafe target for a batch action.
     *
     * The same rules as a single row: a spawn-hazard row is never touched (the
     * 1.4 valve), Stop skips rows already stopped/stopping and rows configured
     * off, and Restart skips only a row that is already stopped and off. Every
     * skipped row is counted in the final summary instead of being posted.
     */
    function batchEligible(server, action) {
      if (spawnHazard(server)) return false
      const status = String(server.status || 'unknown')
      if (action === 'stop') {
        if (server.enabled !== true) return false
        return status !== 'stopped' && status !== 'stopping'
      }
      return !(server.enabled !== true && status === 'stopped')
    }

    /**
     * Live wording for a row the Host maps to `starting` (connecting,
     * reconnecting, waiting-credentials), or `null` when the plain translated
     * `starting` label is right.
     */
    function liveLabelOf(server, live, t) {
      if (live === null || server.status !== 'starting') return null
      if (live.state === 'reconnecting') {
        const attempt = integerOf(live.attempt)
        const maxAttempts = integerOf(live.maxAttempts)
        if (attempt === null || maxAttempts === null) return t('status.reconnectingNoAttempt')
        return fillTemplate(t('status.reconnecting'), { attempt, maxAttempts })
      }
      if (live.state === 'waiting-credentials') return t('status.waitingCredentials')
      return null
    }

    /** Seconds until the next reconnect attempt, or `null` when unknown. */
    function retryHintOf(live, now, t) {
      const at = live.nextRetryAtMs
      if (typeof at !== 'number' || !Number.isFinite(at) || typeof now !== 'number') return null
      const seconds = Math.max(0, Math.ceil((at - now) / 1000))
      return fillTemplate(t('retryIn'), { seconds })
    }

    /** Whether a row's own status still lets its `live` cell explain itself. */
    function liveDetailAllowed(status) {
      return status === 'starting' || status === 'error' || status === 'running' || status === 'idle'
    }

    /**
     * One-line explanation for the card's second line.
     *
     * The Host's `statusDetail` is authoritative and renders as sent. When it
     * is absent (older Host, or the read failed) a line is rebuilt from `live`
     * — the failure reason, the next retry, and the last error — but only while
     * the row's own status still describes a live or failing connection. A
     * stopped/stopping row may still carry its last cell (`presentServer`
     * forwards `live` unchanged) and must not contradict the reported status
     * with a stale failure. `null` means "no detail".
     */
    function detailOf(server, live, status, now, t) {
      const detail = typeof server.statusDetail === 'string' ? server.statusDetail.trim() : ''
      if (detail !== '') return detail
      if (live === null || !liveDetailAllowed(status)) return null
      const parts = []
      if (live.state === 'failed') {
        const reason = typeof live.reason === 'string' && live.reason !== '' ? live.reason : ''
        parts.push(reason === '' ? t('live.failed') : t('live.failed') + ': ' + reason)
      } else if (live.state === 'reconnecting') {
        const retry = retryHintOf(live, now, t)
        if (retry !== null) parts.push(retry)
      } else if (live.state !== 'waiting-credentials') {
        // A connected/closed cell never explains a past error: `lastError` is
        // only meaningful while the connection is failed or retrying.
        return null
      }
      const error = typeof live.lastError === 'string' && live.lastError !== '' ? live.lastError : null
      if (error !== null) parts.push(error)
      return parts.length === 0 ? null : parts.join(' · ')
    }

    function createPanel(fallbackT) {
      return function McpServersPanel(props) {
        const t = props !== null && props !== undefined && typeof props.t === 'function' ? props.t : fallbackT
        const [state, setState] = useState(null)
        const [loadError, setLoadError] = useState(null)
        const [outcome, setOutcome] = useState(null)
        const [pending, setPending] = useState(() => new Map())
        // Status filter for the card list; `all` shows every row.
        const [filter, setFilter] = useState('all')
        const alive = useRef(true)
        // Every request gets a monotonic generation. Snapshots only move forward,
        // and a GET that started before the newest action (or before the newest
        // applied snapshot) is discarded instead of overwriting a newer result.
        const sequence = useRef(0)
        const appliedSequence = useRef(0)
        const actionSequence = useRef(0)
        // Requests still in flight; unmount aborts them so nothing lands late.
        const controllers = useRef(new Set())
        const tRef = useRef(t)
        tRef.current = t

        const load = useCallback(async () => {
          const seq = (sequence.current += 1)
          try {
            const body = await requestJson(STATE_URL, undefined, { track: controllers.current })
            if (!alive.current) return
            if (seq <= appliedSequence.current || seq <= actionSequence.current) return
            appliedSequence.current = seq
            setState(body)
            setLoadError(null)
          } catch (error) {
            if (!alive.current || seq <= appliedSequence.current || seq <= actionSequence.current) return
            setLoadError(errorText(error, tRef.current))
          }
        }, [])

        useEffect(() => {
          alive.current = true
          load()
          const timer = setInterval(load, POLL_MS)
          return () => {
            alive.current = false
            clearInterval(timer)
            for (const controller of controllers.current) controller.abort()
            controllers.current.clear()
          }
        }, [load])

        /** One action request, shared by a single row and a batch row. */
        const sendAction = useCallback(async (server, action) => {
          return action === 'restart'
            ? requestJson(RESTART_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(addressBody(server)),
              }, { track: controllers.current })
            : requestJson(TOGGLE_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(Object.assign(addressBody(server), { enabled: action === 'start' })),
              }, { track: controllers.current })
        }, [])

        const act = useCallback(async (server, action) => {
          const key = addressOf(server)
          const seq = (sequence.current += 1)
          // A new action clears the previous outcome; a later poll never does.
          actionSequence.current = seq
          setOutcome(null)
          setPending((previous) => {
            const next = new Map(previous)
            next.set(key, action)
            return next
          })
          try {
            const body = await sendAction(server, action)
            if (!alive.current) return
            if (seq > appliedSequence.current) {
              appliedSequence.current = seq
              if (body !== null && Array.isArray(body.servers)) setState(body)
              setLoadError(null)
            }
            setOutcome(outcomeOf(body, server, tRef.current))
          } catch (error) {
            // Keep the action failure on screen: a following successful poll
            // must not clear it, only the next action does.
            if (!alive.current) return
            setOutcome({ tone: 'error', text: serverLabel(server) + ': ' + errorText(error, tRef.current) })
          } finally {
            if (alive.current) {
              setPending((previous) => {
                if (!previous.has(key)) return previous
                const next = new Map(previous)
                next.delete(key)
                return next
              })
            }
          }
        }, [sendAction])

        /**
         * Run one batch action over the filtered rows, serially.
         *
         * Every eligible row is marked pending before the first request, each
         * request reuses the single-row body/URL, and the final line reports
         * applied / failed / skipped counts. Requests never overlap, so a slow
         * row delays the rest instead of racing them.
         */
        const runBatch = useCallback(async (action, targets) => {
          if (!Array.isArray(targets) || targets.length === 0) return
          const eligible = targets.filter((server) => batchEligible(server, action))
          const skipped = targets.length - eligible.length
          setOutcome(null)
          if (eligible.length > 0) {
            setPending((previous) => {
              const next = new Map(previous)
              for (const server of eligible) next.set(addressOf(server), action)
              return next
            })
          }
          let applied = 0
          let failed = 0
          for (const server of eligible) {
            const key = addressOf(server)
            const seq = (sequence.current += 1)
            actionSequence.current = seq
            try {
              const body = await sendAction(server, action)
              if (!alive.current) return
              if (seq > appliedSequence.current) {
                appliedSequence.current = seq
                if (body !== null && Array.isArray(body.servers)) setState(body)
                setLoadError(null)
              }
              applied += 1
            } catch {
              if (!alive.current) return
              failed += 1
            } finally {
              if (alive.current) {
                setPending((previous) => {
                  if (!previous.has(key)) return previous
                  const next = new Map(previous)
                  next.delete(key)
                  return next
                })
              }
            }
          }
          if (!alive.current) return
          setOutcome({
            tone: failed > 0 ? 'error' : 'info',
            text: fillTemplate(tRef.current('batch.done'), { applied, failed, skipped }),
          })
        }, [sendAction])

        const servers = state !== null && Array.isArray(state.servers) ? state.servers : []
        // `now` is the Host's clock, so a retry countdown computed from
        // `live.nextRetryAtMs` stays meaningful even when the panel's own clock
        // drifts. It is absent from older Hosts; the countdown is then skipped.
        const now = state !== null && typeof state.now === 'number' && Number.isFinite(state.now) ? state.now : null

        // The Host's optional v1.5 snapshots. The panel's disclosure is computed
        // without an agent, so `loadedTools` is the cold default; the live loaded
        // view is the truthful "this window" count when it has any agent.
        const disclosure = state !== null && state.disclosure !== null && typeof state.disclosure === 'object' ? state.disclosure : null
        const loadedView = state !== null && state.loaded !== null && typeof state.loaded === 'object' ? state.loaded : null
        const loadedAgents = loadedView !== null && Array.isArray(loadedView.agents)
          ? loadedView.agents.filter((agent) => agent !== null && typeof agent === 'object')
          : []
        const hiddenTools = countOf(disclosure?.hiddenTools) ?? 0
        const hiddenTokens = countOf(disclosure?.hiddenTokens) ?? 0
        // "Loaded in this window" is a unique-tool count: the same tool loaded
        // by two live agents is still one tool.
        const loadedNames = new Set()
        for (const agent of loadedAgents) {
          if (!Array.isArray(agent.loaded)) continue
          for (const name of agent.loaded) if (typeof name === 'string' && name !== '') loadedNames.add(name)
        }
        const loadedTotal = loadedAgents.length > 0 ? loadedNames.size : countOf(disclosure?.loadedTools) ?? 0
        const showDisclosure = hiddenTools > 0 || loadedAgents.length > 0
        const keptLines = []
        if (disclosure !== null && Array.isArray(disclosure.notAdopted)) {
          const counts = new Map()
          for (const item of disclosure.notAdopted) {
            if (item === null || typeof item !== 'object') continue
            const reason = clipText(item.reason, 80)
            if (reason === '') continue
            counts.set(reason, (counts.get(reason) ?? 0) + 1)
          }
          for (const [reason, count] of counts) {
            if (keptLines.length >= 3) break
            keptLines.push(fillTemplate(t('disclosure.kept'), { reason, count }))
          }
        }

        const statuses = []
        for (const server of servers) {
          const status = String(server.status || 'unknown')
          if (!statuses.includes(status)) statuses.push(status)
        }
        // Keep the chosen filter even when a poll removes that status: the
        // select keeps the option and the list explains that nothing matches.
        const activeFilter = filter
        const filterStatuses = filter !== 'all' && !statuses.includes(filter) ? [...statuses, filter] : statuses
        const filteredServers = activeFilter === 'all'
          ? servers
          : servers.filter((server) => String(server.status || 'unknown') === activeFilter)
        const batchBusy = pending.size > 0

        const card = (server) => {
          const key = addressOf(server)
          const pendingAction = pending.get(key)
          const busy = pendingAction !== undefined
          const live = liveOf(server)
          const statusKey = String(server.status || 'unknown')
          const stateKey = busy ? BUSY_STATE[pendingAction] : statusKey
          // The Host maps connecting/reconnecting/waiting-credentials to
          // `starting`; an in-flight action keeps its own verb ("Starting…"),
          // otherwise the live state says which kind of start this is.
          const liveLabel = busy ? null : liveLabelOf(server, live, t)
          const label = liveLabel === null ? (busy ? t(BUSY_STATE[pendingAction]) : t('status.' + stateKey)) : liveLabel
          const tone = statusTone(stateKey)
          const cardHiddenTools = countOf(server.hiddenTools) ?? 0
          const hiddenPart = cardHiddenTools > 0
            ? fillTemplate(t('card.hidden'), { hidden: cardHiddenTools, tokens: tokenText(server.hiddenTokens) })
            : null
          // A lazy row is marked in the existing meta line, so the card layout
          // does not grow an extra element for it.
          const lazyPart = server.lazy === true ? t('lazy') : null
          const meta = [server.transport, server.target, server.toolCount + ' ' + t('toolsUnit'), lazyPart, hiddenPart]
            .filter((part) => typeof part === 'string' && part !== '')
            .join(' · ')
          // The management half reports why a server failed to start; surface it
          // instead of leaving "error" unexplained.
          const diagnostic = typeof server.diagnostic === 'string' && server.diagnostic !== '' ? server.diagnostic : null
          const description = diagnostic === null ? meta : meta === '' ? diagnostic : meta + ' · ' + diagnostic
          // The Host's one-line live explanation (reason, retry countdown, last
          // error). Shown as a second clamped line; the full text stays in the
          // title, so nothing is lost to the ellipsis.
          const detail = detailOf(server, live, statusKey, now, t)
          const tagHint = detail === null ? diagnostic : detail
          const tagTitle = tagHint === null
            ? fillTemplate(t('tagTitlePlain'), { label })
            : fillTemplate(t('tagTitle'), { label, detail: tagHint })
          const name = serverLabel(server)
          // A row that may still be spawning keeps both controls disabled: the
          // disposal behind Stop/Restart can signal the Host's process group
          // (see `spawnHazard`). A pending action already wins ("busy"), so the
          // reason only rides along while nothing else is disabling the row.
          const hazard = spawnHazard(server) && !busy
          const hazardHint = hazard ? t('hazard.starting') : null
          const restartLabel = hazardHint === null ? t('restart') + ' ' + name : t('restart') + ' ' + name + ' — ' + hazardHint
          const switchLabel = hazardHint === null ? t('switchLabel') + ' ' + name : t('switchLabel') + ' ' + name + ' — ' + hazardHint
          const restartButton = h('button', {
            type: 'button',
            className: 'dsh-mcp-icon-btn',
            disabled: busy || hazard,
            title: restartLabel,
            'aria-label': restartLabel,
            onClick: () => {
              if (hazard) return
              act(server, 'restart')
            },
          }, restartGlyph())
          const switchButton = h('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-mcp-switch',
            disabled: busy || hazard,
            'aria-checked': server.enabled ? 'true' : 'false',
            // The accessible name names the setting (this server), not the action
            // that the next click would perform; aria-checked carries the state.
            'aria-label': switchLabel,
            title: hazard ? switchLabel : undefined,
            onClick: () => {
              if (hazard) return
              act(server, server.enabled ? 'stop' : 'start')
            },
          }, h('span', { className: 'dsh-mcp-switch-thumb', 'aria-hidden': 'true' }))
          return h('li', { key, className: 'dsh-mcp-card', 'data-state': stateKey },
            h('div', { className: 'dsh-mcp-card-head' },
              h('span', { className: 'dsh-mcp-card-icon', 'aria-hidden': 'true' }, serverGlyph()),
              h('div', { className: 'dsh-mcp-card-main' },
                h('div', { className: 'dsh-mcp-title-row' },
                  h('span', { className: 'dsh-mcp-card-title' }, name),
                  h('span', { className: 'dsh-mcp-tag', 'data-tone': tone, title: tagTitle }, label)),
                h('p', { className: 'dsh-mcp-card-desc', title: description }, description),
                detail === null ? null : h('p', { className: 'dsh-mcp-card-detail', title: detail }, detail)),
              h('div', { className: 'dsh-mcp-card-end' }, restartButton, switchButton)))
        }

        const skeleton = (index) => h('li', { key: 'skeleton-' + index, className: 'dsh-mcp-card' },
          h('div', { className: 'dsh-mcp-card-head' },
            h('span', { className: 'dsh-mcp-skeleton dsh-mcp-skeleton-icon' }),
            h('span', { className: 'dsh-mcp-card-main' },
              h('span', { className: 'dsh-mcp-skeleton dsh-mcp-skeleton-line' }),
              h('span', { className: 'dsh-mcp-skeleton dsh-mcp-skeleton-line' }))))

        // A compact summary of what this window is hiding. It only appears when
        // the Host actually sent a non-empty snapshot; an older Host keeps the
        // exact 1.4 panel.
        const disclosureBlock = showDisclosure
          ? h('div', { className: 'dsh-mcp-disclosure' },
              h('p', { className: 'dsh-mcp-disclosure-summary' },
                fillTemplate(t('disclosure.summary'), {
                  loaded: loadedTotal,
                  hidden: hiddenTools,
                  tokens: tokenText(hiddenTokens),
                })),
              loadedAgents.length === 0 ? null : h('details', { className: 'dsh-mcp-disclosure-loaded' },
                h('summary', {}, fillTemplate(t('disclosure.loadedAgents'), { count: loadedTotal })),
                loadedAgents.map((agent, index) => {
                  const names = Array.isArray(agent.loaded)
                    ? agent.loaded.filter((name) => typeof name === 'string' && name !== '')
                    : []
                  const shown = names.slice(0, LOADED_NAME_LIMIT)
                  const more = names.length > shown.length ? ' +' + (names.length - shown.length) + ' more' : ''
                  return h('p', { className: 'dsh-mcp-disclosure-agent', key: 'agent-' + index },
                    String(agent.title || agent.id || 'agent') + ': ' + shown.join(', ') + more)
                })),
              keptLines.map((line, index) => h('p', { className: 'dsh-mcp-disclosure-kept', key: 'kept-' + index }, line)))
          : null

        // One filter over the rendered rows; the batch buttons act only on the
        // rows this filter currently shows.
        const toolbar = state !== null && servers.length > 0
          ? h('div', { className: 'dsh-mcp-toolbar' },
              h('select', {
                className: 'dsh-mcp-filter',
                'aria-label': t('filter.label'),
                value: activeFilter,
                onChange: (event) => setFilter(event !== null && event !== undefined && event.target ? event.target.value : 'all'),
              }, [
                h('option', { key: 'all', value: 'all' }, t('filter.all')),
                ...filterStatuses.map((status) => h('option', { key: status, value: status }, t('status.' + status))),
              ]),
              h('button', {
                type: 'button',
                className: 'dsh-mcp-btn dsh-mcp-batch-stop',
                disabled: batchBusy || filteredServers.length === 0,
                onClick: () => runBatch('stop', filteredServers),
              }, t('batch.stop')),
              h('button', {
                type: 'button',
                className: 'dsh-mcp-btn dsh-mcp-batch-restart',
                disabled: batchBusy || filteredServers.length === 0,
                onClick: () => runBatch('restart', filteredServers),
              }, t('batch.restart')))
          : null

        let list
        if (loadError !== null) {
          list = h('div', { className: 'dsh-mcp-failure', role: 'alert' },
            h('span', { className: 'dsh-mcp-failure-text' }, t('failure') + ': ' + loadError),
            h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: load }, t('retry')))
        } else if (state === null) {
          list = h('ul', { className: 'dsh-mcp-cards', 'aria-busy': 'true', 'aria-label': t('loading') }, [0, 1].map(skeleton))
        } else if (servers.length === 0) {
          list = h('p', { className: 'dsh-mcp-empty' }, t('empty'))
        } else if (filteredServers.length === 0 && activeFilter !== 'all') {
          list = h('p', { className: 'dsh-mcp-empty' }, t('filter.empty'))
        } else {
          list = h('ul', { className: 'dsh-mcp-cards' }, filteredServers.map(card))
        }

        return h('section', { className: 'dsh-mcp' },
          h('div', { className: 'dsh-mcp-group' },
            h('div', { className: 'dsh-mcp-group-head' },
              h('h3', { className: 'dsh-mcp-group-title' },
                t('title'),
                state !== null ? h('span', { className: 'dsh-mcp-group-info' }, servers.length + ' ' + t('countUnit')) : null)),
            h('p', { className: 'dsh-mcp-intro' }, t('description')),
            disclosureBlock,
            toolbar,
            list,
            // Always mounted, so the live region exists before the message it
            // announces; a following poll leaves it untouched.
            h('p', {
              className: 'dsh-mcp-action',
              'data-tone': outcome === null ? 'info' : outcome.tone,
              role: 'status',
              'aria-live': 'polite',
            }, outcome === null ? '' : outcome.text)))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const fallback = DICT[pickLocale(ctx)] || DICT.en
        const fallbackT = (key) => (Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : DICT.en[key] || key)
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-mcp-progressive: dictionaries')
        const Panel = createPanel(fallbackT)
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-mcp-progressive'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            if (tag.parentNode) tag.parentNode.removeChild(tag)
          }
        }, 'dsh-mcp-progressive: styles')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'mcp-servers',
          order: 30,
          locale: NS,
          label: () => t('tabTitle'),
        }, Panel))
      },
    }
  },
})
