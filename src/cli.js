// cli.js - `install`, `doctor` and `features` subcommands. Issue #383.
//
// =============================================================================
// WHY THERE IS A CLI AT ALL, AND NOT JUST A PROMPT
// =============================================================================
// The MCP spec has no primitive for writing a customer's settings file -
// resources are list/read/subscribe only - so the prompt's job is to RECOMMEND.
// But three of this issue's acceptance criteria are claims about the WRITE:
// that declining leaves the config byte-identical, that pre-existing unrelated
// hooks survive it, and that a second run changes nothing. If the writer were a
// model improvising an edit, not one of those would be checkable.
//
// So the write is a deterministic subcommand over a pure merge function, and
// consent is the user running it. The prompt never writes; this does, and only
// with --apply.
//
// =============================================================================
// WHY `doctor` IS NOT OPTIONAL
// =============================================================================
// A customer must be able to tell a working install from a broken one, and
// "three hooks are registered" does not establish that. Absence is silent at
// several points in the heartbeat path: the endpoint answers HTTP 202 with
// `{"recorded":false}` when it discards a ping, a nonexistent agent id is
// refused with no row written at all, and a read-only key is rejected before
// the handler runs. Every one of those looks like success from the outside.
//
// This posts ONE labelled probe and reports the server's own `recorded` verdict.

// Only `realFs` is imported, deliberately. An earlier revision also pulled in
// the individual functions and used them directly in runInstall, which made the
// injected `fs` decorative: every write went to the real disk regardless, and
// the tests that prove "a dry run writes nothing" and "the script is written
// before the settings" were asserting against a filesystem they did not
// control. The test suite caught it by trying to mkdir /fake/project.
import * as realFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  resolveProjectDir,
  inspectLocal,
  assessInstall,
  planMerge,
  readSettings,
  sha256,
  HOOK_SCRIPT_REL,
} from './setup.js';
import { buildInventory, probeRemote } from './features.js';
import { renderSetupReport, renderFeaturesReport, renderInstallPlan } from './render.js';
import {
  PACKAGE_VERSION,
  UPDATE_COMMAND,
  fetchLatestVersion,
  isNewer,
  readProvenance,
  planScriptRefresh,
  SCRIPT_STATE,
} from './update.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SUBCOMMANDS = new Set(['install', 'update', 'doctor', 'features', 'setup']);

function parseFlags(argv) {
  const flags = { apply: false, actor: null, json: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--actor') { flags.actor = (argv[i + 1] || '').trim() || null; i += 1; }
    else if (a.startsWith('--actor=')) flags.actor = a.slice(8).trim() || null;
  }
  return flags;
}

// `update --help` USED TO PERFORM THE UPDATE.
//
// An unrecognised flag is simply ignored by parseFlags, which is harmless for
// `install` (its default is a dry run) and is not harmless here: `update`
// writes, so someone asking a question got an action. Found by an independent
// verifier on idea-base.us#448 after v2.9.0 had already published.
//
// Only `update` gets this, deliberately. Giving every subcommand a help screen
// is a bigger change than the defect warrants, and the other subcommands do not
// write without `--apply`.
const UPDATE_HELP = [
  'Usage:  npx @idea-base/mcp-server@latest update [--dry-run] [--actor <agent-user-id>]',
  '',
  'Moves an existing install forward:',
  '  * refreshes the files this package installed here (.claude/hooks/heartbeat.sh),',
  '    leaving a copy you edited yourself exactly as it is;',
  '  * re-asserts the three heartbeat hook registrations, preserving your other',
  '    hooks and every unrelated key in .claude/settings.json;',
  '  * runs the doctor check and prints whether tracking actually works.',
  '',
  'Running a second time changes nothing.',
  '',
  '  --dry-run            print everything above and write NOTHING',
  '  --actor <id>         set env.IDEABASE_ACTOR; never guessed if omitted',
  '',
  'Environment:',
  '  CLAUDE_PROJECT_DIR   the project to update (defaults to the current directory)',
  '  IDEA_BASE_UPDATE_CHECK=off   do not ask npm whether a newer version exists',
  '',
  'A session restart is what loads a new server; this command cannot do that for you.',
].join('\n');

function apiBase(env) {
  const custom = (env.IDEA_BASE_API_URL || '').trim();
  return custom || 'https://app.idea-base.us/api';
}

/**
 * THREE tiers, in the SAME order heartbeat.sh resolves them (idea-base.us
 * .claude/hooks/heartbeat.sh, the vendored copy at src/assets/heartbeat.sh):
 * IDEABASE_HEARTBEAT_KEY, then IDEA_BASE_API_KEY (the MCP server's own name
 * for this same credential - a customer who sets one and assumes the other
 * inherits gets silence otherwise), then our own secrets store. Before
 * idea-base.us#440 / idea-base-mcp#29 this stopped at the second tier, so a
 * machine where only the secrets fallback resolved made `doctor` report
 * ABSENT for a hook that was in fact sending successfully.
 *
 * `doctor` does NOT use this function's return to decide the PRESENT/ABSENT
 * verdict - see runDoctor, which reads that off the hook's own `resolve`
 * output instead, so the two can never disagree about whether a key exists.
 * This exists only to obtain a USABLE VALUE for the probe `doctor` sends
 * itself, because the hook deliberately never prints the value
 * (heartbeat.sh: "names are safe to print, values are not").
 */
function resolveKey(env, exec = execFileSync) {
  const hook = (env.IDEABASE_HEARTBEAT_KEY || '').trim();
  if (hook) return { key: hook, source: 'IDEABASE_HEARTBEAT_KEY' };
  const mcp = (env.IDEA_BASE_API_KEY || '').trim();
  if (mcp) return { key: mcp, source: 'IDEA_BASE_API_KEY' };
  try {
    const getter = join(env.HOME || '', '.claude', 'core', 'secrets', 'get');
    const out = exec(getter, ['idea-base-api-key'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) return { key: out, source: 'secrets/get(idea-base-api-key)' };
  } catch { /* absent or failed - same silent-skip rule heartbeat.sh uses */ }
  return { key: null, source: null };
}

function makeApiGet(env) {
  const { key } = resolveKey(env);
  if (!key) return null;
  const base = apiBase(env);
  return async (path) => {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error('response was not JSON'); }
  };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
/**
 * Exit status is the contract `/idea-base:setup` gates on:
 *   0  the row was recorded (or heartbeats are deliberately switched off)
 *   1  the endpoint refused or skipped it
 *   2  could not get as far as asking
 *
 * `2` is a genuinely different answer from `1` and conflating them is the whole
 * problem: "I asked and was told no" and "I never managed to ask" need
 * different fixes, and a single boolean hides which one you have.
 */
export async function runDoctor({ env = process.env, fs = realFs, log = console.log, exec = execFileSync } = {}) {
  const { dir: projectDir } = resolveProjectDir(env);
  const local = inspectLocal({ projectDir, env, fs });

  if (local.env.heartbeatOff) {
    log('=== verdict: DISABLED ===');
    log('  IDEABASE_HEARTBEAT is set to off. Nothing is emitted, deliberately.');
    return { code: 0, verdict: 'DISABLED', detail: ['heartbeats are switched off by IDEABASE_HEARTBEAT'] };
  }

  const scriptPath = join(projectDir, HOOK_SCRIPT_REL);
  if (!local.script.present) {
    log('=== verdict: NOT INSTALLED ===');
    log(`  ${HOOK_SCRIPT_REL} is absent, so there is no hook to ask.`);
    log('  Fix:  npx @idea-base/mcp-server install --apply --actor <agent-user-id>');
    return {
      code: 2,
      verdict: 'NOT INSTALLED - no heartbeat script in this project, so nothing could be asked',
      detail: [`${HOOK_SCRIPT_REL} is absent`, 'fix: npx @idea-base/mcp-server install --apply'],
    };
  }

  // Ask the REAL hook what it would send. A diagnostic that re-derives the
  // anchor itself would resolve differently from the hook and so would pass
  // while the hook failed - which is the exact failure this is meant to expose.
  //
  // THE TWO DIRECTORIES ARE NOT THE SAME DIRECTORY, and conflating them makes
  // this command lie in the worst direction. The hook keeps:
  //
  //   the throttle stamp  at ${TMPDIR}/ib-heartbeat/<cksum>.stamp
  //   the resolved anchor at ${IDEABASE_HEARTBEAT_STATE_DIR:-${TMPDIR}/ib-heartbeat}/<cksum>.anchor
  //
  // TMPDIR must be private, because the 60-second throttle stamp is keyed on
  // the project directory and invoking the hook from inside a live session
  // would otherwise throttle that session's own heartbeats away for a minute.
  // But the ANCHOR has to be read from the real location, or `resolve` finds no
  // state file and reports "nothing resolved" for a session that is in fact
  // perfectly tracked.
  //
  // Measured: with only TMPDIR redirected, this command reported NOT TRACKED
  // for a session whose own anchor was task 990860 - a FALSE NEGATIVE, telling
  // a correctly-configured customer their tracking was broken. The state-dir
  // override exists precisely so the two can be separated.
  let resolved = {};
  try {
    const scratch = mkdtempSync(join(tmpdir(), 'ib-doctor-'));
    const realStateDir = join((env.TMPDIR || '/tmp'), 'ib-heartbeat');
    const out = exec('sh', [scriptPath, 'resolve'], {
      cwd: projectDir,
      env: {
        ...env,
        TMPDIR: scratch,
        IDEABASE_HEARTBEAT_STATE_DIR: env.IDEABASE_HEARTBEAT_STATE_DIR || realStateDir,
        CLAUDE_PROJECT_DIR: projectDir,
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) resolved[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch (err) {
    log('=== verdict: COULD NOT ASK THE HOOK ===');
    log(`  ${err?.message || 'resolve failed'}`);
    return { code: 2, verdict: 'COULD NOT ASK THE HOOK', detail: [String(err?.message || err)] };
  }

  const taskId = (resolved.TASK_ID || '').trim();
  const issueId = (resolved.ISSUE || '').trim();

  // THE ANCHOR CHECK RUNS BEFORE ANYTHING ABOUT THE KEY IS EVER PRINTED.
  // idea-base.us#440 criterion 3: a no-anchor session used to see a `key:`
  // line immediately above "NOT TRACKED", which reads as "the key is the
  // problem" when it is not - there was never anything to send regardless.
  log('=== resolution (what the hook would send from here) ===');
  log(`  project dir : ${projectDir}`);
  log(`  task_id     : ${taskId || '(none)'}`);
  log(`  issue_id    : ${issueId || '(none)'}`);
  log(`  resolved by : ${resolved.ANCHOR_SOURCE || '(unrecorded)'}`);

  if (!taskId && !issueId) {
    log('');
    log('=== verdict: NOT TRACKED - no anchor ===');
    log('  This session has not declared what it is working on, so there is');
    log('  nothing truthful to send and nothing is sent. That is correct for a');
    log('  session that is not working a task.');
    log('  Fix: call start_working(task_id), or set IDEABASE_TASK_ID.');
    return {
      code: 2,
      verdict: 'NOT TRACKED - this session declared no task, so nothing is sent (correct for an ad-hoc session)',
      detail: ['fix: call start_working(task_id) or set IDEABASE_TASK_ID'],
    };
  }

  // THE VERDICT COMES FROM THE HOOK, NOT FROM RE-DERIVING. `resolved.API_KEY`
  // is the hook's own `resolve` output (heartbeat.sh:529) and already walks
  // the real IDEABASE_HEARTBEAT_KEY -> IDEA_BASE_API_KEY -> secrets/get
  // precedence, so trusting it here is what makes doctor's PRESENT/ABSENT
  // verdict unable to diverge from what the hook actually does - the whole
  // point of #440. `resolveKey` below mirrors that same precedence only to
  // obtain a usable VALUE for the probe this function sends, since the hook
  // deliberately never prints the value.
  const hookKeyPresent = (resolved.API_KEY || '').trim() === 'present';
  const { key, source: keySource } = resolveKey(env, exec);
  log(`  key         : ${hookKeyPresent ? `present via ${keySource || '(hook-confirmed)'}` : 'ABSENT'}`);
  log(`  actor       : ${resolved.ACTOR || '(unset)'}`);
  log('');

  if (!hookKeyPresent) {
    log('=== verdict: NO KEY ===');
    log('  The hook (resolve) found no credential here - checked');
    log('  IDEABASE_HEARTBEAT_KEY, IDEA_BASE_API_KEY, then the secrets store.');
    log('  Note the key must have WRITE scope.');
    return { code: 2, verdict: 'NO KEY - nothing could be sent', detail: ['set IDEABASE_HEARTBEAT_KEY or IDEA_BASE_API_KEY (write scope)'] };
  }
  if (!key) {
    // Should never happen - resolveKey mirrors the hook's own precedence
    // exactly - but never send a probe without an actual value in hand.
    log('=== verdict: COULD NOT ASK THE HOOK ===');
    log('  The hook reports a key resolves, but this process could not obtain');
    log('  the same value itself.');
    return { code: 2, verdict: 'COULD NOT ASK THE HOOK', detail: ['key presence and key value disagreed'] };
  }

  // The probe's session id is deliberately NOT a real harness session id, so a
  // row this writes can never be mistaken for evidence that the emitter itself
  // works. A board populated by diagnostics is not a live board.
  const body = { event: 'tool', session_id: `doctor-${process.pid}`, spoke: 'mcp-doctor' };
  if (taskId) body.task_id = Number(taskId);
  else body.issue_id = issueId;

  const url = `${apiBase(env).replace(/\/api$/, '/api')}/heartbeat`;
  let status = 0;
  let text = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(resolved.ACTOR && !resolved.ACTOR.startsWith('<') ? { 'X-On-Behalf-Of': resolved.ACTOR } : {}),
      },
      body: JSON.stringify(body),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    log('=== verdict: NO RESPONSE ===');
    log(`  ${err?.message || 'request failed'}`);
    return { code: 1, verdict: 'NO RESPONSE from the endpoint', detail: [String(err?.message || err)] };
  }

  log('=== response ===');
  log(`  HTTP ${status}`);
  log(`  ${text.slice(0, 400)}`);
  log('');

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* reported below */ }

  // HTTP 202 WITH `recorded:false` IS THE TRAP. A plausible status, a refusal
  // buried in the body, and a client that never read it is why no stop
  // heartbeat had ever been recorded before idea-base.us#409. The status code
  // is not the verdict; the `recorded` field is.
  if (parsed?.recorded === true) {
    const agent = parsed.actor_is_agent === true;
    log('=== verdict: RECORDED ===');
    log(`  attributed to : ${parsed.actor_id || '(unknown)'} (is_agent=${parsed.actor_is_agent})`);
    if (!agent) {
      log('  WARNING: attributed to a non-agent identity. The agent board filters');
      log('  to agents, so sessions like this are filtered off it entirely.');
      log('  Fix: set env.IDEABASE_ACTOR in .claude/settings.json.');
    }
    return {
      code: 0,
      verdict: agent ? 'RECORDED - your sessions are being tracked' : 'RECORDED, BUT MIS-ATTRIBUTED - the row landed as a non-agent and will be filtered off the agent board',
      detail: [
        `row id ${parsed.id ?? '?'} on task ${parsed.task_id ?? '?'}`,
        `attributed to ${parsed.actor_id || '(unknown)'} (is_agent=${parsed.actor_is_agent})`,
        ...(agent ? [] : ['fix: set env.IDEABASE_ACTOR in .claude/settings.json']),
      ],
    };
  }

  const reason = parsed?.reason || parsed?.code || parsed?.error || `HTTP ${status}`;
  log(`=== verdict: NOT RECORDED - reason: ${reason} ===`);
  if (status === 202) {
    log('  Note the status: 202 is a SUCCESS code for "I threw this away". The');
    log('  status line is not the verdict - the `recorded` field is.');
  }
  if (reason === 'issue_not_resolved') {
    log('  No task in your workspace carries that GitHub issue number in');
    log('  github_issue_id, so the ping had nowhere to land.');
  }
  if (status === 403) {
    log('  403 here is one of: a read-only API key on a POST, or a declared');
    log('  actor that does not exist or is a human. All three write NO ROW.');
  }
  return {
    code: 1,
    verdict: `NOT RECORDED - the server refused it (${reason})`,
    detail: [`HTTP ${status}`, `reason: ${reason}`],
  };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------
/**
 * Writes the script BEFORE registering anything that points at it.
 *
 * The order is load-bearing, not tidy. A hook whose script is missing fails
 * CLOSED - it can deny Bash and Edit, including the edit needed to repair the
 * hook - and subagents inherit session hooks, so delegating does not help
 * either. Registering first and copying second would leave a window in which
 * the project is bricked, and if the copy then failed it would stay that way.
 */
export async function runInstall({ env = process.env, fs = realFs, log = console.log, argv = [] } = {}) {
  const flags = parseFlags(argv);
  const { dir: projectDir } = resolveProjectDir(env);
  const local = inspectLocal({ projectDir, env, fs });
  const actor = flags.actor || local.actorEffective || null;
  const plan = planMerge(local.settings ?? {}, { actor });

  if (!flags.apply) {
    log(renderInstallPlan({ local, plan, actor }));
    return { code: local.parseError ? 1 : 0, applied: false, plan };
  }

  if (local.parseError) {
    log(`REFUSING: ${local.settingsPath} - ${local.parseError}`);
    log('A file I cannot parse is not an empty file; rewriting it would delete');
    log('every hook you have. Fix the JSON and run this again.');
    return { code: 1, applied: false, plan };
  }

  const assetPath = join(HERE, 'assets', 'heartbeat.sh');
  const destPath = join(projectDir, HOOK_SCRIPT_REL);
  let wroteScript = false;
  if (!local.script.present) {
    if (!fs.existsSync(assetPath)) {
      // This is the `files` footgun made loud. package.json's `files` list
      // decides what npm actually publishes, so a vendored asset left out of it
      // is silently absent for every customer while working perfectly from a
      // git checkout.
      log(`REFUSING: the packaged hook script is missing at ${assetPath}.`);
      log('This build of the package cannot install session tracking. Registering');
      log('the hooks without it would point three hooks at a missing file, which');
      log('fails CLOSED and can deny Bash and Edit in your session.');
      return { code: 1, applied: false, plan };
    }
    fs.mkdirSync(dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, fs.readFileSync(assetPath, 'utf8'), 'utf8');
    try { fs.chmodSync(destPath, 0o755); } catch { /* best effort; the hook is invoked via `sh` */ }
    wroteScript = true;
    log(`wrote ${HOOK_SCRIPT_REL}`);
  }

  if (plan.idempotent) {
    log(wroteScript
      ? 'Script installed. The hook registrations were already correct, so settings.json is unchanged.'
      : 'Nothing to do - already installed correctly. settings.json left byte-identical.');
    return { code: 0, applied: wroteScript, plan };
  }

  fs.mkdirSync(dirname(local.settingsPath), { recursive: true });
  fs.writeFileSync(local.settingsPath, `${JSON.stringify(plan.next, null, 2)}\n`, 'utf8');
  for (const c of plan.changes) log(`  * ${c.detail}`);
  log('');
  log(`updated ${local.settingsPath}`);
  if (!actor) {
    log('');
    log('env.IDEABASE_ACTOR was NOT set, because no --actor was given and one is');
    log('never defaulted: a wrong agent id is refused by the server and writes no');
    log('row at all, which is worse than a visibly mislabelled one.');
  }
  log('');
  log('Verify it:  npx @idea-base/mcp-server doctor');
  return { code: 0, applied: true, plan };
}

// ---------------------------------------------------------------------------
// update (#448)
// ---------------------------------------------------------------------------
/**
 * Move an existing install forward: refresh the files this package wrote,
 * re-assert the hook registrations, then run the doctor check and say plainly
 * where the customer stands.
 *
 * WHY THIS WRITES BY DEFAULT WHILE `install` REQUIRES `--apply`.
 * `install` is a first contact with a project that may already be configured by
 * hand, so it shows a plan and waits. `update` is asked for by name, and the
 * only file it will ever replace is one whose bytes it recognises as a copy it
 * shipped itself (planScriptRefresh). A copy the customer edited is refused, not
 * merged and not overwritten. So there is nothing here for a confirmation step
 * to protect, and making the one command the issue asks for into two would
 * defeat its purpose. `--dry-run` previews anyway.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch npm. Running
 * `npx @idea-base/mcp-server@latest update` IS the npm work - npx resolves and
 * fetches `latest` in order to run this code at all. How the customer's CLIENT
 * launches the server (a bare `npx`, a pinned version, a global `-g` install, a
 * lockfile) is their configuration, and a command that guessed at it and
 * "fixed" it would be reaching outside what it can see. So the restart is named
 * and not performed - the CEO's own framing on #448: "Sure we can't restart but
 * that's not entirely our problem to solve."
 *
 * EXIT CODE IS ABOUT THE UPDATE, NOT ABOUT THE TRACKING. A clean install on a
 * machine with no API key updates perfectly and is still not tracking anything;
 * reporting that as a failed update would be a lie in the expensive direction,
 * because the next thing a customer does with a non-zero exit is re-run it. The
 * doctor verdict is printed in full and returned, so a caller that cares can
 * read it - exactly the 1-vs-2 distinction runDoctor already makes.
 */
export async function runUpdate({
  env = process.env,
  fs = realFs,
  log = console.log,
  argv = [],
  doctor = runDoctor,
  fetchLatest = fetchLatestVersion,
} = {}) {
  const flags = parseFlags(argv);

  // Before ANY filesystem read and before asking npm anything: someone typing
  // --help is asking a question, not requesting a write.
  if (flags.help) {
    log(UPDATE_HELP);
    return { code: 0, applied: false, script: null, plan: null, doctor: null, help: true };
  }

  const { dir: projectDir, source: dirSource } = resolveProjectDir(env);
  const local = inspectLocal({ projectDir, env, fs });

  const latest = await fetchLatest({ env });

  log('=== IDEA Base MCP update ===');
  log(`  this package    : ${PACKAGE_VERSION}`);
  log(`  latest on npm   : ${latest.version || `unknown (${latest.error})`}`);
  log(`  project         : ${projectDir}  (via ${dirSource})`);
  if (latest.version && isNewer(latest.version, PACKAGE_VERSION)) {
    // Reachable when the customer ran a pinned or cached copy rather than
    // @latest. Saying so beats refreshing their files from a version that is
    // itself behind and reporting success.
    log('');
    log(`  NOTE: ${latest.version} is published but this is ${PACKAGE_VERSION}, so you are`);
    log(`  running an older copy of the updater. Re-run as:  ${UPDATE_COMMAND}`);
  }
  log('');

  if (local.parseError) {
    log(`REFUSING: ${local.settingsPath} - ${local.parseError}`);
    log('A file I cannot parse is not an empty file; rewriting it would delete');
    log('every hook you have. Fix the JSON and run this again.');
    return { code: 1, applied: false, script: null, doctor: null };
  }

  // --- the installed script ------------------------------------------------
  const provenance = readProvenance({ fs });
  const assetPath = join(HERE, 'assets', 'heartbeat.sh');
  let assetBody = null;
  try {
    assetBody = fs.readFileSync(assetPath, 'utf8');
  } catch {
    assetBody = null;
  }

  let shippedSha = null;
  if (assetBody === null) {
    // Same `files` footgun install refuses on: an asset left out of the
    // published tarball is absent for every customer while working perfectly
    // from a git checkout.
    log(`WARNING: the packaged hook script is missing at ${assetPath}.`);
    log('This build cannot refresh it. Your existing copy is left untouched.');
  } else {
    shippedSha = sha256(assetBody);
    if (provenance.sha256 && provenance.sha256 !== shippedSha) {
      // The manifest and the asset disagree, so this build does not know what
      // it ships. Refusing to write is the only safe branch: the alternative
      // is replacing a customer's file with bytes we cannot vouch for.
      log(`WARNING: this build's heartbeat.sh (${shippedSha.slice(0, 12)}) does not match its own`);
      log(`manifest (${provenance.sha256.slice(0, 12)}). Not touching your copy.`);
      shippedSha = null;
    }
  }

  const scriptPlan = planScriptRefresh({
    installedSha: local.script.present ? local.script.sha256 : null,
    shippedSha,
    knownShas: provenance.knownShas,
  });

  log('--- installed files ---');
  log(`  ${HOOK_SCRIPT_REL}`);
  log(`    ${scriptPlan.detail}`);

  const destPath = join(projectDir, HOOK_SCRIPT_REL);
  let wroteScript = false;
  if (scriptPlan.refresh && !flags.dryRun) {
    fs.mkdirSync(dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, assetBody, 'utf8');
    try { fs.chmodSync(destPath, 0o755); } catch { /* best effort; invoked via `sh` */ }
    wroteScript = true;
    log(`    wrote ${destPath}`);
  } else if (scriptPlan.refresh) {
    log('    (--dry-run: not written)');
  }
  log('');

  // --- the hook registrations ---------------------------------------------
  // planMerge, unchanged from install. structuredClone keeps every unrelated
  // key - other tools' hooks, permissions, env, statusLine - byte-for-byte, so
  // "preserves unrelated hooks and settings" is a property of the merge rather
  // than a promise made here.
  const actor = flags.actor || local.actorEffective || null;
  const plan = planMerge(local.settings ?? {}, { actor });

  log('--- hook registrations ---');
  if (plan.idempotent) {
    log(`  already correct - ${local.settingsExists ? `${local.settingsPath} left byte-identical` : 'nothing to write'}`);
  } else {
    for (const c of plan.changes) log(`  * ${c.detail}`);
  }
  if (local.foreignHooks) {
    log(`  (${local.foreignHooks} hook${local.foreignHooks === 1 ? '' : 's'} belonging to other tools, untouched)`);
  }

  let wroteSettings = false;
  if (!plan.idempotent && !flags.dryRun) {
    fs.mkdirSync(dirname(local.settingsPath), { recursive: true });
    fs.writeFileSync(local.settingsPath, `${JSON.stringify(plan.next, null, 2)}\n`, 'utf8');
    wroteSettings = true;
    log(`  updated ${local.settingsPath}`);
  } else if (!plan.idempotent) {
    log('  (--dry-run: not written)');
  }
  log('');

  if (flags.dryRun) {
    log('=== verdict: DRY RUN - nothing was written ===');
    log(`  Run without --dry-run to apply, then restart your session.`);
    return { code: 0, applied: false, script: scriptPlan, plan, doctor: null, dryRun: true };
  }

  // --- the doctor check (criterion 3) -------------------------------------
  log('--- doctor ---');
  const doc = await doctor({ env, fs, log: (s) => log(`  ${s}`) });
  log('');

  log('=== verdict ===');
  const changed = [];
  if (wroteScript) changed.push(HOOK_SCRIPT_REL);
  if (wroteSettings) changed.push('.claude/settings.json');
  log(changed.length
    ? `  Updated: ${changed.join(', ')}.`
    : '  Nothing needed changing - this install was already current.');
  if (scriptPlan.state === SCRIPT_STATE.MODIFIED && local.script.present) {
    log(`  Your ${HOOK_SCRIPT_REL} was left as you wrote it (see above).`);
  }
  log(`  Tracking check: ${doc.verdict}`);
  log('');
  // Said unconditionally, including when nothing was written, because the
  // customer may well have updated the PACKAGE (npx fetched a new one to run
  // this) even when neither installed file needed changing - and the running
  // server in their session is still the old one either way.
  log('  RESTART REQUIRED: a running MCP server keeps the code it started with.');
  log('  Nothing you just did reaches the session you are in now - start a new');
  log('  session (or restart your editor) to load this version.');

  return { code: 0, applied: wroteScript || wroteSettings, script: scriptPlan, plan, doctor: doc };
}

// ---------------------------------------------------------------------------
// features / setup (CLI forms of the two prompts)
// ---------------------------------------------------------------------------
export async function runFeatures({ env = process.env, fs = realFs, log = console.log } = {}) {
  const { dir: projectDir } = resolveProjectDir(env);
  const local = inspectLocal({ projectDir, env, fs });
  const assess = assessInstall(local);
  const apiGet = makeApiGet(env);
  const remote = apiGet ? await probeRemote(apiGet) : null;
  const rows = buildInventory({ local, assess, remote });
  log(renderFeaturesReport({ local, rows, remote }));
  return { code: 0, rows };
}

export async function runSetup({ env = process.env, fs = realFs, log = console.log } = {}) {
  const { dir: projectDir } = resolveProjectDir(env);
  const local = inspectLocal({ projectDir, env, fs });
  const assess = assessInstall(local);
  const plan = local.parseError ? null : planMerge(local.settings ?? {}, { actor: local.actorEffective });
  let doctor = null;
  let probeSkippedReason = null;
  if (local.script.present) {
    const lines = [];
    const r = await runDoctor({ env, fs, log: (s) => lines.push(s) });
    doctor = { verdict: r.verdict, detail: r.detail };
  } else {
    probeSkippedReason = 'the heartbeat script is not installed here, so there is no hook to ask';
  }
  log(renderSetupReport({ local, assess, plan, doctor, probeSkippedReason }));
  return { code: 0, assess };
}

export async function runCli(argv, { env = process.env, fs = realFs, log = console.log } = {}) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'install': return runInstall({ env, fs, log, argv: rest });
    case 'update': return runUpdate({ env, fs, log, argv: rest });
    case 'doctor': return runDoctor({ env, fs, log });
    case 'features': return runFeatures({ env, fs, log });
    case 'setup': return runSetup({ env, fs, log });
    default:
      log(`Unknown subcommand: ${sub}`);
      return { code: 2 };
  }
}

export { readSettings };
