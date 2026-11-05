// setup.js - the state model behind /idea-base:setup, /idea-base:features and
// the `install` / `doctor` CLI subcommands. IDEA Base issue #383.
//
// =============================================================================
// THE RULE THIS MODULE EXISTS TO ENFORCE: NEVER REPORT A GREEN YOU DID NOT READ.
// =============================================================================
// #383 is not "add a setup command". It is that a product selling easier work
// tracking shipped working mechanisms and never told anyone to turn them on -
// and then, when they WERE on, nothing could tell a working install from a
// broken one. On 2026-11-03 the heartbeat hook was registered in this project's
// own repository and the live board was empty all day. A features list saying
// "heartbeats: on" would have been TRUE and USELESS.
//
// So every capability resolves to one of FOUR states, never two:
//
//   on                       - wired, and it has demonstrably produced data
//   configured_not_firing    - wired, and the thing it should produce is absent
//   unknown                  - wired, and NOTHING HERE CAN TELL YOU. Names why.
//   off                      - not wired. Names what turns it on.
//
// `unknown` is the load-bearing one and it is NOT a failure of this module.
// Measured against the live API on 2026-11-05: of the six capabilities the
// issue asks about, THREE have no endpoint that can answer "when did this last
// produce data" - sub-agent dispatch (`dispatches/index.js:3`: "CAPTURE ONLY:
// there is no GET-list, no aggregate, no card"), task-to-GitHub-issue linkage
// (no count, no ratio, no `linked_at`), and the verification_mode default
// (the COLUMN does not exist; inheritance is idea-base.us#990442, still open).
//
// Printing a plausible timestamp for those three would be fabricated data, and
// a fabricated green is the precise defect this whole issue is about, arriving
// one level up. `unknown` with a stated reason is the honest answer and is
// strictly more useful than a confident wrong one.
//
// =============================================================================
// WHY THE INSPECTOR IS A PURE FUNCTION OVER INJECTED I/O
// =============================================================================
// Acceptance criteria 4, 5 and 10 are all claims about THE WRITE: that
// declining leaves the config byte-identical, that pre-existing unrelated hooks
// survive, that a second run changes nothing. If the writer were a model
// improvising an edit, not one of those would be checkable. As a pure function
// over a parsed object they are ordinary unit tests - which is why `planMerge`
// returns a PLAN and touches no disk, and why every filesystem read arrives
// through an injected `fs`.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// The three product hooks. NOTHING ELSE IN OUR REPO IS THE PRODUCT.
// ---------------------------------------------------------------------------
// The contract's section 4 is explicit: idea-base.us/.claude/settings.json
// carries FIVE hook registrations and only these three ship. `session-brief.py`
// prints our hub/spoke process spec and `no-secret-trace.py` is our own guard;
// both reference files that will not exist on a customer machine, and a hook
// pointing at a missing script is the fail-closed trap in section 2.1 - it can
// deny Bash AND Edit, including the edit needed to repair it. Copying our
// settings file wholesale is therefore not a shortcut, it is an outage.
export const PRODUCT_HOOKS = [
  { event: 'start', hookEvent: 'SessionStart', statusMessage: 'Heartbeat: session start' },
  { event: 'tool', hookEvent: 'PostToolUse', statusMessage: null },
  { event: 'stop', hookEvent: 'SessionEnd', statusMessage: null },
];

export const HOOK_SCRIPT_REL = '.claude/hooks/heartbeat.sh';

// `timeout: 5` on the SessionEnd entry is LOAD-BEARING, not decoration.
// SessionEnd hooks share a 1.5s default budget that rises to the highest
// per-hook timeout in the settings file, and the `stop` POST is synchronous
// with a 3s cap. Register it without this and the hook can be cancelled
// mid-POST - which loses the one event that ever takes a session off the board.
// We write it on all three for uniformity; on SessionEnd it is required.
export const HOOK_TIMEOUT_SECONDS = 5;

/**
 * The exact `command` string for one product hook.
 *
 * The `sh -c` wrapper is not cosmetic. `[ -f "$h" ] || exit 0` makes a MISSING
 * script exit 0 instead of failing closed, while `exec` lets a genuine failure
 * in the real script still propagate. See the contract, section 2.1.
 */
export function hookCommand(event) {
  return `sh -c 'h="$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT_REL}"; [ -f "$h" ] || exit 0; exec sh "$h" ${event}'`;
}

// ---------------------------------------------------------------------------
// Project directory resolution. MEASURED, not assumed.
// ---------------------------------------------------------------------------
// Read off the live MCP server processes on 2026-11-05. For a server launched
// by a session running in a git worktree:
//
//   CLAUDE_PROJECT_DIR = /...-/worktrees/idea-base-issue-411   <- correct
//   process.cwd()      = /...-/worktrees/idea-base-issue-411   <- correct
//   PWD                = /.../idea-base.us                     <- WRONG
//
// `PWD` was the HUB's root, three directories up and a different checkout. A
// setup command that trusted it would inspect the wrong repository and report
// confidently on a directory the session is not in. So `PWD` is never
// consulted, and the order below is the measured one.
export function resolveProjectDir(env = process.env, cwd = process.cwd()) {
  const fromEnv = (env.CLAUDE_PROJECT_DIR || '').trim();
  if (fromEnv) return { dir: fromEnv, source: 'CLAUDE_PROJECT_DIR' };
  return { dir: cwd, source: 'process.cwd()' };
}

// ---------------------------------------------------------------------------
// Recognising a heartbeat registration that is ALREADY THERE
// ---------------------------------------------------------------------------
// Idempotency is a hard requirement rather than a nicety, and the reason is
// concrete: a second real repository on this fleet has the same hook registered
// TWICE in its local settings. That is harmless for a guard that only reads,
// and a heartbeat registered twice DOUBLE-WRITES. So the merge has to recognise
// its own prior work, and it cannot do that by string equality - a customer may
// have reformatted the JSON, changed the quoting, or written the bare form
// `sh .claude/hooks/heartbeat.sh stop` instead of the wrapper.
//
// Identity is therefore: the command mentions `heartbeat.sh`, and the event is
// the LAST start|tool|stop token in it. The wrapper form puts the event after
// `"$h"` rather than directly after the filename, so matching
// `heartbeat.sh (start|tool|stop)` would miss every correctly-wrapped hook.
const EVENT_WORD = /\b(start|tool|stop)\b/g;

export function classifyHeartbeatCommand(command) {
  if (typeof command !== 'string' || !command.includes('heartbeat.sh')) return null;
  let last = null;
  for (const m of command.matchAll(EVENT_WORD)) last = m[1];
  return last;
}

/**
 * What is registered right now, per product hook.
 *
 * Reports `misWired` separately from `present`, because a `stop` registered
 * under PostToolUse is a real and silent failure mode: something IS registered,
 * so a check that only asked "is anything there?" would pass it.
 */
export function detectRegistrations(settings) {
  const hooks = (settings && typeof settings.hooks === 'object' && settings.hooks) || {};
  const out = {};

  for (const spec of PRODUCT_HOOKS) {
    const groups = Array.isArray(hooks[spec.hookEvent]) ? hooks[spec.hookEvent] : [];
    const matches = [];
    for (const [gi, group] of groups.entries()) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const [hi, entry] of entries.entries()) {
        const event = classifyHeartbeatCommand(entry?.command);
        if (!event) continue;
        matches.push({
          groupIndex: gi,
          hookIndex: hi,
          event,
          timeout: entry?.timeout ?? null,
          command: entry.command,
        });
      }
    }
    const correct = matches.filter((m) => m.event === spec.event);
    const wrong = matches.filter((m) => m.event !== spec.event);
    out[spec.event] = {
      hookEvent: spec.hookEvent,
      present: correct.length > 0,
      count: correct.length,
      duplicate: correct.length > 1,
      misWired: wrong.map((m) => m.event),
      // The SessionEnd timeout is the one that changes behaviour, so record
      // whether it is actually there rather than whether a hook is.
      timeoutOk: correct.some((m) => Number(m.timeout) >= HOOK_TIMEOUT_SECONDS),
      // A hand-written registration that skips the `sh -c` wrapper is kept as
      // the customer wrote it - a merge that rewrote their command would be a
      // clobber - but it is REPORTED, because the wrapper is load-bearing twice
      // over. Without `[ -f "$h" ] || exit 0` a missing script fails CLOSED and
      // can deny Bash and Edit, including the edit needed to repair it; and
      // without `$CLAUDE_PROJECT_DIR` the path is relative to the working
      // directory, so it silently misses in a git worktree or any subdirectory.
      // Found by running the real installer against a real hand-written file.
      unguarded: correct.length > 0 && correct.every((m) => !m.command.includes('[ -f')),
      notProjectRooted: correct.length > 0 && correct.every((m) => !m.command.includes('CLAUDE_PROJECT_DIR')),
      matches: correct,
    };
  }
  return out;
}

/**
 * Hooks registered in this settings file that are NOT ours.
 *
 * Criterion 5 is "when it does write, it merges", and the only way to be sure
 * is to know what was there first. Counting foreign hooks before and after a
 * merge is what makes that assertion checkable rather than hopeful.
 */
export function foreignHookCount(settings) {
  const hooks = (settings && typeof settings.hooks === 'object' && settings.hooks) || {};
  let n = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (!classifyHeartbeatCommand(entry?.command)) n += 1;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// The merge. RETURNS A PLAN. WRITES NOTHING.
// ---------------------------------------------------------------------------
/**
 * Plan the settings.json changes needed to install the three product hooks.
 *
 * Returns `{ next, changes, idempotent }`. `changes` is empty exactly when the
 * install is already complete, which is what makes "running it twice changes
 * nothing the second time" a property rather than a promise.
 *
 * `actor` is never defaulted. A wrong hardcoded agent id is the WORST of the
 * three outcomes in the contract's section 3.3: unset writes a row attributed
 * to the key's human owner - mislabelled, but visible and fixable - whereas a
 * nonexistent id is `403 AGENT_IDENTITY_NOT_RESOLVABLE` and writes NO ROW AT
 * ALL. So an absent actor is reported as a recommendation for the user to
 * answer, and one installation's user id is never baked into shipped code.
 */
export function planMerge(settings, { actor = null, collapseDuplicates = true } = {}) {
  // structuredClone keeps every unrelated key - other tools' hooks,
  // permissions, env, statusLine, whatever the customer has - byte-for-byte
  // untouched. Rebuilding the object from the fields we know about is how a
  // merge quietly becomes a clobber.
  const next = structuredClone(settings ?? {});
  const changes = [];

  if (typeof next.hooks !== 'object' || next.hooks === null || Array.isArray(next.hooks)) {
    next.hooks = {};
  }

  const before = detectRegistrations(next);

  for (const spec of PRODUCT_HOOKS) {
    const state = before[spec.event];
    if (!Array.isArray(next.hooks[spec.hookEvent])) next.hooks[spec.hookEvent] = [];
    const groups = next.hooks[spec.hookEvent];

    if (state.duplicate && collapseDuplicates) {
      // Keep the FIRST, drop the rest. A heartbeat registered twice posts
      // twice per event; a guard registered twice merely reads twice, which is
      // why the duplicate already sitting in another repo on this fleet is
      // harmless there and would not be here.
      const keep = state.matches[0];
      for (const m of state.matches.slice(1).reverse()) {
        groups[m.groupIndex].hooks.splice(m.hookIndex, 1);
      }
      for (let i = groups.length - 1; i >= 0; i -= 1) {
        if (Array.isArray(groups[i]?.hooks) && groups[i].hooks.length === 0) groups.splice(i, 1);
      }
      changes.push({
        kind: 'collapse_duplicate',
        hookEvent: spec.hookEvent,
        event: spec.event,
        removed: state.matches.length - 1,
        detail: `${spec.hookEvent} had ${state.matches.length} heartbeat '${spec.event}' registrations; a heartbeat registered twice double-writes. Keeping one.`,
      });
      // Re-read, because the indices in `state` are now stale.
      const after = detectRegistrations(next)[spec.event];
      if (after.present && after.timeoutOk) continue;
      if (after.present && !after.timeoutOk) {
        patchTimeout(next, spec, changes);
        continue;
      }
      void keep;
    } else if (state.present) {
      if (!state.timeoutOk) patchTimeout(next, spec, changes);
      continue;
    }

    if (!detectRegistrations(next)[spec.event].present) {
      const entry = { type: 'command', command: hookCommand(spec.event), timeout: HOOK_TIMEOUT_SECONDS };
      if (spec.statusMessage) entry.statusMessage = spec.statusMessage;
      groups.push({ hooks: [entry] });
      changes.push({
        kind: 'add_hook',
        hookEvent: spec.hookEvent,
        event: spec.event,
        detail: `register ${spec.hookEvent} -> heartbeat.sh ${spec.event}`,
      });
    }
  }

  if (actor) {
    if (typeof next.env !== 'object' || next.env === null || Array.isArray(next.env)) next.env = {};
    if (next.env.IDEABASE_ACTOR !== actor) {
      const had = next.env.IDEABASE_ACTOR;
      next.env.IDEABASE_ACTOR = actor;
      changes.push({
        kind: had ? 'change_actor' : 'set_actor',
        detail: had
          ? `env.IDEABASE_ACTOR ${had} -> ${actor}`
          : `set env.IDEABASE_ACTOR = ${actor} (without it every agent heartbeat attributes to the API key's human owner, and the board is agent-only, so the session is filtered off it entirely)`,
      });
    }
  }

  return { next, changes, idempotent: changes.length === 0 };
}

function patchTimeout(settings, spec, changes) {
  const groups = settings.hooks[spec.hookEvent];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (classifyHeartbeatCommand(entry?.command) !== spec.event) continue;
      if (Number(entry.timeout) >= HOOK_TIMEOUT_SECONDS) continue;
      const had = entry.timeout ?? '(absent)';
      entry.timeout = HOOK_TIMEOUT_SECONDS;
      changes.push({
        kind: 'set_timeout',
        hookEvent: spec.hookEvent,
        event: spec.event,
        detail: spec.hookEvent === 'SessionEnd'
          ? `${spec.hookEvent} timeout ${had} -> ${HOOK_TIMEOUT_SECONDS}. REQUIRED: the SessionEnd budget defaults to 1.5s and rises to the highest per-hook timeout, while the stop POST is synchronous with a 3s cap - without this the hook can be cancelled mid-POST, losing the one event that takes a session off the board.`
          : `${spec.hookEvent} timeout ${had} -> ${HOOK_TIMEOUT_SECONDS}`,
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the settings file
// ---------------------------------------------------------------------------
/**
 * A file we cannot parse is NOT an empty file.
 *
 * Treating a parse error as `{}` would make the merge rewrite a customer's
 * settings from scratch and silently delete every hook they had - the exact
 * clobber the issue says is "worse than doing nothing". So the error is carried
 * through as a first-class state and every writer refuses on it.
 */
export function readSettings(projectDir, fs, rel = '.claude/settings.json') {
  const path = `${projectDir}/${rel}`;
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { path, rel, exists: false, raw: null, settings: {}, parseError: null };
    }
    return { path, rel, exists: true, raw: null, settings: null, parseError: `unreadable: ${err.code || err.message}` };
  }
  try {
    const settings = JSON.parse(raw);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      return { path, rel, exists: true, raw, settings: null, parseError: 'top level is not a JSON object' };
    }
    return { path, rel, exists: true, raw, settings, parseError: null };
  } catch (err) {
    return { path, rel, exists: true, raw, settings: null, parseError: `invalid JSON: ${err.message}` };
  }
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// The local half of the inspection
// ---------------------------------------------------------------------------
// Everything here is answerable from the customer's own disk and environment,
// with no network and no API key. That matters: the most important single
// question - "are the three hooks registered, and does the script they point at
// exist?" - must be answerable even when the key is missing or wrong, because
// otherwise a credential problem and a wiring problem look identical.
export function inspectLocal({ projectDir, env = process.env, fs }) {
  const file = readSettings(projectDir, fs);
  const local = {
    projectDir,
    settingsPath: file.path,
    settingsExists: file.exists,
    parseError: file.parseError,
    registrations: file.settings ? detectRegistrations(file.settings) : null,
    foreignHooks: file.settings ? foreignHookCount(file.settings) : null,
    settings: file.settings,
    raw: file.raw,
  };

  const scriptPath = `${projectDir}/${HOOK_SCRIPT_REL}`;
  try {
    const body = fs.readFileSync(scriptPath, 'utf8');
    local.script = { present: true, path: scriptPath, sha256: sha256(body), bytes: body.length };
  } catch {
    local.script = { present: false, path: scriptPath, sha256: null, bytes: 0 };
  }

  // Four env var names across two components, and the underscore placement
  // differs. A customer who sets the MCP pair and assumes the hook inherits it
  // gets heartbeats that never land, so these are reported as two independent
  // credentials rather than one.
  local.env = {
    mcpKey: Boolean((env.IDEA_BASE_API_KEY || '').trim()),
    mcpActor: (env.IDEA_BASE_AGENT_ID || '').trim() || null,
    hookKey: Boolean((env.IDEABASE_HEARTBEAT_KEY || '').trim()),
    hookActor: (env.IDEABASE_ACTOR || '').trim() || null,
    heartbeatOff: ['off', 'OFF', '0', 'false', 'no'].includes((env.IDEABASE_HEARTBEAT || '').trim()),
    settingsActor: file.settings?.env?.IDEABASE_ACTOR ?? null,
  };

  // An exported actor is NOT equivalent to one in the settings `env` block.
  // Measured: a session started detached with the variable exported resolved no
  // task id at all, because a detached session does not inherit the launching
  // shell's environment. `settings.json`'s env block is read per-session. So an
  // actor present only as a shell export is reported as a distinct, weaker
  // state rather than counted as configured.
  local.actorEffective = local.env.settingsActor || null;
  local.actorExportOnly = Boolean(local.env.hookActor && !local.env.settingsActor);

  return local;
}

/**
 * Is the install COMPLETE enough to work? Returns a verdict plus every reason.
 *
 * Deliberately NOT a boolean. "Your sessions are being tracked" and "three
 * hooks are registered" are different claims, and conflating them is how this
 * product spent a day with a registered hook and an empty board.
 */
export function assessInstall(local) {
  const reasons = [];
  if (local.parseError) {
    return { verdict: 'blocked', reasons: [`${local.settingsPath}: ${local.parseError} - refusing to touch it`] };
  }
  if (!local.settingsExists) reasons.push('no .claude/settings.json in this project');

  const regs = local.registrations || {};
  const missing = PRODUCT_HOOKS.filter((s) => !regs[s.event]?.present).map((s) => s.hookEvent);
  if (missing.length) reasons.push(`hook${missing.length > 1 ? 's' : ''} not registered: ${missing.join(', ')}`);

  for (const spec of PRODUCT_HOOKS) {
    const r = regs[spec.event];
    if (!r) continue;
    if (r.duplicate) reasons.push(`${spec.hookEvent} registers heartbeat '${spec.event}' ${r.count} times - it will double-write`);
    if (r.misWired.length) reasons.push(`${spec.hookEvent} carries heartbeat '${r.misWired.join(", ")}' rather than '${spec.event}'`);
    if (r.present && !r.timeoutOk && spec.hookEvent === 'SessionEnd') {
      reasons.push(`SessionEnd has no "timeout": ${HOOK_TIMEOUT_SECONDS} - the stop POST can be cancelled mid-flight`);
    }
    if (r.present && r.unguarded) {
      reasons.push(`${spec.hookEvent}'s command skips the 'sh -c ... [ -f "$h" ] || exit 0' wrapper - left as you wrote it, but if the script ever goes missing this hook fails CLOSED and can deny Bash and Edit`);
    }
    if (r.present && r.notProjectRooted) {
      reasons.push(`${spec.hookEvent}'s command does not use $CLAUDE_PROJECT_DIR, so its path is relative to the working directory and will miss in a git worktree or subdirectory`);
    }
  }

  if (!local.script.present) {
    reasons.push(`${HOOK_SCRIPT_REL} is missing - the registrations above point at nothing`);
  }
  if (local.env.heartbeatOff) reasons.push('IDEABASE_HEARTBEAT is set to off - heartbeats are deliberately disabled');
  if (!local.actorEffective) {
    reasons.push(local.actorExportOnly
      ? 'IDEABASE_ACTOR is only a shell export, not in settings.json env - a detached session will not inherit it'
      : 'env.IDEABASE_ACTOR is unset - heartbeats will attribute to the API key\'s human owner and be filtered off the agent-only board');
  }

  const hooksComplete = missing.length === 0 && local.script.present && !local.parseError;
  if (!hooksComplete) return { verdict: 'incomplete', reasons };
  if (reasons.length) return { verdict: 'complete_with_warnings', reasons };
  return { verdict: 'complete', reasons: [] };
}
