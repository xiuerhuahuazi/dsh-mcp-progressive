# dsh-mcp-progressive

English | [中文](#中文)

Progressive disclosure for MCP tools in DeepSeek Harness — the model no longer pays for every
`mcp__*` tool schema on every request — plus an **MCP servers** tab and two tools to start,
stop and restart MCP servers without leaving the Harness.

## English

### Why

Each MCP server contributes one model-facing tool per remote tool (`mcp__<server>__<tool>`),
and the complete schema set is re-sent on **every** request. Two or three rich MCP servers can
cost tens of thousands of tokens per turn even when the model never calls them.

### What it does

The plugin leaves MCP connections and the global tool registry untouched — approvals, timeouts,
cancellation, images and the tool-card pipeline keep working — and changes only the viewing
agent's registry view:

1. Hiding happens in the registry view, not in the prompt: a per-agent scope restriction
   (`agent.ctx.tools.restrict({ deny })`) removes the unloaded schemas from `schemas(agent)` —
   the exact list the prompt provider reads — and from `get`/`executable`, so a hidden tool is
   neither in the prompt nor callable directly.
2. Loading re-registers the selected definitions inside the agent's own scope, which a
   restriction leaves visible. The deny list is therefore never rebuilt for a load, so the
   request's tool array stays stable within a session.
3. Three small meta-tools replace the catalog:

   | Tool | Purpose |
   |---|---|
   | `mcp_search` | Search the hidden catalog: full name, one-line summary, parameter signature. `detail: "full"` prints the input schema of up to two matches. |
   | `mcp_load` | Make selected tools native for this conversation from the next step; `unload: true` removes them; no arguments lists what is loaded. |
   | `mcp_call` | Run one hidden tool directly through the normal tool pipeline, without loading it. |

   A typical turn is `mcp_search` → `mcp_load` → call the real tool natively, or
   `mcp_search` → `mcp_call` for a single use.
4. A guessed-but-unregistered `mcp__*` call gets a corrective message instead of a bare
   unknown-tool error.

Loaded state is per live agent (session) and in memory: a Harness restart resets it, and a
resumed session starts with only `eagerTools`.

### MCP server management

Every MCP server is one loader row of `@deepseek-ai/dsh-mcp-client`. An unused server can be
disconnected entirely (its child process exits) without unloading this plugin:

- **Plugins page → "MCP servers" tab** — one card per MCP server: a status tag, transport /
  target / tool-count description, a restart icon button and the host switch for start/stop.
  The list reuses the built-in Plugins page card design (48px icon tile, 14px card title,
  13px description, status tag, 36×20 switch) and DSH theme tokens only, so it matches the
  host in light and dark themes. Data comes from same-origin routes served by the Host half,
  so no client RPC surface is added.
- **Model tools** — `mcp_servers` lists every configured server with its status;
  `mcp_server { server, action: "start" | "stop" | "restart" }` changes one.

How the change is applied:

- a row declared by a bundle or by the profile patch is toggled through the Harness
  `pluginManager` service (the same path as the Plugins page switches);
- a row inserted by the home-level patch (`~/.dsh/cordis.patch.yml`) is not addressable through
  that service, so the plugin writes the `disabled` override into that patch file itself
  (a `.mcp-hub.bak` copy is kept next to it);
- HMR applies either change live and both survive a restart. Stopping a server removes its
  `mcp__<server>__*` tools from every session; starting it reconnects and re-registers them.

Management activates only on desktop profiles (it needs `pluginManager`, `profileContext` and
`webServer`); headless profiles keep the disclosure half exactly as before.

### Install

Requires DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0` (0.2.2 moved tool declarations out of the
`system-prompt/assemble` waterfall, which is why older releases cannot run this one).

```
plugin_manager → action: "install_bundle", target: "dsh-mcp-progressive@1.2.0"
```

or **Settings → Plugins → install bundle** with `dsh-mcp-progressive@1.2.0`. The bundle
inserts the row `mcp-progressive`; no other bundle is required.

After installing (or upgrading from 1.0.0), restart the Harness app once so the client half
and the updated package metadata are picked up, then refresh the page. A fresh install shows
the **MCP servers** tab on first start.

### Configuration

The inserted row takes an optional config:

```yaml
- id: mcp-progressive
  name: dsh-mcp-progressive
  config:
    prefix: 'mcp__'          # tool-name prefix that marks hidden MCP tools
    alwaysVisible: []        # exact names or 'mcp__server__*' prefixes never hidden
    eagerTools: []           # names loaded for every agent from the start
    searchLimit: 12          # default result page size (1-40)
    summaryChars: 160        # one-line description budget per result
    enableLoad: true         # register mcp_load
    enableCall: true         # register mcp_call
    correctiveUnknownTool: true
    manageServers: true      # register the MCP server list / start / stop half
```

The bundle's own patch passes `{}`; override the row from the profile patch to change these
values.

### Measured effect

Measured on the author's profile against a real session log (DeepSeek V4.1 Flash, two MCP
servers: 87 + 207 tools; tool arrays read back from the recorded `request/header` entries):

| | tools in request | of which MCP | tool-definition JSON | tokens |
|---|---|---|---|---|
| before | 351 | 294 | 864,556 chars | 268,154 |
| after | 57 | 0 (3 meta-tools) | 48,671 chars | 15,096 |

That is 94.4 % less tool-definition payload on every request, i.e. **253,058 fewer prompt
tokens per request** (measured, not estimated: a flat 4 chars/token understates the block by
~24 %; the real ratio here is 3.224).

Money (deepseek-flash): the tool block sits at the prompt head and normally never changes, so
it is billed at the discount cache-hit price — about **0.010 元/request** saved while cached,
and **0.25–0.51 元** saved on an uncached request. Changing the tool array is what costs money:
one `mcp_load` of a new tool measured ≈ **0.45 元** (a near-full cache miss, paid back after
≈45 cached requests). So prefer `mcp_call` for one-off calls, batch several `mcp_load` names in
one call, keep the loaded set monotonic, and use `eagerTools` for tools a session always needs
(the first request of a session is a cache miss anyway). Your absolute numbers depend on how
many MCP tools you install.

### Limitations

- Hiding is **view + dispatch, not a permission boundary**: a hidden tool cannot be called
  directly, but `mcp_call` can still run it, and policy/approval still applies.
- PTC-presented agents (`tools: { mode: ptc }`, e.g. the shipped `preset-ptc`) read the same
  restricted registry view, so hiding and loaded tools are covered there too; `mcp_call`
  cannot dispatch a raw batch in PTC mode and answers with guidance to `mcp_load` and call the
  tool inside `run_code`.
- Loaded tools stay in the tool array for the rest of the session; unloading changes the array
  again (see the cache note above).
- Non-MCP tools are never touched.
- Disclosure bookkeeping is fail-open: if a scope or a registration is unavailable it logs one
  warning and leaves the tool visible instead of failing a model request.
- Server status is inferred from the loader row and the registered tool names: a row that is
  enabled but whose server failed after its reconnect budget shows as "connected, no tools"
  until it is restarted.

### License

MIT.

## 中文

MCP 工具的渐进披露：模型不必在每次请求里为每个 `mcp__*` 工具 schema 付费；另带一个
**MCP 服务器**标签页和两个工具，可以在 Harness 里直接启动、停止、重启 MCP 服务器。

### 为什么

每个 MCP Server 的每个远程工具都会注册一个面向模型的工具（`mcp__<server>__<tool>`），
完整 schema 集合在**每次请求**都会重发。两三个内容丰富的 MCP Server 即使一次都没被调用，
每回合也可能花掉数万 token。

### 它做什么

插件不改动 MCP 连接和全局工具注册表——审批、超时、取消、图片与工具卡片流程都照常工作——
只改变当前 agent 看到的注册表视图：

1. 隐藏发生在注册表视图而不是 prompt：每个 agent 作用域上的一条 restriction
   （`agent.ctx.tools.restrict({ deny })`）把未装载的 schema 从 `schemas(agent)`
   （prompt provider 读取的正是这份）以及 `get`/`executable` 中移除，因此被隐藏的工具既不在
   prompt 中，也无法被直接调用。
2. 装载会把选中的定义重新注册到该 agent 自己的作用域，作用域内注册不受 restriction 影响。
   因此装载**不会重建** deny 列表，会话内的工具数组保持稳定。
3. 用三个小元工具替代：

   | 工具 | 作用 |
   |---|---|
   | `mcp_search` | 检索隐藏目录：完整名称、一行摘要、参数签名；`detail: "full"` 打印最多两个匹配项的输入 schema。 |
   | `mcp_load` | 让选中的工具从下一步起成为本会话的原生工具；`unload: true` 移除；不带参数则列出已装载项。 |
   | `mcp_call` | 通过正常工具管线直接运行一个隐藏工具，无需装载。 |

   典型回合是 `mcp_search` → `mcp_load` → 原生调用真实工具；单次使用则
   `mcp_search` → `mcp_call`。
4. 猜测但未注册的 `mcp__*` 调用会得到纠正提示，而不是裸的未知工具错误。

已装载状态按活跃 agent（会话）保存在内存中：Harness 重启即重置，恢复的会话只带
`eagerTools`。

### MCP 服务器管理

每个 MCP 服务器都是 `@deepseek-ai/dsh-mcp-client` 的一个 loader 行。不用的服务器可以
整行断开（子进程退出），不需要卸载本插件：

- **插件页 → 「MCP 服务器」标签页**：每个 MCP 服务器一行，显示状态、传输方式、目标、
  工具数量和「启动 / 停止 / 重启」按钮；数据来自 Host 半侧的同源路由，不新增客户端 RPC。
- **模型工具**：`mcp_servers` 列出所有已配置服务器及状态；
  `mcp_server { server, action: "start" | "stop" | "restart" }` 控制其中一个。

生效方式：

- bundle 或 profile 补丁声明的行，通过 Harness 的 `pluginManager` 服务切换（与插件页开关
  同一条路径）；
- 由 home 层补丁（`~/.dsh/cordis.patch.yml`）插入的行无法被该服务寻址，插件会把
  `disabled` 覆盖直接写入该补丁文件（写入前保留 `.mcp-hub.bak` 副本）；
- HMR 会即时应用，两种方式都持久化、重启后仍有效。停止服务器会从所有会话移除它的
  `mcp__<server>__*` 工具；启动会重新连接并注册。

管理半侧只在桌面 profile 激活（需要 `pluginManager`、`profileContext`、`webServer`）；
headless profile 保持原有的披露半侧不变。

### 安装

需要 DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`（0.2.2 把工具声明移出了
`system-prompt/assemble` 瀑布，这正是旧版本无法运行本版本的原因）。

```
plugin_manager → action: "install_bundle", target: "dsh-mcp-progressive@1.2.0"
```

或在**设置 → 插件 → 安装 bundle** 中填入 `dsh-mcp-progressive@1.2.0`。该 bundle 会插入
`mcp-progressive` 行，不依赖其他 bundle。

安装（或从 1.0.0 升级）后请**重启一次 Harness 应用**，让客户端半侧与新的包元数据生效，
然后刷新页面；全新安装首次启动即可看到「MCP 服务器」标签页。

### 配置

插入的行支持可选配置（示例见英文部分的 YAML）：`prefix`、`alwaysVisible`、`eagerTools`、
`searchLimit`、`summaryChars`、`enableLoad`、`enableCall`、`correctiveUnknownTool`、
`manageServers`。bundle 自带 patch 传入 `{}`；如需修改，在 profile 的
`cordis.patch.yml` 中覆盖该行即可。

### 实测效果

在作者 profile 上用真实会话日志测量（DeepSeek V4.1 Flash，两个 MCP Server：87 + 207 个工具；
工具数组取自记录的 `request/header`）：请求内工具从 351 个降至 57 个，其中 MCP 工具从 294 个
降至 0（改为 3 个元工具），工具定义 JSON 从 864,556 字符降至 48,671 字符（268,154 → 15,096
token）。即每次请求工具定义体积 **−94.4%**、prompt **少 253,058 token**（实测值；按 4 字符/token
估算会低估约 24%，本机实测比值为 3.224）。

费用（deepseek-flash）：工具块位于 prompt 头部且通常不变，按缓存命中价计费——缓存命中时每次
约省 **0.010 元**，未命中缓存的请求每次省 **0.25–0.51 元**。真正花钱的是**改变工具数组**：一次
`mcp_load` 装载新工具实测约 **0.45 元**（近似全量缓存未命中，约 45 次缓存请求回本）。因此：单次
调用优先用 `mcp_call`；`mcp_load` 一次批量装载多个工具；装载保持单调；会话必用的工具放进
`eagerTools`（会话首个请求本来就是未命中）。具体金额取决于你安装了多少 MCP 工具。

### 限制

- 隐藏是**视图 + 分发**层面的，不是权限边界：被隐藏的工具不能直接调用，但仍可通过
  `mcp_call` 执行，策略与审批照常生效。
- PTC 呈现的 agent（`tools: { mode: ptc }`，如内置 `preset-ptc`）读取的是同一份受限注册表视图，
  隐藏与已装载工具都覆盖；`mcp_call` 在 PTC 模式下不能直接分发批处理，会提示改用
  `mcp_load` 后在 `run_code` 内调用。
- 已装载的工具会在本会话剩余时间里留在工具数组中；卸载会再次改变数组（见上面的缓存说明）。
- 非 MCP 工具不受影响。
- 披露记账是 fail-open 的：作用域或注册不可用时只记一条警告并让工具保持可见，不会让模型请求失败。
- 服务器状态由 loader 行和已注册的工具名推断：行已启用但服务器在重连预算耗尽后失败时，
  会显示为「已连接（无工具）」，重启后恢复。

### 许可证

MIT。
