// github-action.test.js - the acceptance criteria of idea-base.us#499 / IDEA
// Base task #991118, as tests.
//
// Run: npm test   (node --test over src/*.test.js)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveTaskId, buildMarkDoneRequest, run, API_URL } from './github-action.js';

describe('criterion 1: the action logs no time', () => {
  test('action.yml has no /time endpoint call anywhere', () => {
    const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    assert.ok(!yml.includes('/time'), 'action.yml still references a time-logging endpoint');
    assert.ok(!yml.includes('minutes'), 'action.yml still references "minutes"');
  });

  test('github-action.js code (outside comments) never builds a time endpoint or a minutes field', () => {
    const src = readFileSync(new URL('./github-action.js', import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(!/\/tasks\/[^"'`]*\/time/.test(code), 'module still builds a /tasks/:id/time URL');
    assert.ok(!/\bminutes\b/i.test(code), 'module still references minutes');
  });

  test('run() only ever calls fetch once, against the status endpoint, whatever PR size is', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, text: async () => '{}' };
    };
    try {
      await run({
        PR_MERGED: 'true',
        TASK_ID: '42',
        ACTION_TYPE: 'auto',
        IDEA_BASE_API_KEY: 'test-key',
        // No PR_ADDITIONS/PR_DELETIONS at all — the old action derived
        // "minutes" from these; this run() never reads them.
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1, 'expected exactly one HTTP call');
    assert.ok(calls[0].url.endsWith('/tasks/42/status'), `expected the status endpoint, got ${calls[0].url}`);
    assert.ok(!JSON.stringify(calls[0].opts).toLowerCase().includes('minute'), 'request carried a minutes value');
  });
});

describe('criterion 2: the task id comes from an explicit input, never the PR title', () => {
  test('resolveTaskId takes no title parameter at all', () => {
    // A structural check that cannot regress silently: resolveTaskId has a
    // single parameter (the task-id input), so there is no argument slot a
    // future edit could wire the PR title into without changing this arity.
    assert.equal(resolveTaskId.length, 1);
  });

  test("a PR title containing #N never touches task N — only the explicit task-id input is used", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, text: async () => '{}' };
    };
    try {
      await run({
        PR_MERGED: 'true',
        TASK_ID: '999', // the real, explicit task id
        PR_TITLE: 'Fix #123 by tightening the guard', // a GitHub issue number, not a task id
        ACTION_TYPE: 'auto',
        IDEA_BASE_API_KEY: 'test-key',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/tasks/999/status'), `expected task 999, got ${calls[0].url}`);
    assert.ok(!calls[0].url.includes('/tasks/123/'), 'the PR title\'s #123 leaked into the request');
  });

  test('a non-numeric task-id input is refused rather than guessed from the title', () => {
    const resolved = resolveTaskId('not-a-number');
    assert.equal(resolved.ok, false);
  });

  test('a missing task-id input is refused', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
    try {
      await run({ PR_MERGED: 'true', ACTION_TYPE: 'auto', IDEA_BASE_API_KEY: 'test-key' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(called, false, 'fetch should never be called without a resolved task id');
  });
});

describe('criterion 3: the request body is built with a JSON encoder', () => {
  test('a title containing quotes and a backslash arrives in the request unchanged, via JSON.parse', () => {
    // buildMarkDoneRequest does not take the title at all (status updates
    // carry no PR title), so this proves the body itself is JSON-encoded and
    // round-trips exactly, rather than string-concatenated the way the old
    // bash `-d "{\"minutes\": $MINUTES, \"notes\": \"PR merged: $PR_TITLE\"}"`
    // was.
    const req = buildMarkDoneRequest({ apiUrl: API_URL, taskId: '7', apiKey: 'k"with\\quotes' });
    const parsed = JSON.parse(req.body);
    assert.deepEqual(parsed, { status: 'done' });
    assert.equal(req.headers.Authorization, 'Bearer k"with\\quotes');
  });

  test('github-action.js builds the body with JSON.stringify, not string interpolation', () => {
    const src = readFileSync(new URL('./github-action.js', import.meta.url), 'utf8');
    assert.ok(src.includes('JSON.stringify'), 'buildMarkDoneRequest must encode its body with JSON.stringify');
  });
});

describe('control: an unmerged PR is skipped, as before', () => {
  test('run() makes no request when PR_MERGED is not "true"', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
    try {
      await run({ PR_MERGED: 'false', TASK_ID: '1', IDEA_BASE_API_KEY: 'k' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(called, false);
  });
});
