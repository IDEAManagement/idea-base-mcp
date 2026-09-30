# Changelog

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
