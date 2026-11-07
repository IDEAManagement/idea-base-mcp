# @idea-base/mcp-server

MCP (Model Context Protocol) server for [IDEA Base](https://idea-base.us) — AI-powered project management. Manage projects, tasks, and time tracking directly from Claude Code, Cursor, or any MCP-compatible AI tool.

## Quick Setup

### 1. Get your API key

Sign in to [IDEA Base](https://app.idea-base.us), go to **Settings > API Keys**, and create a key.

### 2. Add to your MCP config

**Claude Code** (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "idea-base": {
      "command": "npx",
      "args": ["-y", "@idea-base/mcp-server"],
      "env": {
        "IDEA_BASE_API_KEY": "ib_your_api_key_here"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` in your project):

```json
{
  "mcpServers": {
    "idea-base": {
      "command": "npx",
      "args": ["-y", "@idea-base/mcp-server"],
      "env": {
        "IDEA_BASE_API_KEY": "ib_your_api_key_here"
      }
    }
  }
}
```

Or via Claude Code CLI:
```bash
claude mcp add idea-base -- npx -y @idea-base/mcp-server \
  --env IDEA_BASE_API_KEY=ib_your_api_key_here
```

### 3. Start using it

Ask Claude to manage your projects:

- *"List my projects"*
- *"Create a task in project 1: Implement login page"*
- *"Log 2 hours on task 42 — built the auth flow"*
- *"What tasks are in progress?"*

## Available Tools

### Projects

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects with task counts and progress |
| `get_project` | Get project details and statistics |
| `create_project` | Create a new project or sub-project |
| `update_project` | Update a project name, description, status, parent (re-parent, or `null` to detach) or product |
| `list_sprints` | List a product's sprints with real task counts and its cadence |
| `get_sprint` | One sprint: tasks, counts, commitment ledger; optionally candidates + blocked work |
| `create_sprint` | Open a sprint — next on the cadence, or an explicit window |
| `add_tasks_to_sprint` | Commit tasks (refuses a task already in another sprint) |
| `remove_tasks_from_sprint` | Take tasks out of a sprint |
| `close_sprint` | Close it; unfinished work carries forward. Irreversible |
| `get_sprint_cadence` | Read a product's sprint rhythm |
| `set_sprint_cadence` | Set length, start weekday, carry-over, auto-open |

### Slash commands (MCP prompts)

Typed directly in Claude Code. The `idea-base` part is whatever you named the
server in your MCP config.

| Command | What it gives you |
| --- | --- |
| `/idea-base:start_sprint [id]` | A sprint laid out to work: goal, window, days left, and items split into assigned-to-you / unassigned / blocked-with-reason. Omit the id for the sprint covering today. |
| `/idea-base:sprint_report [id]` | Committed vs completed, what carried and how often, from the commitment ledger written at close. |
| `/idea-base:plan_sprint <product_id>` | Cadence, the next window, the eligible pool, and what is held back as blocked. |
| `/idea-base:setup` | Whether this project emits session tracking, every missing piece with the literal text to add, and a live check that a heartbeat actually lands. Writes nothing. |
| `/idea-base:features` | What is wired on **this machine** — each capability on, off, configured-but-not-firing, or undetermined with the reason. Read-only. |

Tracker text in these results is fenced as data, and item lists are capped with
the true total printed.

## Session tracking

With it installed, a long-running agent session appears on the dashboard's
**Agents Working Now** board while it works and leaves within seconds of
ending. Without it the board is empty, and **there is no way to tell that from
"no agents are running"** — which is the failure this exists to prevent.

```sh
npx @idea-base/mcp-server install          # DRY RUN — prints the plan, writes nothing
npx @idea-base/mcp-server install --apply --actor <agent-user-id>
npx @idea-base/mcp-server doctor           # does a heartbeat actually land?
npx @idea-base/mcp-server features         # the inventory, read-only
```

**`install` is safe to run as often as you like.** It merges rather than
overwrites: your other tools' hooks, your `permissions`, your `env` and
everything else in `.claude/settings.json` are preserved, and a second run
leaves the file byte-identical. If it finds the same heartbeat hook registered
twice it collapses it to one — a duplicate heartbeat double-writes. A
`settings.json` it cannot parse is **refused, never rewritten**: a file that
will not parse is not an empty file, and rebuilding it would delete every hook
you have.

It installs three hooks — `SessionStart`, `PostToolUse`, `SessionEnd` — plus
the script they call, at `.claude/hooks/heartbeat.sh`. The script is written
**before** the hooks that reference it, because a hook pointing at a missing
script fails *closed* and can deny `Bash` and `Edit`, including the edit needed
to repair it.

### `--actor` is not optional in practice, and is never guessed

The API key belongs to a person. Without `env.IDEABASE_ACTOR` every heartbeat
an agent posts is attributed to that person, and because the board filters to
agents, the session is filtered off it entirely.

It is never defaulted, deliberately:

| `IDEABASE_ACTOR` | Result |
| --- | --- |
| unset | a row is written, attributed to the key's human owner. Mislabelled, but **visible and fixable**. |
| an id that does not exist | `403` — **no row at all**. |
| an id belonging to a human | `403` — no row. |

A wrong guess lands in the invisible row. So `install` asks for it rather than
inventing one.

### Verifying, and what "verified" means

`doctor` posts one labelled probe and reports **the server's own verdict**, because
`POST /api/heartbeat` answers `HTTP 202` with `{"recorded":false}` when it
discards a ping — a success status for "I threw this away". Exit status:

| Exit | Meaning |
| --- | --- |
| `0` | recorded (or heartbeats are deliberately switched off) |
| `1` | the endpoint refused or skipped it |
| `2` | could not get as far as asking |

`1` and `2` are kept apart on purpose: "I asked and was told no" and "I never
managed to ask" need different fixes.

**A session with no task is untracked, by design.** The hook sends nothing
unless the session has declared what it is working on — normally by calling
`start_working`. Nothing about your branch names or directory layout affects
this. A hub on `main`, an exploratory session, anything not working a task: all
correctly absent, and `doctor` says which.

### What this does not do

It never changes a task's status. A session ending marks the *session*
finished; deciding a task is done is a judgment with a verification gate in
front of it.

These three hooks are **Claude Code** mechanisms. Nothing here transfers to
another agent harness — `POST /api/heartbeat` is not Claude-Code-specific, so
you can wire it to any session lifecycle hook yourself, but there is no
packaged install for another harness today.

Requires `curl` on `PATH`, a **write**-scoped API key, and Node 20+.
`IDEABASE_HEARTBEAT=off` disables emission entirely.

### Tasks

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks for a project (filter by status). Compact rows by default (`verbose:true` for full rows) |
| `get_task` | Get task details, acceptance criteria, and time entries |
| `create_task` | Create a task with title, description, estimate, priority, start/due dates, assignee; `parent_task_id` makes it a subtask |
| `update_task` | Update task details, priority, start/due dates, assignee; `blocked_by: [ids]` replaces its dependencies |
| `update_task_status` | Change task status (todo/in_progress/blocked/done) |
| `search_tasks` | Search tasks across all projects, ranked title-first then description then recency. Compact rows by default; filter by `project_id`/`product_id`/`customer_id`/`status`; `verbose:true` for full rows |
| `quick_log` | Create + complete + log time in one step |

### Time Tracking

| Tool | Description |
|------|-------------|
| `log_time` | Log time against a task with notes |
| `start_working` | Open a timed work session on a task, and mark yourself actively working (surfaces the saved resume context + recent work notes so a cold session re-orients). Calling it twice never opens a second session — it resumes or reports the one you have |
| `pause_working` | Pause the open session without ending it, with a required `reason` |
| `resume_working` | Close the pause and carry on in the same session |
| `stop_working` | Close the session with a UTC end instant and drop the active flag (optionally capture a `note` and/or `resume_context` on the way out). Fails if you have no open session |

**Sessions are measured, and the pause reason decides the number.** `start_working`
records a UTC start instant, `stop_working` a UTC end instant, and each pause in
between records both its boundaries plus why work stopped:

| `reason` | Effect on worked time |
|---|---|
| `waiting_on_human` | **Excluded.** A person has to act before you can continue |
| `waiting_on_agent` | **Counted.** A sub-agent blocked on another *active* sub-agent is still working |
| `other` | Counted |

Only waiting on the human is not working. Use `pause_working` rather than
`stop_working` whenever you intend to carry on — `stop_working` ends the session
and the reason is lost.

### Activity & Audit Trail

For AI agents, these leave a durable trail of *what was done and why* on each task — so a future session (or a human reviewer) can see the reasoning, not just the final state.

| Tool | Description |
|------|-------------|
| `add_work_note` | Append a timestamped progress note to a task's activity log (append-only journal) |
| `add_comment` | Add a comment to a task's discussion thread (customer-visible by default) |
| `set_resume_context` | Overwrite the task's pinned "where I left off" block, read first on `start_working` |

### Products

| Tool | Description |
|------|-------------|
| `list_products` | List products (top-level containers) |
| `get_product` | Get product details with linked projects |
| `create_product` | Create a new product |
| `link_project_to_product` | Link a project to a product |

### Support

| Tool | Description |
|------|-------------|
| `report_bug` | File a bug report against IDEA Base itself through the existing Help Desk intake (`POST /api/tickets`, category `bug`) — not a second intake path. Staff see it in the Help Desk queue. A read-only API key is refused. |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `IDEA_BASE_API_KEY` | Yes | Your API key from Settings > API Keys |
| `IDEA_BASE_API_URL` | No | Custom API URL (default: `https://app.idea-base.us/api`) |

## Real-time Notifications

When you use the MCP server to update tasks or log time, changes are broadcast to all connected users. Team members viewing the project in their browser see live toast notifications — when Claude updates a task, everyone sees it immediately.

## Security

- All data access is scoped to your account via API key
- API keys support read/write permissions
- No data is stored locally — all operations go through the IDEA Base API
- Cross-account access is blocked server-side
- Rate limited per API key

## Development

```bash
# Run the server directly
IDEA_BASE_API_KEY=your_key npm start

# Watch mode
IDEA_BASE_API_KEY=your_key npm run dev

# Live integration test — spawns a real server (this checkout, or a
# published version via --cmd) and drives it against the real API.
# Creates and deletes its own scratch tasks; see test/live-mcp.test.mjs.
IDEA_BASE_API_KEY=your_key node test/live-mcp.test.mjs
IDEA_BASE_API_KEY=your_key node test/live-mcp.test.mjs --cmd "npx -y @idea-base/mcp-server@2.5.0"
```

## Releasing

**Merging to `main` does not ship anything.** Every consumer runs whatever
`npm view @idea-base/mcp-server version` currently answers — not whatever is
on `main`. A global `npm install -g` (several deployments run this way) is
frozen at that version until someone explicitly re-installs it; nothing about
publishing a new version moves it. GH #410 is seventeen days of merged work
(`update_task(parent_task_id)`, `update_task(github_issue_id)`) that sat
unreleased because nothing said the registry had fallen behind `main`.

To actually ship a change:

1. Bump `version` in `package.json`, `npm install --package-lock-only`.
2. Commit, push, `gh release create vX.Y.Z` — `publish.yml` (Trusted
   Publisher, Node 24, no tokens) publishes to npm on the release event.
3. **Then check who is still on the old version.** A global install has no
   version spec to resolve and will not move on its own — that upgrade is a
   deliberate decision on each box, not a side effect of publishing.

The `.github/workflows/version-drift.yml` workflow runs on every push to
`main` and reports (as a non-blocking warning) when `main` has commits beyond
the published `gitHead` — so "merged but unpublished" is visible instead of
being rediscovered by whoever trips over it next.

## License

MIT - [IDEA Management LLC](https://ideamngmt.com)
