# Changelog

## 2.7.1 — 2026-11-06

**`doctor` and the heartbeat hook now agree about the API key.** Tracks
`idea-base.us#440` / `idea-base-mcp#29`.

### Fixed

- `doctor`'s PRESENT/ABSENT verdict is now read off the hook's own `resolve`
  output instead of an independently-derived guess, so the two can no longer
  disagree. Previously a machine with only `IDEA_BASE_API_KEY` set could get
  `doctor` reporting the row RECORDED while the real hook (which did not yet
  accept that variable) sent nothing.
- `resolveKey` now also tries the secrets-store fallback
  (`~/.claude/core/secrets/get idea-base-api-key`), matching the hook's own
  precedence — a machine where only that fallback resolved used to report
  ABSENT.
- A session with no declared anchor no longer sees a `key:` line printed
  ahead of the `NOT TRACKED` verdict.
- The vendored `heartbeat.sh` is re-synced with upstream idea-base.us, which
  itself now accepts `IDEA_BASE_API_KEY` as a second-priority credential tier.

## 2.7.0 — 2026-11-05

**The product now instructs you to use it.** Installing IDEA Base gave you
working session-tracking mechanisms and nothing that told you they existed or
wired up what they need. We were the first customer and proved it: a full day
of work in our own repository recorded no task, no work session and no time,
with the live agent board empty of every session actually running.

Tracks `idea-base.us#383`.

### Added

- **`/idea-base:setup`** — reports whether this project emits session tracking,
  names every missing piece with the **literal text to add**, and takes a live
  probe so the answer is "a row landed" rather than "a hook is registered".
  Writes nothing. Re-runnable at any time, and re-running **is** the audit —
  there is no separate audit command to drift from it.
- **`/idea-base:features`** — what is wired on **this machine**, not what the
  product supports. Four states per capability: on, off, configured-but-not-
  firing, and undetermined. Read-only.
- **`install` / `doctor` / `features` CLI subcommands.** The spec has no
  primitive for writing a customer's settings file, so the prompt recommends and
  `install` writes, only with `--apply`.
  - It **merges**: other tools' hooks, `permissions`, `env` and every unrelated
    key survive. A second run leaves the file byte-identical.
  - It **collapses a duplicate** heartbeat registration — a duplicate
    double-writes.
  - It **refuses a `settings.json` it cannot parse** rather than rewriting it. A
    file that will not parse is not an empty file.
  - It writes the hook script **before** the hooks that reference it, because a
    hook pointing at a missing script fails *closed* and can deny `Bash` and
    `Edit`, including the edit needed to repair it.
  - `--actor` is **never defaulted**. Unset writes a mislabelled but visible
    row; a wrong id is refused and writes **no row at all**.
- **A first-use pointer** on the first tool call of a session — once per
  process, and only when tracking is actually missing. There is no sanctioned
  run-on-install moment: the lifecycle forbids a server speaking before
  `initialized`, no hook fires on MCP connection, and the `Setup` hook event is
  not it either (it fires only under `--init-only` / `-p --init`, cannot block,
  and has its output discarded).
- **`src/assets/heartbeat.sh`** — the hook script now ships with the package,
  byte-identical to its origin in `idea-base.us`, with provenance recorded
  beside it. Without it, `setup` would register three hooks pointing at a file
  the customer does not have.
- **An offline test suite, and a `test` script to run it.** 57 assertions on
  `node --test` (built into Node 20+; **no dependency added**), wired as
  `npm test` and run by a new `.github/workflows/test.yml` on every pull
  request. 2.6.0 added `test/live-mcp.test.mjs` shortly before this; the two
  are complementary and deliberately separate — that one uses **no mocks** and
  drives a real server against the **real production API**, which is the right
  shape for what it checks and the wrong thing to fire on every PR, since it
  needs a write-scoped key and would write to production from CI. So it stays
  behind `npm run test:live`, and `npm test` is the glob `src/*.test.js` rather
  than a bare `node --test` precisely so default discovery cannot pick it up.
  Two of the new assertions are **discrimination controls** — a correct install
  must not be reported broken, an undetermined capability must not be reported
  off — because a checker that says "broken" about everything passes every
  positive test and is worthless.

### Fixed

- `serverInfo.version` reported `1.0.0` while the package was at `2.6.0`, so the
  version a client displayed bore no relation to the one installed. Now
  asserted against `package.json` by a test.

### Notes

Three defects in this work were caught by its own tests and its own
end-to-end run rather than by review: the injected filesystem was being
bypassed for writes (so "a dry run writes nothing" was asserting against the
real disk); a capability row carried no timestamp and no reason, which is the
shape this release exists to forbid; and `doctor` redirected `TMPDIR` without
redirecting the hook's **state** dir, so it reported NOT TRACKED for a session
whose anchor was perfectly resolvable — a false negative telling a correctly
configured customer their tracking was broken. Each now has a regression test.

## 2.6.0 — 2026-11-05

Ships seventeen days of merged work that had never been published (GH #410) —
every consumer was still on 2.5.0, so `update_task(parent_task_id)`, the
re-parenting half of #387, was unreachable in every running session.

### Added

- **`update_task` accepts `parent_task_id`, `github_issue_id`,
  `github_issue_url`** (idea-base.us#387; merged in `e2ee06c`, unreleased
  until now). Re-parent an existing task or detach it (`parent_task_id:
  null`); link or unlink the GitHub issue a task tracks
  (`github_issue_id: null`). Both follow the `!== undefined` rule used
  elsewhere in this tool: an explicit `null` is a real value the API acts
  on, not a no-op.
- **`create_task` accepts `github_issue_id` / `github_issue_url`.** This was
  the missing fourth layer: the REST create path
  (`POST /api/projects/:id/tasks`) has destructured and inserted
  `github_issue_id` since it shipped, but this tool's schema never declared
  it — a caller's value never reached the handler, so a 200 came back with
  the field silently stored as NULL. Fixed to persist rather than drop it.

### Process

- Added `.github/workflows/version-drift.yml` — reports (non-blocking) when
  `main` has commits beyond the published version's `gitHead`, so "merged
  but unpublished" is visible instead of being rediscovered by whoever trips
  over it next. See README.md#releasing: **merging to `main` does not ship
  anything** — every consumer runs whatever npm currently answers for
  `version`, and a global `npm install -g` (several deployments run this
  way) will not move on its own no matter what gets published.

## 2.5.0 — 2026-10-19

Three **prompts**. Until now this server shipped 35 tools and nothing else, so
an agent starting a sprint had to know to call several tools in the right
order. A prompt is one invocation that returns the sprint already laid out.

In Claude Code they appear as `/idea-base:start_sprint 6` (the server name comes
from your MCP config key, so it is `/idea-base:…` for a standard install).

### Added

- **`start_sprint [sprint_id]`** — the goal, the window, days left, and every
  item split into **assigned to you**, **unassigned**, and **blocked with the
  reason**. Omit the id for the sprint covering today. Work assigned to someone
  else is counted but not listed, because it is not yours to pick up.
- **`sprint_report [sprint_id]`** — from the commitment ledger: committed vs
  completed, what carried, what was released. On an open sprint it says nothing
  has been judged yet; on a sprint closed before the ledger existed it says the
  record was never kept, which is NOT the same as having committed to nothing.
- **`plan_sprint <product_id>`** — the cadence, the window the next sprint would
  cover, the eligible pool, and the work held back as blocked with its reason.
  Works before any sprint exists.

### Two rules the implementation follows

- **Tracker text is untrusted.** Titles, descriptions, goals and blocked reasons
  are written by whoever filed the work — in this product, often another agent —
  and a prompt result is injected directly into the conversation. All of it goes
  inside a fenced DATA block, the fence **escalates** so embedded backticks
  cannot close it, each value is flattened to one line, and the instructions
  above the block say plainly that it is data. The text itself is preserved
  verbatim: flattening is not censoring.
- **The body is bounded and says when it is.** Items are capped per group at 25
  and the TRUE total is always printed (`showing 25 of 72`), so a truncated list
  can never read as a complete one. There is no documented size limit for a
  prompt result, which is a reason to cap deliberately rather than hope.

A missing or malformed argument returns `-32602 InvalidParams`, not a generic
internal error. An unknown or inaccessible id returns a readable refusal rather
than an empty body.

### Not included

Per-team reporting. Sprints have no team dimension — ownership is product-level
— so a team view would be invented rather than read.

## 2.4.0 — 2026-10-19

Sprints. Eight tools, additive — nothing existing changed.

### Added

- **`list_sprints`, `get_sprint`, `create_sprint`, `add_tasks_to_sprint`,
  `remove_tasks_from_sprint`, `close_sprint`, `get_sprint_cadence`,
  `set_sprint_cadence`.**

A sprint is a list of work for one period, and it is owned by the **product**:
the product sets the cadence and owns the lifecycle, while projects add and
remove the work. So a sprint spans every project under its product, sub-projects
included, and it can never straddle two customers.

The tool descriptions carry the rules a schema cannot express, which are the
ones an agent would otherwise find by getting them wrong:

- A task is in **at most one** sprint, and adding one that already belongs to
  another is **refused, not moved** — silently relocating it would lose someone
  else's commitment.
- `create_sprint` with no dates opens the **next** sprint on the cadence, which
  is the normal case. Explicit dates are the exception.
- `close_sprint` is **irreversible**. It carries unfinished work into the next
  sprint and increments each task's carry count, so work that keeps slipping
  says so rather than being quietly re-added every period.
- Setting a cadence is also what **opts a product into the schedule**. A product
  with no cadence row is never rolled unattended, so "these are the defaults" is
  not the same as "sprints are on".
- `get_sprint` with `candidates: true` returns both the work that could be
  pulled in **and** the work being held back as blocked, with the reason —
  "why isn't this in my sprint" deserves an answer.

`set_sprint_cadence` forwards each field on `!== undefined`, so an omitted field
keeps its current value. In a tool with five independent settings the
alternative quietly rewrites four of them every time one changes.

## 2.3.0 — 2026-10-19

A project can finally be re-parented or detached through this server. The API
has accepted both since the hierarchy shipped; the gap was entirely on this
side, and it was two bugs deep.

### Added

- **`update_project` takes `parent_project_id` and `product_id`.** Pass a
  parent id to move the project, or `null` to DETACH it into a top-level
  project. A detached project keeps the product it had inherited — verified
  against the live API, not assumed — so `product_id` is only needed to move it
  to a different product. Both fields are forwarded on `!== undefined` rather
  than on truthiness, so a name-only update can never silently detach anything.

### Fixed

- **The argument validator dropped every `null`, so a nullable field could not
  exist.** `validateArgs` skipped any argument whose value was `null` before a
  handler ran, which meant adding `parent_project_id` to the schema would not
  on its own have made detaching possible: the field arrived, vanished, and the
  API answered "No fields to update". `null` now survives when — and only
  when — the tool's own schema declares it (`type: ['number', 'null']`).
- **`coerce` compared `spec.type` with `===`,** so a union type fell through
  every branch to the string handler. A `['number', 'null']` id would have been
  stringified and skipped the positive-integer-id guard entirely. Branch
  selection now reads the union.
- **A refusal lost the half that said what to do about it.** The API splits an
  error into `error` (the headline) and `details`; only the headline reached
  the caller, so a plan nesting-depth or sub-project-limit refusal arrived with
  its remedy stripped off. Both halves are now joined into the message.

## 2.2.0 — 2026-09-30

Additive. `start_working` and `stop_working` now record a real timed session
instead of only toggling a presence flag, and two new tools record a pause and
the reason for it.

### Added

- **`pause_working` and `resume_working`.** Separate tools rather than a mode
  parameter on the existing pair, for two mechanical reasons. First, `reason`
  can be schema-REQUIRED on a dedicated tool — folded into `stop_working` it
  would have to be optional, because a plain stop has no reason, so a caller who
  did not think about it silently gets a default. The entire worked-time figure
  turns on that value, and "required only when mode=pause" is documentable but
  not enforceable. Second, "end the session" and "keep it open" should not be one
  token apart: under a mode flag, meaning to pause and ending the session instead
  is a one-word typo with no signal, and an ended session cannot be un-ended.
- **`reason` is a closed set: `waiting_on_human` | `waiting_on_agent` | `other`.**
  This is the distinction the whole feature exists for. A `waiting_on_human`
  pause is NOT work and is excluded from worked time. A `waiting_on_agent` pause
  IS work and is included — a sub-agent blocked on another active sub-agent is
  still working. Proven twice with independent fixtures: identical spans and
  identical pause lengths differing only in reason gave 6.00 versus 10.00 worked
  minutes on a 10-minute session.

### Changed

- `start_working` opens a session, or resumes the open one if this actor already
  has a session running on that task. It does not open a second — the database
  enforces one open session per (task, actor) as a backstop, but the tool
  resolves it before reaching that.
- `stop_working` closes the session with a UTC end instant and a terminal state,
  and fails clearly with `NO_OPEN_SESSION` if there is none, rather than writing
  a row with a null start.

### Unchanged, deliberately

- **`start_working`'s orientation block.** It still reads the task back and
  surfaces `resume_context` and recent work notes — the reason the tool is worth
  calling from a cold session. The fetch logic is byte-identical; only a timing
  line is prepended.
- **The `task_events` audit trail.** Both tools still call `/assignments`, so
  `started_working` and `stopped_working` rows keep landing. Sessions sit
  alongside that trail rather than replacing it.

### Requires

Server-side work-session endpoints, deployed to app.idea-base.us in commit
7bfd4ad and confirmed resolving in production before this release was cut.

## Unreleased

### Added

- **Timed work sessions.** `start_working` now opens a `work_sessions` row with a
  UTC start instant and `stop_working` closes it with a UTC end instant, so how
  long a task was actually worked is measured rather than guessed. Previously the
  pair only flipped a presence flag (`task_assignments.is_active`) and wrote
  unmatched `started_working` / `stopped_working` audit events — 96 starts against
  24 stops, with no duration derivable from either.
- **`pause_working` and `resume_working`**, as separate tools rather than
  parameters on the existing pair. A pause keeps the session open and records
  both its boundaries plus a required `reason`, and the reason carries the whole
  meaning: `waiting_on_human` EXCLUDES the interval from worked time,
  `waiting_on_agent` and `other` INCLUDE it. A sub-agent blocked on another
  active sub-agent is still working; only waiting on the human is not.
- `start_working` called twice on one task by one actor no longer opens a second
  session: it resumes a paused one or reports the running one, and says which.
  The database enforces this too (a partial unique index on the open row).

### Changed

- `stop_working` FAILS when there is no open session, rather than reporting a
  stop that measured nothing. Nothing is written and the active-work flag is left
  alone.
- Both tools keep everything they already did — the presence flag, the
  `started_working` / `stopped_working` audit events, the todo -> in_progress
  promotion, and `start_working`'s orientation block (resume context + recent
  work notes) are unchanged. The session timing sits alongside them.
- API errors now carry the endpoint's `code` and HTTP status on the thrown
  `Error`, so a handler can tell a real answer ("you have no open session") from
  an infrastructure failure without string-matching prose.

## 2.1.0 — 2026-09-30

Additive. Five fields and three tools the REST API already accepted and this
server silently dropped. Nothing removed, nothing renamed — a 2.0.0 client keeps
working unchanged.

### Added

- **`verification_mode` on `create_task` and `update_task`** (`manual` |
  `ai_review` | `ci_required` | `all`). This arms the server-side gate that
  `PUT /api/tasks/:id/status` enforces when a task is marked done. Until now the
  only path that could arm it was the web UI, so the gate had never fired for an
  agent. Rejected at the tool schema as an enum — note that the REST API itself
  performs no validation and will store any string, tracked as idea-base 990455.
- **`github_pr_url` on `create_task` and `update_task`.** A join key, not a
  display field: the CI-status webhook and `POST /api/tasks/:id/verify` both read
  it, and neither had input from an agent path. An empty string clears it,
  matching REST. `github_pr_id` is deliberately NOT wired — nothing joins on it
  and neither REST handler accepts it; wiring it would add a second,
  unsynchronised PR pointer.
- **`required_ci_checks`, `sort_order` and `is_milestone`** on both handlers.
  Note that the REST *create* endpoint accepts none of these three, so passing
  them to `create_task` is a no-op there — each field's description says so, and
  callers must follow up with `update_task`.
- **`verify_task`** — runs the product's AI verification, which grades a task's
  acceptance criteria and persists `ai_completion_score`. An agent could
  previously arm a gate it had no way to satisfy: set `ai_review`, attempt to
  close, get 403, and be stuck. **This call costs AI credits** (2 per call), and
  it grades the DIFF rather than the running system — both stated in the tool's
  own description.
- **`record_verification_feedback`** — records whether a verification verdict was
  useful. No model call, no cost; it is the calibration data that lets the
  verification prompt improve.
- **`add_assignee` / `remove_assignee`** — a task may now hold more than one
  assignee over MCP. `assignee_user_id` replaced the whole set, so a second
  assignment silently removed the first. Granular add/remove rather than an
  array replace-set, because the REST layer has only upsert-one and delete-one:
  a replace-set would need N non-transactional calls with no rollback.
  `add_assignee` no-ops when the user is already assigned, which matters because
  a blind re-POST would submit `is_active=0` and stop a running work timer.

## 2.0.0 — 2026-09-30

Major version because `author_kind` stops being an accepted input. See the app's
`docs/architecture/actor-attribution.md` for the design this implements.

### Breaking

- **`author_kind` is removed from `add_work_note`, `add_comment` and
  `set_resume_context`.** It was a free-text claim, never checked against who
  authenticated, and was demonstrably wrong in both directions — work genuinely done
  by the agent was labelled `human`, and notes authored under the owner's session were
  labelled `ai`. The value is now derived server-side from the validated agent
  identity, so there is nothing left to declare. Arguments are dropped by schema
  validation, so a caller still sending it is ignored rather than errored; the field
  is gone from the schemas, which is what the major bump announces. Older builds of
  this server keep working against the new API — they simply send a field it no longer
  reads. (idea-base#271)

### Added

- **`X-On-Behalf-Of` on every request.** The server now declares which agent is
  acting, so work an agent does is attributed to the agent instead of silently
  recorded as the API key's owner. Sent from the single `apiRequest` chokepoint, so
  every tool inherits it.

  The header **grants nothing** — no permission, no delegation, no elevation.
  Authorization stays entirely with the API key and its owner. It answers "who did
  this?" and only that.

  Defaults to `claude_ai`; override per session with `IDEA_BASE_AGENT_ID`. The
  identity must already exist server-side as a non-human user, or every call fails
  closed with `403 AGENT_IDENTITY_NOT_RESOLVABLE` / `AGENT_IDENTITY_NOT_PERMITTED` —
  deliberately loud, never a silent fallback to the key owner.

  Why it matters: an agent recorded as the owner made the owner the actor of his own
  notifications, and the notification fan-out correctly excludes the actor. The
  account owner received no product-generated alert from 2026-09-19 until this
  shipped.

## 1.3.0 — 2026-09-09

### Added

- **Assignee and dates on tasks.** `create_task` and `update_task` accept
  `assignee_user_id`, `start_date` and `due_date` (`YYYY-MM-DD`). On
  `update_task` an empty string clears a date or unassigns. (#2)
- **Compact rows and filters for task listing.** `list_tasks` and `search_tasks`
  return compact rows by default — id, title, status, priority, project/product/
  customer names, estimate, time logged, due date and a 160-character
  description snippet — instead of every column of every row. Pass
  `verbose: true` for the old full shape. `search_tasks` gains
  `project_id` / `product_id` / `customer_id` / `status` filters and a `limit`,
  and ranks title matches above description matches, then by recency. (#3)
- **Blocked status, subtasks and dependencies.** `update_task_status` accepts
  `blocked` (with an optional `blocked_reason`); `create_task` accepts
  `parent_task_id` to create a one-level subtask; `update_task` accepts
  `blocked_by: [ids]`, which replaces the task's full dependency set. `get_task`
  surfaces the derived `effective_status` / `status_reason`. (#4)

### Security

Full findings in [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

- Tool arguments are validated against each tool's own input schema before
  dispatch: ids must be positive integers, enums must match, strings are
  length-capped, and undeclared properties are dropped. A path-shaped id can no
  longer be interpolated into a request URL.
- An `IDEA_BASE_API_URL` override must be https with no embedded credentials,
  and a non-default host is announced once on stderr at startup.
- Requests carry a 30-second timeout, refuse to follow redirects, cap the
  response at 5 MB, and only parse a body the API labelled as JSON — an HTML
  error page is reported as such rather than quoted back into the tool result.
- Error text is capped and passed through a redactor so the API key can never
  reach a log or a tool result.
- `npm audit --omit=dev` is clean (was 7 findings in transitive HTTP-transport
  dependencies of the MCP SDK); the published tarball is limited to
  `src/index.js`, `README.md` and `LICENSE`; release workflow actions are pinned
  to commit SHAs and the release refuses to publish a version that disagrees
  with its tag.

### Changed

- `engines.node` raised to `>=20.0.0`.

## 1.2.0

- Added the audit-trail tools: `add_work_note`, `add_comment`,
  `set_resume_context`. 21 tools total.

## 1.1.0

- `create_project` accepts `product_id`; `create_product` requires
  `customer_id` (containment-model fixes).
