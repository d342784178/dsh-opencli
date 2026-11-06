/**
 * dsh-opencli — DSH tools that speak to the local OpenCLI daemon directly.
 *
 * Why this plugin exists: the `opencli` CLI costs 1.4–1.8 s per invocation
 * (318 modules resolve from disk before the first request leaves the process),
 * while the daemon it starts answers the same `exec` in ~10 ms. This module
 * keeps that daemon hot and gives the model five small tools layered on it.
 *
 * Design constraints, deliberate:
 * - Plain object tool definitions registered through `ctx.tools.register`, so
 *   the file needs no `@deepseek-ai/*` value import and no dependencies at all.
 * - That registration path validates only `output.schema`; the model's
 *   arguments arrive here verbatim. Every tool therefore rejects undeclared
 *   keys and re-checks its own types before touching the daemon.
 * - Nothing throws on a daemon or extension failure: the tool returns
 *   `ok:false` plus a `hint` naming the one command that fixes it, because a
 *   dead daemon is a user-actionable state, not a plugin bug.
 *
 * @module dsh-opencli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default OpenCLI daemon port (`opencli daemon status` reports the live one). */
const DEFAULT_PORT = 19825;
/** Session key: OpenCLI keeps one persistent automation tab per session name. */
const DEFAULT_SESSION = 'dsh';
/** Per-expression budget when neither the call nor the config sets one. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 120_000;
/** Highest number of expressions one `oc_exec` call will run. */
const MAX_EXPRESSIONS = 40;
/** Characters of a JS value kept in the result before truncation. */
const VALUE_LIMIT = 8_000;
/** Every non-public daemon route requires this header. */
const DAEMON_HEADER = { 'X-OpenCLI': '1' };
/** Default number of interactive nodes an `oc_snapshot` outline collects. */
const DEFAULT_SNAPSHOT_LIMIT = 60;
const MAX_SNAPSHOT_LIMIT = 400;

export const name = 'dsh-opencli';
/** The tools service must exist before `register` is called. */
export const inject = ['tools'];

/* ------------------------------------------------------------------ config */

function report(ctx, message, level = 'warn') {
  const logger = ctx?.logger;
  const sink = logger ? Reflect.get(logger, level) : undefined;
  if (typeof sink === 'function') sink.call(logger, message);
  else if (level === 'error') console.error(message);
  else console.warn(message);
}

/**
 * Fold the saved config into a total value. Bad numbers fall back to the
 * default with one warning instead of disabling the plugin.
 * @param {unknown} raw - the loader's `config` object.
 * @param {(message: string) => void} warn - sink for a rejected value.
 */
function normalizeConfig(raw, warn) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pickPort = source.port;
  const port = Number.isInteger(pickPort) && pickPort > 0 && pickPort < 65_536
    ? pickPort
    : (pickPort === undefined ? DEFAULT_PORT : (warn(`port 必须是 1–65535 的整数，已回退为 ${DEFAULT_PORT}`), DEFAULT_PORT));
  const rawSession = typeof source.defaultSession === 'string' ? source.defaultSession.trim() : '';
  const defaultSession = rawSession && !/[\s"'`]/.test(rawSession)
    ? rawSession
    : DEFAULT_SESSION;
  const rawTimeout = source.timeoutMs;
  const timeoutMs = Number.isInteger(rawTimeout) && rawTimeout >= MIN_TIMEOUT_MS && rawTimeout <= MAX_TIMEOUT_MS
    ? rawTimeout
    : (rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : (warn(`timeoutMs 超出 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}，已回退为 ${DEFAULT_TIMEOUT_MS}`), DEFAULT_TIMEOUT_MS));
  return { port, defaultSession, timeoutMs, base: `http://127.0.0.1:${port}` };
}

/* ---------------------------------------------------------- argument guards */

/**
 * Reject arguments this tool does not declare.
 * @param {unknown} args - model arguments.
 * @param {readonly string[]} known - declared names.
 * @returns {Record<string, unknown>} the arguments as an object.
 */
function assertKnownArguments(args, known) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`invalid arguments: expected an object, got ${JSON.stringify(args)}`);
  }
  const unknown = Object.keys(args).filter(key => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`invalid arguments: unknown ${unknown.length === 1 ? 'key' : 'keys'} `
      + `${unknown.map(key => JSON.stringify(key)).join(', ')}; this tool accepts ${known.join(', ')}`);
  }
  return args;
}

function optionalString(args, key, limit = 4_000) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid ${key}: expected a string, got ${JSON.stringify(value)}`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > limit) throw new Error(`invalid ${key}: ${trimmed.length} characters exceeds the ${limit} limit`);
  return trimmed;
}

function optionalPositiveInteger(args, key, max) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid ${key}: expected a positive integer, got ${JSON.stringify(value)}`);
  if (max !== undefined && value > max) throw new Error(`invalid ${key}: ${value} exceeds the ${max} limit`);
  return value;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/* ------------------------------------------------------------- daemon client */

/**
 * A failure the model can act on: `hint` names the remediation command.
 */
class DaemonError extends Error {
  constructor(message, { code = 'daemon_error', hint } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function combinedSignal(signal, ms) {
  const timer = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
  if (!signal) return timer;
  if (timer && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timer]);
  return timer ?? signal;
}

/**
 * Turn a failed `fetch` or a daemon envelope error into a {@link DaemonError}
 * carrying the fix spelled out.
 * @param {unknown} error - anything a request threw.
 * @param {string} base - daemon origin, for the message.
 */
function toDaemonError(error, base) {
  if (error instanceof DaemonError) return error;
  const code = String(error?.cause?.code ?? error?.code ?? '');
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || /fetch failed|socket hang up/i.test(String(error?.message ?? ''))) {
    return new DaemonError(`OpenCLI daemon 未响应（${base}）`, {
      code: 'daemon_unreachable',
      hint: '先运行 `opencli daemon restart`（任意 opencli 命令也会自动拉起 daemon），确认 `opencli daemon status` 里 extensionConnected=true 后再重试',
    });
  }
  if (error?.name === 'AbortError' || code === 'ABORT_ERR' || /aborted|timed out/i.test(String(error?.message ?? ''))) {
    return new DaemonError(`请求超时或被取消：${String(error?.message ?? error)}`, {
      code: 'timeout',
      hint: '缩小操作范围，或给该工具传更大的 timeoutMs（上限 120000）；导航慢站可用 oc_navigate 的 timeoutMs',
    });
  }
  return new DaemonError(String(error?.message ?? error), { code: 'daemon_error' });
}

/**
 * Hint text for a daemon-reported `errorCode`, matched loosely because the
 * daemon owns the vocabulary.
 * @param {string} code - `errorCode` from the envelope.
 * @param {string} message - the human message beside it.
 */
function hintFor(code, message) {
  const text = `${code} ${message}`;
  if (/automation container/i.test(text)) {
    return 'select 只能切到「自动化容器」里已有的标签页：先用 op=new 在容器内开一个，或按 OpenCLI 的 bind/slot 流程把目标页纳进容器；op=list 只列容器内的 tab';
  }
  if (/session (is )?required/i.test(text)) {
    return '这次调用缺 session：给工具传 session（默认取插件配置的 defaultSession）；tabs 的 list/new/close/select 同样需要它';
  }
  if (/ReferenceError|SyntaxError|TypeError|is not defined|Unexpected token/i.test(text)) {
    return '表达式本身报错（不是 daemon 问题）：检查变量名与选择器，先用 oc_snapshot 确认页面上真实存在的节点';
  }
  if (/extension|bridge|disconnect|not connected/i.test(text)) {
    return '浏览器扩展没有连上 daemon：点开 Chrome/Edge 里的 OpenCLI 扩展并保持该浏览器打开，然后 `opencli daemon status` 复查';
  }
  if (/profile/i.test(text)) {
    return '缺少浏览器 profile：先 `opencli profile import` / `opencli profile use <name>` 选定要驱动的 profile';
  }
  if (/page_not_found|no such page|stale|target closed/i.test(text)) {
    return 'page 句柄已失效：先跑 oc_tabs 取最新列表，再用其中的 index/page，或省略 page 让 daemon 自选';
  }
  if (/timeout|timed out/i.test(text)) {
    return '操作超时：调大 timeoutMs，或先 oc_status 确认扩展仍在；慢站可先 oc_navigate 再 oc_exec';
  }
  if (/cdp|debugger|attach/i.test(text)) {
    return 'CDP 连接异常：重启扩展（关闭再打开）或 `opencli daemon restart` 后重试';
  }
  return undefined;
}

/**
 * Minimal client for the OpenCLI daemon command channel.
 */
class DaemonClient {
  constructor(config) {
    this.config = config;
    this.sequence = 0;
  }

  nextId() {
    this.sequence += 1;
    return `dsh-${process.pid.toString(36)}-${Date.now().toString(36)}-${this.sequence}`;
  }

  /**
   * POST /command and unwrap the envelope.
   * @param {string} action - daemon action (`exec`, `navigate`, `tabs`).
   * @param {Record<string, unknown>} params - action payload.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<{data: unknown, page?: string}>}
   */
  async command(action, params, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const body = {
      id: this.nextId(),
      action,
      ...params,
      // The daemon arms its own timer from this value (seconds).
      timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    };
    let response;
    try {
      response = await fetch(`${this.config.base}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...DAEMON_HEADER },
        body: JSON.stringify(body),
        signal: combinedSignal(options.signal, timeoutMs + 5_000),
      });
    } catch (error) {
      throw toDaemonError(error, this.config.base);
    }
    const text = await response.text().catch(() => '');
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new DaemonError(`daemon 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 300)}`, {
        code: 'bad_response',
        hint: '可能是端口被其它服务占用：确认 config.port 与 `opencli daemon status` 报告的一致',
      });
    }
    if (envelope?.ok === true) return { data: envelope.data, page: envelope.page };
    const code = String(envelope?.errorCode ?? 'command_failed');
    const message = String(envelope?.error ?? envelope?.errorHint ?? `daemon ${action} 失败（HTTP ${response.status}）`);
    throw new DaemonError(message, { code, hint: envelope?.errorHint ?? hintFor(code, message) });
  }

  /** GET /status — the one route that reports extension health. */
  async status(options = {}) {
    let response;
    try {
      response = await fetch(`${this.config.base}/status`, {
        headers: DAEMON_HEADER,
        signal: combinedSignal(options.signal, options.timeoutMs ?? this.config.timeoutMs),
      });
    } catch (error) {
      throw toDaemonError(error, this.config.base);
    }
    const text = await response.text().catch(() => '');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DaemonError(`daemon /status 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, { code: 'bad_response' });
    }
    // Older daemons answer the bare status object; newer ones wrap it.
    const status = payload?.status && typeof payload.status === 'object' ? payload.status : payload;
    return { status, httpStatus: response.status };
  }
}

/* ------------------------------------------------------------------ helpers */

function stringifyValue(value) {
  let text;
  if (value === undefined) text = 'undefined';
  else if (typeof value === 'string') text = JSON.stringify(value);
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= VALUE_LIMIT) return text;
  return `${text.slice(0, VALUE_LIMIT)}\n… 截断（原长 ${text.length} 字符；用更精确的表达式取子字段）`;
}

function previewExpression(code) {
  const flat = code.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function indent(text, prefix = '    ') {
  return text.split('\n').map(line => `${prefix}${line}`).join('\n');
}

function errorFields(error) {
  const info = error instanceof DaemonError ? error : toDaemonError(error, 'daemon');
  return { error: info.message, errorCode: info.code, ...(info.hint ? { hint: info.hint } : {}) };
}

/**
 * The browser-side snapshot program. Written as a real function and shipped
 * through `Function.prototype.toString`, so the collector is lint-checked here
 * instead of hiding inside a string literal.
 * @param {number} limit - maximum number of interactive nodes to keep.
 */
function snapshotProgram(limit) {
  const seen = [];
  const lines = [];
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const textOf = (element) => {
    const raw = element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.textContent
      || element.value
      || element.getAttribute('placeholder')
      || element.getAttribute('name')
      || '';
    const flat = String(raw).replace(/\s+/g, ' ').trim();
    return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
  };
  const isActionable = (element) => {
    const tag = element.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'label'].includes(tag)) return true;
    if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') return true;
    if (element.hasAttribute('onclick')) return true;
    const role = element.getAttribute('role');
    return ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'switch', 'searchbox', 'combobox'].includes(role);
  };
  const candidates = document.querySelectorAll(
    'h1,h2,h3,a,button,input,select,textarea,summary,label,[role],[contenteditable],[onclick]',
  );
  for (const element of candidates) {
    if (seen.length >= limit) break;
    const tag = element.tagName.toLowerCase();
    const heading = tag === 'h1' || tag === 'h2' || tag === 'h3';
    if (!heading && !isActionable(element)) continue;
    if (element.closest('[aria-hidden="true"]')) continue;
    if (!isVisible(element)) continue;
    if (seen.some(previous => previous.contains(element))) continue;
    seen.push(element);
    const parts = [heading ? tag.toUpperCase() : tag];
    const role = element.getAttribute('role');
    if (role && !heading) parts[0] = `${tag}[${role}]`;
    if (tag === 'a') {
      try {
        const href = element.href;
        if (href && !href.startsWith('javascript:')) parts.push(`→ ${href.slice(0, 140)}`);
      } catch { /* detached node */ }
    }
    if (tag === 'input') {
      const bits = [element.type || 'text'];
      if (element.name) bits.push(`name=${element.name}`);
      if (element.placeholder) bits.push(`ph=${JSON.stringify(element.placeholder.slice(0, 40))}`);
      if (element.disabled) bits.push('disabled');
      parts.push(`(${bits.join(' ')})`);
    }
    if (tag === 'select' || tag === 'textarea') {
      if (element.name) parts.push(`(name=${element.name})`);
      if (element.disabled) parts.push('(disabled)');
    }
    const label = textOf(element);
    if (label) parts.push(JSON.stringify(label));
    if (element.disabled && tag !== 'input' && tag !== 'select') parts.push('(disabled)');
    lines.push(parts.join(' '));
  }
  return {
    url: location.href,
    title: document.title,
    count: seen.length,
    truncated: seen.length >= limit,
    text: lines.join('\n'),
  };
}

/* ----------------------------------------------------------- tool definitions */

const SESSION_DESCRIPTION = '持久标签页的会话键；同一 session 复用同一个自动化 tab，不同任务用不同值隔离（默认取插件配置的 defaultSession）';

function buildTools(config, client) {
  const base = {};

  /* oc_exec ------------------------------------------------------------- */
  base.exec = {
    name: 'oc_exec',
    description: [
      '在用户已登录的本地浏览器里执行 JS 表达式并返回其值。',
      '直连 OpenCLI daemon（单条约 10ms），不走 `opencli` CLI 冷启动（每条 1.4–1.8s）。',
      '做法：一次调用用 codes 数组跑多条表达式（点击→等待→读取），不要为每一步单独调用。',
      '表达式是 async 求值的，可直接 `await fetch(...)` 或 `await new Promise(r => setTimeout(r, 500))`。',
      '适用：读取页面状态（location.href / document.title / querySelector 文本 / localStorage / JSON-LD）、点击、填表、提取列表。',
      '不适用：无头隔离的简单页面测试（用 Playwright）；需要截图或像素比对时说明并改用 Playwright/OpenCLI CLI。',
      '它会操作用户真实浏览器：写操作前先用 oc_snapshot 或先读取确认目标，别盲点。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '单条 JS 表达式（与 codes 二选一）' },
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: `按顺序执行的表达式，最多 ${MAX_EXPRESSIONS} 条；前一条的返回值无法在源码里引用，需要时把状态写进 window 再读`,
        },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选；省略时 daemon 用该 session 的当前自动化 tab）' },
        frameIndex: { type: 'integer', description: '在指定 iframe 里求值（0 = 主文档）' },
        timeoutMs: { type: 'integer', description: `单条表达式上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '所有表达式都成功' },
          session: { type: 'string' },
          elapsedMs: { type: 'number' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string', description: '表达式预览（截断到 80 字符）' },
                ok: { type: 'boolean' },
                ms: { type: 'number' },
                json: { type: 'string', description: '返回值的 JSON，超过 8000 字符会截断' },
                page: { type: 'string' },
                error: { type: 'string' },
                errorCode: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object' || !Array.isArray(value.results)) {
          return [{ type: 'text', text: stringifyValue(value) }];
        }
        const total = value.results.length;
        const passed = value.results.filter(item => item?.ok).length;
        const lines = [`oc_exec · session=${value.session ?? '?'} · ${passed}/${total} ok · ${value.elapsedMs ?? 0}ms`];
        value.results.forEach((item, index) => {
          lines.push(`[${index + 1}] ${item?.ok ? 'ok' : 'FAIL'} ${item?.ms ?? 0}ms  ${item?.code ?? ''}`);
          if (item?.ok) lines.push(indent(String(item?.json ?? 'undefined')));
          else lines.push(indent(`${item?.errorCode ?? 'error'}: ${item?.error ?? 'unknown error'}`));
        });
        if (value.hint) lines.push(`hint: ${value.hint}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['code', 'codes', 'session', 'page', 'frameIndex', 'timeoutMs']);
      const expressions = [];
      const single = optionalString(input, 'code', 200_000);
      if (single) expressions.push(single);
      const batch = input.codes;
      if (batch !== undefined && batch !== null) {
        if (!Array.isArray(batch)) throw new Error(`invalid codes: expected an array of strings, got ${JSON.stringify(batch)}`);
        for (const [index, entry] of batch.entries()) {
          if (typeof entry !== 'string' || entry.trim() === '') {
            throw new Error(`invalid codes[${index}]: expected a non-empty string`);
          }
          expressions.push(entry);
        }
      }
      if (expressions.length === 0) throw new Error('oc_exec 需要 code（单条）或 codes（字符串数组）里的至少一条非空表达式');
      if (expressions.length > MAX_EXPRESSIONS) {
        throw new Error(`oc_exec 单次最多 ${MAX_EXPRESSIONS} 条表达式（收到 ${expressions.length}）；请拆成多次调用`);
      }
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const frameIndex = optionalPositiveInteger(input, 'frameIndex', 64);
      const timeoutMs = clamp(input.timeoutMs === undefined ? config.timeoutMs : (optionalPositiveInteger(input, 'timeoutMs'), clamp(input.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

      const started = Date.now();
      const results = [];
      let fatal;
      for (const expression of expressions) {
        const startedAt = Date.now();
        try {
          const params = { code: expression, session, surface: 'browser' };
          if (page) params.page = page;
          if (frameIndex !== undefined) params.frameIndex = frameIndex;
          const { data, page: resolvedPage } = await client.command('exec', params, { timeoutMs, signal: exec?.signal });
          results.push({
            code: previewExpression(expression),
            ok: true,
            ms: Date.now() - startedAt,
            json: stringifyValue(data),
            ...(resolvedPage ? { page: resolvedPage } : {}),
          });
        } catch (error) {
          // The item schema carries no `hint`: the remediation belongs once, at the top level.
          const info = error instanceof DaemonError ? error : toDaemonError(error, 'daemon');
          results.push({
            code: previewExpression(expression),
            ok: false,
            ms: Date.now() - startedAt,
            error: info.message,
            errorCode: info.code,
          });
          fatal = fatal ?? { error: info.message, errorCode: info.code, ...(info.hint ? { hint: info.hint } : {}) };
          // A dead daemon or a closed page fails every remaining expression too.
          if (info.code === 'daemon_unreachable') break;
        }
      }
      return {
        ok: results.every(item => item.ok),
        session,
        elapsedMs: Date.now() - started,
        results,
        ...(fatal ?? {}),
      };
    },
  };

  /* oc_navigate --------------------------------------------------------- */
  base.navigate = {
    name: 'oc_navigate',
    description: [
      '让 OpenCLI 驱动的浏览器打开一个 URL 并等页面加载完成，返回标题、最终 URL 与是否超时。',
      '适合在 oc_exec 之前把目标页定位好；对需要登录态的站点会直接复用浏览器里已有的会话。',
      '会切换该 session 自动化标签页的地址（是写操作）：不要用它覆盖用户正在手动浏览的标签页，除非用户要求。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的 http(s) URL' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        timeoutMs: { type: 'integer', description: `导航等待上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
        page: { type: 'string', description: '目标 page id（可选）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          url: { type: 'string', description: '最终 URL（跟随重定向后）' },
          title: { type: 'string' },
          timedOut: { type: 'boolean', description: 'true 表示壳已就绪但页面仍在加载' },
          page: { type: 'string' },
          ms: { type: 'number' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_navigate FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        const lines = [
          `oc_navigate → ${value.url}`,
          `title: ${value.title ?? '(empty)'}`,
          `${value.timedOut ? '页面仍在加载（timedOut）' : '已加载'} · ${value.ms ?? 0}ms${value.page ? ` · page=${value.page}` : ''}`,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['url', 'session', 'timeoutMs', 'page']);
      const url = optionalString(input, 'url', 4_000);
      if (!url) throw new Error('oc_navigate 需要 url');
      if (!/^https?:\/\//i.test(url)) throw new Error(`invalid url: 只接受 http(s) URL，收到 ${JSON.stringify(url)}`);
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

      const startedAt = Date.now();
      try {
        const params = { url, session, surface: 'browser' };
        if (page) params.page = page;
        const { data, page: resolvedPage } = await client.command('navigate', params, { timeoutMs, signal: exec?.signal });
        const payload = data && typeof data === 'object' ? data : {};
        return {
          ok: true,
          url: typeof payload.url === 'string' ? payload.url : url,
          ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
          timedOut: payload.timedOut === true,
          ...(resolvedPage ? { page: resolvedPage } : {}),
          ms: Date.now() - startedAt,
        };
      } catch (error) {
        return { ok: false, url, ms: Date.now() - startedAt, ...errorFields(error) };
      }
    },
  };

  /* oc_tabs ------------------------------------------------------------- */
  base.tabs = {
    name: 'oc_tabs',
    description: [
      '查看 / 新建 / 关闭 / 切换 OpenCLI 控制的浏览器标签页。',
      '排障第一个该跑的工具：oc_exec 报 page 失效时，先用 op=list 拿到最新的 index 与 page id。',
      'op=new 会真的在用户浏览器里开标签页，op=close 会关掉它，op=select 只把自动化 tab 指向容器内已有页面——这三个都是写操作。',
      'op=list 只列「自动化容器」里的 tab；容器外用户自己的标签页不会出现，也不能被 select。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'new', 'close', 'select'],
          description: 'list 只读；new/close/select 会改变用户浏览器里的标签页',
        },
        index: { type: 'integer', description: 'op=close/select 时的标签页序号（来自 list）' },
        page: { type: 'string', description: 'op=close/select 时的 page id（与 index 二选一）' },
        url: { type: 'string', description: 'op=new 时可选的首地址' },
        session: { type: 'string', description: `${SESSION_DESCRIPTION}；daemon 要求 tabs 各 op 都带 session，省略时用插件默认值` },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          op: { type: 'string' },
          count: { type: 'integer' },
          page: { type: 'string', description: 'op=select 生效后指向的 page id' },
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                url: { type: 'string' },
                title: { type: 'string' },
                active: { type: 'boolean' },
                page: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok', 'op'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_tabs ${value.op} FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        const tabs = Array.isArray(value.tabs) ? value.tabs : [];
        if (tabs.length === 0) {
          const suffix = value.page ? ` · page=${value.page}` : '';
          return [{ type: 'text', text: value.op === 'list'
            ? `oc_tabs list · 自动化容器内没有标签页${suffix}`
            : `oc_tabs ${value.op} ok${suffix}` }];
        }
        const lines = [`oc_tabs ${value.op} · ${value.count ?? tabs.length} tab(s)${value.page ? ` · active page=${value.page}` : ''}`];
        for (const tab of tabs) {
          lines.push(`  ${tab?.active ? '*' : ' '} [${tab?.index ?? '?'}] ${tab?.title ? `${tab.title} — ` : ''}${tab?.url ?? ''}${tab?.page ? ` (page=${tab.page})` : ''}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['op', 'index', 'page', 'url', 'session']);
      const op = optionalString(input, 'op', 16);
      if (!['list', 'new', 'close', 'select'].includes(op)) {
        throw new Error(`invalid op: expected list|new|close|select, got ${JSON.stringify(input.op)}`);
      }
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const index = optionalPositiveInteger(input, 'index', 10_000);
      const page = optionalString(input, 'page', 200);
      const url = optionalString(input, 'url', 4_000);
      if ((op === 'close' || op === 'select') && index === undefined && !page) {
        throw new Error(`oc_tabs op=${op} 需要 index 或 page（先用 op=list 取列表）`);
      }
      if (url && !/^https?:\/\//i.test(url)) throw new Error(`invalid url: 只接受 http(s) URL，收到 ${JSON.stringify(url)}`);

      const params = { op, session };
      if (index !== undefined) params.index = index;
      if (page) params.page = page;
      if (op === 'new' && url) params.url = url;
      try {
        const { data, page: resolvedPage } = await client.command('tabs', params, { signal: exec?.signal });
        const payload = data && typeof data === 'object' ? data : {};
        const rawTabs = Array.isArray(payload.tabs) ? payload.tabs : (Array.isArray(data) ? data : []);
        const tabs = rawTabs.map(tab => ({
          ...(Number.isInteger(tab?.index) ? { index: tab.index } : {}),
          ...(typeof tab?.url === 'string' ? { url: tab.url } : {}),
          ...(typeof tab?.title === 'string' ? { title: tab.title } : {}),
          active: tab?.active === true,
          ...(typeof tab?.page === 'string' ? { page: tab.page } : {}),
        }));
        const nextPage = typeof resolvedPage === 'string' ? resolvedPage : (typeof payload.page === 'string' ? payload.page : undefined);
        return {
          ok: true,
          op,
          count: tabs.length,
          ...(nextPage ? { page: nextPage } : {}),
          ...(tabs.length > 0 ? { tabs } : {}),
        };
      } catch (error) {
        return { ok: false, op, ...errorFields(error) };
      }
    },
  };

  /* oc_status ----------------------------------------------------------- */
  base.status = {
    name: 'oc_status',
    description: [
      '读取本地 OpenCLI daemon 与浏览器扩展的健康状况：daemon 版本、是否监听、扩展是否连上、contextId、profiles、内存占用。',
      '所有 oc_* 工具失败时先跑它：它能区分「daemon 没起」「扩展没连」「profile 没选」这三种完全不同的修法。',
      '只读。',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'daemon 在线且扩展已连接' },
          port: { type: 'integer' },
          daemonVersion: { type: 'string' },
          extensionConnected: { type: 'boolean' },
          extensionVersion: { type: 'string' },
          contextId: { type: 'string' },
          uptimeMs: { type: 'number' },
          memoryMB: { type: 'number' },
          profiles: { type: 'array', items: { type: 'string' }, description: '每个 profile 一行：contextId · 版本 · 是否连接' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        const lines = [
          `OpenCLI daemon: ${value.ok ? 'ok' : 'NOT READY'} · 127.0.0.1:${value.port ?? '?'}`,
          ...(value.daemonVersion ? [`daemon 版本: ${value.daemonVersion}`] : []),
          ...(value.extensionConnected === undefined ? [] : [`扩展: ${value.extensionConnected ? `connected${value.extensionVersion ? ` (v${value.extensionVersion})` : ''}` : 'DISCONNECTED'}`]),
          ...(value.contextId ? [`contextId: ${value.contextId}`] : []),
          ...(value.memoryMB === undefined ? [] : [`内存: ${value.memoryMB} MB`]),
          ...(Array.isArray(value.profiles) && value.profiles.length > 0 ? [`profiles:\n${indent(value.profiles.join('\n'))}`] : []),
          ...(value.error ? [`error ${value.errorCode ?? ''}: ${value.error}`] : []),
          ...(value.hint ? [`hint: ${value.hint}`] : []),
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_args, exec) {
      try {
        const { status } = await client.status({ signal: exec?.signal });
        const profiles = Array.isArray(status?.profiles)
          ? status.profiles.map(profile => {
            if (typeof profile === 'string') return profile;
            const id = profile?.contextId ?? profile?.id ?? profile?.name ?? '?';
            const version = profile?.version ? ` · v${profile.version}` : '';
            const connected = profile?.connected === true ? ' · connected' : (profile?.connected === false ? ' · disconnected' : '');
            return `${id}${version}${connected}`;
          })
          : [];
        const extensionConnected = typeof status?.extensionConnected === 'boolean'
          ? status.extensionConnected
          : (typeof status?.extension?.connected === 'boolean' ? status.extension.connected : undefined);
        return {
          ok: extensionConnected !== false,
          port: config.port,
          ...(typeof status?.daemonVersion === 'string' ? { daemonVersion: status.daemonVersion } : {}),
          ...(extensionConnected === undefined ? {} : { extensionConnected }),
          ...(typeof status?.extensionVersion === 'string' ? { extensionVersion: status.extensionVersion } : {}),
          ...(typeof status?.contextId === 'string' ? { contextId: status.contextId } : {}),
          ...(Number.isFinite(status?.uptimeMs) ? { uptimeMs: status.uptimeMs } : {}),
          ...(Number.isFinite(status?.memoryMB) ? { memoryMB: status.memoryMB } : {}),
          ...(profiles.length > 0 ? { profiles } : {}),
        };
      } catch (error) {
        return { ok: false, port: config.port, ...errorFields(error) };
      }
    },
  };

  /* oc_snapshot --------------------------------------------------------- */
  base.snapshot = {
    name: 'oc_snapshot',
    description: [
      '把当前页面压成一份精简的可交互结构：标题、链接（含 href）、按钮、输入框（含 name/placeholder）、select/textarea、角色元素，每行一条。',
      '比 `document.body.outerHTML` 便宜一个数量级，是 oc_exec 点击/填表前先看清页面的默认手段。',
      '不返回样式、图片、隐藏节点，也不返回表单以外的大段正文；需要整段文本时用 oc_exec 精确取 selector。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        limit: { type: 'integer', description: `最多收集多少个交互节点，1–${MAX_SNAPSHOT_LIMIT}（默认 ${DEFAULT_SNAPSHOT_LIMIT}）` },
        timeoutMs: { type: 'integer', description: `求值上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          url: { type: 'string' },
          title: { type: 'string' },
          count: { type: 'integer', description: '收集到的节点数' },
          truncated: { type: 'boolean', description: 'true 表示达到 limit 被截断' },
          outline: { type: 'string', description: '每行一个节点' },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_snapshot FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        const header = `oc_snapshot ${value.url ?? ''}${value.title ? ` — ${value.title}` : ''}\n`
          + `${value.count ?? 0} 个节点${value.truncated ? '（已截断，调大 limit 看更多）' : ''}${value.page ? ` · page=${value.page}` : ''}`;
        return [{ type: 'text', text: `${header}\n\n${value.outline ?? ''}` }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['session', 'page', 'limit', 'timeoutMs']);
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const rawLimit = input.limit;
      const limit = rawLimit === undefined ? DEFAULT_SNAPSHOT_LIMIT : clamp(optionalPositiveInteger(input, 'limit', MAX_SNAPSHOT_LIMIT), 1, MAX_SNAPSHOT_LIMIT);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const code = `(${snapshotProgram.toString()})(${limit})`;
      try {
        const params = { code, session, surface: 'browser' };
        if (page) params.page = page;
        const { data, page: resolvedPage } = await client.command('exec', params, { timeoutMs, signal: exec?.signal });
        const payload = data && typeof data === 'object' ? data : {};
        return {
          ok: true,
          url: typeof payload.url === 'string' ? payload.url : '',
          title: typeof payload.title === 'string' ? payload.title : '',
          count: Number.isFinite(payload.count) ? payload.count : 0,
          truncated: payload.truncated === true,
          outline: typeof payload.text === 'string' ? payload.text : '',
          ...(resolvedPage ? { page: resolvedPage } : {}),
        };
      } catch (error) {
        return { ok: false, ...errorFields(error) };
      }
    },
  };

/* oc_screenshot ------------------------------------------------------- */
  base.screenshot = {
    name: 'oc_screenshot',
    description: [
      '对当前标签页截图，PNG/JPEG/WebP 二进制落盘到本地临时目录，返回文件路径。',
      '想看图而不是拿路径时，用返回的 path 打开；需要像素级证据（元素位置、渲染结果）时比 oc_exec 更直接。',
      '写操作（会新建文件），但不改变页面状态。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        fullPage: { type: 'boolean', description: '是否整页截图（默认只截视口）' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: '图片格式，默认 png' },
        quality: { type: 'integer', description: 'jpeg/webp 质量 1–100' },
        width: { type: 'integer', description: '目标宽度（像素）' },
        height: { type: 'integer', description: '目标高度（像素）' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string', description: '截图落盘的绝对路径' },
          bytes: { type: 'integer' },
          format: { type: 'string' },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_screenshot FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        return [{ type: 'text', text: `oc_screenshot ok · ${value.format ?? 'png'} · ${value.bytes ?? 0} bytes\n${value.path ?? ''}` }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['session', 'page', 'fullPage', 'format', 'quality', 'width', 'height', 'timeoutMs']);
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const format = optionalString(input, 'format', 16) ?? 'png';
      if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error(`invalid format: expected png|jpeg|webp, got ${JSON.stringify(format)}`);
      const quality = input.quality === undefined ? undefined : clamp(optionalPositiveInteger(input, 'quality', 100), 1, 100);
      const width = optionalPositiveInteger(input, 'width', 16_000);
      const height = optionalPositiveInteger(input, 'height', 16_000);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { session, surface: 'browser', format };
        if (page) params.page = page;
        if (input.fullPage === true) params.fullPage = true;
        if (quality !== undefined) params.quality = quality;
        if (width !== undefined) params.width = width;
        if (height !== undefined) params.height = height;
        const { data, page: resolvedPage } = await client.command('screenshot', params, { timeoutMs, signal: exec?.signal });
        if (typeof data !== 'string' || data === '') throw new Error('daemon 返回的截图不是 base64 字符串');
        const buffer = Buffer.from(data, 'base64');
        const dir = path.join(os.tmpdir(), 'dsh-opencli', 'shots');
        await fs.promises.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(dir, `shot-${stamp}.${format}`);
        await fs.promises.writeFile(target, buffer);
        return {
          ok: true,
          path: target,
          bytes: buffer.length,
          format,
          ...(resolvedPage ? { page: resolvedPage } : {}),
        };
      } catch (error) {
        return { ok: false, ...errorFields(error) };
      }
    },
  };

  /* oc_cookies ---------------------------------------------------------- */
  base.cookies = {
    name: 'oc_cookies',
    description: [
      '读取浏览器某个域下的 cookie（登录态排查用）。',
      '必须给 domain 或 url：daemon 拒绝无范围的全量 dump，避免把整站凭据一次性拉进上下文。',
      '只读。返回的 value 就是凭据本身，转述给用户时不要贴全值。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '域名，例如 xiaohongshu.com' },
        url: { type: 'string', description: '页面 URL（按 URL 作用域取 cookie）' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        names: { type: 'array', items: { type: 'string' }, description: '只要这几个 cookie 名' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          cookies: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                domain: { type: 'string' },
                path: { type: 'string' },
                secure: { type: 'boolean' },
                httpOnly: { type: 'boolean' },
                expirationDate: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_cookies FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        const lines = [`oc_cookies · ${value.count ?? 0} cookie(s)`];
        for (const cookie of Array.isArray(value.cookies) ? value.cookies : []) {
          lines.push(`  ${cookie?.name} = ${cookie?.value ?? ''}  (${cookie?.domain ?? ''}${cookie?.path ?? ''})`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['domain', 'url', 'session', 'names', 'timeoutMs']);
      const domain = optionalString(input, 'domain', 300);
      const url = optionalString(input, 'url', 4_000);
      if (!domain && !url) throw new Error('oc_cookies 需要 domain 或 url（daemon 拒绝无范围的 cookie dump）');
      const names = input.names;
      if (names !== undefined && names !== null) {
        if (!Array.isArray(names) || names.some(item => typeof item !== 'string')) {
          throw new Error('invalid names: expected an array of strings');
        }
      }
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { session, surface: 'browser' };
        if (domain) params.domain = domain;
        if (url) params.url = url;
        const { data } = await client.command('cookies', params, { timeoutMs, signal: exec?.signal });
        const list = Array.isArray(data) ? data : [];
        const wanted = Array.isArray(names) && names.length > 0 ? new Set(names) : undefined;
        const cookies = list
          .filter(cookie => !wanted || wanted.has(cookie?.name))
          .map(cookie => ({
            name: String(cookie?.name ?? ''),
            value: String(cookie?.value ?? ''),
            ...(typeof cookie?.domain === 'string' ? { domain: cookie.domain } : {}),
            ...(typeof cookie?.path === 'string' ? { path: cookie.path } : {}),
            secure: cookie?.secure === true,
            httpOnly: cookie?.httpOnly === true,
            ...(Number.isFinite(cookie?.expirationDate) ? { expirationDate: cookie.expirationDate } : {}),
          }));
        return { ok: true, count: cookies.length, cookies };
      } catch (error) {
        return { ok: false, ...errorFields(error) };
      }
    },
  };

  /* oc_network ---------------------------------------------------------- */
  base.network = {
    name: 'oc_network',
    description: [
      '抓取页面网络请求：op=start 开始监听，op=read 读回已抓到的请求（URL/方法/状态/内容类型/请求体预览）。',
      '这是拿「页面真实 API 证据」的标准姿势：先 start，再做导航或交互，再 read。',
      'op=read 会清空已抓到的缓冲（每条命令只读一次）；不需要真实响应体时只看 url+status。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['start', 'read'], description: 'start 开始监听，read 读回缓冲' },
        pattern: { type: 'string', description: '只关心匹配该子串的 URL（start 时生效）' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          op: { type: 'string' },
          started: { type: 'boolean' },
          count: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                method: { type: 'string' },
                status: { type: 'integer' },
                contentType: { type: 'string' },
                kind: { type: 'string' },
                requestBody: { type: 'string', description: '请求体预览（截断）' },
              },
              additionalProperties: false,
            },
          },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok', 'op'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_network ${value.op} FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        if (value.op === 'start') return [{ type: 'text', text: 'oc_network start ok · 监听已开启，接下来做导航/交互再 read' }];
        const lines = [`oc_network read · ${value.count ?? 0} request(s)`];
        for (const entry of Array.isArray(value.entries) ? value.entries : []) {
          lines.push(`  ${entry?.method ?? 'GET'} ${entry?.status ?? '?'} ${entry?.url ?? ''}${entry?.contentType ? `  [${entry.contentType}]` : ''}`);
          if (entry?.requestBody) lines.push(indent(`body: ${entry.requestBody}`));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['op', 'pattern', 'session', 'page', 'timeoutMs']);
      const op = optionalString(input, 'op', 16);
      if (op !== 'start' && op !== 'read') throw new Error(`invalid op: expected start|read, got ${JSON.stringify(input.op)}`);
      const pattern = optionalString(input, 'pattern', 500);
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { session, surface: 'browser' };
        if (page) params.page = page;
        if (op === 'start') {
          if (pattern) params.pattern = pattern;
          const { data, page: resolvedPage } = await client.command('network-capture-start', params, { timeoutMs, signal: exec?.signal });
          return {
            ok: true,
            op,
            started: data?.started === true,
            ...(resolvedPage ? { page: resolvedPage } : {}),
          };
        }
        const { data, page: resolvedPage } = await client.command('network-capture-read', params, { timeoutMs, signal: exec?.signal });
        const list = Array.isArray(data) ? data : [];
        const entries = list.map(item => ({
          url: String(item?.url ?? ''),
          method: typeof item?.method === 'string' ? item.method : 'GET',
          ...(Number.isFinite(item?.responseStatus) ? { status: item.responseStatus } : {}),
          ...(typeof item?.responseContentType === 'string' ? { contentType: item.responseContentType } : {}),
          ...(typeof item?.kind === 'string' ? { kind: item.kind } : {}),
          ...(typeof item?.requestBodyPreview === 'string' && item.requestBodyPreview !== ''
            ? { requestBody: item.requestBodyPreview.slice(0, 2_000) } : {}),
        }));
        return { ok: true, op, count: entries.length, entries, ...(resolvedPage ? { page: resolvedPage } : {}) };
      } catch (error) {
        return { ok: false, op, ...errorFields(error) };
      }
    },
  };

  /* oc_upload ----------------------------------------------------------- */
  base.upload = {
    name: 'oc_upload',
    description: [
      '给页面上的 <input type=file> 塞本地文件路径（走 CDP DOM.setFileInputFiles，不是 base64 注入）。',
      'files 是本机绝对路径数组；selector 是该 input 的 CSS 选择器。',
      '写操作：会真的向站点提交文件内容，确认目标后再调。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '本机文件绝对路径列表' },
        selector: { type: 'string', description: 'file input 的 CSS 选择器' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      required: ['files', 'selector'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer', description: '成功挂载的文件数' },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_upload FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        return [{ type: 'text', text: `oc_upload ok · ${value.count ?? 0} file(s)${value.page ? ` · page=${value.page}` : ''}` }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['files', 'selector', 'session', 'page', 'timeoutMs']);
      const files = input.files;
      if (!Array.isArray(files) || files.length === 0) throw new Error('oc_upload 需要非空的 files 数组');
      for (const [index, file] of files.entries()) {
        if (typeof file !== 'string' || file.trim() === '') throw new Error(`invalid files[${index}]: expected a non-empty string path`);
      }
      const selector = optionalString(input, 'selector', 2_000);
      if (!selector) throw new Error('oc_upload 需要 selector（file input 的 CSS 选择器）');
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { files, selector, session, surface: 'browser' };
        if (page) params.page = page;
        const { data, page: resolvedPage } = await client.command('set-file-input', params, { timeoutMs, signal: exec?.signal });
        return {
          ok: true,
          count: Number.isFinite(data?.count) ? data.count : files.length,
          ...(resolvedPage ? { page: resolvedPage } : {}),
        };
      } catch (error) {
        return { ok: false, ...errorFields(error) };
      }
    },
  };

  /* oc_input ------------------------------------------------------------ */
  base.input = {
    name: 'oc_input',
    description: [
      '向当前焦点元素插入文本（原生键盘输入，触发 input/change 事件，React 也能收到）。',
      '先 click/focus 目标再调它；已经聚焦时可直接调。',
      '写操作。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要插入的文本' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          inserted: { type: 'boolean' },
          length: { type: 'integer' },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_input FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        return [{ type: 'text', text: `oc_input ok · ${value.length ?? 0} 字符` }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['text', 'session', 'page', 'timeoutMs']);
      const text = optionalString(input, 'text', 100_000);
      if (!text) throw new Error('oc_input 需要非空 text');
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { text, session, surface: 'browser' };
        if (page) params.page = page;
        const { data, page: resolvedPage } = await client.command('insert-text', params, { timeoutMs, signal: exec?.signal });
        return {
          ok: true,
          inserted: data?.inserted === true,
          length: text.length,
          ...(resolvedPage ? { page: resolvedPage } : {}),
        };
      } catch (error) {
        return { ok: false, ...errorFields(error) };
      }
    },
  };

  /* oc_frames ----------------------------------------------------------- */
  base.frames = {
    name: 'oc_frames',
    description: [
      '列出页面里的跨域 iframe 目标（url + frame 索引），便于对指定 frame 执行表达式。',
      '拿到 frameIndex 后用 oc_exec 的 frameIndex 参数在该 frame 里求值。',
      '只读。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          frames: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                index: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_frames FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        const lines = [`oc_frames · ${value.count ?? 0} frame(s)`];
        for (const frame of Array.isArray(value.frames) ? value.frames : []) {
          lines.push(`  [${frame?.index ?? '?'}] ${frame?.url ?? ''}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['session', 'page', 'timeoutMs']);
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { session, surface: 'browser' };
        if (page) params.page = page;
        const { data, page: resolvedPage } = await client.command('frames', params, { timeoutMs, signal: exec?.signal });
        const list = Array.isArray(data) ? data : [];
        const frames = list.map((frame, index) => ({
          url: String(frame?.url ?? frame?.frameUrl ?? ''),
          index: Number.isFinite(frame?.index) ? frame.index : index,
        }));
        return { ok: true, count: frames.length, frames, ...(resolvedPage ? { page: resolvedPage } : {}) };
      } catch (error) {
        return { ok: false, ...errorFields(error) };
      }
    },
  };

  /* oc_cdp -------------------------------------------------------------- */
  base.cdp = {
    name: 'oc_cdp',
    description: [
      '直接发一条 Chrome DevTools Protocol 命令（扩展侧有方法白名单，越权方法会被 daemon 拒绝）。',
      '常用：Page.captureScreenshot、DOM.getDocument、DOM.getBoxModel、Input.dispatchMouseEvent、Runtime.enable。',
      '注意 Runtime.evaluate 不在白名单里——求值请用 oc_exec。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'CDP 方法名，例如 DOM.getBoxModel' },
        params: { type: 'object', description: 'CDP 参数对象' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      required: ['method'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          method: { type: 'string' },
          result: { type: 'string', description: 'CDP 返回的 JSON（超过 8000 字符会截断）' },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok', 'method'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_cdp ${value.method} FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        return [{ type: 'text', text: `oc_cdp ${value.method} ok\n${value.result ?? ''}` }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['method', 'params', 'session', 'page', 'timeoutMs']);
      const method = optionalString(input, 'method', 200);
      if (!method) throw new Error('oc_cdp 需要 method');
      const cdpParams = input.params;
      if (cdpParams !== undefined && cdpParams !== null && (typeof cdpParams !== 'object' || Array.isArray(cdpParams))) {
        throw new Error('invalid params: expected an object');
      }
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { cdpMethod: method, cdpParams: cdpParams ?? {}, session, surface: 'browser' };
        if (page) params.page = page;
        const { data, page: resolvedPage } = await client.command('cdp', params, { timeoutMs, signal: exec?.signal });
        return {
          ok: true,
          method,
          result: stringifyValue(data),
          ...(resolvedPage ? { page: resolvedPage } : {}),
        };
      } catch (error) {
        return { ok: false, method, ...errorFields(error) };
      }
    },
  };

  /* oc_chrome ----------------------------------------------------------- */
  base.chrome = {
    name: 'oc_chrome',
    description: [
      '管理浏览器「原生」的标签页、分组和窗口（不绑定页面，不占用 session）：op=describe 列出支持的方法，op=call 调用其中一个。',
      '可用方法：tabs.query/get/create/duplicate/update/move/remove、tabGroups.query/get/update/move、windows.get/getAll/create/update/remove。',
      'op=call 的 args 是位置参数数组，例如 tabs.query 传 [{"url":"https://example.com"}]。',
      '写操作：create/remove/update 会真的改变用户浏览器里的窗口与标签。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['describe', 'call'], description: 'describe 列出方法，call 调用方法' },
        method: { type: 'string', description: 'op=call 时的方法名，例如 tabs.query' },
        args: { type: 'array', items: {}, description: 'op=call 时的位置参数数组' },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          op: { type: 'string' },
          method: { type: 'string' },
          methods: { type: 'array', items: { type: 'string' }, description: 'op=describe 时可用方法名' },
          notes: { type: 'string', description: 'op=describe 时 daemon 给的说明（ids/lifecycle 等）' },
          tabs: {
            type: 'array',
            description: 'op=call 且结果是标签页列表时的精简视图',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                id: { type: 'integer' },
                title: { type: 'string' },
                url: { type: 'string' },
                groupId: { type: 'integer' },
                windowId: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          result: { type: 'string', description: '非标签页结果的 JSON（超过 8000 字符会截断）' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok', 'op'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_chrome ${value.op} FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        if (value.op === 'describe') {
          const lines = [`oc_chrome describe · ${(value.methods ?? []).length} 个方法`];
          for (const method of value.methods ?? []) lines.push(`  ${method}`);
          if (value.notes) lines.push(indent(value.notes));
          return [{ type: 'text', text: lines.join('\n') }];
        }
        const lines = [`oc_chrome call ${value.method ?? ''} ok`];
        for (const tab of Array.isArray(value.tabs) ? value.tabs : []) {
          lines.push(`  [${tab?.index ?? '?'}] ${tab?.title ? `${tab.title} — ` : ''}${tab?.url ?? ''}`);
        }
        if (value.result) lines.push(value.result);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['op', 'method', 'args', 'timeoutMs']);
      const op = optionalString(input, 'op', 16);
      if (op !== 'describe' && op !== 'call') throw new Error(`invalid op: expected describe|call, got ${JSON.stringify(input.op)}`);
      const method = optionalString(input, 'method', 200);
      const callArgs = input.args;
      if (callArgs !== undefined && callArgs !== null && !Array.isArray(callArgs)) throw new Error('invalid args: expected an array');
      if (op === 'call' && !method) throw new Error('oc_chrome op=call 需要 method');
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        if (op === 'describe') {
          const { data } = await client.command('chrome-describe', { surface: 'browser' }, { timeoutMs, signal: exec?.signal });
          const methods = Array.isArray(data?.methods) ? data.methods.map(item => String(item)) : [];
          const notes = [data?.ids, data?.lifecycle].filter(part => typeof part === 'string' && part !== '').join('\n');
          return { ok: true, op, methods, ...(notes ? { notes } : {}) };
        }
        const params = { chromeMethod: method, chromeArgs: callArgs ?? [], surface: 'browser' };
        const { data } = await client.command('chrome-call', params, { timeoutMs, signal: exec?.signal });
        const list = Array.isArray(data) ? data : undefined;
        if (list && list.every(item => item && typeof item === 'object' && typeof item.url === 'string')) {
          const tabs = list.map((item, index) => ({
            index: Number.isFinite(item.index) ? item.index : index,
            ...(Number.isFinite(item.id) ? { id: item.id } : {}),
            ...(typeof item.title === 'string' ? { title: item.title } : {}),
            url: item.url,
            ...(Number.isFinite(item.groupId) ? { groupId: item.groupId } : {}),
            ...(Number.isFinite(item.windowId) ? { windowId: item.windowId } : {}),
          }));
          return { ok: true, op, method, tabs };
        }
        return { ok: true, op, method, result: stringifyValue(data) };
      } catch (error) {
        return { ok: false, op, ...(method ? { method } : {}), ...errorFields(error) };
      }
    },
  };

  /* oc_close ------------------------------------------------------------ */
  base.close = {
    name: 'oc_close',
    description: [
      '关闭当前 session 占用的浏览器资源：op=window 关掉自动化窗口，op=tab 只关掉它自己开的那个标签页。',
      '写操作：会真的关掉用户浏览器里的窗口/标签。任务收尾时用它释放资源。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['window', 'tab'], description: 'window 关自动化窗口，tab 关自己开的标签页' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        timeoutMs: { type: 'integer', description: `超时上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          op: { type: 'string' },
          closed: { type: 'boolean' },
          session: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok', 'op'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_close ${value.op} FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        return [{ type: 'text', text: `oc_close ${value.op} ok${value.session ? ` · session=${value.session}` : ''}` }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['op', 'session', 'timeoutMs']);
      const op = optionalString(input, 'op', 16);
      if (op !== 'window' && op !== 'tab') throw new Error(`invalid op: expected window|tab, got ${JSON.stringify(input.op)}`);
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const action = op === 'tab' ? 'close-owned-tab' : 'close-window';
        const { data } = await client.command(action, { session, surface: 'browser' }, { timeoutMs, signal: exec?.signal });
        return {
          ok: true,
          op,
          closed: data?.closed === true || data?.tabCleanup === 'closed-owned-tab',
          session,
        };
      } catch (error) {
        return { ok: false, op, session, ...errorFields(error) };
      }
    },
  };

  /* oc_download --------------------------------------------------------- */
  base.download = {
    name: 'oc_download',
    description: [
      '等待一次浏览器下载完成，返回落盘信息（文件名/路径/大小）。',
      '先触发下载再调它；pattern 用来只等匹配该子串的 URL。',
      '这个动作会阻塞到下载结束或超时，不要在没有下载发生时调用。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '只等匹配该子串的下载 URL' },
        session: { type: 'string', description: SESSION_DESCRIPTION },
        page: { type: 'string', description: '目标 page id（可选）' },
        timeoutMs: { type: 'integer', description: `等待上限，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          filename: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          url: { type: 'string' },
          page: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: stringifyValue(value) }];
        if (!value.ok) {
          return [{ type: 'text', text: `oc_download FAIL ${value.errorCode ?? 'error'}: ${value.error ?? 'unknown'}\n`
            + `${value.hint ? `hint: ${value.hint}` : ''}`.trim() }];
        }
        return [{ type: 'text', text: `oc_download ok · ${value.filename ?? '(unnamed)'}${value.bytes ? ` · ${value.bytes} bytes` : ''}\n${value.path ?? ''}` }];
      },
    },
    async execute(args, exec) {
      const input = assertKnownArguments(args, ['pattern', 'session', 'page', 'timeoutMs']);
      const pattern = optionalString(input, 'pattern', 500);
      const session = optionalString(input, 'session', 120) ?? config.defaultSession;
      const page = optionalString(input, 'page', 200);
      const timeoutMs = input.timeoutMs === undefined
        ? config.timeoutMs
        : clamp(optionalPositiveInteger(input, 'timeoutMs'), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const params = { session, surface: 'browser', timeoutMs };
        if (pattern) params.pattern = pattern;
        if (page) params.page = page;
        const { data, page: resolvedPage } = await client.command('wait-download', params, { timeoutMs, signal: exec?.signal });
        const payload = data && typeof data === 'object' ? data : {};
        return {
          ok: true,
          ...(typeof payload.filename === 'string' ? { filename: payload.filename } : {}),
          ...(typeof payload.path === 'string' ? { path: payload.path } : {}),
          ...(Number.isFinite(payload.bytes) ? { bytes: payload.bytes } : {}),
          ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
          ...(resolvedPage ? { page: resolvedPage } : {}),
        };
      } catch (error) {
        return { ok: false, ...errorFields(error) };
      }
    },
  };

  return Object.values(base);
}

/* -------------------------------------------------------------------- plugin */

/**
 * Mount the OpenCLI tools on this context.
 * @param {import('cordis').Context} ctx - the plugin context.
 * @param {unknown} [config] - saved config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config, message => report(ctx, `dsh-opencli: ${message}`));
  const client = new DaemonClient(cfg);
  const definitions = buildTools(cfg, client);
  for (const definition of definitions) {
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => ctx.tools.register(definition));
      else ctx.tools.register(definition);
    } catch (error) {
      report(ctx, `dsh-opencli: 注册 ${definition.name} 失败：${String(error?.message ?? error)}`, 'error');
    }
  }
  report(ctx, `dsh-opencli: ${definitions.length} 个工具已挂载，daemon ${cfg.base}，默认 session=${cfg.defaultSession}`, 'info');
  ctx.on?.('dispose', () => client.reset?.());
}
