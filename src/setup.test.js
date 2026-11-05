// setup.test.js - the acceptance criteria of IDEA Base issue #383, as tests.
//
// Run: npm test   (node --test, built into Node 20+; no dependency added)
//
// =============================================================================
// WHY THESE ASSERTIONS AND NOT "IT RUNS"
// =============================================================================
// This repository had NO test suite before this file: `package.json`'s scripts
// were `start` and `dev`, there were no devDependencies, and the only workflow
// publishes. So the bar was not "add coverage" but "make the three criteria
// that are claims about the WRITE checkable at all":
//
//   criterion 4  - it never writes without asking
//   criterion 5  - when it does write, it merges
//   criterion 10 - safe to run more than once, including against a settings
//                  file that already carries a duplicate registration
//
// None of those is checkable if the writer is a model improvising an edit.
// Each is an ordinary assertion over a pure function, which is the entire
// reason `planMerge` returns a plan instead of touching a disk.
//
// Two tests here are DISCRIMINATION CONTROLS rather than feature tests, and
// they are the ones worth keeping if anything is ever trimmed: a test that a
// correctly-installed project is NOT reported as broken, and a test that an
// undetermined capability is NOT reported as off. A checker that says "broken"
// about everything passes every positive test and is useless.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PRODUCT_HOOKS,
  HOOK_SCRIPT_REL,
  HOOK_TIMEOUT_SECONDS,
  hookCommand,
  resolveProjectDir,
  classifyHeartbeatCommand,
  detectRegistrations,
  foreignHookCount,
  planMerge,
  readSettings,
  inspectLocal,
  assessInstall,
  sha256,
} from './setup.js';
import { buildInventory, STATE } from './features.js';
import { renderSetupReport, renderFeaturesReport, settingsSnippet } from './render.js';
import { runInstall, runDoctor } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = '/fake/project';
const SETTINGS = `${PROJECT}/.claude/settings.json`;
const SCRIPT = `${PROJECT}/${HOOK_SCRIPT_REL}`;

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

// ===========================================================================
describe('project directory resolution (measured, not assumed)', () => {
  // Read off live MCP server processes on 2026-11-05: for a server launched by
  // a session in a git worktree, CLAUDE_PROJECT_DIR and cwd were the worktree
  // while PWD was a DIFFERENT checkout three directories up. A command that
  // trusted PWD would inspect the wrong repository and report confidently on a
  // directory the session is not in.
  test('CLAUDE_PROJECT_DIR wins', () => {
    const r = resolveProjectDir({ CLAUDE_PROJECT_DIR: '/a/worktree', PWD: '/the/hub' }, '/a/worktree');
    assert.equal(r.dir, '/a/worktree');
    assert.equal(r.source, 'CLAUDE_PROJECT_DIR');
  });

  test('PWD is NEVER consulted, even when it is the only thing set', () => {
    const r = resolveProjectDir({ PWD: '/the/hub' }, '/a/worktree');
    assert.equal(r.dir, '/a/worktree', 'fell back to cwd, not PWD');
    assert.notEqual(r.dir, '/the/hub');
  });
});

// ===========================================================================
describe('recognising a registration that is already there', () => {
  test('the wrapped form is recognised', () => {
    // The event sits after `"$h"`, not after the filename, so a naive
    // /heartbeat\.sh (start|tool|stop)/ match would miss every correctly
    // wrapped hook and the installer would duplicate all three.
    assert.equal(classifyHeartbeatCommand(hookCommand('stop')), 'stop');
    assert.equal(classifyHeartbeatCommand(hookCommand('start')), 'start');
    assert.equal(classifyHeartbeatCommand(hookCommand('tool')), 'tool');
  });

  test('the bare form a customer might hand-write is recognised', () => {
    assert.equal(classifyHeartbeatCommand('sh .claude/hooks/heartbeat.sh stop'), 'stop');
  });

  test("another tool's hook is not mistaken for ours", () => {
    assert.equal(classifyHeartbeatCommand('python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/session-brief.py"'), null);
    assert.equal(classifyHeartbeatCommand('npm run start'), null);
    assert.equal(classifyHeartbeatCommand(undefined), null);
  });

  test('a mis-wired hook is reported as mis-wired, not as present', () => {
    // Something IS registered, so a check that only asked "is anything there?"
    // would pass this. It is a real failure mode: the stop event under
    // PostToolUse means the terminal event never fires.
    const s = { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand('stop') }] }] } };
    const regs = detectRegistrations(s);
    assert.equal(regs.tool.present, false);
    assert.deepEqual(regs.tool.misWired, ['stop']);
  });

  test('a hand-written bare command is kept but flagged as unguarded', () => {
    // Found by running the real installer against a real hand-written settings
    // file: the merge correctly does NOT rewrite the customer's command, which
    // means it also does not add the fail-open wrapper for them. Silence there
    // would leave a project one missing file away from a session that cannot
    // repair itself, so it is reported instead of fixed behind their back.
    const bare = {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'sh .claude/hooks/heartbeat.sh stop', timeout: 5 }] }] },
    };
    const r = detectRegistrations(bare).stop;
    assert.equal(r.present, true, 'still counts as installed');
    assert.equal(r.unguarded, true, 'and is flagged');
    assert.equal(r.notProjectRooted, true, 'relative path will miss in a worktree');

    const fs = fakeFs({ [SETTINGS]: JSON.stringify(bare), [SCRIPT]: '#!/bin/sh\n' });
    const local = inspectLocal({ projectDir: PROJECT, env: { IDEABASE_ACTOR: 'x' }, fs });
    const reasons = assessInstall(local).reasons.join(' | ');
    assert.match(reasons, /fails CLOSED/);
    assert.match(reasons, /CLAUDE_PROJECT_DIR/);
  });

  test('the wrapper form is NOT flagged', () => {
    // Discrimination control for the two flags above.
    const r = detectRegistrations({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand('stop'), timeout: 5 }] }] },
    }).stop;
    assert.equal(r.unguarded, false);
    assert.equal(r.notProjectRooted, false);
  });

  test('a missing SessionEnd timeout is detected', () => {
    const s = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand('stop') }] }] } };
    assert.equal(detectRegistrations(s).stop.present, true);
    assert.equal(detectRegistrations(s).stop.timeoutOk, false, 'no timeout means the stop POST can be cancelled mid-flight');
  });
});

// ===========================================================================
describe('criterion 10 / 8 - idempotency', () => {
  test('a fresh install plans exactly the three hooks', () => {
    const plan = planMerge({}, { actor: 'claude_ai' });
    const added = plan.changes.filter((c) => c.kind === 'add_hook').map((c) => c.hookEvent);
    assert.deepEqual(added.sort(), ['PostToolUse', 'SessionEnd', 'SessionStart']);
    assert.equal(plan.idempotent, false);
  });

  test('running it a second time changes NOTHING', () => {
    const first = planMerge({}, { actor: 'claude_ai' });
    const second = planMerge(first.next, { actor: 'claude_ai' });
    assert.equal(second.idempotent, true);
    assert.deepEqual(second.changes, []);
  });

  test('and the file would be byte-identical', () => {
    // The strongest form of criterion 8's evidence requirement.
    const first = planMerge({}, { actor: 'claude_ai' });
    const a = JSON.stringify(first.next, null, 2);
    const b = JSON.stringify(planMerge(first.next, { actor: 'claude_ai' }).next, null, 2);
    assert.equal(a, b);
  });

  test('a THIRD and fourth run still change nothing', () => {
    let s = {};
    for (let i = 0; i < 4; i += 1) s = planMerge(s, { actor: 'claude_ai' }).next;
    assert.equal(planMerge(s, { actor: 'claude_ai' }).idempotent, true);
  });

  test('the DUPLICATE registration case is collapsed, then idempotent', () => {
    // This is not hypothetical. A second real repository on this fleet has the
    // same hook registered twice in its local settings. Harmless for a guard
    // that only reads; a heartbeat registered twice DOUBLE-WRITES.
    const dup = {
      hooks: {
        SessionEnd: [
          { hooks: [{ type: 'command', command: hookCommand('stop'), timeout: 5 }] },
          { hooks: [{ type: 'command', command: hookCommand('stop'), timeout: 5 }] },
        ],
      },
    };
    assert.equal(detectRegistrations(dup).stop.count, 2, 'fixture really does have two');

    const plan = planMerge(dup, {});
    const collapse = plan.changes.find((c) => c.kind === 'collapse_duplicate');
    assert.ok(collapse, 'the duplicate was noticed');
    assert.equal(collapse.removed, 1);
    assert.equal(detectRegistrations(plan.next).stop.count, 1, 'exactly one survives');
    assert.equal(planMerge(plan.next, {}).idempotent, true, 'and it settles');
  });

  test('a duplicate in a single group (both entries in one hooks array) is also collapsed', () => {
    const dup = {
      hooks: {
        PostToolUse: [{
          hooks: [
            { type: 'command', command: hookCommand('tool'), timeout: 5 },
            { type: 'command', command: hookCommand('tool'), timeout: 5 },
          ],
        }],
      },
    };
    const plan = planMerge(dup, {});
    assert.equal(detectRegistrations(plan.next).tool.count, 1);
  });

  test('a hand-written bare registration is NOT duplicated by the installer', () => {
    // A customer who followed the docs by hand must not end up with two.
    const hand = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'sh .claude/hooks/heartbeat.sh stop', timeout: 5 }] }] } };
    const plan = planMerge(hand, {});
    assert.equal(detectRegistrations(plan.next).stop.count, 1);
    assert.equal(plan.changes.filter((c) => c.kind === 'add_hook' && c.event === 'stop').length, 0);
  });
});

// ===========================================================================
describe('criterion 5 - when it writes, it merges', () => {
  const withForeign = {
    $schema: 'https://example.invalid/schema.json',
    permissions: { defaultMode: 'acceptEdits', deny: ['Read(./.env)'] },
    env: { NODE_ENV: 'development', SOMETHING_ELSE: 'keep-me' },
    statusLine: { type: 'command', command: 'my-status-line' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 my-own-guard.py' }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'echo some-other-tool' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'python3 my-briefing.py' }] }],
    },
  };

  test('every unrelated hook survives', () => {
    assert.equal(foreignHookCount(withForeign), 3, 'fixture has three foreign hooks');
    const plan = planMerge(withForeign, { actor: 'claude_ai' });
    assert.equal(foreignHookCount(plan.next), 3, 'all three still there afterwards');
  });

  test('every unrelated top-level key survives untouched', () => {
    const plan = planMerge(withForeign, { actor: 'claude_ai' });
    assert.deepEqual(plan.next.permissions, withForeign.permissions);
    assert.deepEqual(plan.next.statusLine, withForeign.statusLine);
    assert.equal(plan.next.$schema, withForeign.$schema);
    assert.equal(plan.next.env.NODE_ENV, 'development');
    assert.equal(plan.next.env.SOMETHING_ELSE, 'keep-me');
  });

  test('the foreign PostToolUse and SessionStart hooks keep their own entries', () => {
    const plan = planMerge(withForeign, { actor: 'claude_ai' });
    const cmds = plan.next.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.includes('python3 my-briefing.py'), 'their session hook is still registered');
    assert.ok(cmds.some((c) => classifyHeartbeatCommand(c) === 'start'), 'and ours was added alongside');
  });

  test('planMerge does not mutate its input', () => {
    // If the plan mutated the caller's object, a dry run would already have
    // changed the state it was only supposed to describe.
    const before = JSON.stringify(withForeign);
    planMerge(withForeign, { actor: 'someone' });
    assert.equal(JSON.stringify(withForeign), before);
  });

  test('our own repo\'s non-product hooks are never generated', () => {
    // The contract's section 4: of five registrations in idea-base.us, only
    // three are the product. session-brief.py prints our hub/spoke process
    // spec and no-secret-trace.py is our own guard; both point at files a
    // customer will not have, and a hook pointing at a missing script fails
    // CLOSED and can deny Bash and Edit.
    const generated = JSON.stringify(planMerge({}, { actor: 'x' }).next) + settingsSnippet('x');
    assert.ok(!generated.includes('session-brief'), 'session-brief.py must never be installed');
    assert.ok(!generated.includes('no-secret-trace'), 'no-secret-trace.py must never be installed');
    assert.ok(!generated.includes('NODE_ENV'), "our own env.NODE_ENV is not part of the product either");
  });
});

// ===========================================================================
describe('criterion 4 - it never writes without asking', () => {
  test('a dry run writes nothing at all', async () => {
    const fs = fakeFs({ [SETTINGS]: JSON.stringify({ hooks: {} }) });
    const r = await runInstall({
      env: { CLAUDE_PROJECT_DIR: PROJECT },
      fs,
      log: () => {},
      argv: [],
    });
    assert.equal(r.applied, false);
    assert.deepEqual(fs.writes, [], 'not one write');
  });

  test('the settings file is byte-identical after a declined run', async () => {
    const original = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }, null, 2);
    const fs = fakeFs({ [SETTINGS]: original });
    await runInstall({ env: { CLAUDE_PROJECT_DIR: PROJECT }, fs, log: () => {}, argv: [] });
    assert.equal(fs.files[SETTINGS], original);
  });

  test('--apply does write', async () => {
    const fs = fakeFs({ [SETTINGS]: JSON.stringify({ hooks: {} }), [join(HERE, 'assets', 'heartbeat.sh')]: '#!/bin/sh\n' });
    const r = await runInstall({
      env: { CLAUDE_PROJECT_DIR: PROJECT },
      fs,
      log: () => {},
      argv: ['--apply', '--actor', 'claude_ai'],
    });
    assert.equal(r.code, 0);
    assert.ok(fs.writes.some((w) => w.path === SETTINGS), 'settings were written');
    assert.ok(fs.writes.some((w) => w.path === SCRIPT), 'and the script was installed');
  });

  test('the script is written BEFORE the settings that reference it', async () => {
    // Order is load-bearing: a hook whose script is missing fails CLOSED and
    // can deny Bash and Edit, including the edit needed to repair it. Register
    // first and the project is bricked in the window between the two writes.
    const fs = fakeFs({ [join(HERE, 'assets', 'heartbeat.sh')]: '#!/bin/sh\n' });
    await runInstall({ env: { CLAUDE_PROJECT_DIR: PROJECT }, fs, log: () => {}, argv: ['--apply', '--actor', 'a'] });
    const iScript = fs.writes.findIndex((w) => w.path === SCRIPT);
    const iSettings = fs.writes.findIndex((w) => w.path === SETTINGS);
    assert.ok(iScript >= 0 && iSettings >= 0, 'both were written');
    assert.ok(iScript < iSettings, 'script first');
  });

  test('a second --apply is a no-op on settings', async () => {
    const fs = fakeFs({ [join(HERE, 'assets', 'heartbeat.sh')]: '#!/bin/sh\n' });
    const env = { CLAUDE_PROJECT_DIR: PROJECT };
    await runInstall({ env, fs, log: () => {}, argv: ['--apply', '--actor', 'claude_ai'] });
    const after = fs.files[SETTINGS];
    fs.writes.length = 0;
    const r2 = await runInstall({ env, fs, log: () => {}, argv: ['--apply', '--actor', 'claude_ai'] });
    assert.equal(r2.plan.idempotent, true);
    assert.deepEqual(fs.writes, [], 'the second run wrote nothing');
    assert.equal(fs.files[SETTINGS], after, 'and the file is unchanged');
  });
});

// ===========================================================================
describe('a file we cannot parse is not an empty file', () => {
  test('a malformed settings.json is refused, not overwritten', async () => {
    const broken = '{ "hooks": { oops';
    const fs = fakeFs({ [SETTINGS]: broken, [join(HERE, 'assets', 'heartbeat.sh')]: '#!/bin/sh\n' });
    const r = await runInstall({
      env: { CLAUDE_PROJECT_DIR: PROJECT },
      fs,
      log: () => {},
      argv: ['--apply', '--actor', 'claude_ai'],
    });
    assert.equal(r.code, 1);
    assert.equal(r.applied, false);
    assert.equal(fs.files[SETTINGS], broken, 'left exactly as it was');
    assert.deepEqual(fs.writes, [], 'and nothing else was written either');
  });

  test('a JSON array at the top level is refused too', () => {
    const fs = fakeFs({ [SETTINGS]: '[]' });
    const r = readSettings(PROJECT, fs);
    assert.equal(r.settings, null);
    assert.match(r.parseError, /not a JSON object/);
  });

  test('assessInstall reports it as blocked rather than incomplete', () => {
    const fs = fakeFs({ [SETTINGS]: '{oops' });
    const local = inspectLocal({ projectDir: PROJECT, env: {}, fs });
    assert.equal(assessInstall(local).verdict, 'blocked');
  });
});

// ===========================================================================
describe('the actor is never defaulted', () => {
  test('no --actor means no env change', () => {
    // Contract 3.3: unset writes a row attributed to the key's human owner -
    // mislabelled but visible and fixable - whereas a NONEXISTENT id is
    // 403 AGENT_IDENTITY_NOT_RESOLVABLE and writes NO ROW AT ALL. So guessing
    // is strictly worse than leaving it unset, and one installation's user id
    // does not belong in shipped code.
    const plan = planMerge({}, {});
    assert.equal(plan.next.env?.IDEABASE_ACTOR, undefined);
    assert.equal(plan.changes.some((c) => c.kind.includes('actor')), false);
  });

  test('an export-only actor is reported as weaker than a configured one', () => {
    // Measured: a session started detached with the variable exported resolved
    // no task id at all, because a detached session does not inherit the
    // launching shell's environment.
    const fs = fakeFs({ [SETTINGS]: JSON.stringify(installedSettings({ env: {} })), [SCRIPT]: '#!/bin/sh\n' });
    const local = inspectLocal({ projectDir: PROJECT, env: { IDEABASE_ACTOR: 'claude_ai' }, fs });
    assert.equal(local.actorExportOnly, true);
    assert.equal(local.actorEffective, null, 'an export does not count as configured');
    assert.ok(assessInstall(local).reasons.some((r) => /only a shell export/.test(r)));
  });

  test('an actor in the settings env block does count', () => {
    const fs = fakeFs({ [SETTINGS]: JSON.stringify(installedSettings()), [SCRIPT]: '#!/bin/sh\n' });
    const local = inspectLocal({ projectDir: PROJECT, env: {}, fs });
    assert.equal(local.actorEffective, 'claude_ai');
    assert.equal(local.actorExportOnly, false);
  });
});

// ===========================================================================
describe('criterion 3 + 11 - it can tell a working install from a broken one', () => {
  test('a project with NOTHING is reported incomplete, naming each missing piece', () => {
    // This is criterion 11's negative control: the command must be graded on a
    // repo that does not have the hooks.
    const fs = fakeFs({});
    const local = inspectLocal({ projectDir: PROJECT, env: {}, fs });
    const a = assessInstall(local);
    assert.equal(a.verdict, 'incomplete');
    const joined = a.reasons.join(' | ');
    assert.match(joined, /no \.claude\/settings\.json/);
    assert.match(joined, /SessionStart/);
    assert.match(joined, /PostToolUse/);
    assert.match(joined, /SessionEnd/);
    assert.match(joined, /heartbeat\.sh is missing/);
    assert.match(joined, /IDEABASE_ACTOR/);
  });

  test('DISCRIMINATION CONTROL: a correctly-installed project is NOT reported broken', () => {
    // The test worth keeping if anything is trimmed. A checker that reports
    // "broken" about everything passes every negative test above and is
    // worthless. #377 shipped a board that passed every check it had while
    // showing the wrong thing, for want of exactly this.
    const fs = fakeFs({ [SETTINGS]: JSON.stringify(installedSettings()), [SCRIPT]: '#!/bin/sh\n' });
    const local = inspectLocal({ projectDir: PROJECT, env: {}, fs });
    const a = assessInstall(local);
    assert.equal(a.verdict, 'complete', `expected complete, got ${a.verdict}: ${a.reasons.join('; ')}`);
    assert.deepEqual(a.reasons, []);
  });

  test('the two reports differ between a clean and a configured project', () => {
    // Criterion 3: shown to be reading real state, not printing a fixed string.
    const empty = inspectLocal({ projectDir: PROJECT, env: {}, fs: fakeFs({}) });
    const done = inspectLocal({
      projectDir: PROJECT,
      env: {},
      fs: fakeFs({ [SETTINGS]: JSON.stringify(installedSettings()), [SCRIPT]: '#!/bin/sh\n' }),
    });
    const rEmpty = renderSetupReport({ local: empty, assess: assessInstall(empty), plan: planMerge({}, {}) });
    const rDone = renderSetupReport({ local: done, assess: assessInstall(done), plan: planMerge(done.settings, {}) });
    assert.notEqual(rEmpty, rDone);
    assert.match(rEmpty, /NO - this project is not emitting/);
    assert.match(rDone, /YES - your sessions are being tracked/);
    assert.match(rEmpty, /MISSING/);
  });

  test("a complete install still says what it could NOT check", () => {
    // Criterion 6. The section is never omitted, because an absent section
    // reads identically to one nobody remembered to print.
    const done = inspectLocal({
      projectDir: PROJECT,
      env: {},
      fs: fakeFs({ [SETTINGS]: JSON.stringify(installedSettings()), [SCRIPT]: '#!/bin/sh\n' }),
    });
    const out = renderSetupReport({ local: done, assess: assessInstall(done), plan: planMerge(done.settings, {}) });
    assert.match(out, /WHAT I COULD NOT CHECK/);
    assert.match(out, /is_agent flag/, 'names the invisible failure it cannot rule out');
    assert.match(out, /NOT CHECKED/, 'and does not pass a wiring check off as a live one');
  });

  test('it does NOT claim ignorance of what the probe just established', () => {
    // The inverse error, and just as real: an earlier revision printed "I could
    // not check whether the agent id exists" on a run whose probe had come back
    // actor_is_agent=true one section earlier. Over-stating uncertainty trains
    // a reader to skip the honesty section, which costs what a false green does.
    const done = inspectLocal({
      projectDir: PROJECT,
      env: {},
      fs: fakeFs({ [SETTINGS]: JSON.stringify(installedSettings()), [SCRIPT]: '#!/bin/sh\n' }),
    });
    const withProbe = renderSetupReport({
      local: done,
      assess: assessInstall(done),
      plan: planMerge(done.settings, {}),
      doctor: { verdict: 'RECORDED - your sessions are being tracked', detail: ['row id 313 on task 990860', 'attributed to claude_ai (is_agent=true)'] },
    });
    assert.ok(!/is_agent flag/.test(withProbe), 'must not claim it could not check an identity it confirmed');
    assert.match(withProbe, /Established rather than assumed/);

    // ...and still says it when there was no probe.
    const noProbe = renderSetupReport({ local: done, assess: assessInstall(done), plan: planMerge(done.settings, {}) });
    assert.match(noProbe, /is_agent flag/, 'without a probe the caveat belongs');
  });

  test('criterion 2 - the report carries the LITERAL text to add', () => {
    const empty = inspectLocal({ projectDir: PROJECT, env: {}, fs: fakeFs({}) });
    const out = renderSetupReport({ local: empty, assess: assessInstall(empty), plan: planMerge({}, {}) });
    assert.ok(out.includes('"SessionEnd"'), 'the actual JSON key');
    assert.ok(out.includes(`"timeout": ${HOOK_TIMEOUT_SECONDS}`), 'including the load-bearing timeout');
    assert.ok(out.includes('[ -f \\"$h\\"') || out.includes('[ -f "$h"'), 'including the fail-open guard');
    assert.ok(out.includes('IDEABASE_ACTOR'));
  });
});

// ===========================================================================
describe('criterion 9 - the features inventory never fabricates', () => {
  const localDone = () => inspectLocal({
    projectDir: PROJECT,
    env: {},
    fs: fakeFs({ [SETTINGS]: JSON.stringify(installedSettings()), [SCRIPT]: '#!/bin/sh\n' }),
  });

  test('with no key, network rows are UNKNOWN - never OFF', () => {
    // "I could not ask" and "it is switched off" are different facts and a
    // customer acts on them differently. Collapsing them into a red tick is
    // how a working install gets reported as broken.
    const local = localDone();
    const rows = buildInventory({ local, assess: assessInstall(local), remote: null });
    for (const key of ['dispatch', 'work_sessions', 'time']) {
      const r = rows.find((x) => x.key === key);
      assert.equal(r.state, STATE.UNKNOWN, `${key} should be unknown without a key`);
      assert.ok(r.lastDataNote, `${key} must say why`);
    }
  });

  test('no row ever carries a timestamp nobody read', () => {
    const local = localDone();
    for (const remote of [null, { heartbeat: {}, workSession: {}, time: {}, dispatch: null, errors: [] }]) {
      for (const r of buildInventory({ local, assess: assessInstall(local), remote })) {
        if (r.lastData === null) {
          assert.ok(r.lastDataNote || r.state === STATE.OFF, `${r.key} has no data and no explanation`);
        } else {
          assert.equal(typeof r.lastData, 'string');
        }
      }
    }
  });

  test('hooks wired + nothing came back = CONFIGURED, NOT FIRING', () => {
    // The 2026-11-03 state exactly: the hook was registered in this project's
    // own repository and the board was empty all day. "heartbeats: on" would
    // have been true and useless.
    const local = localDone();
    const rows = buildInventory({
      local,
      assess: assessInstall(local),
      remote: { heartbeat: {}, workSession: {}, time: {}, dispatch: { available: true }, errors: [] },
    });
    const hb = rows.find((r) => r.key === 'heartbeats');
    assert.equal(hb.state, STATE.NOT_FIRING);
    assert.match(hb.turnOn, /doctor/, 'and points at the thing that can decide');
  });

  test('DISCRIMINATION CONTROL: a real ping makes it ON, not NOT_FIRING', () => {
    const local = localDone();
    const rows = buildInventory({
      local,
      assess: assessInstall(local),
      remote: {
        heartbeat: { lastPingAt: '2026-11-05T19:16:12.537Z' },
        workSession: {}, time: {}, dispatch: { available: true }, errors: [],
      },
    });
    const hb = rows.find((r) => r.key === 'heartbeats');
    assert.equal(hb.state, STATE.ON);
    assert.equal(hb.lastData, '2026-11-05T19:16:12.537Z');
  });

  test('no hooks = OFF, and it says what turns it on', () => {
    const local = inspectLocal({ projectDir: PROJECT, env: {}, fs: fakeFs({}) });
    const rows = buildInventory({ local, assess: assessInstall(local), remote: null });
    const hb = rows.find((r) => r.key === 'heartbeats');
    assert.equal(hb.state, STATE.OFF);
    assert.match(hb.turnOn, /install/);
  });

  test('a deliberate off is OFF, and is not reported as broken', () => {
    // Criterion 8's "configured and off by choice" must not read as a missing
    // piece, or a setup tool becomes something people stop running.
    const fs = fakeFs({ [SETTINGS]: JSON.stringify(installedSettings()), [SCRIPT]: '#!/bin/sh\n' });
    const local = inspectLocal({ projectDir: PROJECT, env: { IDEABASE_HEARTBEAT: 'off' }, fs });
    const rows = buildInventory({ local, assess: assessInstall(local), remote: null });
    const hb = rows.find((r) => r.key === 'heartbeats');
    assert.equal(hb.state, STATE.OFF);
    assert.match(hb.detail, /deliberate choice/);
    assert.equal(hb.state === STATE.NOT_FIRING, false);
  });

  test('the issue-link row agrees with the actual tool schema', () => {
    // The anti-drift pin. This row has been wrong twice in opposite directions
    // in one day: it claimed create_task accepted github_issue_id when the
    // field was absent, then said it was absent after 2.6.0 added it. A
    // sentence describing a data structure in this same package must be checked
    // against that structure, not re-read by a human each release.
    const src = readFileSync(join(HERE, 'index.js'), 'utf8');
    const block = (toolName) => {
      const at = src.indexOf(`name: '${toolName}'`);
      assert.ok(at > 0, `${toolName} not found in index.js`);
      // Stop at the next tool declaration so the window is just this tool.
      const next = src.indexOf("    name: '", at + 20);
      return src.slice(at, next > 0 ? next : src.length);
    };
    const onCreate = block('create_task').includes('github_issue_id');
    const onUpdate = block('update_task').includes('github_issue_id');

    const local = localDone();
    const r = buildInventory({ local, assess: assessInstall(local), remote: null })
      .find((x) => x.key === 'issue_link');

    if (onCreate && onUpdate) {
      assert.match(r.detail, /both create_task and update_task/,
        'both schemas carry the field, so the row must say both');
    } else if (onUpdate && !onCreate) {
      assert.match(r.detail, /NOT through create_task/,
        'create_task lacks the field, so the row must say it is unavailable there');
    } else {
      assert.fail(`unexpected schema shape (create=${onCreate}, update=${onUpdate}) - the row's wording needs revisiting, which is the point of this test`);
    }
  });

  test('verification_mode is honest that the data does not exist', () => {
    const local = localDone();
    const rows = buildInventory({ local, assess: assessInstall(local), remote: null });
    const v = rows.find((r) => r.key === 'verification');
    assert.equal(v.state, STATE.UNKNOWN);
    assert.match(v.lastDataNote, /990442/, 'names the open issue rather than inventing a default');
  });

  test('the rendered inventory prints a reasons section, never a bare grid', () => {
    const local = localDone();
    const rows = buildInventory({ local, assess: assessInstall(local), remote: null });
    const out = renderFeaturesReport({ local, rows, remote: null });
    assert.match(out, /WHAT I COULD NOT DETERMINE, AND WHY/);
    assert.ok(!out.includes('| 0 |'), 'no zero standing in for unknown');
    assert.match(out, /None of the above is a placeholder/);
  });
});

// ===========================================================================
describe('the doctor reads the anchor from the REAL state dir (regression)', () => {
  // The bug this pins was found by running the command against this very
  // repository: with only TMPDIR redirected to a private scratch dir, `resolve`
  // could not find the state file the hook had written under the real TMPDIR,
  // so the doctor reported NOT TRACKED for a session whose anchor was in fact
  // task 990860. A FALSE NEGATIVE - telling a correctly-configured customer
  // that their tracking is broken, which is worse than saying nothing.
  //
  // The two directories are genuinely different things in the hook:
  //   throttle stamp -> ${TMPDIR}/ib-heartbeat/...stamp         (no override)
  //   anchor state   -> ${IDEABASE_HEARTBEAT_STATE_DIR:-...}    (own override)
  // TMPDIR must be private so a doctor run cannot throttle away a live
  // session's own heartbeats; the anchor must still be read from the real path.
  test('TMPDIR is private but the state dir points at the real one', async () => {
    const fs = fakeFs({ [SCRIPT]: '#!/bin/sh\n', [SETTINGS]: JSON.stringify(installedSettings()) });
    let seen = null;
    await runDoctor({
      env: { CLAUDE_PROJECT_DIR: PROJECT, TMPDIR: '/real/tmp', IDEABASE_HEARTBEAT_KEY: 'k' },
      fs,
      log: () => {},
      exec: (_cmd, _args, opts) => { seen = opts.env; return 'TASK_ID=\nISSUE=\n'; },
    });
    assert.ok(seen, 'the hook was invoked');
    assert.notEqual(seen.TMPDIR, '/real/tmp', 'TMPDIR must be redirected to a scratch dir');
    assert.equal(seen.IDEABASE_HEARTBEAT_STATE_DIR, '/real/tmp/ib-heartbeat',
      'but the anchor must still be read from the real state dir');
  });

  test('an explicit IDEABASE_HEARTBEAT_STATE_DIR is respected', async () => {
    const fs = fakeFs({ [SCRIPT]: '#!/bin/sh\n' });
    let seen = null;
    await runDoctor({
      env: { CLAUDE_PROJECT_DIR: PROJECT, TMPDIR: '/real/tmp', IDEABASE_HEARTBEAT_STATE_DIR: '/custom/state', IDEABASE_HEARTBEAT_KEY: 'k' },
      fs,
      log: () => {},
      exec: (_c, _a, opts) => { seen = opts.env; return 'TASK_ID=\nISSUE=\n'; },
    });
    assert.equal(seen.IDEABASE_HEARTBEAT_STATE_DIR, '/custom/state');
  });

  test('exit 2 when nothing is installed, distinct from exit 1 for a refusal', async () => {
    // "I asked and was told no" and "I never managed to ask" need different
    // fixes, and a single boolean hides which one you have.
    const r = await runDoctor({
      env: { CLAUDE_PROJECT_DIR: PROJECT },
      fs: fakeFs({}),
      log: () => {},
    });
    assert.equal(r.code, 2);
    assert.match(r.verdict, /NOT INSTALLED/);
  });

  test('a declared-off install exits 0, not as a failure', async () => {
    const r = await runDoctor({
      env: { CLAUDE_PROJECT_DIR: PROJECT, IDEABASE_HEARTBEAT: 'off' },
      fs: fakeFs({}),
      log: () => {},
    });
    assert.equal(r.code, 0, 'deliberately off is not broken');
    assert.match(r.verdict, /DISABLED/);
  });

  test('no anchor exits 2 and says so is correct for an ad-hoc session', async () => {
    const fs = fakeFs({ [SCRIPT]: '#!/bin/sh\n' });
    const r = await runDoctor({
      env: { CLAUDE_PROJECT_DIR: PROJECT, IDEABASE_HEARTBEAT_KEY: 'k' },
      fs,
      log: () => {},
      exec: () => 'TASK_ID=\nISSUE=\nANCHOR_SOURCE=NOTHING RESOLVED\n',
    });
    assert.equal(r.code, 2);
    assert.match(r.verdict, /NOT TRACKED/);
  });
});

// ===========================================================================
describe('the packaged hook script', () => {
  test('matches the sha256 recorded in its provenance manifest', () => {
    // Catches a local edit to the vendored copy. Byte-identity with upstream is
    // a cross-repo check neither repo's CI can perform today, so the manifest
    // records the origin commit and this asserts nothing drifted since.
    const manifest = JSON.parse(readFileSync(join(HERE, 'assets', 'heartbeat.provenance.json'), 'utf8'));
    const body = readFileSync(join(HERE, 'assets', 'heartbeat.sh'), 'utf8');
    assert.equal(sha256(body), manifest.sha256);
    assert.equal(manifest.origin_repo, 'IDEAManagement/idea-base.us');
    assert.match(manifest.origin_commit, /^[0-9a-f]{40}$/);
  });

  test('the version the server reports matches the version shipped', () => {
    // It had drifted: serverInfo said 1.0.0 while package.json was at 2.5.0, so
    // the version a client displayed bore no relation to the one installed -
    // which makes "does this build have /idea-base:setup?" unanswerable from
    // the client side. Asserted rather than commented so it cannot drift again.
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    const src = readFileSync(join(HERE, 'index.js'), 'utf8');
    assert.ok(
      src.includes(`version: '${pkg.version}'`),
      `src/index.js does not declare version '${pkg.version}' - serverInfo has drifted from package.json`,
    );
  });

  test('is listed in package.json files, or it would not be published', () => {
    // The silent one: `files` decides what npm actually ships, so an asset left
    // out of it is absent for every customer while working perfectly from a git
    // checkout - and installing hooks that point at a missing script fails
    // CLOSED and can deny Bash and Edit.
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    for (const f of ['src/assets/heartbeat.sh', 'src/cli.js', 'src/setup.js', 'src/features.js', 'src/render.js']) {
      assert.ok(pkg.files.includes(f), `${f} is missing from package.json "files" and would not be published`);
    }
  });

  test('the script it ships still supports the resolve mode the doctor calls', () => {
    const body = readFileSync(join(HERE, 'assets', 'heartbeat.sh'), 'utf8');
    assert.match(body, /start\|tool\|stop\|resolve/, 'resolve is an accepted event');
    assert.match(body, /ANCHOR_SOURCE=/, 'and it prints the field the doctor parses');
  });

  test('and it does NOT parse a branch name for the task id', () => {
    // idea-base.us#411 deleted that, and it is the precondition that makes this
    // contract installable in a second repository at all: the branch parse did
    // not merely fail on unexpected names, it SUCCEEDED against the wrong task
    // on names it recognised.
    const body = readFileSync(join(HERE, 'assets', 'heartbeat.sh'), 'utf8');
    const live = body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/\.git\/HEAD/.test(live), 'no .git/HEAD read in live code');
    assert.ok(!/issue\[\/-\]/.test(live), 'no issue[/-]<digits> branch match in live code');
  });
});
