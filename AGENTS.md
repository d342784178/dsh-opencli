# AGENTS.md — dsh-opencli

给在本仓库里干活的 agent 的项目说明书。**先读完再动手**，尤其是「硬约束」和「本机环境事实」两节——那里记的都是踩过的坑。

## 1. 这是什么

DSH 插件（cordis bundle），把本机常驻的 **OpenCLI daemon** 当成 RPC 服务直接用，替代「每条命令起一次 `opencli` CLI」：

```
CLI 路径    : agent -> shell -> node opencli -> (解析 318 个模块) -> daemon   ~1400-1800 ms
插件路径    : agent -> oc_exec -> fetch()    ->            daemon          ~10-20 ms
```

存在理由只有一个：**省掉 CLI 冷启动**。参考机器实测（Windows 11 x64、Node v25.5.0、暖缓存）：裸 Node 启动 ~175 ms、`opencli list search` 中位 **951–1071 ms**、daemon `/status` **1.6 ms**、`POST /command` 往返 **10–13 ms**。模块图本身 104 个自有模块 + 194 个 CJS 依赖 ≈ 318 个文件、平均 2.2 ms/模块、最大深度 11 层（**面宽，不是太深**）；CPU profile 里 83% 耗在模块加载/文件 syscall，真正执行代码只占 17%，idle 仅 6%——**不存在隐藏 sleep 或轮询**，所以「优化等待」这条路是死的，只能不重新加载。

要复现：`node --cpu-prof` 跑一条 `opencli list search`，跟 `opencli daemon status` 的耗时对比；浏览器往返本身只要几毫秒。

## 2. 仓库结构

| 路径 | 说明 |
|---|---|
| `index.js` | 全部实现，单文件 host 模块（约 900 行）。**没有构建步骤，没有依赖** |
| `cordis.patch.yml` | 插件行定义 + 三个可配置项（`port` / `defaultSession` / `timeoutMs`） |
| `locale/en.json`, `locale/zh.json` | 插件市场展示用的标题/描述（`meta.title` / `meta.description`）；改文案两边都要改 |
| `test/schema.test.mjs` | schema 一致性测试，`npm test` |
| `icon.svg`, `package.json` | 打包用；`package.json` 的 `files` 白名单决定发布内容 |

工具面固定 15 个：基础 5 个（`oc_status` / `oc_exec` / `oc_navigate` / `oc_snapshot` / `oc_tabs`）+ 浏览器动作 10 个（`oc_screenshot` / `oc_cookies` / `oc_network` / `oc_upload` / `oc_input` / `oc_frames` / `oc_cdp` / `oc_chrome` / `oc_close` / `oc_download`），默认 port `19825`、session `dsh`、`timeoutMs` `30000`（钳在 2000–120000）。

## 3. 常用命令

```bash
npm test                 # schema conformance，需要 daemon 在跑；不在跑时只验 daemon-down 信封
opencli daemon status    # daemonVersion / extensionConnected / port
opencli daemon restart   # daemon_unreachable 时的第一条命令
```

改了 `index.js` **不会热更**，必须重载插件行：`plugin_manager action=list_plugins` 找到 `include:dsh-opencli`，`set_plugin enabled=false` 再 `enabled=true`。改 `cordis.patch.yml` 里的 config 同样要重载或重启会话。

## 4. 硬约束（破坏任何一条都会在真实调用时炸，且本地 `execute()` 测不出来）

1. **零运行期依赖**。只用 `ctx.tools.register` 注册纯对象工具定义，不 `import` 任何 `@deepseek-ai/*` 值，不新增 npm 依赖。`package.json` 里 `"dependencies"` 必须保持不存在。
2. **harness 只严格校验 `output.schema`**（`additionalProperties: false`）。多返回一个未声明字段 → 整个调用失败：`tool "oc_xxx" returned invalid output: ... is not a declared property`。这条**只在真实调用时出现**，直接 `execute()` 不会报——所以每次改返回结构必须跑 `npm test`（它拿真实 daemon 输出对着声明的 schema 校）。
3. **永不 throw 成工具失败**。daemon 挂、扩展断、页面没了都是**用户可处理的状态**，不是插件 bug：统一返回 `{ ok: false, errorCode, error, hint }`，`hint` 必须点名「下一条该跑什么命令」。抛异常会让模型失去线索并重试。
4. **参数先自检**。注册路径不校验入参，模型给的参数原样进来：每个工具先用 `assertKnownArguments` 拒掉未声明键，再用 `optionalString` / `optionalPositiveInteger` / `clamp` 复查类型和范围（`oc_exec` 最多 40 条表达式、`oc_snapshot` limit 1–400、`oc_navigate` 只接受 http(s)）。
5. **单值截断**：结果里每个 JS 值限制 `VALUE_LIMIT = 8000` 字符；新增返回字段要一起想清楚大小，否则一次 `outerHTML` 就能把上下文打爆。
6. **不自动重启 daemon**。真故障不许藏在静默重试后面——报 `daemon_unreachable` 并给命令。
7. session 是有语义的：一个 session = 一个持久自动化标签页，默认 `dsh`；不同任务用不同 session 隔离，`oc_tabs` 的 `list/new/select/close` 都吃这个键。

## 5. 浏览器自动化路由

- 简单页面、无登录态、纯交互验证 → **Playwright + Edge headless**，不要用 `oc_*`。
- 需要登录态、需要真实浏览器窗口、需要拿页面里的真实 API 证据 → `oc_*`（它驱动的是用户**正在使用的、已登录的**浏览器；点击、填表、关标签都发生在用户眼前，写操作前先 `oc_snapshot` 或先读确认目标）。

## 6. 运行环境中容易踩的两件事

**① shell 工具的成本口径**（同一 harness 测，别跨工具比）。一次性命令工具（如 `ops_bash`、`bash`）每次调用都要重新起进程：约 **0.7–1.1 s** 固定税（harness 前置 ~260 ms + 起进程 ~620 ms）＋ 每条外部命令 **66–77 ms**（Windows 上 MSYS 的 fork 模拟），与是否沙箱无关；持久 PTY 终端是「每会话一次 ~1 s，之后每条 ~66 ms」。所以**连续多条命令该合并成一次调用**，别一条命令一个 tool call；需要连续几十条命令时用持久终端，而不是反复调一次性 shell。

**② `terminal_open` 报 `PTY shell exited during startup`**。先别怀疑沙箱或 ConPTY，按顺序查：

1. `shellPath` 是否指向一个**能独立启动**的真二进制（`usr/bin/bash.exe`，不是同目录的几十 KB launcher）；
2. 用同一台机器、同一 spawn 方式做对照：`node -e "spawnSync(bin, ['--noprofile','--norc','-i'], {input:'echo HI; exit\n'})"`——启不来的二进制换到终端里一样起不来；
3. 如果用的是一份被补丁过的运行时（例如 dsh-ops 的 `bash-ipc/<identity>/`，为在受限令牌下绕过 MSYS 建信号管道而改写导入表），**先确认它自己能跑**。我们踩到的实例：该补丁运行时由 Node 直接 spawn、在 `danger-full-access` 下、连 `env -i` 都报 `*** fatal error - couldn't create signal pipe, Win32 error 5`（`exit 0xC0000142`），而同一时刻未打补丁的 payload 和系统 Git Bash 都能用 `-i` 正常起来——症状和「后端逻辑坏了」一模一样，但真凶是那个 shellPath。
4. 结论与修法：把 `terminal-controller.config.shell.path` 与 `optional-terminal-bash.config.shellPath` 都指向**系统 Git Bash 的真二进制**（`C:/Program Files/Git/bin/bash.exe`，带空格的路径在 YAML 里加引号；同目录的 `usr/bin/bash.exe` 也可以），保留 `args: [-i]`。改完先跑一遍 YAML 解析确认没改坏，再新建一个终端会话验证；**这个 build 不需要重启宿主**——`terminal_open` 新建会话时就吃到了新路径，`echo $BASH_VERSION` 打出 `5.2.37(1)-release`、`MSYSTEM=MINGW64`、`exit` 干净退出 0。只有宿主把配置缓存住了才需要重启。
5. 改这种文件前先备份到仓库之外（例如 `~/.dsh/backup/`），别把 profile 的 `.bak` 留在仓库里被误提交。

实测口径（可用作基线）：持久 PTY 里 5 条外部命令 358 ms ≈ **72 ms/条**，与上面第 ① 条的 66–77 ms 一致；`/usr/bin/true` 这类最小进程也要付这个钱，因为贵的是 MSYS 的 fork 模拟，不是进程本身。

顺带记一条：受限令牌下 MSYS 建不了信号管道（`error 5`），所以「沙箱内 + 持久 bash 终端」目前在 Windows 上不是默认成立，要么用一次性命令工具，要么让宿主以更高权限启动终端，要么真有可信的 IPC 补丁运行时。

## 7. OpenCLI daemon / CLI 已知坑

- 端口必须与 `opencli daemon status` 一致；所有非公开路由都要带 `X-OpenCLI: 1`。
- `code` 是**表达式**，不是语句：要多行逻辑就包 `(async()=>{ ... })()`，别写 `return`。
- session 过期 / 页面被关 → 返回空标题或 `ok:false`，重跑一次 `opencli browser open <url> --session <name>` 即可；首条 ~40 ms（attach），之后 10–13 ms。
- `Page is not in the automation container`：`select` 只能切容器内标签页，先 `op=new`。
- `page_not_found` / `stale page identity`：先 `oc_tabs op=list` 取最新 `index`/`page`，或省略 `page` 让 daemon 自选。
- **别在自动化流程里调 `opencli list`**：输出几 MB，且要付 1.1 s 冷启动。
- daemon 常驻在 `127.0.0.1:19825`，状态里要看 `daemonVersion`、`extensionConnected`、`port`（`/status` 约 1.6 ms，适合当探活）。

## 8. 风格与提交

- 换行一律 LF（`.gitattributes`：`* text=auto eol=lf`），提交前别让编辑器写回 CRLF。
- 提交前缀沿用现有约定：`feat:` / `test:` / `chore:` / `docs:`。
- 注释写**为什么**，不写「这行做了什么」；本仓库现有注释密度偏高的原因是踩坑记录（schema 校验、IPC 补丁、冷启动数据），改代码时别把这些解释删掉。
- 临时脚本/文档放项目根目录 `temp/`，不要落在仓库根；`temp/` 没进 `.gitignore`，提交前确认。
- 这是公开仓库：**别把本机的用户名、绝对家目录、profile 名、daemon 的 identity 哈希、token 写进文档或测试**。需要举例时用 `%USERPROFILE%` / `~` / `<占位符>`。
