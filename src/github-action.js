// github-action.js - the logic behind action.yml. idea-base.us#499 / IDEA Base
// task #991118, found by the #496 review (F2, F3).
//
// =============================================================================
// THE TWO DEFECTS THIS REPLACES
// =============================================================================
// F2 — the old action.yml derived 30-240 "minutes" from a PR's line count and
// POSTed it to the task time-entry endpoint as a real time entry. That is exactly the
// thing idea-base.us#455 / task #990998 banned: a number nobody measured,
// written to the one field (`minutes`) the product treats as ground truth. The
// fix removes size-based time entirely rather than re-routing the guess to
// `estimated_minutes` — an estimate derived from PR line count is still a
// fabricated number dressed differently, and this action has no way to measure
// real work. It only ever marks a task done.
//
// F3 — the old action took the FIRST `#\d+` in the PR title as the IDEA Base
// task id. A PR titled "Fix #123" (a GitHub issue number, not a task id) would
// silently mark task 123 done. The fix makes `task-id` a required action input
// — set explicitly by the workflow caller — and the PR title is never parsed
// for it. `resolveTaskId` takes no title argument at all, so there is no path
// by which a title could supply one.
//
// F3 also covers the unescaped JSON splice (`-d "{\"minutes\": $MINUTES,
// \"notes\": \"PR merged: $PR_TITLE\"}"` in bash) — a title containing a `"`
// broke the request body. This file builds every body with JSON.stringify, so
// that class of defect cannot recur here.
//
// =============================================================================
// WHY THIS IS A NODE MODULE AND NOT INLINE BASH
// =============================================================================
// The acceptance criteria ask for each fix to be "proved by a test". Bash
// embedded in action.yml's `run:` block cannot be unit tested without a shell
// test harness this package does not have and should not add for one action.
// Factoring the decision logic into plain functions — resolveTaskId,
// buildMarkDoneRequest — lets `npm test` (node --test src/*.test.js) exercise
// exactly the same code the workflow runs, with no mocked shell.
//
// `run()` is the only side-effecting part: it reads env vars (what the
// composite action step sets from `github.event.pull_request.*` and the
// inputs) and performs the one HTTP call. It is intentionally thin so nearly
// everything is covered by testing the pure functions above it.

export function resolveTaskId(taskIdInput) {
  const trimmed = String(taskIdInput ?? '').trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `task-id input must be a positive integer, got: ${JSON.stringify(taskIdInput)}` };
  }
  return { ok: true, taskId: trimmed };
}

export function buildMarkDoneRequest({ apiUrl, taskId, apiKey }) {
  return {
    url: `${apiUrl}/tasks/${taskId}/status`,
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'done' }),
  };
}

export const API_URL = 'https://app.idea-base.us/api';

// run() never touches process.exitCode itself — it returns { ok, error } and
// leaves the mapping to the exit code to its one caller, run-github-action.js.
// A function under test that mutates global process state on its failure
// paths poisons every test that runs after it in the same process; returning
// a value keeps those paths testable like any other branch.
export async function run(env = process.env) {
  const prMerged = env.PR_MERGED === 'true';
  if (!prMerged) {
    console.log('PR not merged, skipping');
    return { ok: true, skipped: true };
  }

  const resolved = resolveTaskId(env.TASK_ID);
  if (!resolved.ok) {
    console.error(resolved.error);
    return { ok: false, error: resolved.error };
  }
  const { taskId } = resolved;

  const actionType = env.ACTION_TYPE || 'auto';
  if (actionType !== 'auto' && actionType !== 'mark_done') {
    const error = `Unknown action: ${actionType}. This action only marks a task done (no time logging).`;
    console.error(error);
    return { ok: false, error };
  }

  const apiKey = env.IDEA_BASE_API_KEY;
  if (!apiKey) {
    console.error('IDEA_BASE_API_KEY is required');
    return { ok: false, error: 'IDEA_BASE_API_KEY is required' };
  }

  console.log(`Marking task #${taskId} as done...`);
  const req = buildMarkDoneRequest({ apiUrl: API_URL, taskId, apiKey });
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  console.log(text);
  if (!res.ok) {
    console.error(`Request failed: ${res.status}`);
    return { ok: false, error: `Request failed: ${res.status}` };
  }

  console.log(`Done! Task #${taskId} updated.`);
  return { ok: true, taskId };
}
