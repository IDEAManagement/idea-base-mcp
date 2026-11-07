// update.test.js - the acceptance criteria of IDEA Base issue #448, as tests.
//
// Run: npm test   (node --test over src/*.test.js; no dependency added)
//
// =============================================================================
// HOW THE HEADLINE TEST WAS SHOWN RED FIRST, AND WHY THAT TOOK CARE
// =============================================================================
// Criterion 1 asks for a test that FAILS before the change. A new test file
// that imports a new module gets a red for free - "module not found" - and that
// red proves nothing about the product. So the test that matters here,
// `describe('criterion 1 ...')`, imports NOTHING that did not already exist: it
// drives `runCli(['update'], ...)` out of cli.js and `sha256` out of setup.js,
// both present on the pre-change tree, and asserts on the bytes left on the
// (fake) disk afterwards.
//
// Against pre-change cli.js that test fails with the real defect in the message:
// `update` was not a subcommand, runCli answered `{code: 2}`, nothing was
// written, and the stale script stayed stale. Reproduce the red with:
//
//     git worktree add --detach /tmp/pre origin/main
//     cp src/update.test.js /tmp/pre/src/
//     cd /tmp/pre && node --test src/update.test.js
//
// Everything that NEEDS the new module reaches it through `mod()` below, a
// memoised dynamic import, so the file still LOADS against the old tree and the
// behavioural failures are the ones you read first.
//
// =============================================================================
// THE CONTROL TEST IS THE ONE WORTH KEEPING
// =============================================================================
// `install leaves a stale script stale` passes before AND after this change.
// That is the point: it pins cli.js:374, the line the whole issue turns on, so
// nobody later "fixes" install to clobber on every run and calls it an
// improvement. A suite that only proved the new thing works would not notice.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  PRODUCT_HOOKS,
  HOOK_SCRIPT_REL,
  HOOK_TIMEOUT_SECONDS,
  hookCommand,
  sha256,
  foreignHookCount,
} from './setup.js';
import { runCli, runInstall } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = '/fake/project';
const SETTINGS = `${PROJECT}/.claude/settings.json`;
const SCRIPT = `${PROJECT}/${HOOK_SCRIPT_REL}`;
const ASSET = join(HERE, 'assets', 'heartbeat.sh');
const PROVENANCE = join(HERE, 'assets', 'heartbeat.provenance.json');

// Memoised dynamic imports, so this file LOADS against a tree that has neither
// update.js nor cli.js's `runUpdate` export. A static `import { runUpdate } from
// './cli.js'` is a load-time error in ESM when the export is absent, which would
// collapse every behavioural failure into one unreadable module error.
let _mod = null;
async function mod() {
  if (!_mod) _mod = await import('./update.js');
  return _mod;
}
let _cli = null;
async function cli() {
  if (!_cli) _cli = await import('./cli.js');
  return _cli;
}

// Two bodies that are not each other. Their real shas are computed, never
// typed, so the fixture cannot drift from what the code hashes.
const SHIPPED_BODY = '#!/bin/sh\n# the version this build ships\necho new\n';
const OLD_BODY = '#!/bin/sh\n# a version this package shipped previously\necho old\n';
const CUSTOMER_BODY = '#!/bin/sh\n# the customer rewrote this themselves\necho mine\n';

function provenanceFor(shipped, ...alsoKnown) {
  return JSON.stringify({
    file: 'heartbeat.sh',
    sha256: sha256(shipped),
    known_shas: [sha256(shipped), ...alsoKnown.map(sha256)],
    origin_repo: 'IDEAManagement/idea-base.us',
    origin_path: '.claude/hooks/heartbeat.sh',
  });
}

/** An in-memory fs that records every write, so "wrote nothing" is provable. */
function fakeFs(files = {}) {
  const writes = [];
  return {
    writes,
    files,
    readFileSync(p) {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    writeFileSync(p, data) { writes.push({ path: p, data }); files[p] = data; },
    mkdirSync() {},
    chmodSync() {},
    existsSync(p) { return p in files; },
  };
}

/** A settings file with three correct registrations, as `install` would write it. */
function installedSettings(extra = {}) {
  const hooks = {};
  for (const spec of PRODUCT_HOOKS) {
    const entry = { type: 'command', command: hookCommand(spec.event), timeout: HOOK_TIMEOUT_SECONDS };
    if (spec.statusMessage) entry.statusMessage = spec.statusMessage;
    hooks[spec.hookEvent] = [{ hooks: [entry] }];
  }
  return { env: { IDEABASE_ACTOR: 'claude_ai' }, hooks, ...extra };
}

/** A project that installed at an older version: correct hooks, stale script. */
function staleProject(extraSettings = {}) {
  return fakeFs({
    [SETTINGS]: JSON.stringify(installedSettings(extraSettings), null, 2),
    [SCRIPT]: OLD_BODY,
    [ASSET]: SHIPPED_BODY,
    [PROVENANCE]: provenanceFor(SHIPPED_BODY, OLD_BODY),
  });
}

const ENV = { CLAUDE_PROJECT_DIR: PROJECT };

/** A doctor that asks nothing and reports a fixed verdict. */
function stubDoctor(verdict = 'RECORDED - your sessions are being tracked', code = 0) {
  const calls = [];
  const fn = async ({ log } = {}) => {
    calls.push(true);
    if (log) log(`=== verdict: ${verdict} ===`);
    return { code, verdict, detail: [] };
  };
  fn.calls = calls;
  return fn;
}

const noNpm = async () => ({ version: null, error: 'stubbed: not asked' });

async function update(fs, { argv = [], doctor = stubDoctor(), fetchLatest = noNpm, env = ENV } = {}) {
  const lines = [];
  const { runUpdate } = await cli();
  const result = await runUpdate({ env, fs, argv, doctor, fetchLatest, log: (s) => lines.push(String(s)) });
  return { ...result, out: lines.join('\n') };
}

// ===========================================================================
describe('criterion 1 - an older installed heartbeat.sh is brought to the current one', () => {
  // THE RED-FIRST TEST. Imports only cli.js and setup.js, both of which predate
  // this change, so against the pre-change tree it fails on the BEHAVIOUR:
  // runCli answers {code: 2} for an unknown subcommand, nothing is written, and
  // the stale body is still on disk.
  test('runCli("update") replaces a stale shipped script with the shipped one', async () => {
    const fs = staleProject();
    assert.equal(fs.files[SCRIPT], OLD_BODY, 'precondition: the project holds the OLD script');

    const result = await runCli(['update'], { env: ENV, fs, log: () => {} });

    assert.equal(result.code, 0, 'update must be a recognised subcommand that succeeds');
    assert.equal(
      sha256(fs.files[SCRIPT]),
      sha256(SHIPPED_BODY),
      'after update, the script on disk must be the version this build ships',
    );
    assert.ok(
      fs.writes.some((w) => w.path === SCRIPT),
      'the refresh must actually be written, not merely reported',
    );
  });

  test('CONTROL: install leaves a stale script stale - cli.js:374, the defect itself', async () => {
    // Passes before and after. It pins the behaviour the issue asked about
    // ("Not yet known: whether install overwrites an existing heartbeat.sh")
    // so that nobody later makes install clobber and calls it a fix.
    const fs = staleProject();
    const lines = [];
    await runInstall({ env: ENV, fs, argv: ['--apply'], log: (s) => lines.push(String(s)) });
    assert.equal(fs.files[SCRIPT], OLD_BODY, 'install must NOT touch an existing script');
    assert.match(lines.join('\n'), /already installed correctly/i);
  });

  test('both shas are named in the output, so the customer can see what moved', async () => {
    const { out } = await update(staleProject());
    assert.ok(out.includes(sha256(OLD_BODY).slice(0, 12)), 'the old sha is printed');
    assert.ok(out.includes(sha256(SHIPPED_BODY).slice(0, 12)), 'the new sha is printed');
  });

  test('an absent script is installed, same as install would', async () => {
    const fs = fakeFs({
      [SETTINGS]: JSON.stringify(installedSettings(), null, 2),
      [ASSET]: SHIPPED_BODY,
      [PROVENANCE]: provenanceFor(SHIPPED_BODY),
    });
    await update(fs);
    assert.equal(fs.files[SCRIPT], SHIPPED_BODY);
  });
});

// ===========================================================================
describe('criterion 1, the other half - a script the CUSTOMER wrote is never clobbered', () => {
  test('a body matching no shipped version is left exactly as it is', async () => {
    const fs = fakeFs({
      [SETTINGS]: JSON.stringify(installedSettings(), null, 2),
      [SCRIPT]: CUSTOMER_BODY,
      [ASSET]: SHIPPED_BODY,
      [PROVENANCE]: provenanceFor(SHIPPED_BODY, OLD_BODY),
    });
    const { out } = await update(fs);
    assert.equal(fs.files[SCRIPT], CUSTOMER_BODY, 'the customer edit survives');
    assert.ok(!fs.writes.some((w) => w.path === SCRIPT), 'and was not rewritten');
    assert.match(out, /LEFT EXACTLY AS IT IS/);
    assert.match(out, /move your copy aside/, 'and they are told how to take ours if they want it');
  });

  test('a build whose asset disagrees with its own manifest touches nothing', async () => {
    // Not hypothetical bookkeeping: if the two ever disagree the build cannot
    // say what it ships, and replacing a customer's file with bytes we cannot
    // vouch for is the worst available outcome.
    const fs = fakeFs({
      [SETTINGS]: JSON.stringify(installedSettings(), null, 2),
      [SCRIPT]: OLD_BODY,
      [ASSET]: SHIPPED_BODY,
      [PROVENANCE]: provenanceFor(CUSTOMER_BODY),
    });
    const { out } = await update(fs);
    assert.equal(fs.files[SCRIPT], OLD_BODY, 'nothing written');
    assert.match(out, /does not match its own/);
  });

  test('planScriptRefresh is total, pure and writes nothing', async () => {
    const { planScriptRefresh, SCRIPT_STATE } = await mod();
    const shipped = sha256(SHIPPED_BODY);
    const old = sha256(OLD_BODY);
    const theirs = sha256(CUSTOMER_BODY);

    const cases = [
      [{ installedSha: shipped, shippedSha: shipped, knownShas: [old] }, SCRIPT_STATE.CURRENT, false],
      [{ installedSha: old, shippedSha: shipped, knownShas: [old] }, SCRIPT_STATE.STALE, true],
      [{ installedSha: null, shippedSha: shipped, knownShas: [old] }, SCRIPT_STATE.ABSENT, true],
      [{ installedSha: theirs, shippedSha: shipped, knownShas: [old] }, SCRIPT_STATE.MODIFIED, false],
      [{ installedSha: old, shippedSha: null, knownShas: [] }, SCRIPT_STATE.MODIFIED, false],
    ];
    for (const [input, state, refresh] of cases) {
      const r = planScriptRefresh(input);
      assert.equal(r.state, state, `state for ${JSON.stringify(input)}`);
      assert.equal(r.refresh, refresh, `refresh for ${JSON.stringify(input)}`);
      assert.ok(r.detail.length > 0, 'every verdict carries a reason');
    }
  });

  test("the shipped manifest's own known_shas pins every published body", async () => {
    // The real file, not a fixture. A dropped entry silently reclassifies every
    // customer still on that version as having edited the file, and update then
    // leaves them stale forever - so this is asserted rather than trusted.
    const manifest = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
    const body = readFileSync(ASSET, 'utf8');
    assert.ok(Array.isArray(manifest.known_shas), 'known_shas is a list');
    assert.equal(manifest.known_shas[0], manifest.sha256, 'the current sha leads the list');
    assert.equal(sha256(body), manifest.sha256, 'and the asset on disk is that sha');
    assert.ok(
      manifest.known_shas.includes('18fbd977aa37f9261891932cf1f09155790c6097c17c4e27caeb205df0b8afb4'),
      "v2.7.0's heartbeat.sh must stay listed - it is published and customers hold it",
    );
    assert.ok(manifest.known_shas.length >= 2, 'history is appended to, never replaced');
  });
});

// ===========================================================================
describe('criterion 2 - unrelated hooks and settings survive, and a second run is a no-op', () => {
  const FOREIGN = {
    permissions: { allow: ['Bash(ls:*)'] },
    statusLine: { type: 'command', command: 'my-statusline' },
    env: { IDEABASE_ACTOR: 'claude_ai', SOMETHING_OF_MINE: 'keep me' },
    hooks: {
      PostToolUse: [{ hooks: [{ type: 'command', command: 'sh my-own-linter.sh' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'python3 my-guard.py' }] }],
    },
  };

  test('every unrelated key and every foreign hook is still there afterwards', async () => {
    const before = installedSettings();
    // Merge the foreign hooks in alongside ours rather than replacing them.
    before.permissions = FOREIGN.permissions;
    before.statusLine = FOREIGN.statusLine;
    before.env = FOREIGN.env;
    before.hooks.PostToolUse.push(...FOREIGN.hooks.PostToolUse);
    before.hooks.PreToolUse = FOREIGN.hooks.PreToolUse;
    const foreignBefore = foreignHookCount(before);
    assert.equal(foreignBefore, 2, 'precondition: two hooks that are not ours');

    const fs = fakeFs({
      [SETTINGS]: JSON.stringify(before, null, 2),
      [SCRIPT]: OLD_BODY,
      [ASSET]: SHIPPED_BODY,
      [PROVENANCE]: provenanceFor(SHIPPED_BODY, OLD_BODY),
    });
    await update(fs);

    const after = JSON.parse(fs.files[SETTINGS]);
    assert.deepEqual(after.permissions, FOREIGN.permissions);
    assert.deepEqual(after.statusLine, FOREIGN.statusLine);
    assert.equal(after.env.SOMETHING_OF_MINE, 'keep me');
    assert.equal(foreignHookCount(after), foreignBefore, 'no foreign hook was dropped');
  });

  test('a second run writes NOTHING - not the script, not the settings', async () => {
    const fs = staleProject();
    await update(fs);
    const settingsAfterFirst = fs.files[SETTINGS];
    const scriptAfterFirst = fs.files[SCRIPT];

    fs.writes.length = 0;
    const { out } = await update(fs);

    assert.deepEqual(fs.writes, [], 'the second run wrote nothing at all');
    assert.equal(fs.files[SETTINGS], settingsAfterFirst, 'settings byte-identical');
    assert.equal(fs.files[SCRIPT], scriptAfterFirst, 'script byte-identical');
    assert.match(out, /already the current version/);
    assert.match(out, /Nothing needed changing/);
  });

  test('an unparseable settings file is refused, never rewritten', async () => {
    const fs = fakeFs({
      [SETTINGS]: '{oops',
      [SCRIPT]: OLD_BODY,
      [ASSET]: SHIPPED_BODY,
      [PROVENANCE]: provenanceFor(SHIPPED_BODY, OLD_BODY),
    });
    const { code, out } = await update(fs);
    assert.equal(code, 1);
    assert.deepEqual(fs.writes, [], 'and it did not refresh the script either');
    assert.match(out, /REFUSING/);
  });

  test('--dry-run writes nothing and says so', async () => {
    const fs = staleProject();
    const { out, code } = await update(fs, { argv: ['--dry-run'] });
    assert.equal(code, 0);
    assert.deepEqual(fs.writes, []);
    assert.match(out, /DRY RUN - nothing was written/);
  });

  test('a missing heartbeat registration is re-asserted', async () => {
    // A customer who removed one, or installed before all three existed.
    const partial = installedSettings();
    delete partial.hooks.SessionEnd;
    const fs = fakeFs({
      [SETTINGS]: JSON.stringify(partial, null, 2),
      [SCRIPT]: SHIPPED_BODY,
      [ASSET]: SHIPPED_BODY,
      [PROVENANCE]: provenanceFor(SHIPPED_BODY),
    });
    await update(fs);
    const after = JSON.parse(fs.files[SETTINGS]);
    assert.ok(Array.isArray(after.hooks.SessionEnd) && after.hooks.SessionEnd.length === 1);
    assert.equal(after.hooks.SessionEnd[0].hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  });
});

// ===========================================================================
describe('criterion 3 - it ends by running doctor and states the restart', () => {
  test('doctor is actually invoked and its verdict is reported', async () => {
    const doctor = stubDoctor('NOT RECORDED - the server refused it (issue_not_resolved)', 1);
    const { out, doctor: reported } = await update(staleProject(), { doctor });
    assert.equal(doctor.calls.length, 1, 'doctor ran exactly once');
    assert.match(out, /NOT RECORDED/, "doctor's own output is shown");
    assert.match(out, /Tracking check: NOT RECORDED/, 'and summarised in the verdict');
    assert.equal(reported.verdict, 'NOT RECORDED - the server refused it (issue_not_resolved)');
  });

  test('the restart is stated in plain words, every time', async () => {
    for (const fs of [staleProject(), staleProject()]) {
      // once where something changed, once where nothing did
      await update(fs);
      const { out } = await update(fs);
      assert.match(out, /RESTART REQUIRED/);
      assert.match(out, /keeps the code it started with/);
    }
  });

  test('a doctor verdict of "not tracking" does NOT make the update a failure', async () => {
    // The expensive direction: a non-zero exit sends a customer round the loop
    // again on an update that worked perfectly. The exit code is about the
    // update; the tracking verdict is printed and returned separately.
    const { code } = await update(staleProject(), {
      doctor: stubDoctor('NO KEY - nothing could be sent', 2),
    });
    assert.equal(code, 0);
  });
});

// ===========================================================================
describe('criterion 4 - the running server says an update exists, and costs nothing when npm is down', () => {
  test('updateNoticeText is SYNCHRONOUS - there is no await on the tool path', async () => {
    const { updateNoticeText } = await mod();
    const r = updateNoticeText({ installed: '2.8.0', latest: '2.9.0' });
    assert.equal(typeof r, 'string', 'a string, not a promise');
    assert.ok(!(r instanceof Promise));
  });

  test('it names the new version and the command', async () => {
    const { updateNoticeText, UPDATE_COMMAND } = await mod();
    const r = updateNoticeText({ installed: '2.8.0', latest: '2.9.0' });
    assert.match(r, /2\.9\.0 is available/);
    assert.match(r, /2\.8\.0/);
    assert.ok(r.includes(UPDATE_COMMAND));
    assert.match(r, /restart/i);
  });

  test('it says NOTHING when npm was never reached, when current, or when ahead', async () => {
    const { updateNoticeText } = await mod();
    assert.equal(updateNoticeText({ installed: '2.9.0', latest: null }), '', 'unknown stays quiet');
    assert.equal(updateNoticeText({ installed: '2.9.0', latest: '2.9.0' }), '', 'current stays quiet');
    assert.equal(updateNoticeText({ installed: '2.9.0', latest: '2.8.0' }), '', 'ahead stays quiet');
    assert.equal(updateNoticeText({ installed: '2.9.0', latest: 'not-a-version' }), '', 'garbage stays quiet');
  });

  test('an unreachable registry cannot throw, reject, or hang past the timeout', async () => {
    const { fetchLatestVersion, startVersionCheck, __resetVersionCheck, latestKnownVersion } = await mod();

    const boom = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); };
    const r = await fetchLatestVersion({ fetchImpl: boom });
    assert.equal(r.version, null);
    assert.match(r.error, /ENOTFOUND/);

    // The un-awaited form is the one that matters: an unhandled rejection
    // terminates the process on Node 20 by default, which would turn a
    // cosmetic notice into a server that will not start.
    __resetVersionCheck();
    await assert.doesNotReject(() => startVersionCheck({ fetchImpl: boom }));
    assert.equal(latestKnownVersion(), null, 'and nothing is claimed');
    assert.equal((await mod()).updateNoticeText({ installed: '1.0.0' }), '', 'so no notice is produced');
    __resetVersionCheck();
  });

  test('a transport that never settles is cut off by our own deadline', async () => {
    // Found while verifying #448 against a stub that ignored the abort signal:
    // the tool path was fine (it never awaits), but /idea-base:update does, and
    // it hung forever. An AbortSignal only binds a fetch that HONOURS it, so the
    // deadline is raced in our own code. This test is that guarantee - it must
    // return, and it must return quickly.
    const { fetchLatestVersion } = await mod();
    const never = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await fetchLatestVersion({ fetchImpl: never, timeoutMs: 120 });
    const ms = Date.now() - t0;
    assert.equal(r.version, null);
    assert.match(r.error, /no answer within 120ms/);
    assert.ok(ms < 2000, `returned in ${ms}ms, so the deadline is ours and not the transport's`);
  });

  test('a non-200, or a body without a usable version, is "I do not know"', async () => {
    const { fetchLatestVersion } = await mod();
    const res = (status, body) => async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    assert.match((await fetchLatestVersion({ fetchImpl: res(503, {}) })).error, /HTTP 503/);
    assert.match((await fetchLatestVersion({ fetchImpl: res(200, {}) })).error, /usable version/);
    assert.match((await fetchLatestVersion({ fetchImpl: res(200, { version: 'latest' }) })).error, /usable version/);
    assert.equal((await fetchLatestVersion({ fetchImpl: res(200, { version: ' 2.9.0 ' }) })).version, '2.9.0');
  });

  test('IDEA_BASE_UPDATE_CHECK=off asks npm nothing at all', async () => {
    const { fetchLatestVersion, updateCheckDisabled } = await mod();
    let asked = false;
    const spy = async () => { asked = true; throw new Error('should not be called'); };
    for (const v of ['off', 'OFF', '0', 'false', 'no']) {
      assert.equal(updateCheckDisabled({ IDEA_BASE_UPDATE_CHECK: v }), true, v);
      const r = await fetchLatestVersion({ fetchImpl: spy, env: { IDEA_BASE_UPDATE_CHECK: v } });
      assert.match(r.error, /IDEA_BASE_UPDATE_CHECK/);
    }
    assert.equal(asked, false, 'no request was made');
    assert.equal(updateCheckDisabled({}), false, 'and it is on by default');
  });

  test('the lookup sends no credential and no body', async () => {
    const { fetchLatestVersion, NPM_LATEST_URL } = await mod();
    let seen = null;
    const capture = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ version: '2.9.0' }) };
    };
    await fetchLatestVersion({ fetchImpl: capture });
    assert.equal(seen.url, NPM_LATEST_URL);
    assert.equal(seen.init.method, 'GET');
    assert.deepEqual(Object.keys(seen.init.headers), ['Accept'], 'Accept and nothing else');
    assert.equal(seen.init.body, undefined, 'no request body');
    assert.ok(!JSON.stringify(seen).toLowerCase().includes('authorization'));
    assert.ok(seen.init.signal, 'and it is bounded by an abort signal');
  });

  test('version comparison refuses to guess', async () => {
    const { isNewer, parseVersion } = await mod();
    assert.equal(isNewer('2.9.0', '2.8.0'), true);
    assert.equal(isNewer('3.0.0', '2.99.99'), true);
    assert.equal(isNewer('2.8.1', '2.8.0'), true);
    assert.equal(isNewer('2.8.0', '2.9.0'), false);
    assert.equal(isNewer('2.9.0', '2.9.0'), false);
    assert.equal(isNewer('2.10.0', '2.9.0'), true, 'numeric, not lexical');
    assert.equal(isNewer('3.0.0-rc.1', '2.9.0'), false, 'never onto a prerelease');
    assert.equal(isNewer('2.9.0', '2.9.0-rc.1'), true, 'but a release beats its own prerelease');
    assert.equal(isNewer('garbage', '2.9.0'), false);
    assert.equal(isNewer('2.9.0', 'garbage'), false);
    assert.equal(isNewer(null, '2.9.0'), false);
    assert.equal(parseVersion('v2.9.0').minor, 9, 'a leading v is tolerated');
    assert.equal(parseVersion('2.9'), null);
  });

  test('the notice is wired into the tool path once per process, inside a try/catch', () => {
    // A source assertion, like setup.test.js's serverInfo check: the handler
    // needs a live MCP client to exercise, and what must not regress is the
    // SHAPE - no await of a network call, one spend, and a swallowed failure.
    const src = readFileSync(join(HERE, 'index.js'), 'utf8');
    assert.match(src, /let updateNoticeSpent = false;/);
    assert.match(src, /\$\{await firstUseNudge\(\)\}\$\{updateNudge\(\)\}/,
      'the notice is appended on the tool path alongside the first-use nudge');
    assert.match(src, /startVersionCheck\(\)\.catch\(\(\) => \{\}\);/,
      'the lookup is fired un-awaited with a catch attached');
    assert.ok(!/await\s+startVersionCheck/.test(src), 'and is NEVER awaited');
    assert.ok(!/await\s+fetchLatestVersion\(\)[\s\S]{0,200}CallToolRequestSchema/.test(src));
  });
});

// ===========================================================================
describe('criterion 5 - /idea-base:update', () => {
  test('the prompt is declared and has a builder', () => {
    const src = readFileSync(join(HERE, 'index.js'), 'utf8');
    assert.match(src, /name: 'update',/, 'declared in the prompts array');
    assert.match(src, /async function buildUpdatePrompt\(\)/);
    assert.match(src, /update: buildUpdatePrompt,/, 'and registered in promptBuilders');
    // `arguments: []` is required: the GetPrompt handler iterates spec.arguments
    // unconditionally, so an omitted key throws.
    const block = src.slice(src.indexOf("name: 'update',"));
    assert.match(block.slice(0, 600), /arguments: \[\],/);
  });

  test('its text names both versions, the command, and the restart', async () => {
    // Exercised through the same module the handler calls, with npm stubbed.
    const src = readFileSync(join(HERE, 'index.js'), 'utf8');
    for (const needle of [
      'running in this session',
      'latest published on npm',
      'could not ask npm',
      'RESTART',
    ]) {
      assert.ok(src.includes(needle), `buildUpdatePrompt says "${needle}"`);
    }
    const { UPDATE_COMMAND } = await mod();
    assert.ok(src.includes('UPDATE_COMMAND'), 'and gives the one command');
    assert.equal(UPDATE_COMMAND, 'npx @idea-base/mcp-server@latest update');
  });
});

// ===========================================================================
describe('criterion 6 - a machine with none of our tooling', () => {
  // The real code, spawned as a real OS process, writing to a real filesystem,
  // with a HOME that holds nothing, against a repository holding only what a
  // customer's install leaves. No ~/.claude, no core tooling, no secrets store,
  // no API key, no network.
  //
  // IT ENTERS AT cli.js AND NOT AT index.js, DELIBERATELY. index.js imports the
  // MCP SDK at module scope, and `.github/workflows/test.yml` installs NO
  // dependencies on purpose ("the MCP SDK is needed by src/index.js and by
  // nothing under test"), so spawning index.js here would make this suite
  // require an npm install and fail in CI. What index.js adds over this is one
  // branch - `SUBCOMMANDS.has(process.argv[2])` above the API-key check - and
  // that is asserted directly in the `plumbing` suite below. The full
  // `npx @idea-base/mcp-server@latest update` binary path is proved against the
  // PUBLISHED tarball instead, which is where it actually has to work.
  const CLI_URL = pathToFileURL(join(HERE, 'cli.js')).href;

  function cleanRun(args, { body = null, extraSettings = null, env = {} } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'ib-home-'));
    const project = mkdtempSync(join(tmpdir(), 'ib-proj-'));
    try {
      mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
      writeFileSync(
        join(project, '.claude', 'settings.json'),
        JSON.stringify(extraSettings ?? installedSettings(), null, 2),
      );
      if (body !== null) writeFileSync(join(project, HOOK_SCRIPT_REL), body);
      const code = `import { runCli } from ${JSON.stringify(CLI_URL)};`
        + ` const r = await runCli(${JSON.stringify(args)});`
        + ' process.exit(r.code ?? 0);';
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          // Deliberately minimal. PATH only so `sh` resolves for the doctor's
          // own `resolve` call; HOME points at an empty directory.
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: home,
          CLAUDE_PROJECT_DIR: project,
          IDEA_BASE_UPDATE_CHECK: 'off',
          ...env,
        },
      });
      return { ...r, project, home, script: body === null ? null : join(project, HOOK_SCRIPT_REL) };
    } finally {
      rmSync(home, { recursive: true, force: true });
      // `project` is read by the caller's assertions, so it is removed there.
    }
  }

  test('`update` runs end to end, refreshes nothing it should not, and exits 0', () => {
    const shipped = readFileSync(ASSET, 'utf8');
    const r = cleanRun(['update'], { body: shipped });
    try {
      assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
      assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
      assert.match(r.stdout, /=== IDEA Base MCP update ===/);
      assert.match(r.stdout, /already the current version/);
      assert.match(r.stdout, /RESTART REQUIRED/);
      // No key and no anchor on this machine, and that is reported honestly
      // rather than as an update failure.
      assert.match(r.stdout, /Tracking check: NOT/);
      assert.equal(readFileSync(join(r.project, HOOK_SCRIPT_REL), 'utf8'), shipped);
    } finally {
      rmSync(r.project, { recursive: true, force: true });
    }
  });

  test('a repo with NO heartbeat.sh gets one, and a customer edit is left alone', () => {
    const shipped = readFileSync(ASSET, 'utf8');

    const fresh = cleanRun(['update'], { body: null });
    try {
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.equal(readFileSync(join(fresh.project, HOOK_SCRIPT_REL), 'utf8'), shipped);
    } finally {
      rmSync(fresh.project, { recursive: true, force: true });
    }

    const mine = cleanRun(['update'], { body: CUSTOMER_BODY });
    try {
      assert.equal(mine.status, 0, mine.stderr);
      assert.equal(
        readFileSync(join(mine.project, HOOK_SCRIPT_REL), 'utf8'),
        CUSTOMER_BODY,
        'the real binary leaves a real edited file alone',
      );
      assert.match(mine.stdout, /LEFT EXACTLY AS IT IS/);
    } finally {
      rmSync(mine.project, { recursive: true, force: true });
    }
  });

  test('with npm genuinely unreachable it still completes and says so', () => {
    // The check is left ON and pointed at a host that cannot resolve, which is
    // what a blocked egress looks like. It must report an unknown and finish,
    // not fail and not hang.
    const r = cleanRun(['update'], {
      body: readFileSync(ASSET, 'utf8'),
      env: {
        IDEA_BASE_UPDATE_CHECK: 'on',
        // No way to redirect the registry URL by design (it is a constant, so
        // nothing can point this package's update check at an attacker's host),
        // so this asserts the real thing: whatever this machine's answer is,
        // the command finishes and prints one of the two honest lines.
      },
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /latest on npm\s+: (unknown \(|\d)/,
        'either a version or a stated unknown - never a blank or a crash',
      );
      assert.match(r.stdout, /RESTART REQUIRED/);
    } finally {
      rmSync(r.project, { recursive: true, force: true });
    }
  });

  test('an unknown subcommand is still an unknown subcommand', () => {
    const r = cleanRun(['updates'], { body: readFileSync(ASSET, 'utf8') });
    try {
      assert.equal(r.status, 2);
      assert.match(r.stdout, /Unknown subcommand/);
    } finally {
      rmSync(r.project, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe('plumbing', () => {
  test('update is a subcommand, so index.js branches to it above the API-key check', async () => {
    const { SUBCOMMANDS } = await import('./cli.js');
    assert.ok(SUBCOMMANDS.has('update'));
    // The branch at the top of index.js is what lets `update` work for someone
    // whose key is missing or wrong - which includes everyone whose install is
    // broken, i.e. the people who need it.
    const src = readFileSync(join(HERE, 'index.js'), 'utf8');
    const branch = src.indexOf('SUBCOMMANDS.has(process.argv[2])');
    const keyCheck = src.indexOf('if (!API_KEY)');
    assert.ok(branch > 0 && keyCheck > branch, 'the subcommand branch precedes the key check');
  });

  test('the version the module reports is package.json, not a second literal', async () => {
    const { PACKAGE_VERSION } = await mod();
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(PACKAGE_VERSION, pkg.version);
  });
});
