// Agent-user tools: a person provisions their own agents over MCP.
// idea-base.us GH #526 / IDEA Base task 991212, criterion 3.
//
//   npm test        (node --test src/*.test.js)
//
// CEO, 2026-11-21, verbatim: "Any paid user should be able to. And they should
// be able to over the MCP/API."
//
// ── WHAT THIS FILE IS REALLY GUARDING ────────────────────────────────────
//
// One line, and it is not an obvious one: these six handlers pass
// `declareAgent: false`, so they do NOT send `X-On-Behalf-Of`.
//
// That is deliberate and the reasoning is in `apiRequest`. Provisioning an
// agent is a PERSON acting on their own tooling with their own credential — no
// agent did that work — and the server refuses a request that declares an
// agent actor for exactly these operations (criterion 4: "an agent cannot
// create agents or issue keys"). Since this package declares `claude_ai` by
// default on every single request, these tools would 403 unconditionally
// without the flag, and criterion 3 would be unsatisfiable.
//
// It is also the kind of line a later refactor deletes while every other test
// stays green, because nothing else in the package behaves this way. So the
// assertions below are not "the handler calls the right URL" box-ticking:
//
//   * the header must be ABSENT on all six, proved by running the REAL
//     `apiRequest` against a mocked fetch and reading the headers it built;
//   * the header must be PRESENT on an ordinary tool — the discrimination
//     control, without which "absent everywhere" would also pass;
//   * the flag must NOT have spread beyond this block, checked over the source,
//     because its correctness is an argument about provisioning specifically.
//
// ── HOW IT LOADS THE MODULE ──────────────────────────────────────────────
//
// `src/index.js` calls `main()` at import and exports nothing, so a direct
// import would start a stdio server. It is staged into a scratch copy with that
// one trailing invocation removed and an export appended. Everything under test
// is therefore the SHIPPED code, not a transcription of it — including the real
// `apiRequest`, which is where the behaviour this file exists for actually
// lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = new URL('../', import.meta.url);
const SRC = readFileSync(new URL('src/index.js', repo), 'utf8');

const AGENT_TOOLS = [
  'list_agents', 'create_agent', 'issue_agent_key',
  'list_agent_keys', 'revoke_agent_key', 'remove_agent',
];

// ── stage the real module ─────────────────────────────────────────────────
// Staged in `src/` ITSELF, because index.js imports its own siblings relatively
// (`./cli.js`, `./features.js`) and those only resolve from the directory it
// actually lives in. Dot-prefixed so `node --test src/*.test.js` cannot pick
// the copies up as suites, and both are removed on exit.
const srcDir = join(fileURLToPath(repo), 'src');
const stagedPath = join(srcDir, `.ib-agents-staged-${process.pid}.mjs`);
const sdkStubPath = join(srcDir, `.ib-agents-sdk-stub-${process.pid}.mjs`);

// THE SDK IS STUBBED, and that is required rather than convenient: `npm test`
// in CI runs with NO node_modules installed (see .github/workflows/test.yml —
// checkout, setup-node, `npm test`, and no install step), because every other
// suite in this package reads index.js as TEXT and never imports it. An import
// of the real `@modelcontextprotocol/sdk` therefore dies with
// ERR_MODULE_NOT_FOUND in CI while passing locally, which is exactly how this
// file first went red on its own PR.
//
// Nothing under test touches the SDK. `main()` is stripped below, so no
// transport is ever connected; `new Server(...)` and `setRequestHandler(...)`
// run at import and must merely not throw. The six handlers and `apiRequest`
// are the real shipped code.
const SDK_STUB = `
export class Server {
  constructor() {}
  setRequestHandler() {}
  async connect() {}
}
export class StdioServerTransport {}
export const CallToolRequestSchema = { method: 'tools/call' };
export const ListToolsRequestSchema = { method: 'tools/list' };
export const ListPromptsRequestSchema = { method: 'prompts/list' };
export const GetPromptRequestSchema = { method: 'prompts/get' };
export const ErrorCode = { InvalidRequest: -32600, MethodNotFound: -32601, InternalError: -32603 };
export class McpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
`;
writeFileSync(sdkStubPath, SDK_STUB);

const MAIN_CALL = /main\(\)\.catch\([\s\S]*?\}\);\s*$/;
assert.ok(MAIN_CALL.test(SRC),
  'could not find the trailing main().catch(...) invocation — this stager is stale');

// Asserted rather than assumed: if the SDK import specifiers are ever changed,
// the rewrite below silently stops applying and the suite goes red in CI only.
const SDK_SPECIFIER = /'@modelcontextprotocol\/sdk\/[^']+'/g;
assert.equal((SRC.match(SDK_SPECIFIER) || []).length, 3,
  'expected exactly 3 @modelcontextprotocol/sdk imports in index.js — this stager is stale');

const staged = SRC
  .replace(MAIN_CALL, 'export { apiRequest, toolHandlers, tools, AGENT_ID };\n')
  .replace(SDK_SPECIFIER, `'./${basename(sdkStubPath)}'`);
writeFileSync(stagedPath, staged);
process.on('exit', () => {
  for (const p of [stagedPath, sdkStubPath]) {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});

// `src/index.js` exits the process when there is no API key, and resolves the
// base URL and agent id at import. Both are set before the import so the module
// loads at all, and so the assertions below know what to expect.
process.env.IDEA_BASE_API_KEY = 'ib_SAMPLEtestkeyNOTAREALCREDENTIAL1';
process.env.IDEA_BASE_AGENT_ID = 'sample_test_agent';
process.env.IDEA_BASE_API_URL = 'https://app.idea-base.us/api';

const mod = await import(pathToFileURL(stagedPath).href);
const { apiRequest, toolHandlers, tools, AGENT_ID } = mod;
const byName = new Map(tools.map((t) => [t.name, t]));

// ── a recording fetch ─────────────────────────────────────────────────────
// Replaces the global rather than injecting a seam, so the request under
// inspection is the one `apiRequest` really builds — headers included.
let calls = [];
function mockFetch({ status = 200, body = {} } = {}) {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
const headerOf = (call, name) => new Headers(call.options.headers).get(name);
const bodyOf = (call) => (call.options.body ? JSON.parse(call.options.body) : null);

// ═══════════════════════════════════════════════════════════════════════════
test('all six agent tools are declared', () => {
  for (const name of AGENT_TOOLS) {
    assert.ok(byName.has(name), `tool ${name} is missing from tools[]`);
    const t = byName.get(name);
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 40, `${name}: description is too thin to steer a model`);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('every agent tool is also wired to a handler', () => {
  // A tool in the list with no handler is a tool a model will call and get an
  // "Unknown tool" error from, which reads as the feature being broken.
  for (const name of AGENT_TOOLS) {
    assert.equal(typeof toolHandlers[name], 'function', `no handler for ${name}`);
  }
});

test('the schemas require what the API requires', () => {
  assert.deepEqual(byName.get('create_agent').inputSchema.required, ['name']);
  assert.deepEqual(byName.get('issue_agent_key').inputSchema.required, ['agent_user_id', 'name']);
  assert.deepEqual(byName.get('list_agent_keys').inputSchema.required, ['agent_user_id']);
  assert.deepEqual(byName.get('revoke_agent_key').inputSchema.required, ['key_id']);
  assert.deepEqual(byName.get('remove_agent').inputSchema.required, ['agent_user_id']);
  assert.deepEqual(byName.get('list_agents').inputSchema.properties, {},
    'list_agents takes no arguments');

  // The scope enum must match the API's allow-list exactly. A model offered a
  // value the server rejects produces a 400 that looks like a product bug.
  assert.deepEqual(
    byName.get('issue_agent_key').inputSchema.properties.permissions.enum,
    ['read', 'write', 'read,write']);
});

test('the descriptions state the rules the server enforces', () => {
  // A description is the entire interface a model sees before it decides what
  // to pass, so in this package it is behaviour rather than documentation.
  // Each of these corresponds to a refusal the server will actually issue.
  const create = byName.get('create_agent').description;
  assert.match(create, /PAID plan/i, 'create_agent must say a paid plan is required');
  assert.match(create, /cannot create another agent/i,
    'create_agent must say an agent cannot create an agent');
  assert.match(create, /no seat/i, 'create_agent must say an agent takes no seat');

  const issue = byName.get('issue_agent_key').description;
  assert.match(issue, /exactly once/i, 'issue_agent_key must say the key is shown once');
  assert.match(issue, /only its hash is stored/i);

  const remove = byName.get('remove_agent').description;
  assert.match(remove, /past work stays attributed/i,
    'remove_agent must say the identity is not deleted');

  for (const name of ['issue_agent_key', 'revoke_agent_key', 'remove_agent']) {
    assert.match(byName.get(name).description, /owner or admin/i,
      `${name} must state who may act on an agent that is not theirs`);
  }
});

// ── the line this file exists for ─────────────────────────────────────────

test('NO agent tool declares X-On-Behalf-Of', async () => {
  // Run the REAL apiRequest through each handler and read the headers it built.
  const invocations = {
    list_agents: [{}],
    create_agent: [{ name: 'SAMPLE Agent' }],
    issue_agent_key: [{ agent_user_id: 'agent_sample', name: 'SAMPLE key' }],
    list_agent_keys: [{ agent_user_id: 'agent_sample' }],
    revoke_agent_key: [{ key_id: 7 }],
    remove_agent: [{ agent_user_id: 'agent_sample' }],
  };

  for (const name of AGENT_TOOLS) {
    mockFetch({ body: { id: 'agent_sample', ok: true } });
    await toolHandlers[name](...invocations[name]);
    assert.equal(calls.length, 1, `${name}: expected exactly one API call`);
    assert.equal(headerOf(calls[0], 'X-On-Behalf-Of'), null,
      `${name} sent X-On-Behalf-Of. Provisioning an agent is a PERSON's act, and the ` +
      'server refuses a declared agent actor for these operations — this tool would 403 ' +
      'unconditionally. Pass declareAgent: false.');
    // The credential must still be sent. Dropping the actor header must not
    // have dropped the thing that authenticates the request.
    assert.match(headerOf(calls[0], 'Authorization') || '', /^Bearer /,
      `${name}: the API key must still be sent`);
  }
});

test('CONTROL: an ORDINARY tool DOES declare X-On-Behalf-Of', async () => {
  // Without this, "absent on all six" would also pass if the header had been
  // removed from the whole package — which would silently break attribution on
  // every other tool.
  mockFetch({ body: [] });
  await toolHandlers.list_projects({});
  assert.equal(calls.length, 1);
  assert.equal(headerOf(calls[0], 'X-On-Behalf-Of'), AGENT_ID,
    'an ordinary tool must still declare the agent actor — attribution depends on it');
  assert.equal(AGENT_ID, 'sample_test_agent');
});

test('the declareAgent escape hatch has NOT spread beyond agent provisioning', () => {
  // Its correctness is an argument about provisioning specifically. Anywhere
  // else it is an attribution bug: work an agent did, recorded as the key
  // owner, which makes the owner the actor of their own notifications.
  const occurrences = [...SRC.matchAll(/declareAgent/g)].length;
  assert.ok(occurrences > 0, 'the flag is gone — these tools will 403');
  // Expected sites: the JSDoc param, the destructure, the ternary, and the one
  // AGENT_PROVISIONING constant. Six handlers share that constant rather than
  // repeating the flag.
  assert.ok(occurrences <= 6,
    `declareAgent appears ${occurrences} times; it should be confined to apiRequest and the ` +
    'single AGENT_PROVISIONING constant. If a new caller needs it, justify it there.');
  assert.match(SRC, /const AGENT_PROVISIONING = \{ declareAgent: false \}/,
    'the one opt-out must stay a single named constant, not an inline flag per handler');
});

// ── endpoints, methods and bodies ────────────────────────────────────────

test('create_agent POSTs the trimmed name to /agents', async () => {
  mockFetch({ body: { id: 'agent_sample_1', name: 'SAMPLE Agent' } });
  const out = await toolHandlers.create_agent({ name: '  SAMPLE Agent  ' });
  assert.equal(calls[0].url, 'https://app.idea-base.us/api/agents');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(bodyOf(calls[0]), { name: 'SAMPLE Agent' });

  // The response tells the caller what to do next: an agent with no key cannot
  // act, and the id is what goes in IDEA_BASE_AGENT_ID.
  const text = out.content[0].text;
  assert.match(text, /issue_agent_key/, 'the result must point at the next step');
  assert.match(text, /IDEA_BASE_AGENT_ID=agent_sample_1/,
    'and name the env var that makes a session act as it');
});

test('create_agent refuses an empty name without calling the API', async () => {
  mockFetch({ body: {} });
  await assert.rejects(() => toolHandlers.create_agent({ name: '   ' }), /name is required/);
  assert.equal(calls.length, 0, 'a refused call must not reach the API');
});

test('issue_agent_key defaults to the WEAKER scope', async () => {
  // The API's own default is 'read,write'. A tool call that does not say what a
  // credential is for should mint the weaker one; a caller that wants writes
  // asks for them.
  mockFetch({ body: { id: 1, key: 'ib_SAMPLE' } });
  await toolHandlers.issue_agent_key({ agent_user_id: 'agent_sample', name: 'SAMPLE key' });
  assert.equal(calls[0].url, 'https://app.idea-base.us/api/api-keys');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(bodyOf(calls[0]), {
    agent_user_id: 'agent_sample', name: 'SAMPLE key', permissions: 'read',
  });

  mockFetch({ body: { id: 2 } });
  await toolHandlers.issue_agent_key({
    agent_user_id: 'agent_sample', name: 'SAMPLE rw', permissions: 'read,write', expires_in_days: 90,
  });
  assert.deepEqual(bodyOf(calls[0]), {
    agent_user_id: 'agent_sample', name: 'SAMPLE rw', permissions: 'read,write', expires_in_days: 90,
  });
});

test('issue_agent_key omits expires_in_days rather than sending null', async () => {
  // The API treats a present-but-empty expiry differently from an absent one,
  // and `undefined` would serialise away silently — so this is asserted.
  mockFetch({ body: { id: 3 } });
  await toolHandlers.issue_agent_key({ agent_user_id: 'agent_sample', name: 'SAMPLE' });
  assert.ok(!('expires_in_days' in bodyOf(calls[0])),
    'an unspecified expiry must be absent from the body, not null');
});

test('list_agent_keys and the two deletes target the right URLs, id-encoded', async () => {
  mockFetch({ body: [] });
  await toolHandlers.list_agent_keys({ agent_user_id: 'agent_sample/../x' });
  assert.equal(calls[0].url,
    'https://app.idea-base.us/api/api-keys?agent_user_id=agent_sample%2F..%2Fx',
    'an id must be encoded — it is caller-supplied and goes into a URL');

  mockFetch({ body: { success: true } });
  await toolHandlers.revoke_agent_key({ key_id: 42 });
  assert.equal(calls[0].url, 'https://app.idea-base.us/api/api-keys/42');
  assert.equal(calls[0].options.method, 'DELETE');

  mockFetch({ body: { success: true } });
  await toolHandlers.remove_agent({ agent_user_id: 'agent sample' });
  assert.equal(calls[0].url, 'https://app.idea-base.us/api/agents/agent%20sample');
  assert.equal(calls[0].options.method, 'DELETE');

  mockFetch({ body: { agents: [] } });
  await toolHandlers.list_agents({});
  assert.equal(calls[0].url, 'https://app.idea-base.us/api/agents');
  assert.ok(!calls[0].options.method || calls[0].options.method === 'GET');
});

test('a server refusal reaches the caller as its message, not a bare status', async () => {
  // The upgrade refusal is the one a paying decision depends on, so it must not
  // be flattened to "API error: 403".
  mockFetch({
    status: 403,
    body: {
      error: 'Agent users are available on paid plans. Upgrade this workspace to create an agent and issue its API keys.',
      code: 'AGENT_PLAN_UPGRADE_REQUIRED',
    },
  });
  await assert.rejects(
    () => toolHandlers.create_agent({ name: 'SAMPLE Agent' }),
    /paid plans/,
    'the plan refusal must survive to the model as words it can act on');
});

test('the issued key is passed through verbatim — it is shown exactly once', async () => {
  // If this handler ever summarised the response, the one copy of the key would
  // be lost and the credential unrecoverable.
  const KEY = 'ib_SAMPLEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  mockFetch({ body: { id: 9, key: KEY, key_prefix: 'ib_SAMP', permissions: 'read' } });
  const out = await toolHandlers.issue_agent_key({
    agent_user_id: 'agent_sample', name: 'SAMPLE key',
  });
  assert.ok(out.content[0].text.includes(KEY),
    'the full key must reach the caller — there is no second chance to read it');
});
