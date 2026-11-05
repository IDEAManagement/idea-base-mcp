#!/usr/bin/env node
/**
 * Live integration test for idea-base-mcp — no mocks.
 *
 * Spawns a REAL MCP server process (this checkout, or a published npm
 * version via --cmd) and drives it with the real SDK Client over stdio
 * against the REAL production API (app.idea-base.us), the same way a
 * genuine caller would. This is deliberate: a mocked fetch would only prove
 * the mock, and the server's own fetch call is exactly what GH #410 found
 * broken.
 *
 * Every task this script creates is deleted in a finally block — never a
 * hardcoded fixture row left behind (same rule as docs/security-testing.md's
 * isolation discipline).
 *
 * Usage:
 *   IDEA_BASE_API_KEY=... node test/live-mcp.test.mjs
 *   IDEA_BASE_API_KEY=... node test/live-mcp.test.mjs --cmd "npx -y @idea-base/mcp-server@2.5.0"
 *   IDEA_BASE_API_KEY=... node test/live-mcp.test.mjs --cmd "npx -y @idea-base/mcp-server@latest"
 *
 * Exit code 0 = all checks passed. Non-zero = at least one failed; the
 * summary says which.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API_BASE = 'https://app.idea-base.us/api';
const API_KEY = process.env.IDEA_BASE_API_KEY;
const PROJECT_ID = Number(process.env.TEST_PROJECT_ID || 990118);

if (!API_KEY) {
  console.error('IDEA_BASE_API_KEY must be set.');
  process.exit(2);
}

function parseCmd(argv) {
  const idx = argv.indexOf('--cmd');
  const raw = idx >= 0 ? argv[idx + 1] : 'node src/index.js';
  const parts = raw.split(' ').filter(Boolean);
  return { command: parts[0], args: parts.slice(1) };
}

async function rest(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

function toolResultJson(result) {
  if (result.isError) {
    const text = result.content?.[0]?.text || 'unknown tool error';
    const err = new Error(text);
    err.isToolError = true;
    throw err;
  }
  const text = result.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch (err) {
    // As of idea-base-mcp main (post-2.6.0, #383's setup/features work), the
    // FIRST tool call of a session may have a plain-text first-use nudge
    // appended after the JSON ("\n\nThis project is not emitting..."). That
    // is fine for an LLM reading prose, but it breaks a strict parse — which
    // is exactly what this script does, so tolerate it rather than treat it
    // as a false failure: take the longest valid-JSON prefix.
    const nudgeIdx = text.indexOf('\n\n');
    if (nudgeIdx > 0) {
      try { return JSON.parse(text.slice(0, nudgeIdx)); } catch { /* fall through */ }
    }
    throw err;
  }
}

async function main() {
  const { command, args } = parseCmd(process.argv.slice(2));
  console.log(`== live-mcp.test.mjs == spawning: ${command} ${args.join(' ')}`);

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, IDEA_BASE_API_KEY: API_KEY },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'idea-base-mcp-live-test', version: '1.0.0' }, { capabilities: {} });

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
  };

  const createdTaskIds = [];

  try {
    await client.connect(transport);

    // --- tools/list: confirm schema shape (cheap, no API call) -------------
    const toolList = await client.listTools();
    const updateTaskTool = toolList.tools.find(t => t.name === 'update_task');
    const createTaskTool = toolList.tools.find(t => t.name === 'create_task');
    check(
      'tools/list: update_task advertises parent_task_id',
      !!updateTaskTool?.inputSchema?.properties?.parent_task_id,
    );
    check(
      'tools/list: update_task advertises github_issue_id',
      !!updateTaskTool?.inputSchema?.properties?.github_issue_id,
    );
    check(
      'tools/list: create_task advertises github_issue_id',
      !!createTaskTool?.inputSchema?.properties?.github_issue_id,
    );

    // --- create_task(github_issue_id) must PERSIST, not silently drop ------
    const probeIssueNumber = 410000 + Math.floor(Math.random() * 1000);
    let createdTask;
    try {
      createdTask = toolResultJson(await client.callTool({
        name: 'create_task',
        arguments: {
          project_id: PROJECT_ID,
          title: `[live-mcp.test.mjs scratch] create_task github_issue_id probe`,
          github_issue_id: probeIssueNumber,
        },
      }));
      if (createdTask?.id) createdTaskIds.push(createdTask.id);
      check(
        'create_task(github_issue_id) persists (not silently NULL)',
        String(createdTask?.github_issue_id ?? '') === String(probeIssueNumber),
        `got github_issue_id=${JSON.stringify(createdTask?.github_issue_id)}`,
      );
    } catch (err) {
      // On a server too old to even accept the field, this is the honest
      // failure mode — report it as a FAIL rather than crashing the run.
      check('create_task(github_issue_id) persists (not silently NULL)', false, err.message);
    }

    // Read back over REST — never trust the tool's own success message.
    if (createdTask?.id) {
      const readBack = await rest('GET', `/tasks/${createdTask.id}`);
      check(
        'create_task github_issue_id read-back via REST matches',
        String(readBack.json?.github_issue_id ?? '') === String(probeIssueNumber),
        `REST shows github_issue_id=${JSON.stringify(readBack.json?.github_issue_id)}`,
      );
    }

    // --- update_task(parent_task_id): re-parent end to end, with read-back -
    let parentTask, childTask;
    try {
      parentTask = toolResultJson(await client.callTool({
        name: 'create_task',
        arguments: { project_id: PROJECT_ID, title: '[live-mcp.test.mjs scratch] re-parent target (parent)' },
      }));
      createdTaskIds.push(parentTask.id);

      childTask = toolResultJson(await client.callTool({
        name: 'create_task',
        arguments: { project_id: PROJECT_ID, title: '[live-mcp.test.mjs scratch] re-parent target (child)' },
      }));
      createdTaskIds.push(childTask.id);

      const reparented = toolResultJson(await client.callTool({
        name: 'update_task',
        arguments: { task_id: childTask.id, parent_task_id: parentTask.id },
      }));
      check(
        'update_task(parent_task_id) re-parent succeeds over MCP',
        Number(reparented?.parent_task_id) === Number(parentTask.id),
        `tool returned parent_task_id=${JSON.stringify(reparented?.parent_task_id)}`,
      );

      const readBackChild = await rest('GET', `/tasks/${childTask.id}`);
      check(
        're-parent read-back via REST matches',
        Number(readBackChild.json?.parent_task_id) === Number(parentTask.id),
        `REST shows parent_task_id=${JSON.stringify(readBackChild.json?.parent_task_id)}`,
      );

      // Detach (null) must also work — the commit this test is guarding
      // against regressing specifically fixed a `null` that got dropped.
      const detached = toolResultJson(await client.callTool({
        name: 'update_task',
        arguments: { task_id: childTask.id, parent_task_id: null },
      }));
      check(
        'update_task(parent_task_id: null) detach succeeds over MCP',
        detached?.parent_task_id === null,
        `tool returned parent_task_id=${JSON.stringify(detached?.parent_task_id)}`,
      );
    } catch (err) {
      check('update_task(parent_task_id) re-parent succeeds over MCP', false, err.message);
    }

    // --- update_task(github_issue_id) set + null-unlink, with read-back ----
    if (createdTask?.id) {
      try {
        const linked = toolResultJson(await client.callTool({
          name: 'update_task',
          arguments: { task_id: createdTask.id, github_issue_id: 410 },
        }));
        check(
          'update_task(github_issue_id) sets value over MCP',
          String(linked?.github_issue_id ?? '') === '410',
          `tool returned github_issue_id=${JSON.stringify(linked?.github_issue_id)}`,
        );

        const unlinked = toolResultJson(await client.callTool({
          name: 'update_task',
          arguments: { task_id: createdTask.id, github_issue_id: null },
        }));
        check(
          'update_task(github_issue_id: null) unlinks over MCP',
          unlinked?.github_issue_id === null,
          `tool returned github_issue_id=${JSON.stringify(unlinked?.github_issue_id)}`,
        );
      } catch (err) {
        check('update_task(github_issue_id) sets value over MCP', false, err.message);
      }
    }
  } finally {
    // Cleanup — every scratch row this run created, never left behind.
    for (const id of createdTaskIds) {
      try {
        await rest('DELETE', `/tasks/${id}`);
      } catch { /* best effort */ }
    }
    try { await client.close(); } catch { /* already closed */ }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(2);
});
