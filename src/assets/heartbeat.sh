#!/bin/sh
# heartbeat.sh — emit a session heartbeat to IDEA Base. GitHub issue #369.
#
# Usage (from a hook `command`, never by hand):
#   sh .claude/hooks/heartbeat.sh start     <- SessionStart
#   sh .claude/hooks/heartbeat.sh tool      <- PostToolUse   (throttled, 60s)
#   sh .claude/hooks/heartbeat.sh stop      <- SessionEnd
#
# =============================================================================
# THIS SCRIPT MUST NEVER BLOCK, SLOW, OR BREAK THE AGENT. READ BEFORE EDITING.
# =============================================================================
# `PostToolUse` fires on EVERY tool call, in the main conversation AND inside
# every subagent (subagents inherit session hooks; verified against the current
# hook reference). So every line here is on the hot path of every action the
# agent takes, and a careless edit taxes the whole session.
#
# Four rules, in priority order. Each one is load-bearing.
#
# 1. EXIT 0 ALWAYS. There is no `set -e` on purpose, every exit is explicit,
#    and nothing here is allowed to fail loudly. `PostToolUse` surfaces a
#    non-zero exit's stderr to the model, and `Stop` exit 2 actively BLOCKS
#    the agent from stopping and continues the conversation — which is why
#    this script is deliberately NOT wired to `Stop` (see settings.json).
#
# 2. DECIDE THE THROTTLE BEFORE DOING ANY WORK. The 60-second check happens
#    first, from a stamp file's mtime, and the throttled path runs ONE
#    subprocess (`stat`) and exits. No stdin parse, no git, no secret read, no
#    network. That path is ~19 of every 20 invocations, so it is the one whose
#    cost actually matters.
#
# 3. THE POST IS DETACHED. `setsid curl ... &` with every descriptor
#    redirected, so this script cannot wait on the endpoint and the endpoint
#    cannot hold the hook open. A hung, slow, 500ing or entirely unreachable
#    server costs the same as a working one: the time it takes to fork.
#
# 4. ABSENCE IS SILENT. No issue, no key, no session id, no curl -> exit 0 and
#    write nothing. #369: "If neither resolves, skip silently."
#
# =============================================================================
# WHY THE HOOK COMMAND IS WRAPPED, AND WHY THIS FILE LIVES IN THE REPO
# =============================================================================
# A hook whose script is MISSING fails CLOSED. On 2026-09-10 a hook pointing at
# a file that existed only on an unmerged branch denied Bash AND Edit — the
# edit needed to repair the hook included — and subagents inherit session hooks,
# so delegating did not help either. A guard that cannot be repaired from inside
# the session it guards is a design fault.
#
# Two defences, both applied:
#
#   a. The hook `command` in settings.json wraps this path so that ABSENCE
#      exits 0 while a GENUINE failure still propagates:
#
#        sh -c 'h=".../heartbeat.sh"; [ -f "$h" ] || exit 0; exec sh "$h" tool'
#
#      That is not invented here. It is the idiom all five user-scope hooks in
#      this environment already use, and `exec` is what makes the real script's
#      own exit code pass through unchanged once the file is confirmed present.
#
#   b. This file lives in the REPO (`.claude/hooks/`), beside no-secret-trace.py
#      and session-brief.py, NOT in `~/.claude/core`. That directory is detached
#      to origin/main on every container boot, so a hook referencing a file not
#      on main is GUARANTEED to vanish. A repo path travels with the branch that
#      registers it, so the script and its registration cannot get separated.
# =============================================================================

EVENT="$1"

# ---------------------------------------------------------------------------
# RULE 0: THE OFF SWITCH, BEFORE EVERYTHING, INCLUDING THE THROTTLE.
# ---------------------------------------------------------------------------
# #380 criterion 10: "A telemetry hook nobody can turn off is not acceptable on
# someone else's machine."
#
# This sits above rule 2 rather than beside it because a parameter expansion is
# cheaper than the `stat` the throttle costs, and because an operator who has
# said "off" should not have their /tmp written to either. Setting this to any
# of the values below makes this script a no-op that still exits 0, so it also
# serves as the blast-radius escape hatch: a container can disable heartbeats
# without editing (or being able to edit) the settings.json that registers them.
case "${IDEABASE_HEARTBEAT:-}" in
  off|OFF|0|false|no) exit 0 ;;
esac

# ---------------------------------------------------------------------------
# THE TRACE. #409 criterion 5: ABSENCE MUST NOT BE SILENT FOR THE TERMINAL EVENT.
# ---------------------------------------------------------------------------
# Rule 4 ("absence is silent") is CORRECT for a throttled `tool` ping — one of
# those is one sample of a continuous signal, and a lost sample changes nothing
# a reader can see. It is WRONG for `stop`, which happens exactly once and is
# the only thing that ever takes a session off the board. A lost `stop` is
# indistinguishable from a session that is still running, forever, and that is
# the whole of #409.
#
# So the asymmetry is deliberate: every exit path now records WHY it took it,
# and the terminal event records it UNCONDITIONALLY. `tool` and `start` write a
# trace line only when an operator has asked for one.
#
# The log is a single append-only file with a bounded size, written with `>>`
# (one atomic-enough write per line for lines this short), and a failure to
# write it is itself swallowed — rule 1 outranks this.
HB_LOG="${IDEABASE_HEARTBEAT_LOG:-}"
if [ -z "$HB_LOG" ] && [ "$EVENT" = "stop" ]; then
  HB_LOG="${TMPDIR:-/tmp}/ib-heartbeat/stop.log"
fi

# Trim the log before appending if it has grown past ~256KB. An unbounded log on
# someone else's machine is the same class of rudeness as a hook with no off
# switch. Checked only on the terminal event, which runs once per session.
hb_trim() {
  [ -n "$HB_LOG" ] || return 0
  [ -f "$HB_LOG" ] || return 0
  _sz=$(wc -c < "$HB_LOG" 2>/dev/null || echo 0)
  [ "$_sz" -gt 262144 ] 2>/dev/null || return 0
  tail -c 131072 "$HB_LOG" > "$HB_LOG.trim" 2>/dev/null && mv "$HB_LOG.trim" "$HB_LOG" 2>/dev/null
  return 0
}

hb_trace() {
  [ -n "$HB_LOG" ] || return 0
  mkdir -p "$(dirname "$HB_LOG")" 2>/dev/null
  printf '%s event=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EVENT" "$1" >> "$HB_LOG" 2>/dev/null
  return 0
}

# Rule 1 and rule 4 together: an unrecognised event is a wiring mistake, and a
# wiring mistake must not be an outage.
# `resolve` is NOT an event and is never sent to the API. It is a read-only
# self-report — "what anchor, actor and credential would this script use right
# now?" — added for #409 so `scripts/heartbeat-doctor.sh` can answer "is my
# session being tracked?" WITHOUT a second copy of the resolution logic. A
# doctor that reimplements this would drift from it, and the drift would be
# invisible in exactly the way this whole issue is about.
case "$EVENT" in
  start|tool|stop|resolve) ;;
  *) exit 0 ;;
esac

[ "$EVENT" = "stop" ] && hb_trim

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
hb_trace "phase=enter project_dir=$PROJECT_DIR pwd=$PWD"

# ---------------------------------------------------------------------------
# RULE 2: THE THROTTLE, FIRST, BEFORE ANYTHING ELSE.
# ---------------------------------------------------------------------------
# Keyed on the project directory rather than the session id, which is what
# makes it possible to decide this BEFORE reading stdin. A worktree hosts one
# spoke session working one issue, so project-dir and session are the same
# grain in practice — and when a subagent fires PostToolUse it shares the
# parent's project dir, so its calls are throttled by the same stamp instead of
# each subagent getting its own 60-second budget.
#
# GNU `stat -c %Y`. NOT `stat -f%m`, which is the macOS/BSD form: this runs in
# a Debian bookworm container where that flag means something else entirely,
# and `core/consolidate/consolidate.sh` carries the scar from the last time a
# BSD-ism failed silently here.
#
# The stamp is touched BEFORE the network work, not after, so two tool calls
# landing in the same instant cannot both decide to fire.
if [ "$EVENT" = "tool" ]; then
  STAMP_DIR="${TMPDIR:-/tmp}/ib-heartbeat"
  # One stamp per project dir. `cksum` keeps the filename short and free of
  # path separators without needing a hash binary that may not exist.
  STAMP="$STAMP_DIR/$(printf '%s' "$PROJECT_DIR" | cksum | cut -d' ' -f1).stamp"
  THROTTLE_SECONDS="${IDEABASE_HEARTBEAT_THROTTLE:-60}"

  if [ -f "$STAMP" ]; then
    LAST=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    # dash has no arithmetic surprises here; both values are integers.
    if [ "$LAST" -gt 0 ] && [ $((NOW - LAST)) -lt "$THROTTLE_SECONDS" ]; then
      hb_trace "skip=throttled age=$((NOW - LAST))s"
      exit 0
    fi
  fi

  mkdir -p "$STAMP_DIR" 2>/dev/null
  : > "$STAMP" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# Past the throttle. Everything below runs at most once per 60s (for `tool`),
# or once per session (for `start` / `stop`).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# THE ANCHOR: WHAT WORK IS BEING DONE, NOT WHERE THE CODE LIVES. #411.
# ---------------------------------------------------------------------------
# This block used to read `.git/HEAD`, pull `issue[/-]<digits>` out of the
# branch name with a sed, and then try the same pattern against the worktree
# DIRECTORY name. All of that is gone, and a replacement parser would be the
# same bug with wider coverage.
#
# A branch name encodes WHERE THE CODE LIVES. A task id identifies WHAT WORK IS
# BEING DONE. On this fleet those are routinely different facts:
#
#   * `worktree-buyingbuddy-issue-760` was live while the work was IDEA Base
#     task 990851 — a different number belonging to a different system. The
#     parser does not FAIL there, it SUCCEEDS against the wrong task and writes
#     a row saying an agent is working on something nobody is working on.
#     Silent misattribution into the exact dataset this feature exists to
#     produce, and undetectable from the inside.
#   * `project/class-split` carries no number at all and never could.
#
# Those conventions are correct and are not ours to accommodate or change. The
# CEO's words, via #411: "Do not conflate another projects methods of work with
# the hooks of starting and stopping a task."
#
# So every anchor below is a DECLARATION — something the session said about
# itself — and when none exists this script refuses out loud instead of
# guessing. The session always has the answer: it called `start_working` with
# the task id. Nothing needs inferring.
ISSUE=""
ANCHOR_SRC=""

# The GitHub issue number, EXPLICIT ONLY. A four-hop anchor: the endpoint
# resolves it through `tasks.github_issue_id`, which holds repo-local numbers
# in this project and GitHub's global ids elsewhere, so it is not safe to
# compare across accounts and it ranks below the task id for that reason. Kept
# because an env var someone set IS a declaration, and because the row carries
# the number for the human reading it later.
case "${IDEABASE_ISSUE:-}" in
  '') ;;
  *[!0-9]*) ;;            # non-numeric: ignore rather than send nonsense
  *) ISSUE="$IDEABASE_ISSUE"
     ANCHOR_SRC="IDEABASE_ISSUE env var (explicit declaration)" ;;
esac

# ---------------------------------------------------------------------------
# WHERE THE RESOLVED ANCHOR IS REMEMBERED.
# ---------------------------------------------------------------------------
# Two files, both tiny, both in the same directory, each answering a question
# the other cannot:
#
#   <cksum SESSION_ID>.anchor  — this session's resolved anchor. Read as the
#       fallback when live resolution fails, which is what lets a REAPED
#       `SessionEnd` still name its task once the transcript is unreadable
#       (#409 criterion 6).
#   <cksum PROJECT_DIR>.anchor — what the session in this working tree last
#       resolved. `resolve` mode has no stdin by design and therefore no
#       transcript path, so this is what `scripts/heartbeat-doctor.sh` reads
#       back. The doctor reporting what the hook ACTUALLY resolved on a real
#       event is better evidence than any re-derivation, and re-derivation is
#       precisely the drift `resolve` was added to kill.
#
# The directory is overridable SEPARATELY from TMPDIR, because the doctor
# redirects TMPDIR to a private dir to avoid clobbering the 60-second throttle
# stamp — and that redirect would otherwise hide both of these from it.
HB_STATE_DIR="${IDEABASE_HEARTBEAT_STATE_DIR:-${TMPDIR:-/tmp}/ib-heartbeat}"
HB_STATE=""
HB_PROJECT_STATE="$HB_STATE_DIR/$(printf '%s' "$PROJECT_DIR" | cksum | cut -d' ' -f1).anchor"

# ---------------------------------------------------------------------------
# THE TASK ID — ONE HOP, AND THE ONLY ANCHOR THAT HAS EVER RESOLVED. #380.
# ---------------------------------------------------------------------------
# `POST /api/heartbeat` turns a task id into a containment anchor in one query
# (heartbeat.js:160-176). The issue number needs `tasks.github_issue_id`, which
# was NULL on every task an agent had ever created — which is why four and a
# half hours of a continuously-firing hook produced zero rows. Sending both is
# correct and not redundant: the endpoint anchors on task_id and still stores
# the raw issue number for the human reading the row later.
#
# FORM 1: the env var. Explicit, and the right shape for a LAUNCHER that
# already knows the task — spoke-tab, a test harness, CI. It is NOT the right
# shape for a customer: it is per-session configuration holding a per-task
# fact, and `docs/session-tracking-install.md` measured that a detached
# background session does not even inherit it from the launching shell.
#
# FORM 2 is the session's own `start_working` call and lives further down,
# because it needs the stdin payload. See THE DECLARED ANCHOR.
TASK_ID=""
case "${IDEABASE_TASK_ID:-}" in
  '') ;;
  *[!0-9]*) ;;            # non-numeric: ignore rather than send nonsense
  *) TASK_ID="$IDEABASE_TASK_ID"
     ANCHOR_SRC="IDEABASE_TASK_ID env var (explicit declaration)" ;;
esac

# The spoke / worktree name, for provenance. This is a LABEL on the row and
# never an input to resolution — which is the whole distinction #411 draws.
SPOKE=$(basename "$PROJECT_DIR")

# The harness session id and the transcript path, from the hook's stdin JSON.
#
# One `sed` per field rather than jq (not guaranteed present) or python3 (whose
# ~30ms interpreter start-up is the single biggest cost this script could take
# on). Both are documented top-level strings on every hook event, so a flat
# extraction is sound; nested objects in the same payload cannot shadow them
# because the first match wins and both are emitted before them.
#
# `head -c` bounds the read: a PostToolUse payload carries tool_input and
# tool_response, which for a large file read can be megabytes, and this script
# needs only the head of it. The bound is 8192 rather than 4096 because
# `transcript_path` is now taken from the same buffer and sits after
# `session_id` — still one bounded read of a stream that is never consumed
# twice, and still nothing on the throttled path.
#
# `resolve` has no hook payload on stdin — reading it would BLOCK on a terminal.
if [ "$EVENT" = "resolve" ]; then
  PAYLOAD_HEAD=""
  SESSION_ID="resolve-mode-no-session"
  TRANSCRIPT=""
else
  PAYLOAD_HEAD=$(head -c 8192 2>/dev/null)
  SESSION_ID=$(printf '%s' "$PAYLOAD_HEAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  TRANSCRIPT=$(printf '%s' "$PAYLOAD_HEAD" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi

# A WRONG session id is worse than none: it would merge two sessions' pings
# into one row and make a dead session look alive. So an unparseable payload
# skips rather than inventing an id.
if [ -z "$SESSION_ID" ]; then
  hb_trace "skip=no_session_id payload_bytes=$(printf '%s' "$PAYLOAD_HEAD" | wc -c)"
  exit 0
fi

# ---------------------------------------------------------------------------
# THE DECLARED ANCHOR: READ BACK THE `start_working` CALL THIS SESSION MADE.
# ---------------------------------------------------------------------------
# #411's fix. The session already holds the task id — it passed it to
# `start_working`, which is STEP ZERO of every run — and its own transcript is
# the record of having done so. Reading that back is not inference; it is the
# declaration itself. No branch name, directory, repo convention or customer
# naming scheme appears anywhere in this chain, which is the entire point.
#
# WHAT A MULTI-TASK SESSION IS ATTRIBUTED TO: the task it declared MOST
# RECENTLY. The `tail -n 1` below is the rule, and nothing else decides it.
#
# A heartbeat is a point-in-time liveness fact — "this session is alive and
# working on X right now" — not a time allocation. Duration and allocation
# already have owners: `work_sessions` holds one open row per
# (task_id, actor_id), so a session legitimately holds several, and `log_time`
# apportions. The only question left for a heartbeat is WHAT NOW, and
# `start_working(B)` after `start_working(A)` is the session saying the answer
# changed. Taking the FIRST would pin the row to work that has finished;
# refusing when there is more than one would discard a fact the session gave us.
#
# `stop_working` deliberately does NOT clear it. The terminal `SessionEnd`
# heartbeat is what takes a session off the board (#409), so a session that
# tidied up before exiting must still be able to say it is gone — against the
# task it was last working on.
#
# THE MATCH IS ANCHORED ON BOTH THE TOOL NAME AND ITS `task_id` INPUT, and that
# is load-bearing. A transcript also contains the harness's list of AVAILABLE
# tool names, in which the bare string `mcp__idea-base__start_working` appears
# with no call attached; requiring `"input":{...,"task_id":<n>` in the same
# record is what separates a call from a mention. Measured against a live
# transcript: the id occurs both as a JSON number and as a quoted string, so
# both forms are accepted.
hb_anchor_from_transcript() {
  [ -n "$1" ] || return 0
  [ -f "$1" ] || return 0
  grep -oE '"name":"(mcp__[A-Za-z0-9_-]+__)?(start_working|resume_working)","input":\{[^}]*"task_id":"?[0-9]+' "$1" 2>/dev/null \
    | sed -n 's/.*"task_id":"\{0,1\}\([0-9][0-9]*\)$/\1/p' \
    | tail -n 1
}

HB_STATE="$HB_STATE_DIR/$(printf '%s' "$SESSION_ID" | cksum | cut -d' ' -f1).anchor"

# The scan is skipped when a cached answer is at least as new as the transcript,
# so the ordinary `tool` event costs one `stat` instead of a grep. Re-scanning
# the moment the transcript moves is what lets a SECOND `start_working` take
# effect within one throttle window rather than being pinned by the first.
#
# A transcript path that no longer EXISTS also takes this branch, and that is
# right rather than incidental: a file that is gone cannot be newer than the
# cache, so a teardown whose transcript has already been cleaned up recovers
# here instead of falling through. Either way the trace says the answer came
# out of the cache — which branch served it is not something a reader should
# have to care about, and the one trace line was originally only on the other
# one.
if [ -z "$TASK_ID" ] && [ -n "$TRANSCRIPT" ]; then
  if [ -f "$HB_STATE" ] && [ ! "$TRANSCRIPT" -nt "$HB_STATE" ]; then
    TASK_ID=$(sed -n 's/^TASK_ID=\([0-9][0-9]*\)$/\1/p' "$HB_STATE" 2>/dev/null | head -n 1)
    if [ -n "$TASK_ID" ]; then
      ANCHOR_SRC="start_working declared in this session's transcript (cached)"
      hb_trace "anchor=recovered_from_cache task=$TASK_ID issue=${ISSUE:-<none>} transcript_present=$([ -f "$TRANSCRIPT" ] && echo yes || echo no)"
    fi
  fi
  if [ -z "$TASK_ID" ]; then
    TASK_ID=$(hb_anchor_from_transcript "$TRANSCRIPT")
    [ -n "$TASK_ID" ] && ANCHOR_SRC="start_working declared in this session's transcript"
  fi
fi

# The LAST resort, and the only one a teardown has once it can no longer read
# the transcript: whatever this session resolved on an earlier event. #409 c6.
if [ -z "$TASK_ID" ] && [ -z "$ISSUE" ] && [ -f "$HB_STATE" ]; then
  # Read it WITHOUT sourcing the file. A `.` would execute whatever is in there,
  # and a cache file in a world-writable /tmp must never be a code path.
  TASK_ID=$(sed -n 's/^TASK_ID=\([0-9][0-9]*\)$/\1/p' "$HB_STATE" 2>/dev/null | head -n 1)
  ISSUE=$(sed -n 's/^ISSUE=\([0-9][0-9]*\)$/\1/p' "$HB_STATE" 2>/dev/null | head -n 1)
  CACHED_SPOKE=$(sed -n 's/^SPOKE=\(.*\)$/\1/p' "$HB_STATE" 2>/dev/null | head -n 1)
  [ -n "$CACHED_SPOKE" ] && SPOKE="$CACHED_SPOKE"
  if [ -n "$TASK_ID" ] || [ -n "$ISSUE" ]; then
    ANCHOR_SRC="the anchor cache from an earlier event in this session"
    hb_trace "anchor=recovered_from_cache task=${TASK_ID:-<none>} issue=${ISSUE:-<none>}"
  fi
fi

# Remember it on EVERY event that resolved one, not just `start`.
#
# This used to write only on `start`, which is the one event that can never
# resolve: `SessionStart` fires before STEP ZERO has created the task, so the
# cache that the reaped-`stop` path depends on was empty in practice. The first
# resolving `tool` ping is the earliest moment there is anything true to keep.
if [ "$EVENT" != "resolve" ] && { [ -n "$TASK_ID" ] || [ -n "$ISSUE" ]; }; then
  mkdir -p "$HB_STATE_DIR" 2>/dev/null
  printf 'TASK_ID=%s\nISSUE=%s\nSPOKE=%s\nSOURCE=%s\nSESSION_ID=%s\n' \
    "$TASK_ID" "$ISSUE" "$SPOKE" "${ANCHOR_SRC:-unrecorded}" "$SESSION_ID" > "$HB_STATE" 2>/dev/null
  cp "$HB_STATE" "$HB_PROJECT_STATE" 2>/dev/null
fi

# Rule 4. NO ANCHOR MEANS REFUSE, OUT LOUD, AND NEVER GUESS. #409 c5/c10, #411.
#
# There is nothing truthful to write without a declared anchor, and before #411
# the alternative on offer was a guess off the branch name — strictly worse than
# silence, because a wrong row is indistinguishable from a right one once it is
# in the table. So the terminal event records the refusal where a human will
# find it, and names the two things that fix it.
if [ -z "$TASK_ID" ] && [ -z "$ISSUE" ] && [ "$EVENT" != "resolve" ]; then
  hb_trace "result=NOT_SENT reason=no_anchor detail=no-start_working-call-found-in-this-session-and-IDEABASE_TASK_ID-unset fix=call-start_working-or-set-IDEABASE_TASK_ID transcript=${TRANSCRIPT:-<none>} dir=$SPOKE session=$SESSION_ID"
  exit 0
fi

# The credential. Env var first so tests and CI can drive this without the
# secret store; then the store.
#
# `secrets/get` lives under ~/.claude/core, which may be absent — hence the
# -x test before calling it, the same absence-is-silent rule as everything
# else here. It exits non-zero on a missing secret and prints the fix, so the
# `|| true` keeps a missing key from tripping anything.
HB_KEY="${IDEABASE_HEARTBEAT_KEY:-}"
if [ -z "$HB_KEY" ]; then
  GETTER="$HOME/.claude/core/secrets/get"
  if [ -x "$GETTER" ]; then
    HB_KEY=$("$GETTER" 'idea-base-api-key' 2>/dev/null || true)
  fi
fi

# Rule 4 again. An UNRECOGNISED Bearer token is 401'd by _middleware.js before
# the handler runs, so sending a placeholder is strictly worse than sending
# nothing: it burns a request and writes no row either way.
if [ -z "$HB_KEY" ] && [ "$EVENT" != "resolve" ]; then
  hb_trace "result=NOT_SENT reason=no_api_key session=$SESSION_ID tried=IDEABASE_HEARTBEAT_KEY,secrets/get(idea-base-api-key)"
  exit 0
fi

HAVE_CURL=yes
command -v curl >/dev/null 2>&1 || HAVE_CURL=no
if [ "$HAVE_CURL" = "no" ] && [ "$EVENT" != "resolve" ]; then
  hb_trace "result=NOT_SENT reason=no_curl session=$SESSION_ID"
  exit 0
fi

HB_URL="${IDEABASE_HEARTBEAT_URL:-https://app.idea-base.us/api/heartbeat}"

# WHO DID THE WORK, as distinct from whose key authorised it.
#
# The API key this hook reads belongs to a HUMAN. Without this header every
# heartbeat an agent posts is recorded against that person — `actor_is_agent:
# false` on an agent's own activity, in the one feature whose purpose is to
# know whether an AGENT session is alive. Measured against production before it
# was fixed; it is #990482's defect in new clothes.
#
# `X-On-Behalf-Of` is validated fail-closed by _middleware.js: the identity
# must already exist and must NOT be a person, and it confers no permission of
# any kind. So an unset or wrong value cannot escalate anything — a wrong one
# gets a clean 403 and, because this POST is detached, costs the agent nothing.
#
# EXPLICIT OR NOTHING. DO NOT GIVE THIS A HARDCODED DEFAULT. #380.
#
# An earlier revision of #380 defaulted this to `claude_ai`, reasoning that
# `PostToolUse` fires on a tool call THE MODEL MADE and `SessionStart` /
# `SessionEnd` are fired by the harness, so no human can trigger this script by
# typing and the actor is therefore always an agent.
#
# That reasoning is correct that the actor is an AGENT and wrong that we know
# WHICH agent, and the asymmetry in how the two defaults FAIL is what decides
# it. Measured: `claude_ai` is the only `is_agent = 1` row in the entire `users`
# table. `_middleware.js` validates `X-On-Behalf-Of` fail-closed — the identity
# must already exist and must not be a person — so:
#
#   * default to the KEY OWNER (no header): the row is written and attributed to
#     a human. Mislabelled, and after #381's agents-only board it is filtered
#     out of that view — but it EXISTS, and it is queryable and fixable.
#   * default to a HARDCODED id: anywhere that id does not exist, every
#     heartbeat is 403'd and NO ROW IS WRITTEN AT ALL. And because the POST is
#     detached (rule 3), that refusal is invisible.
#
# A wrong label is recoverable; silently nothing is the failure mode this whole
# issue exists to kill, so the default must be the one that degrades to a row.
# `scripts/test-session-heartbeats.mjs` has asserted this since #375 and the
# assertion is RIGHT — it was not loosened to accommodate the code.
#
# THE IDENTITY IS CONFIGURATION, NOT A CODE DEFAULT. This repo sets it in
# `.claude/settings.json`'s `env` block, which does reach hook processes
# (verified: `printenv NODE_ENV` returns `production`, and that value exists
# only in that block). That gives correct attribution here without baking one
# installation's user id into a script.
HB_ACTOR="${IDEABASE_ACTOR:-}"

# ---------------------------------------------------------------------------
# `resolve`: report and stop. Nothing is posted and nothing is written.
# ---------------------------------------------------------------------------
# The KEY IS NEVER PRINTED, only whether one resolved — the same rule as every
# other credential surface here (names are safe to print, values are not).
if [ "$EVENT" = "resolve" ]; then
  # `resolve` has no stdin, so it has no transcript path and cannot re-run the
  # scan. It reads back what the live session LAST RESOLVED on a real event
  # instead — see WHERE THE RESOLVED ANCHOR IS REMEMBERED. Re-deriving the
  # anchor here is exactly what this mode exists to prevent: a diagnostic that
  # resolves differently from the hook passes while the hook fails.
  if [ -z "$TASK_ID" ] && [ -z "$ISSUE" ] && [ -f "$HB_PROJECT_STATE" ]; then
    TASK_ID=$(sed -n 's/^TASK_ID=\([0-9][0-9]*\)$/\1/p' "$HB_PROJECT_STATE" 2>/dev/null | head -n 1)
    ISSUE=$(sed -n 's/^ISSUE=\([0-9][0-9]*\)$/\1/p' "$HB_PROJECT_STATE" 2>/dev/null | head -n 1)
    CACHED_SRC=$(sed -n 's/^SOURCE=\(.*\)$/\1/p' "$HB_PROJECT_STATE" 2>/dev/null | head -n 1)
    CACHED_SESSION=$(sed -n 's/^SESSION_ID=\(.*\)$/\1/p' "$HB_PROJECT_STATE" 2>/dev/null | head -n 1)
    if [ -n "$TASK_ID" ] || [ -n "$ISSUE" ]; then
      ANCHOR_SRC="${CACHED_SRC:-unrecorded} — as last resolved by session ${CACHED_SESSION:-<unknown>}"
    fi
  fi
  [ -n "$ANCHOR_SRC" ] || ANCHOR_SRC="NOTHING RESOLVED — no start_working call recorded for this working tree, and IDEABASE_TASK_ID is unset"
  printf 'TASK_ID=%s\n' "$TASK_ID"
  printf 'ISSUE=%s\n' "$ISSUE"
  printf 'ANCHOR_SOURCE=%s\n' "$ANCHOR_SRC"
  printf 'SPOKE=%s\n' "$SPOKE"
  printf 'ACTOR=%s\n' "${HB_ACTOR:-<unset — heartbeats will attribute to the API key owner, a human>}"
  printf 'API_KEY=%s\n' "$([ -n "$HB_KEY" ] && echo present || echo ABSENT)"
  printf 'CURL=%s\n' "$HAVE_CURL"
  printf 'URL=%s\n' "${IDEABASE_HEARTBEAT_URL:-https://app.idea-base.us/api/heartbeat}"
  printf 'PROJECT_DIR=%s\n' "$PROJECT_DIR"
  printf 'STATE_FILE=%s\n' "$HB_PROJECT_STATE"
  printf 'STOP_LOG=%s\n' "${TMPDIR:-/tmp}/ib-heartbeat/stop.log"
  exit 0
fi

# THE TRAILING NEWLINE IS LOAD-BEARING AND A COMMAND SUBSTITUTION DESTROYS IT.
#
# This was `ACTOR_HEADER=$(printf 'header = "..."\n' "$HB_ACTOR")`, and `$( )`
# STRIPS TRAILING NEWLINES. The outer config printf interpolates this value
# immediately before `data = `, so the result was two options glued onto one
# line:
#
#   header = "Content-Type: application/json"
#   header = "X-On-Behalf-Of: claude_ai"data = {"event":"tool",...}
#
# MEASURED CONSEQUENCE, against a catcher that logs every method (not reasoned
# — the same way the quoted-vs-unquoted rule below was established): curl
# parses the header correctly and SILENTLY DISCARDS the glued-on `data`. With
# no body left, it sends a **GET**:
#
#   method=GET  obo=claude_ai  auth=present  len=0  body=(EMPTY)
#
# And a GET is the worst possible shape, because `/api/heartbeat` ANSWERS one:
# `onRequestGet` returns the endpoint's own self-description with a 200. So the
# request succeeds, looks healthy from every angle a caller can see, and writes
# nothing.
#
# (An earlier revision of this comment said curl "sends no request at all".
# That was wrong, and it was wrong because the first catcher only implemented
# do_POST, so the GET was answered 501 and never logged. The corrected
# measurement is above. Absence of evidence in a tool that cannot observe the
# thing is not evidence of absence — which is the same mistake, in miniature,
# as the one this whole issue is about.)
#
# So before this fix, setting IDEABASE_ACTOR did not mis-attribute a
# heartbeat, it SILENTLY SUPPRESSED the recording of it — and because the POST
# is detached and curl's own exit code is discarded, the only observable
# difference between "attribution configured" and "emitter switched off" was
# the absence of rows nobody was watching for. The actor path shipped in #375
# was verified with a direct curl, which never exercises this assembly, so it
# has never worked through the hook.
#
# A literal newline inside a double-quoted assignment survives, because no
# command substitution is involved. Keep it that way; do not "tidy" this back
# into a $( ) form.
if [ -n "$HB_ACTOR" ]; then
  ACTOR_HEADER="header = \"X-On-Behalf-Of: $HB_ACTOR\"
"
else
  ACTOR_HEADER=""
fi

# ---------------------------------------------------------------------------
# RULE 3: DETACH, THEN EXIT.
# ---------------------------------------------------------------------------
# The credential is passed through curl's --config on STDIN, never on argv, so
# it does not appear in `ps` output for any other process on the box to read.
# Every other script here puts tokens in argv; this one is on a hot path that
# runs hundreds of times a session, so the window is proportionally wider and
# the fix costs nothing.
#
# `setsid` puts curl in its own session so it is not in this script's process
# group and cannot be signalled or waited on when the hook's shell goes away.
# The surrounding `( ... ) &` backgrounds the WHOLE pipeline — backgrounding
# only curl would leave the foreground shell holding the pipe write.
#
# Every descriptor is redirected to /dev/null. This is not tidiness: an
# un-redirected background child inherits the hook's stdout, and anything
# reading that stream to EOF would wait for the child to finish — which is
# exactly the blocking this rule exists to prevent.
#
# --max-time bounds the DETACHED process, not this one. It exists so a hung
# endpoint leaves no curl accumulating for hours across a long session.
# THE ANCHOR KEYS ARE OMITTED WHEN EMPTY RATHER THAN SENT BLANK. #380.
#
# Both matter, and in opposite ways:
#
#   * `"task_id":""` would reach `Number(body?.task_id)` as 0, fail the
#     `> 0` guard at heartbeat.js:164 and fall through — harmless, but it
#     would also mean the hot path always carries a key that means nothing.
#   * `"issue_id":""` is NOT harmless. heartbeat.js:130 only maps undefined
#     and null to NULL, so an empty string is stored verbatim in
#     `github_issue_id` — a row claiming to track an issue named "". NULL is
#     the truthful value for "this session has no issue number".
#
# Each is emitted as a separate fragment with its leading comma inside, which
# keeps the assembled object valid for all four combinations without needing a
# join. task_id is UNQUOTED (a JSON number, which is what the endpoint's
# `Number()` wants); issue_id stays a string because the column is TEXT.
TASK_FRAGMENT=""
[ -n "$TASK_ID" ] && TASK_FRAGMENT=$(printf ',"task_id":%s' "$TASK_ID")
ISSUE_FRAGMENT=""
[ -n "$ISSUE" ] && ISSUE_FRAGMENT=$(printf ',"issue_id":"%s"' "$ISSUE")

BODY=$(printf '{"event":"%s","session_id":"%s"%s%s,"spoke":"%s"}' \
  "$EVENT" "$SESSION_ID" "$TASK_FRAGMENT" "$ISSUE_FRAGMENT" "$SPOKE")

# THE HEADERS ARE QUOTED AND `data` IS NOT. THE MIX IS NOT AN OVERSIGHT —
# EACH FORM IS WRONG FOR THE OTHER FIELD, AND BOTH FAIL QUIETLY.
#
# curl's config parser treats a value STARTING with a double quote as a quoted
# string with backslash escapes, and an unquoted value as verbatim-to-EOL. So:
#
#   * `data` must be UNQUOTED. The JSON body is full of double quotes; quoting
#     it would require escaping every one and would break the first time a
#     spoke name contained one.
#
#   * the HEADERS must be QUOTED. Measured, not reasoned: unquoted, curl emits
#       warning: 'header' uses unquoted whitespace in the line that may cause
#       side-effects!
#     and DROPS the header. The first version of this script left them
#     unquoted, and a local catcher proved it: the request arrived with
#     Authorization: null and Content-Type: null — a 401 in production and a
#     heartbeat that silently never recorded. Nothing in the hook's own exit
#     code would ever have shown it, because the POST is detached by design.
#
# Neither value can contain a newline (the issue is digits, the session id and
# spoke name are single-line), which is the one thing this format cannot carry.
CURL_CFG=$(printf 'url = "%s"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n%sdata = %s\nsilent\nmax-time = 10\noutput = "/dev/null"\n' \
  "$HB_URL" "$HB_KEY" "$ACTOR_HEADER" "$BODY")

# ===========================================================================
# RULE 3, AMENDED: `start` AND `tool` DETACH. `stop` DOES NOT. #409 c1 + c5.
# ===========================================================================
# THIS ASYMMETRY IS THE FIX, AND IT IS DELIBERATE. Read before "tidying" the
# two branches back into one.
#
# Rule 3 (detach, discard the outcome) is RIGHT for `start` and `tool`:
#
#   * `tool` fires on every tool call in the session AND in every subagent.
#     One ping is one sample of a continuous signal. A lost sample changes
#     nothing a reader can see, and waiting on the network to take that sample
#     would tax every action the agent performs.
#   * `start` is followed within 60 seconds by a `tool` ping that carries the
#     same anchor, so a lost `start` self-heals.
#
# It is WRONG for `stop`, measured, and here is the measurement (#409, this
# worktree, 2026-11-05). A real nested session was run to termination with the
# emission logged. Every hook-side link WORKED:
#
#     event=stop phase=enter   project_dir=<worktree>  (SessionEnd DID fire)
#     event=stop phase=forking session=378560e4-... issue=409 actor=claude_ai
#     event=stop phase=curl_returned rc=0             (curl succeeded)
#
# and the POST arrived on the wire, well-formed, with the actor header. Then
# production answered:
#
#     HTTP 202 {"recorded":false,"reason":"issue_not_resolved","issue_id":"409"}
#
# NO ROW WAS WRITTEN. The anchor could not resolve, because `/api/heartbeat`
# turns an issue number into a task through `tasks.github_issue_id`, and that
# column is NULL on every agent-created task (MCP `create_task` accepted the
# field and stored null; `update_task` had no such field at all). So the
# emitter was never broken — the SERVER declined, politely, and rule 3 threw
# the decline away. `output = "/dev/null"` plus a discarded exit code plus a
# 202-not-4xx status is three independent reasons nobody could ever see it.
#
# That is why the leading hypothesis (worktree gone at teardown) was wrong, and
# why no amount of hook-side hardening would have found it. The one terminal
# event has to READ ITS OWN ANSWER.
#
# What this costs: `stop` runs once per session, at the moment the agent is
# already exiting, so there is no hot path left to protect. `--max-time 4`
# keeps it inside the hook's 5-second timeout in settings.json, and rule 1
# still holds — the exit is 0 whatever happened.
if [ "$EVENT" != "stop" ]; then
  hb_trace "phase=forking session=$SESSION_ID task=${TASK_ID:-<none>} issue=${ISSUE:-<none>} url=$HB_URL actor=${HB_ACTOR:-<none>}"
  ( printf '%s' "$CURL_CFG" | setsid curl --config - ) >/dev/null 2>&1 &
  exit 0
fi

# ---------------------------------------------------------------------------
# The terminal event, synchronously, and recorded whatever happens.
# ---------------------------------------------------------------------------
mkdir -p "$HB_STATE_DIR" 2>/dev/null
STOP_BODY_FILE="$HB_STATE_DIR/stop-body.$$"

# ---------------------------------------------------------------------------
# WRITE THE ATTEMPT **BEFORE** THE CALL. THIS IS NOT BELT-AND-BRACES.
# ---------------------------------------------------------------------------
# `SessionEnd` hooks run under a timeout, and this script now BLOCKS on the
# network inside it. If the hook is killed mid-POST — slow endpoint, DNS
# stalling, a budget tighter than measured — then a log written only AFTER curl
# returns would record nothing, and the one terminal event would be silent again
# in precisely the circumstance it most needs not to be.
#
# So the attempt is recorded first. A `phase=posting` line with no matching
# `result=` line on the same session id IS the signal: it says the stop was
# attempted and the hook did not survive to learn the outcome. That is a
# different and more useful fact than silence.
#
# THE BUDGET, STATED CORRECTLY — checked against the current hook reference,
# because an earlier version of this comment made it sound tighter than it is.
# `SessionEnd` hooks share a 1.5-SECOND DEFAULT budget, but that budget RISES to
# match the highest per-hook `timeout` in settings, up to 60s. This hook is
# registered with `"timeout": 5`, so the real budget here is 5 seconds and a
# 3-second curl sits comfortably inside it. Measured round-trip to production
# from this container is ~1s (stop at 14:14:39Z, outcome logged 14:14:40Z).
#
# If you ever drop that `"timeout": 5` from settings.json, the budget falls back
# to 1.5s and this default becomes too generous. The two numbers are coupled.
STOP_TIMEOUT="${IDEABASE_HEARTBEAT_STOP_TIMEOUT:-3}"

# WHY the session ended, from the same payload the session id came from.
# `SessionEnd` carries a documented `reason`: clear | resume | logout |
# prompt_input_exit | other. It is recorded LOCALLY ONLY — the endpoint has no
# such field and inventing one would be a schema change this issue does not
# need. It costs one sed over bytes already in memory, and it is the difference
# between "a session ended" and "the user ran /clear".
STOP_REASON=$(printf '%s' "$PAYLOAD_HEAD" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
hb_trace "phase=posting session=$SESSION_ID task=${TASK_ID:-<none>} issue=${ISSUE:-<none>} reason=${STOP_REASON:-<none>} url=$HB_URL actor=${HB_ACTOR:-<none>} max_time=${STOP_TIMEOUT}s"

# Same quoting discipline as above: headers quoted, `data` unquoted to EOL.
# `write-out` is quoted and its `%` is doubled for the outer printf.
STOP_CFG=$(printf 'url = "%s"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n%soutput = "%s"\nsilent\nmax-time = %s\nwrite-out = "%%{http_code}"\ndata = %s\n' \
  "$HB_URL" "$HB_KEY" "$ACTOR_HEADER" "$STOP_BODY_FILE" "$STOP_TIMEOUT" "$BODY")

HTTP_CODE=$(printf '%s' "$STOP_CFG" | curl --config - 2>/dev/null)
CURL_RC=$?
RESP=$(head -c 400 "$STOP_BODY_FILE" 2>/dev/null | tr -d '\n\r')
rm -f "$STOP_BODY_FILE" 2>/dev/null

# Classify, so a later grep finds the failure without parsing JSON. The three
# outcomes a reader actually cares about are "the row exists", "the server
# refused and said why", and "the request never completed".
case "$RESP" in
  *'"recorded":true'*)
    hb_trace "result=RECORDED http=${HTTP_CODE:-none} session=$SESSION_ID task=${TASK_ID:-<none>} issue=${ISSUE:-<none>} reason=${STOP_REASON:-<none>} resp=$RESP"
    # The session is accounted for; the cache has done its job.
    rm -f "$HB_STATE" 2>/dev/null
    ;;
  *'"recorded":false'*)
    hb_trace "result=NOT_RECORDED http=${HTTP_CODE:-none} session=$SESSION_ID task=${TASK_ID:-<none>} issue=${ISSUE:-<none>} resp=$RESP"
    ;;
  *)
    hb_trace "result=NO_RESPONSE curl_rc=$CURL_RC http=${HTTP_CODE:-none} session=$SESSION_ID url=$HB_URL resp=${RESP:-<empty>}"
    ;;
esac

# Rule 1. Unconditional. Whether the endpoint answered, 500'd, or was never
# reachable at all is not this script's business and must never be the agent's.
# What HAS changed is that it is now somebody's business: it is in the log.
exit 0
