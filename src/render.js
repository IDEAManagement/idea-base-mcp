// render.js - turning the inspected state into something a person can act on.
// Issue #383.
//
// Two rules shape everything here.
//
// 1. SAY WHAT YOU COULD NOT CHECK. Acceptance criterion 6, and the reason the
//    issue exists at all. Every report ends with a "could not check" section,
//    and when there is nothing in it, it says so explicitly rather than being
//    omitted - an absent section is indistinguishable from a section nobody
//    remembered to print.
//
// 2. RECOMMEND WITH THE LITERAL TEXT. Criterion 2 wants "the literal text to
//    add", not a description of it. There is no sanctioned way for an MCP server
//    to write a customer's config through the protocol, so showing the exact
//    bytes is not merely polite, it is the only in-spec option.

import {
  PRODUCT_HOOKS,
  HOOK_SCRIPT_REL,
  HOOK_TIMEOUT_SECONDS,
  hookCommand,
} from './setup.js';
import { STATE, STATE_LABEL } from './features.js';

const RULE = '-'.repeat(72);

/** The exact JSON a customer needs in .claude/settings.json. */
export function settingsSnippet(actor = '<your agent identity\'s user id>') {
  const hooks = {};
  for (const spec of PRODUCT_HOOKS) {
    const entry = { type: 'command', command: hookCommand(spec.event), timeout: HOOK_TIMEOUT_SECONDS };
    if (spec.statusMessage) entry.statusMessage = spec.statusMessage;
    hooks[spec.hookEvent] = [{ hooks: [entry] }];
  }
  return JSON.stringify({ env: { IDEABASE_ACTOR: actor }, hooks }, null, 2);
}

function verdictLine(assess) {
  switch (assess.verdict) {
    case 'complete':
      return 'YES - your sessions are being tracked.';
    case 'complete_with_warnings':
      return 'PARTLY - the hooks are installed, but something below will make the data wrong.';
    case 'blocked':
      return 'CANNOT TELL - and I will not touch the file until it is fixed.';
    default:
      return 'NO - this project is not emitting session activity.';
  }
}

/**
 * The /idea-base:setup report.
 *
 * `doctor` is the live verdict when one was taken, otherwise null. Its absence
 * is reported rather than papered over: the local checks can say the wiring is
 * right, and ONLY a round trip can say the data lands. Treating the first as
 * the second is how this product ran for three days over an emitter that had
 * never once emitted.
 */
export function renderSetupReport({ local, assess, plan, doctor = null, probeSkippedReason = null }) {
  const L = [];
  const regs = local.registrations || {};

  L.push('IDEA BASE - SESSION TRACKING SETUP');
  L.push(RULE);
  L.push(`Project    : ${local.projectDir}`);
  L.push(`Settings   : ${local.settingsPath}${local.settingsExists ? '' : '   (does not exist yet)'}`);
  L.push('');
  L.push(`Are your sessions being tracked?  ${verdictLine(assess)}`);
  L.push('');

  if (local.parseError) {
    L.push(`!! ${local.settingsPath}`);
    L.push(`!! ${local.parseError}`);
    L.push('!!');
    L.push('!! REFUSING TO WRITE. A file I cannot parse is not an empty file, and');
    L.push('!! rewriting it from scratch would silently delete every hook you have.');
    L.push('!! Fix the JSON and run this again.');
    return L.join('\n');
  }

  // --- what is wired ---------------------------------------------------------
  L.push('WHAT IS WIRED');
  L.push('');
  L.push('| Piece | State | Detail |');
  L.push('| --- | --- | --- |');
  for (const spec of PRODUCT_HOOKS) {
    const r = regs[spec.event] || {};
    let state = r.present ? 'OK' : 'MISSING';
    const notes = [];
    if (r.duplicate) { state = 'DUPLICATE'; notes.push(`registered ${r.count}x - will double-write`); }
    if (r.misWired?.length) { state = 'MIS-WIRED'; notes.push(`carries '${r.misWired.join(", ")}' instead`); }
    if (r.present && !r.timeoutOk) {
      notes.push(spec.hookEvent === 'SessionEnd'
        ? `no "timeout": ${HOOK_TIMEOUT_SECONDS} - the stop POST can be cancelled mid-flight`
        : `no "timeout": ${HOOK_TIMEOUT_SECONDS}`);
    }
    L.push(`| ${spec.hookEvent} -> heartbeat.sh ${spec.event} | ${state} | ${notes.join('; ') || (r.present ? 'registered' : 'not registered')} |`);
  }
  L.push(`| ${HOOK_SCRIPT_REL} | ${local.script.present ? 'OK' : 'MISSING'} | ${local.script.present ? `present, sha256 ${local.script.sha256.slice(0, 12)}` : 'absent - any registration above points at nothing'} |`);
  L.push(`| env.IDEABASE_ACTOR | ${local.actorEffective ? 'OK' : (local.actorExportOnly ? 'EXPORT ONLY' : 'MISSING')} | ${local.actorEffective ? local.actorEffective : (local.actorExportOnly ? `'${local.env.hookActor}' is a shell export, which a detached session does not inherit` : 'unset - agent work will attribute to a human and be filtered off the agent board')} |`);
  L.push(`| API key for the hook | ${local.env.hookKey ? 'OK' : 'NOT IN ENV'} | ${local.env.hookKey ? 'IDEABASE_HEARTBEAT_KEY is set' : 'IDEABASE_HEARTBEAT_KEY unset; the hook also falls back to a local secret-store helper, which I cannot verify from here'} |`);
  if (local.foreignHooks) {
    L.push(`| other tools' hooks | ${local.foreignHooks} present | left untouched by anything this command does |`);
  }
  L.push('');

  // --- the live verdict ------------------------------------------------------
  // Deliberately its own section. "Three hooks are registered" and "a row
  // landed on the server" are different claims and the table above can only
  // make the first.
  L.push('DOES IT ACTUALLY LAND?');
  L.push('');
  if (doctor) {
    L.push(`  ${doctor.verdict}`);
    if (doctor.detail) for (const d of doctor.detail) L.push(`  ${d}`);
  } else {
    L.push(`  NOT CHECKED - ${probeSkippedReason || 'no live probe was taken'}.`);
    L.push('  The table above is about WIRING. Only a round trip proves the data');
    L.push('  lands, and absence is silent at several points in that path.');
    L.push('  Run:  npx @idea-base/mcp-server doctor');
  }
  L.push('');

  // --- what to do ------------------------------------------------------------
  if (plan && !plan.idempotent) {
    L.push('RECOMMENDED CHANGES');
    L.push('');
    for (const c of plan.changes) L.push(`  * ${c.detail}`);
    L.push('');
    L.push('  Nothing has been written. To see the merged file without writing it:');
    L.push('');
    L.push('      npx @idea-base/mcp-server install');
    L.push('');
    L.push('  and to apply it:');
    L.push('');
    L.push('      npx @idea-base/mcp-server install --apply --actor <agent-user-id>');
    L.push('');
    L.push('  It merges: your other hooks and settings are preserved, and running');
    L.push('  it twice changes nothing the second time.');
    L.push('');
    L.push('  Or paste this into ' + local.settingsPath + ' yourself:');
    L.push('');
    for (const line of settingsSnippet(local.actorEffective || undefined).split('\n')) L.push('      ' + line);
    L.push('');
  } else if (plan?.idempotent) {
    L.push('RECOMMENDED CHANGES');
    L.push('');
    L.push('  None. The three product hooks are registered correctly and the script');
    L.push('  is in place. Re-running this command is safe and will keep reporting');
    L.push('  the same thing.');
    L.push('');
  }

  // --- what I could not check ------------------------------------------------
  L.push('WHAT I COULD NOT CHECK');
  L.push('');
  // Honesty cuts BOTH ways, and getting this wrong in the generous direction is
  // still getting it wrong. An earlier revision printed "I could not check
  // whether the agent id exists" on a run whose live probe had just come back
  // actor_is_agent=true - claiming ignorance of something it had measured one
  // section earlier. Over-stating uncertainty trains a reader to skip the
  // section, which costs exactly as much as a false green.
  const agentConfirmed = doctor?.detail?.some((d) => /is_agent=true/.test(d));
  const landed = doctor && /^RECORDED/.test(doctor.verdict || '');

  const cant = [];
  if (!local.env.hookKey) {
    cant.push(landed
      ? 'which key the HOOK itself will use. The probe above authenticated with the key available to this command; IDEABASE_HEARTBEAT_KEY is unset, so the hook falls back to a local secret-store helper I cannot inspect. They can differ.'
      : 'whether the hook can find an API key. IDEABASE_HEARTBEAT_KEY is unset and the hook falls back to a local secret-store helper that I cannot inspect from here. Note the key must have WRITE scope - a read-only key is refused before the handler runs.');
  }
  if (!doctor) {
    cant.push('whether a heartbeat actually reaches the server, and whether it is attributed to an agent. Only the live probe answers that.');
  }
  if (!agentConfirmed) {
    cant.push('whether the agent id in IDEABASE_ACTOR exists and has its is_agent flag set. A nonexistent id is refused and writes NO ROW AT ALL, which is the invisible failure - the live probe is what catches it.');
  }
  cant.push('whether your harness is Claude Code. These three hooks are Claude Code mechanisms and nothing here transfers to another agent harness; on another harness the board is driven by work sessions and sweeps instead.');
  for (const c of cant) L.push(`  * ${c}`);
  if (agentConfirmed) {
    L.push('');
    L.push('  Established rather than assumed: the probe came back attributed to an');
    L.push('  agent identity the server accepted, so attribution is not in question.');
  }
  L.push('');
  L.push('  This section is never empty, and that is deliberate. A setup tool that');
  L.push('  claims a clean bill it did not verify is the defect this command exists');
  L.push('  to prevent, one level up - and nor does it claim ignorance of something');
  L.push('  it just measured.');

  return L.join('\n');
}

/** The /idea-base:features inventory. */
export function renderFeaturesReport({ local, rows, remote }) {
  const L = [];
  L.push('IDEA BASE - CAPABILITIES ON THIS MACHINE');
  L.push(RULE);
  L.push(`Project : ${local.projectDir}`);
  L.push('');
  L.push('This reports what is WIRED HERE, not what the product supports. A list');
  L.push('that always says yes would be decoration.');
  L.push('');
  L.push('| Capability | State | Last produced data | Detail |');
  L.push('| --- | --- | --- | --- |');
  for (const r of rows) {
    const last = r.lastData ? r.lastData : (r.state === STATE.OFF && r.lastDataNote?.startsWith('never') ? 'never' : 'not determined');
    L.push(`| ${r.name} | ${STATE_LABEL[r.state]} | ${last} | ${r.detail} |`);
  }
  L.push('');

  const turnOns = rows.filter((r) => r.turnOn);
  if (turnOns.length) {
    L.push('HOW TO TURN ON WHAT IS OFF');
    L.push('');
    for (const r of turnOns) {
      L.push(`  ${r.name}`);
      L.push(`      ${r.turnOn}`);
    }
    L.push('');
  }

  // The honesty section, and the one that took the most measuring. For three of
  // these capabilities no endpoint can answer "when did this last produce
  // data", so the alternative to saying so is inventing a number.
  const unknowns = rows.filter((r) => r.lastDataNote && !r.lastData);
  L.push('WHAT I COULD NOT DETERMINE, AND WHY');
  L.push('');
  if (unknowns.length === 0) {
    L.push('  Nothing - every row above carries a real observation.');
  } else {
    for (const r of unknowns) {
      L.push(`  ${r.name}`);
      L.push(`      ${r.lastDataNote}`);
    }
  }
  L.push('');
  L.push('  None of the above is a placeholder, a zero standing in for "unknown",');
  L.push('  or an estimate. Where a timestamp is missing it is because nothing');
  L.push('  could be read, and that is reported rather than filled in.');

  if (remote?.errors?.length) {
    L.push('');
    L.push('PROBES THAT FAILED');
    L.push('');
    for (const e of remote.errors) L.push(`  * ${e}`);
  }
  return L.join('\n');
}

/** The dry-run diff for `install`. */
export function renderInstallPlan({ local, plan, actor }) {
  const L = [];
  if (local.parseError) {
    L.push(`REFUSING: ${local.settingsPath} - ${local.parseError}`);
    L.push('A file I cannot parse is not an empty file. Rewriting it would delete');
    L.push('every hook you have. Fix the JSON and run this again.');
    return L.join('\n');
  }
  if (plan.idempotent) {
    L.push('Nothing to do - session tracking is already installed correctly here.');
    L.push('');
    L.push(`  ${local.settingsPath}`);
    L.push('  would be left byte-identical. This command is safe to run as often');
    L.push('  as you like.');
    return L.join('\n');
  }
  L.push('PLANNED CHANGES (nothing has been written)');
  L.push('');
  for (const c of plan.changes) L.push(`  * ${c.detail}`);
  if (!actor) {
    L.push('');
    L.push('  NOTE: no --actor given, so env.IDEABASE_ACTOR will NOT be set. Agent');
    L.push('  heartbeats will then attribute to your API key\'s human owner and be');
    L.push('  filtered off the agent-only board. This is deliberate rather than');
    L.push('  defaulted: a wrong agent id is refused by the server and writes no');
    L.push('  row at all, which is worse than a visibly mislabelled one.');
  }
  L.push('');
  L.push('  To apply:  npx @idea-base/mcp-server install --apply' + (actor ? ` --actor ${actor}` : ' --actor <agent-user-id>'));
  return L.join('\n');
}
