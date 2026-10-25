# dsh-opencli

Low-latency browser tools for DSH that drive the **local OpenCLI daemon directly** instead of spawning the `opencli` CLI once per command.

`opencli` pays a Node cold start on every call — it resolves 318 modules to send one request (~1.4–1.8 s per command; measured: `opencli list search` = 1071 ms). The daemon, once warm, answers the same request in **5–20 ms**. This plugin keeps that daemon as a resident service: it posts to `http://127.0.0.1:19825/command` with the `X-OpenCLI: 1` header and hands the result straight back to the agent.

```
CLI path    : agent -> shell -> node opencli -> (318 modules) -> daemon   ~1400-1800 ms
plugin path : agent -> oc_exec -> fetch()     ->                daemon    ~10-20 ms
```

## Install

```bash
# as a DSH bundle (writes the cordis patch row and mounts the tools)
plugin_manager action=install_bundle target=dsh-opencli
```

From a checkout instead: `plugin_manager action=install_bundle target=/absolute/path/to/dsh-opencli`.
Then restart the session, or toggle the plugin entry `include:dsh-opencli` off and on.

## Tools

| Tool | What it does | Writes |
|---|---|---|
| `oc_status` | Daemon version, online state, extension connection, contextId, profiles, memory. The first call when something breaks. | no |
| `oc_exec` | Runs JS expressions in your already-logged-in browser. `codes` runs up to 40 expressions in one round trip; evaluation is async, so `await fetch(...)` works. | depends |
| `oc_navigate` | Opens a URL, waits for load, returns title / final URL / whether it timed out. | yes |
| `oc_snapshot` | Compresses the page into a compact interactive structure (title, links with href, buttons, inputs with name/placeholder, disabled flags) — an order of magnitude cheaper than `outerHTML`. | no |
| `oc_tabs` | `list` / `new` / `select` / `close` tabs inside the automation container. | new/select/close |

`session` is the key of a persistent automation tab (default `dsh`), so different jobs get isolated tabs for free. Every `oc_tabs` op takes a session (falls back to the configured default).

## Config

Three fields in `cordis.patch.yml`, overridable from the profile patch or the plugin settings UI:

```yaml
config:
  port: 19825          # must match `opencli daemon status`
  defaultSession: dsh  # session key for the persistent automation tab
  timeoutMs: 30000     # per-expression budget, clamped to 2000-120000
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `daemon_unreachable` | `opencli daemon restart` (any `opencli` command also auto-starts it) |
| `extension ... disconnected` | Open the OpenCLI extension in Chrome/Edge, keep that browser window alive, re-check `extensionConnected` in `opencli daemon status` |
| `Page is not in the automation container` | `select` only reaches tabs inside the container: open one with `op=new` first |
| `page_not_found` / `stale page identity` | `oc_tabs op=list` for the current `index`/`page`, or omit `page` and let the daemon choose |
| `ReferenceError` / `SyntaxError` | The expression itself is wrong: call `oc_snapshot` first and look at what the DOM really contains |

Every failure comes back as a structured value, not a throw: `{ ok: false, errorCode, error, hint }` — `hint` names the next action. A dead daemon is deliberately **not** auto-restarted, so a real outage never hides behind a silent retry.

## Safety

These tools drive your **real** browser with your real logins — clicks, form fills and closed tabs happen in the window in front of you. For simple, unauthenticated page tests prefer headless Playwright; reach for `oc_*` when you actually need a logged-in session or a persistent tab.

## Development

`index.js` is a host-side module: editing it does **not** hot-reload. Re-import it by toggling the plugin entry.

```
plugin_manager action=list_plugins                                        # find include:dsh-opencli
plugin_manager action=set_plugin target=include:dsh-opencli enabled=false
plugin_manager action=set_plugin target=include:dsh-opencli enabled=true
```

The harness validates each tool's `output.schema` strictly (`additionalProperties: false`), so one undeclared field fails the whole call with `tool "oc_xxx" returned invalid output`. That only shows up on a real invocation — never in a direct `execute()` call — so `npm test` validates real outputs against the declared schemas:

```bash
npm test        # schema conformance: success envelopes, failure envelopes, daemon-down
```

## 中文速览

`dsh-opencli` 把本机 OpenCLI daemon 当常驻服务用，替掉「每条命令起一次 `opencli` CLI」的冷启动开销（1.4–1.8 s → 10–20 ms），提供 5 个工具：`oc_status` / `oc_exec` / `oc_navigate` / `oc_snapshot` / `oc_tabs`。

- 安装：在 DSH 里 `plugin_manager action=install_bundle target=dsh-opencli`（已装过就重启会话或把插件条目关一次再打开）。
- 排障先跑 `oc_status`；报 `daemon_unreachable` 就 `opencli daemon restart`。
- 它操作的是你真实的、已登录的浏览器，不是无头沙箱；简单无登录态的测试仍走 Playwright 无头。
- 改 `index.js` 不会热更，要 disable → enable 插件条目重新 import。

## License

MIT
