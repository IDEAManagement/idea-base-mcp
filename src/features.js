// features.js - the capability inventory behind /idea-base:features. Issue #383.
//
// =============================================================================
// A LIST THAT ALWAYS SAYS YES IS DECORATION.
// =============================================================================
// This reports what is actually wired on THIS machine, not what the product
// supports. The difference is the entire value of the command: on 2026-11-03
// the heartbeat hook was registered in this project's own repository and the
// live agent board was empty all day. A features list reading "heartbeats: on"
// would have been literally true and would have told the reader nothing.
//
// So "configured but not firing" is a first-class state, and so is "I cannot
// tell". The second one is unavoidable rather than lazy: measured against the
// live API on 2026-11-05, THREE of the six capabilities below have no endpoint
// that can answer "when did this last produce data". Inventing a timestamp for
// those would be fabricated data - and a fabricated green is the exact defect
// #383 exists to fix, one level up.
//
// Every `unknown` here therefore carries the REASON it is unknown and, where
// one exists, the command that CAN decide. An `unknown` that names its own
// blind spot is strictly more useful than a confident wrong answer.

import { PRODUCT_HOOKS } from './setup.js';

export const STATE = {
  ON: 'on',
  NOT_FIRING: 'configured_not_firing',
  UNKNOWN: 'unknown',
  OFF: 'off',
};

export const STATE_LABEL = {
  [STATE.ON]: 'ON',
  [STATE.NOT_FIRING]: 'CONFIGURED, NOT FIRING',
  [STATE.UNKNOWN]: 'UNKNOWN',
  [STATE.OFF]: 'OFF',
};

/**
 * One capability row.
 *
 * `lastData` is the honest field and the one with teeth. It is a timestamp ONLY
 * when something read one back; otherwise it is `null` and `lastDataNote` says
 * why - never a placeholder, never a zero standing in for "don't know", never
 * "recently".
 */
function row({ key, name, state, detail, lastData = null, lastDataNote = null, turnOn = null, source = null }) {
  return { key, name, state, detail, lastData, lastDataNote, turnOn, source };
}

/**
 * Build the inventory.
 *
 * `local`   - from inspectLocal(): disk and environment, no network needed.
 * `assess`  - from assessInstall().
 * `remote`  - the result of probeRemote(), or null when there was no key to
 *             probe with. A null `remote` must degrade every network-dependent
 *             row to `unknown`, NOT to `off`: "I could not ask" and "it is
 *             switched off" are different facts and a customer acts on them
 *             differently.
 */
export function buildInventory({ local, assess, remote }) {
  const rows = [];
  const noKey = !remote;
  const askNote = noKey
    ? 'no API key in this environment, so nothing could be asked of the server'
    : null;

  // --- 1. activity heartbeats -------------------------------------------------
  // The one capability whose local wiring is fully knowable without a network,
  // which is why it is the only row that can reach `configured_not_firing`
  // rather than `unknown`.
  const regs = local.registrations || {};
  const registered = PRODUCT_HOOKS.filter((s) => regs[s.event]?.present).length;
  const hooksAllThere = registered === PRODUCT_HOOKS.length && local.script.present;

  if (local.env.heartbeatOff) {
    rows.push(row({
      key: 'heartbeats',
      name: 'Activity heartbeats (live agent board)',
      state: STATE.OFF,
      detail: 'IDEABASE_HEARTBEAT is set to off. This is a deliberate choice, not a missing piece - telemetry nobody can turn off is not acceptable on someone else\'s machine.',
      turnOn: 'unset IDEABASE_HEARTBEAT (or set it to any value other than off/0/false/no)',
      source: 'environment',
    }));
  } else if (!hooksAllThere) {
    const missing = PRODUCT_HOOKS.filter((s) => !regs[s.event]?.present).map((s) => s.hookEvent);
    rows.push(row({
      key: 'heartbeats',
      name: 'Activity heartbeats (live agent board)',
      state: STATE.OFF,
      detail: local.script.present
        ? `${registered} of 3 hooks registered; missing ${missing.join(', ')}.`
        : `${registered} of 3 hooks registered, and ${local.script.path.split('/').slice(-1)[0]} is absent, so any registration points at nothing.`,
      turnOn: 'npx @idea-base/mcp-server install   (dry run; add --apply to write)',
      source: local.settingsPath,
    }));
  } else if (remote?.heartbeat?.lastPingAt) {
    rows.push(row({
      key: 'heartbeats',
      name: 'Activity heartbeats (live agent board)',
      state: STATE.ON,
      detail: `3 of 3 hooks registered, script present, and the server has a ping on record.${local.actorEffective ? '' : ' Attribution is wrong though - see IDEABASE_ACTOR below.'}`,
      lastData: remote.heartbeat.lastPingAt,
      source: 'GET /api/session-activity',
    }));
  } else {
    // Registered, script present, and NOTHING came back. This is the
    // 2026-11-03 state exactly, and it is the row the command exists for.
    //
    // Note what it does NOT claim: `GET /api/session-activity` is filtered to
    // tasks with status 'in_progress', so an empty result is genuinely
    // ambiguous between "never fired" and "nothing in progress right now". The
    // read-only inventory cannot separate those, and `doctor` can, because it
    // posts a labelled probe and reads the server's verdict. So this row says
    // which it is not, and points at the thing that decides.
    rows.push(row({
      key: 'heartbeats',
      name: 'Activity heartbeats (live agent board)',
      state: STATE.NOT_FIRING,
      detail: '3 of 3 hooks registered and the script is present, but no heartbeat came back from the server.',
      lastDataNote: noKey
        ? askNote
        : 'GET /api/session-activity only reports tasks whose status is in_progress, so an empty answer cannot tell "never fired" from "nothing in progress right now"',
      turnOn: 'npx @idea-base/mcp-server doctor   (posts one labelled probe and reports the server\'s own verdict - the definitive answer)',
      source: noKey ? 'environment' : 'GET /api/session-activity',
    }));
  }

  // --- 2. actor attribution ---------------------------------------------------
  // Its own row rather than a footnote on the heartbeat row, because it fails
  // in a way that LOOKS like the feature working: rows are written, the hook
  // reports success, and the session is filtered off the agent-only board for
  // being attributed to a human. idea-base.us#362.
  if (local.actorEffective) {
    rows.push(row({
      key: 'actor',
      name: 'Agent attribution (IDEABASE_ACTOR)',
      state: remote?.actor?.isAgent === false ? STATE.NOT_FIRING : STATE.ON,
      detail: remote?.actor?.isAgent === false
        ? `settings.json declares '${local.actorEffective}', but the server resolved a heartbeat to a HUMAN identity - the board filters to agents, so these sessions are invisible on it.`
        : `settings.json env declares '${local.actorEffective}'.`,
      // Attribution is a CONFIGURATION fact, so "last produced data" does not
      // apply to it - but saying nothing would leave a row with no timestamp
      // and no reason, which is the shape this module exists to forbid. Being
      // declared is also not the same as being ACCEPTED: a nonexistent or human
      // id is refused with no row written at all, and only a live probe sees
      // that. So the note states which of the two has been established.
      lastDataNote: remote?.actor
        ? null
        : (askNote || 'declared locally; whether the server ACCEPTS this identity as an agent is only visible once a heartbeat lands, so it is not confirmed here - run the doctor'),
      source: local.settingsPath,
    }));
  } else {
    rows.push(row({
      key: 'actor',
      name: 'Agent attribution (IDEABASE_ACTOR)',
      state: STATE.OFF,
      detail: local.actorExportOnly
        ? `set as a shell export ('${local.env.hookActor}') but NOT in settings.json's env block. Measured: a detached session does not inherit the launching shell's environment, so this is lost by any session the harness starts in the background.`
        : 'unset. Every agent heartbeat will attribute to the API key\'s human owner; the board filters to agents, so those sessions are filtered off it entirely.',
      turnOn: 'add env.IDEABASE_ACTOR to .claude/settings.json, set to an existing user id whose is_agent flag is set',
      source: local.settingsPath,
    }));
  }

  // --- 3. sub-agent dispatch telemetry ---------------------------------------
  // Wired-or-not is answerable; last-activity is not, and the server says so
  // about itself.
  if (noKey) {
    rows.push(row({
      key: 'dispatch',
      name: 'Sub-agent dispatch telemetry',
      state: STATE.UNKNOWN,
      detail: 'could not ask the server.',
      lastDataNote: askNote,
      source: 'environment',
    }));
  } else if (remote.dispatch?.available) {
    rows.push(row({
      key: 'dispatch',
      name: 'Sub-agent dispatch telemetry',
      state: STATE.ON,
      detail: 'the endpoint is available and accepting dispatches.',
      lastDataNote: 'no endpoint reports dispatch activity - the capture endpoint documents itself as "CAPTURE ONLY: there is no GET-list, no aggregate, no card", so "when did this last produce data" is genuinely unanswerable from outside the database',
      source: 'GET /api/dispatches/schema',
    }));
  } else {
    rows.push(row({
      key: 'dispatch',
      name: 'Sub-agent dispatch telemetry',
      state: STATE.OFF,
      detail: remote.dispatch?.detail || 'the endpoint reported the capability as unavailable.',
      turnOn: 'this is a server-side migration, not a local setting - contact your IDEA Base administrator',
      source: 'GET /api/dispatches/schema',
    }));
  }

  // --- 4. work sessions -------------------------------------------------------
  if (noKey) {
    rows.push(row({
      key: 'work_sessions',
      name: 'Work sessions (start_working / stop_working)',
      state: STATE.UNKNOWN,
      detail: 'the tools are available in this server; whether they have been used could not be checked.',
      lastDataNote: askNote,
      source: 'environment',
    }));
  } else if (remote.workSession?.startedAt) {
    rows.push(row({
      key: 'work_sessions',
      name: 'Work sessions (start_working / stop_working)',
      state: STATE.ON,
      detail: 'at least one session is open right now.',
      lastData: remote.workSession.startedAt,
      source: 'GET /api/session-activity',
    }));
  } else {
    rows.push(row({
      key: 'work_sessions',
      name: 'Work sessions (start_working / stop_working)',
      state: STATE.UNKNOWN,
      detail: 'the tools are available; no open session is visible.',
      lastDataNote: 'there is no account-wide read for work sessions - the per-task read needs a task id and the only global count sits behind the scheduled-jobs secret, so "in use / never used" cannot be answered for the workspace as a whole',
      turnOn: 'call start_working(task_id) when you begin work on a task',
      source: 'GET /api/session-activity',
    }));
  }

  // --- 5. time logging --------------------------------------------------------
  // The one capability whose API states "never" outright rather than leaving it
  // to be inferred - `days_since_last_time_entry` is null for never, not a
  // sentinel value.
  if (noKey) {
    rows.push(row({
      key: 'time',
      name: 'Time logging (log_time / quick_log)',
      state: STATE.UNKNOWN,
      detail: 'the tools are available; usage could not be checked.',
      lastDataNote: askNote,
      source: 'environment',
    }));
  } else if (remote.time?.everLogged) {
    rows.push(row({
      key: 'time',
      name: 'Time logging (log_time / quick_log)',
      state: STATE.ON,
      detail: remote.time.projectsWithTime != null
        ? `${remote.time.projectsWithTime} of ${remote.time.projectsTotal} active projects have logged time.`
        : 'time has been logged in this workspace.',
      lastData: remote.time.lastDate,
      lastDataNote: remote.time.lastDate ? null : 'the health endpoint reports days-since rather than a date for the most recent entry',
      source: 'GET /api/projects/health',
    }));
  } else {
    rows.push(row({
      key: 'time',
      name: 'Time logging (log_time / quick_log)',
      state: STATE.OFF,
      detail: remote.time?.projectsTotal === 0
        ? 'no active projects to log against yet.'
        : 'never used - no active project has a time entry.',
      lastDataNote: 'never (the health endpoint reports this explicitly as null rather than as a zero)',
      turnOn: 'call log_time(task_id, minutes, notes) after finishing a piece of work',
      source: 'GET /api/projects/health',
    }));
  }

  // --- 6. task <-> GitHub issue linking --------------------------------------
  // "available / not available in this project" is the question the issue asks,
  // and availability genuinely changed recently, so it is reported as a
  // capability of the running server rather than as a fixed yes.
  // THIS ROW HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, INSIDE ONE DAY -
  // which is why it is now pinned by a test rather than by care.
  //
  // It first claimed create_task and update_task both accepted
  // `github_issue_id`. Measured: the field was in update_task's schema ONLY,
  // and create_task discarded it silently - a 200 with the column reading back
  // null, which is exactly how task 990860 came to be created with no anchor
  // and had to be fixed over REST. That correction was written, and 2.6.0 then
  // added the field to create_task, making the correction stale within the
  // hour.
  //
  // The lesson is not "be more careful with the prose". It is that a sentence
  // asserting what a tool schema contains has no business BEING prose: it is a
  // claim about a data structure in this same package, and it goes stale
  // silently every time that structure moves. So the wording below is held to
  // the real schema by a test (setup.test.js, "the issue-link row agrees with
  // the actual tool schema"). Change which tools accept the field and the test
  // fails, instead of a customer reading a confident falsehood.
  //
  // It is reported as a capability of THIS server version for the same reason:
  // the honest answer to "is linking available" depends on what is installed,
  // and it has changed twice.
  rows.push(row({
    key: 'issue_link',
    name: 'Task <-> GitHub issue linking (github_issue_id)',
    state: STATE.ON,
    detail: 'available on both create_task and update_task in this server version. Load-bearing for heartbeats anchored by issue number: the endpoint resolves an issue to a task through this column, so a task created for an issue without it collects pings that have nowhere to land and is invisible on the live board.',
    lastDataNote: 'no endpoint reports linkage coverage - there is no count, no ratio, no linked_at column and no linked/unlinked filter, so "how much of this project is linked" can only be computed by listing every task',
    source: 'this server\'s tool schema',
  }));

  // --- 7. AI verification gate ------------------------------------------------
  // The honest answer is that the thing being asked about does not exist yet.
  // Reporting a per-project default would mean inventing one.
  rows.push(row({
    key: 'verification',
    name: 'AI verification gate (verification_mode)',
    state: STATE.UNKNOWN,
    detail: 'per-task only. There is no per-project or per-account default: no such column exists, and the only canonical default is the constant \'manual\'.',
    lastDataNote: 'asking for "this project\'s default verification mode" has no answer today - inheritance (account default, project may raise, task may override) is idea-base.us#990442 and still open',
    turnOn: 'set verification_mode on an individual task (manual | ai_review | ci_required | all)',
    source: 'idea-base.us _lib/verification.js',
  }));

  return rows;
}

/**
 * Ask the server the few things it can actually answer.
 *
 * Every probe is independently failure-tolerant: one endpoint being down or
 * forbidden degrades its own row to `unknown` and leaves the rest intact.
 * Returning a partial answer beats returning nothing, and beats pretending the
 * missing part is a zero.
 */
export async function probeRemote(apiGet) {
  const remote = { heartbeat: {}, actor: null, dispatch: null, workSession: {}, time: {}, errors: [] };

  try {
    const sa = await apiGet('/session-activity');
    const items = Array.isArray(sa?.items) ? sa.items : [];
    const pings = items.filter((i) => i?.has_heartbeat && i?.last_ping_at);
    if (pings.length) {
      pings.sort((a, b) => String(b.last_ping_at).localeCompare(String(a.last_ping_at)));
      remote.heartbeat.lastPingAt = pings[0].last_ping_at;
      remote.heartbeat.lastEvent = pings[0].last_heartbeat_event ?? null;
      // `actor_is_agent` on a real row is the only evidence that attribution is
      // not merely declared but ACCEPTED by the server.
      if (typeof pings[0].actor_is_agent === 'boolean') {
        remote.actor = { isAgent: pings[0].actor_is_agent, actorId: pings[0].actor_id ?? null };
      }
    }
    const ws = items.filter((i) => i?.work_session_started_at);
    if (ws.length) {
      ws.sort((a, b) => String(b.work_session_started_at).localeCompare(String(a.work_session_started_at)));
      remote.workSession.startedAt = ws[0].work_session_started_at;
      remote.workSession.state = ws[0].work_session_state ?? null;
    }
  } catch (err) {
    remote.errors.push(`session-activity: ${err?.message || 'failed'}`);
  }

  try {
    await apiGet('/dispatches/schema');
    remote.dispatch = { available: true };
  } catch (err) {
    // A 503 here is the endpoint's documented way of saying the table is not
    // present, which is a real OFF rather than a failed probe.
    const msg = err?.message || '';
    remote.dispatch = /not available|503/i.test(msg)
      ? { available: false, detail: 'the server reports dispatch telemetry is not available (the table has not been created).' }
      : null;
    if (remote.dispatch === null) remote.errors.push(`dispatches/schema: ${msg || 'failed'}`);
  }

  try {
    const health = await apiGet('/projects/health');
    const list = Array.isArray(health?.health) ? health.health : [];
    remote.time.projectsTotal = list.length;
    const withTime = list.filter((p) => Number(p?.stats?.time_spent) > 0);
    remote.time.projectsWithTime = withTime.length;
    remote.time.everLogged = withTime.length > 0;
    // `days_since_last_time_entry` is null for "never" by design, so a number
    // here is a real observation and its absence is not filled in.
    const days = list
      .map((p) => p?.days_since_last_time_entry)
      .filter((d) => typeof d === 'number');
    remote.time.daysSinceMostRecent = days.length ? Math.min(...days) : null;
    remote.time.lastDate = null;
  } catch (err) {
    remote.time = {};
    remote.errors.push(`projects/health: ${err?.message || 'failed'}`);
  }

  return remote;
}
