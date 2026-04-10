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
| `update_project` | Update project name, description, or status |

### Tasks

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks for a project (filter by status) |
| `get_task` | Get task details, acceptance criteria, and time entries |
| `create_task` | Create a task with title, description, estimate |
| `update_task` | Update task details |
| `update_task_status` | Change task status (todo/in_progress/done) |
| `search_tasks` | Search tasks across all projects |
| `quick_log` | Create + complete + log time in one step |

### Time Tracking

| Tool | Description |
|------|-------------|
| `log_time` | Log time against a task with notes |
| `start_working` | Mark yourself as actively working on a task |
| `stop_working` | Stop active work on a task |

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
