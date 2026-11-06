# dsh-opencli

Low-latency browser tools for DSH that drive the **local OpenCLI daemon directly** instead of spawning the `opencli` CLI once per command.

[![npm version](https://img.shields.io/npm/v/dsh-opencli.svg)](https://www.npmjs.com/package/dsh-opencli)
[![npm downloads](https://img.shields.io/npm/dm/dsh-opencli.svg)](https://www.npmjs.com/package/dsh-opencli)
[![license](https://img.shields.io/npm/l/dsh-opencli.svg)](LICENSE)

`opencli` pays a Node cold start on every call — it resolves 318 modules to send one request (~1.4–1.8 s per command; measured: `opencli list search` = 1071 ms). The daemon, once warm, answers the same request in **5–20 ms**. This plugin keeps that daemon as a resident service: it posts to `http://127.0.0.1:19825/command` with the `X-OpenCLI: 1` header and hands the result straight back to the agent.

```
CLI path    : agent -> shell -> node opencli -> (318 modules) -> daemon   ~1400-1800 ms
plugin path : agent -> oc_exec -> fetch()     ->                daemon    ~10-20 ms
```

## Install

Published on npm: **[dsh-opencli](https://www.npmjs.com/package/dsh-opencli)** (registry: `https://registry.npmjs.org/dsh-opencli`, `npm view dsh-opencli version` for the current release).

**A · Inside DSH** — let the plugin manager resolve it from the registry:

```bash
plugin_manager action=install_bundle target=dsh-opencli
```

From a checkout instead: `plugin_manager action=install_bundle target=/absolute/path/to/dsh-opencli`.

**B · With the `dsh` CLI** — the CLI's `plugin` command forwards the rest of the line to pnpm inside that profile directory:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-opencli   # or install it once: npm i -g @deepseek-ai/dsh
```

**C · Manually, with npm / pnpm** — a DSH profile is an ordinary package directory, so the plugin is an ordinary dependency:

```bash
cd ~/.dsh/profiles/web          # the profile you run; `web` is the desktop default
pnpm add dsh-opencli            # or: npm install dsh-opencli
```

Profiles created by the desktop app carry a pnpm `.npmrc` (`node-linker=hoisted`), so prefer `pnpm add` there; plain `npm install dsh-opencli` also works in a profile that has no pnpm setup. Behind a mirror: append `--registry=https://registry.npmmirror.com`.

⚠️ **B and C only install the package** — neither touches `dsh.profile.bundles`, so the harness will not load it until you enable the bundle (the sidebar's **Plugins** page, which both installs and selects; or the `plugin_manager` tool when your preset enables it). Route A does that step for you. Also keep the pnpm doing the install in step with the profile's lockfile: a v9 lockfile needs pnpm 10+, and an older pnpm prints `Ignoring broken lockfile ... not compatible with current pnpm` and re-resolves the whole profile (the desktop app ships its own pnpm 11.8 for exactly this reason).

To add it by hand instead, list it in `dsh.profile.bundles` inside that profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-opencli"]
    }
  }
}
```

Its own `cordis.patch.yml` inserts the `dsh-opencli` tool row; you do not need to hand-write that. Every route finishes the same way: restart the session, or toggle the plugin entry `include:dsh-opencli` off and on.

## Tools

| Tool | What it does | Writes |
|---|---|---|
| `oc_status` | Daemon version, online state, extension connection, contextId, profiles, memory. The first call when something breaks. | no |
| `oc_exec` | Runs JS expressions in your already-logged-in browser. `codes` runs up to 40 expressions in one round trip; evaluation is async, so `await fetch(...)` works. | depends |
| `oc_navigate` | Opens a URL, waits for load, returns title / final URL / whether it timed out. | yes |
| `oc_snapshot` | Compresses the page into a compact interactive structure (title, links with href, buttons, inputs with name/placeholder, disabled flags) — an order of magnitude cheaper than `outerHTML`. | no |
| `oc_tabs` | `list` / `new` / `select` / `close` tabs inside the automation container. | new/select/close |
| `oc_screenshot` | Captures the viewport (or full page) to a PNG/JPEG file under the system temp dir and returns its path. | no |
| `oc_cookies` | Reads cookies for one domain/URL scope — the logged-in session of the real browser. | no |
| `oc_network` | `start` / `read` a network capture buffer: URL, method, request headers, response status, body preview. | start/read |
| `oc_upload` | Attaches local files to a file input (CSS selector). | yes |
| `oc_input` | Inserts text into the focused element (typing into a real field). | yes |
| `oc_frames` | Lists the frames (iframes) of the current page. | no |
| `oc_cdp` | Calls one whitelisted Chrome DevTools Protocol method (e.g. `DOM.getBoxModel`). | depends |
| `oc_chrome` | `describe` / `call` native Chrome management methods (tabs, tabGroups, windows). | call writes |
| `oc_close` | Closes the automation window (`window`) or an owned tab (`tab`). | yes |
| `oc_download` | Waits for a download matching a URL pattern and returns where it landed. | no |

`session` is the key of a persistent automation tab (default `dsh`), so different jobs get isolated tabs for free. Every `oc_tabs` op takes a session (falls back to the configured default).

### Coverage

The tool set mirrors what the OpenCLI **daemon** can do, because that is the fast path (5–20 ms) and the CLI's own sub-commands are only reachable by paying its 1.4–1.8 s cold start:

- Covered here: expression evaluation, navigation, tab management, snapshots, screenshots, cookies, network capture, file upload, text input, frames, whitelisted CDP calls, native Chrome tab/group/window management, window/tab closing, and download waiting.
- Not covered here: the OpenCLI **site adapters** (176 of them — GitHub, Xiaohongshu, Twitter, …) and the CLI-only browser verbs (`click`, `fill`, `scroll`, `dialog`, …). Those run inside the `opencli` CLI process, not behind the daemon, so wrapping them here would reintroduce the cold start this plugin exists to avoid. Drive them with the `opencli` CLI directly, or use `oc_exec` / `oc_cdp` against the same page.

`oc_cdp` is restricted to a whitelist of CDP methods (`DOM.*`, `Page.captureScreenshot`, `Input.dispatchMouseEvent`, `Runtime.enable`, …); `Runtime.evaluate` is denied by the extension, so use `oc_exec` for JavaScript.

`oc_chrome` operates the browser's **native** tabs, groups and windows — not the automation container. Native tabs survive after the session ends, so treat `oc_chrome op=call` as a user-visible write.

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
| `Cookie scope required` | `oc_cookies` needs a `domain` or `url`; the daemon refuses an unscoped cookie dump on purpose |
| `CDP method not permitted` | `oc_cdp` only allows whitelisted methods; `Runtime.evaluate` is one of the blocked ones — use `oc_exec` |
| `No element found matching selector` | The `oc_upload` selector does not match on the current page — check it with `oc_snapshot` first |
| download never arrives | `oc_download` waits for a real download; if the page never starts one it will time out |

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

`dsh-opencli` 把本机 OpenCLI daemon 当常驻服务用，替掉「每条命令起一次 `opencli` CLI」的冷启动开销（1.4–1.8 s → 10–20 ms），提供 15 个工具：基础 5 个（`oc_status` / `oc_exec` / `oc_navigate` / `oc_snapshot` / `oc_tabs`）+ 浏览器动作 10 个（`oc_screenshot` / `oc_cookies` / `oc_network` / `oc_upload` / `oc_input` / `oc_frames` / `oc_cdp` / `oc_chrome` / `oc_close` / `oc_download`）。

- 安装：npm 上已发布（[dsh-opencli](https://www.npmjs.com/package/dsh-opencli)）。三条路：DSH 里 `plugin_manager action=install_bundle target=dsh-opencli`（或侧栏 Plugins 页，会把「装包 + 选中 bundle」一起做掉）；`npx @deepseek-ai/dsh plugin --profile web add dsh-opencli`；或进 profile 目录 `pnpm add dsh-opencli`。后两条只是装包，**还要去 Plugins 页启用该 bundle**，且 pnpm 版本要和 profile 的 lockfile 对齐（v9 → pnpm 10+）。装完重启会话，或把插件条目关一次再打开。
- 排障先跑 `oc_status`；报 `daemon_unreachable` 就 `opencli daemon restart`。
- 它操作的是你真实的、已登录的浏览器，不是无头沙箱；简单无登录态的测试仍走 Playwright 无头。
- 改 `index.js` 不会热更，要 disable → enable 插件条目重新 import。
- 覆盖范围 = OpenCLI **daemon** 能做的浏览器动作（求值、导航、标签页、截图、cookie、抓包、上传、输入、frame、白名单 CDP、原生 Chrome 标签/分组/窗口、下载等待）。**站点适配器**（github / 小红书 / 推特等 176 个）和 CLI 专属动词（click / fill / scroll / dialog…）走的是 `opencli` CLI 进程，不在 daemon 后面；包进这里就等于把 1.4–1.8 s 冷启动又请回来，所以保持不包——需要时直接跑 `opencli`，或用 `oc_exec` / `oc_cdp` 操作同一个页面。

## License

MIT
