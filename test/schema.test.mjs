// Schema conformance for every tool this package registers.
//
// The harness validates each tool's `output.schema` strictly
// (`additionalProperties: false`), so a single undeclared field turns a call into
// `tool "oc_xxx" returned invalid output: ... is not a declared property`.
// That only ever surfaces on a real invocation, never by calling `execute()`
// directly — hence this test: mount the plugin on a fake context, run the real
// tools against the real daemon, and check every response against its schema.
//
// Needs a running OpenCLI daemon (`opencli daemon status`). Without one the live
// assertions are skipped and only the daemon-down envelope is verified.

import { apply } from '../index.js';

const DAEMON_PORT = 19825;

/** Minimal JSON-Schema checker: type / properties / required / additionalProperties / items / enum. */
function validate(schema, value, path = '$') {
  const problems = [];
  if (!schema || typeof schema !== 'object') return problems;
  const typeOf = (input) => {
    if (input === null) return 'null';
    if (Array.isArray(input)) return 'array';
    if (typeof input === 'number' && Number.isInteger(input)) return 'integer';
    return typeof input;
  };
  const matches = (expected, actual) => expected === actual
    || (expected === 'number' && actual === 'integer')
    || (expected === 'boolean' && (actual === 'true' || actual === 'false'));
  if (typeof schema.type === 'string' && !matches(schema.type, typeOf(value))) {
    problems.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return problems;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(`${path}.${key}: required but missing`);
    }
    const declared = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (declared[key] === undefined) {
        if (schema.additionalProperties === false) problems.push(`${path}.${key}: not a declared property`);
        continue;
      }
      if (item === undefined) continue;
      problems.push(...validate(declared[key], item, `${path}.${key}`));
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, index) => problems.push(...validate(schema.items, item, `${path}[${index}]`)));
  }
  return problems;
}

function mount(config) {
  const tools = new Map();
  apply({
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    effect: callback => callback(),
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
  }, config);
  return tools;
}

async function check(tools, name, args) {
  const definition = tools.get(name);
  if (!definition) throw new Error(`${name} was not registered`);
  const value = await definition.execute(args);
  const problems = validate(definition.output.schema, value);
  const rendered = definition.output.render(args, value).map(block => block.text ?? '').join('\n');
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  console.log(rendered.slice(0, 500));
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  - SCHEMA: ${problem}`);
  } else {
    console.log('schema: ok');
  }
  return problems.length;
}

async function daemonUp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const tools = mount({ port: DAEMON_PORT, defaultSession: 'dsh-opencli-test', timeoutMs: 20000 });
console.log(`registered: ${[...tools.keys()].join(', ')}`);

let problems = 0;
if (await daemonUp(DAEMON_PORT)) {
  problems += await check(tools, 'oc_status', {});
  problems += await check(tools, 'oc_navigate', { url: 'https://example.com/' });
  problems += await check(tools, 'oc_exec', { codes: ['location.href', 'document.title', '1 + 1'] });
  problems += await check(tools, 'oc_snapshot', { limit: 6 });
  problems += await check(tools, 'oc_tabs', { op: 'list' });
  // Failure envelopes travel through the same schemas.
  problems += await check(tools, 'oc_exec', { code: 'window.__nope__.x' });
  problems += await check(tools, 'oc_exec', { codes: ['1 + 1'], page: 'no_such_page_xyz' });
  problems += await check(tools, 'oc_tabs', { op: 'select', page: 'no_such_page_xyz' });
} else {
  console.log(`\nNo OpenCLI daemon on 127.0.0.1:${DAEMON_PORT} — live checks skipped.`);
}

// Closed port: the tool must report the failure instead of throwing.
const closedPort = 19826;
const closedTools = mount({ port: closedPort, defaultSession: 'dsh-opencli-test', timeoutMs: 4000 });
if (await daemonUp(closedPort)) {
  console.log(`\nPort ${closedPort} is serving something — skipping the daemon-down check.`);
} else {
  const value = await closedTools.get('oc_exec').execute({ code: '1 + 1' });
  const downProblems = validate(closedTools.get('oc_exec').output.schema, value);
  problems += downProblems.length;
  console.log('\n=== oc_exec with daemon down ===');
  console.log(closedTools.get('oc_exec').output.render({ code: '1 + 1' }, value).map(block => block.text).join('\n'));
  console.log(downProblems.length === 0 ? 'schema: ok' : `SCHEMA PROBLEMS: ${downProblems.join('; ')}`);
}

console.log(`\nschema problems: ${problems}`);
process.exitCode = problems === 0 ? 0 : 1;
