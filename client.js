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
    const NS = 'dshMcpServers'

    const DICT = {
      en: {
        tabTitle: 'MCP servers',
        title: 'MCP servers',
        description: 'Start, stop or restart the MCP servers configured for this profile. Changes are written to the profile patch and apply to every session.',
        countUnit: 'servers',
        toolsUnit: 'tools',
        empty: 'No MCP servers are configured for this profile.',
        loading: 'Loading MCP servers…',
        failure: 'Could not load MCP servers',
        retry: 'Retry',
        restart: 'Restart',
        start: 'Start',
        stop: 'Stop',
        starting: 'Starting…',
        stopping: 'Stopping…',
        restarting: 'Restarting…',
        'status.running': 'running',
        'status.stopped': 'stopped',
        'status.idle': 'connected, no tools',
        'status.starting': 'starting',
        'status.error': 'error',
        'status.unknown': 'unknown',
      },
      zh: {
        tabTitle: 'MCP 服务器',
        title: 'MCP 服务器',
        description: '启动、停止或重启当前 profile 配置的 MCP 服务器；修改会写入 profile 补丁并对所有会话生效。',
        countUnit: '个',
        toolsUnit: '个工具',
        empty: '当前 profile 没有配置 MCP 服务器。',
        loading: '正在加载 MCP 服务器…',
        failure: '无法加载 MCP 服务器',
        retry: '重试',
        restart: '重启',
        start: '启动',
        stop: '停止',
        starting: '启动中…',
        stopping: '停止中…',
        restarting: '重启中…',
        'status.running': '运行中',
        'status.stopped': '已停止',
        'status.idle': '已连接（无工具）',
        'status.starting': '启动中',
        'status.error': '错误',
        'status.unknown': '未知',
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
.dsh-mcp-tag{display:inline-flex;align-items:center;flex:none;height:18px;padding:0 7px;border-radius:999px;corner-shape:round;font-size:10px;font-weight:500;line-height:1;white-space:nowrap}
.dsh-mcp-tag[data-tone=success]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-tag[data-tone=warning]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-mcp-tag[data-tone=danger]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-mcp-tag[data-tone=neutral]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dsh-mcp-card-desc{display:-webkit-box;overflow:hidden;-webkit-line-clamp:1;-webkit-box-orient:vertical;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:18px}
.dsh-mcp-card-end{position:relative;z-index:1;display:inline-flex;flex:none;align-items:center;gap:8px}
.dsh-mcp-icon-btn{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease}
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
          const id = snapshot && (snapshot.id || snapshot.locale || snapshot.current)
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

    async function requestJson(url, init) {
      const response = await fetch(url, Object.assign({ cache: 'no-store' }, init))
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
    }

    function statusTone(state) {
      if (state === 'running') return 'success'
      if (state === 'error') return 'danger'
      if (state === 'starting') return 'warning'
      return 'neutral'
    }

    function createPanel(fallbackT) {
      return function McpServersPanel(props) {
        const t = props !== null && props !== undefined && typeof props.t === 'function' ? props.t : fallbackT
        const [state, setState] = useState(null)
        const [failure, setFailure] = useState(null)
        const [pending, setPending] = useState({})
        const alive = useRef(true)
        const inFlight = useRef(false)

        const load = useCallback(async () => {
          if (inFlight.current) return
          inFlight.current = true
          try {
            const body = await requestJson(STATE_URL)
            if (!alive.current) return
            setState(body)
            setFailure(null)
          } catch (error) {
            if (alive.current) setFailure(error && error.message ? error.message : String(error))
          } finally {
            inFlight.current = false
          }
        }, [])

        useEffect(() => {
          alive.current = true
          load()
          const timer = setInterval(load, POLL_MS)
          return () => {
            alive.current = false
            clearInterval(timer)
          }
        }, [load])

        const act = useCallback(async (server, action) => {
          const key = server.id || server.serverName
          setPending((previous) => Object.assign({}, previous, { [key]: action }))
          try {
            const body = action === 'restart'
              ? await requestJson(RESTART_URL, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ server: key }),
                })
              : await requestJson(TOGGLE_URL, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ server: key, enabled: action === 'start' }),
                })
            if (alive.current) {
              setState(body)
              setFailure(null)
            }
          } catch (error) {
            if (alive.current) setFailure(error && error.message ? error.message : String(error))
            await load()
          } finally {
            if (alive.current) {
              setPending((previous) => {
                const next = Object.assign({}, previous)
                delete next[key]
                return next
              })
            }
          }
        }, [load])

        const servers = state !== null && Array.isArray(state.servers) ? state.servers : []

        const card = (server) => {
          const key = server.id || server.serverName
          const action = pending[key]
          const busy = action !== undefined
          const stateKey = busy ? 'starting' : String(server.status || 'unknown')
          const label = busy
            ? t(action === 'stop' ? 'stopping' : action === 'restart' ? 'restarting' : 'starting')
            : t('status.' + stateKey)
          const tone = statusTone(stateKey)
          const meta = [server.transport, server.target, server.toolCount + ' ' + t('toolsUnit')]
            .filter((part) => typeof part === 'string' && part !== '')
            .join(' · ')
          const restartButton = h('button', {
            type: 'button',
            className: 'dsh-mcp-icon-btn',
            disabled: busy,
            title: t('restart'),
            'aria-label': t('restart') + ' ' + server.serverName,
            onClick: () => act(server, 'restart'),
          }, restartGlyph())
          const switchButton = h('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-mcp-switch',
            disabled: busy,
            'aria-checked': server.enabled ? 'true' : 'false',
            'aria-label': (server.enabled ? t('stop') : t('start')) + ' ' + server.serverName,
            onClick: () => act(server, server.enabled ? 'stop' : 'start'),
          }, h('span', { className: 'dsh-mcp-switch-thumb', 'aria-hidden': 'true' }))
          return h('li', { key, className: 'dsh-mcp-card', 'data-state': stateKey },
            h('div', { className: 'dsh-mcp-card-head' },
              h('span', { className: 'dsh-mcp-card-icon', 'aria-hidden': 'true' }, serverGlyph()),
              h('div', { className: 'dsh-mcp-card-main' },
                h('div', { className: 'dsh-mcp-title-row' },
                  h('span', { className: 'dsh-mcp-card-title' }, server.serverName),
                  h('span', { className: 'dsh-mcp-tag', 'data-tone': tone }, label)),
                h('p', { className: 'dsh-mcp-card-desc' }, meta)),
              h('div', { className: 'dsh-mcp-card-end' }, restartButton, switchButton)))
        }

        const skeleton = (index) => h('li', { key: 'skeleton-' + index, className: 'dsh-mcp-card' },
          h('div', { className: 'dsh-mcp-card-head' },
            h('span', { className: 'dsh-mcp-skeleton dsh-mcp-skeleton-icon' }),
            h('span', { className: 'dsh-mcp-card-main' },
              h('span', { className: 'dsh-mcp-skeleton dsh-mcp-skeleton-line' }),
              h('span', { className: 'dsh-mcp-skeleton dsh-mcp-skeleton-line' }))))

        let list
        if (failure !== null) {
          list = h('div', { className: 'dsh-mcp-failure', role: 'alert' },
            h('span', { className: 'dsh-mcp-failure-text' }, t('failure') + ': ' + failure),
            h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: load }, t('retry')))
        } else if (state === null) {
          list = h('ul', { className: 'dsh-mcp-cards', 'aria-busy': 'true', 'aria-label': t('loading') }, [0, 1].map(skeleton))
        } else if (servers.length === 0) {
          list = h('p', { className: 'dsh-mcp-empty' }, t('empty'))
        } else {
          list = h('ul', { className: 'dsh-mcp-cards' }, servers.map(card))
        }

        return h('section', { className: 'dsh-mcp' },
          h('div', { className: 'dsh-mcp-group' },
            h('div', { className: 'dsh-mcp-group-head' },
              h('h3', { className: 'dsh-mcp-group-title' },
                t('title'),
                state !== null ? h('span', { className: 'dsh-mcp-group-info' }, servers.length + ' ' + t('countUnit')) : null)),
            h('p', { className: 'dsh-mcp-intro' }, t('description')),
            list))
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
