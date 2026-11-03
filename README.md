# @idea-base/mcp-server

MCP (Model Context Protocol) server for [IDEA Base](https://idea-base.us) — AI-powered project management. Manage projects, tasks, and time tracking directly from Claude Code, Cursor, or any MCP-compatible AI tool.

## Quick Setup

### 1. Get your API key

Sign in to [IDEA Base](https://app.idea-base.us), go to **Settings > API Keys**, and create a key.

### 2. Add to your MCP config

**Claude Code** — project scope, `.mcp.json` in the repo root (shared with the
team; put the key in your environment rather than in this file if it is
committed):

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

**Claude Desktop** (`claude_desktop_config.json`) takes the same `mcpServers`
block.

Or via the Claude Code CLI — note `--env` goes **before** the `--`, not after
it. Everything after `--` is passed to the server as argv, and this server does
not read argv at all, so a key placed there never arrives and startup fails with
`IDEA_BASE_API_KEY environment variable is required`:

```bash
claude mcp add idea-base --env IDEA_BASE_API_KEY=ib_your_api_key_here \
  -- npx -y @idea-base/mcp-server
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

Tracker text in these results is fenced as data, and item lists are capped with
the true total printed.

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `IDEA_BASE_API_KEY` | Yes | Your API key from Settings > API Keys |
| `IDEA_BASE_API_URL` | No | Custom API URL (default: `https://app.idea-base.us/api`) |
| `IDEA_BASE_AGENT_ID` | No | The agent identity this server declares as the actor on every request, via `X-On-Behalf-Of` (default: `claude_ai`). Attribution only — it carries no permission, and the identity must already exist server-side as a non-human user or every call fails closed with a 403. |
| `IDEA_BASE_HEARTBEAT` | No | Set to `off` (or `0`/`false`/`no`) to disable session heartbeats entirely. See below. |
| `IDEA_BASE_HEARTBEAT_INTERVAL_SECONDS` | No | Heartbeat interval (default `60`, floor `10`). |

## Session Heartbeats

Once you call `start_working`, this server reports that the session is alive —
so the agent shows up on the IDEA Base dashboard's live agent board, and
disappears from it when the session ends.

**There is nothing to install and nothing to configure.** No hook to register,
no `settings.json` to edit, no `postinstall`. If you have this server, you have
this.

**What it sends**, to `POST /api/heartbeat`, authenticated with the same API key
and attributed to the same `IDEA_BASE_AGENT_ID` as every other call:

| When | Event |
|---|---|
| `start_working` | `start` |
| every `IDEA_BASE_HEARTBEAT_INTERVAL_SECONDS` while a task is active | `tool` |
| any tool call, at most once per interval | `tool` |
| `stop_working`, or the client's pipe closing | `stop` |

The payload is the event, the task id, the session id and the project directory
name. Nothing else — no tool names, no arguments, no file contents, no code.

**What it writes to your disk: nothing.** This server has no `fs` access at all
(see [SECURITY-REVIEW.md](SECURITY-REVIEW.md)) and heartbeats did not change
that. The session id is `CLAUDE_CODE_SESSION_ID` when the client provides one,
otherwise a random `mcp-<uuid>` generated in memory for the life of the process.

**To turn it off:**

```json
{
  "mcpServers": {
    "idea-base": {
      "command": "npx",
      "args": ["-y", "@idea-base/mcp-server"],
      "env": {
        "IDEA_BASE_API_KEY": "...",
        "IDEA_BASE_HEARTBEAT": "off"
      }
    }
  }
}
```

The server prints `IDEA Base heartbeats: DISABLED` to stderr at startup so the
setting is confirmable rather than assumed. Every other tool keeps working.

A heartbeat can never fail a tool call: it is never awaited, every error is
swallowed, and the interval timer is `unref`'d so it cannot keep the process
alive after the client has gone. If the server *is* emitting but the endpoint is
refusing the rows, it says so once on stderr with the reason — which is the
point of emitting from here rather than from a detached background request.

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
```

## License

MIT - [IDEA Management LLC](https://ideamngmt.com)
