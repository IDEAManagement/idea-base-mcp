// The time tools say MEASURED time, and point estimates at estimated_minutes.
// idea-base.us#455 / IDEA Base task #990998.
//
//   npm test        (node --test src/*.test.js)
//
// WHY A TEST OVER PROSE. Criterion 4 of #455 is "the log_time and quick_log
// descriptions say measured time only, and that estimates go in
// estimated_minutes". A description is the ENTIRE interface a model sees before
// it decides what to pass, so in this package it is behaviour, not
// documentation — and before this file there was no test of any kind over
// `tools[]` or `toolHandlers`: not one assertion on a description, a schema, or
// the endpoint a handler calls. The thing that actually caused the reported
// defect was a description ("Log time spent on a task") sitting next to time
// estimation guidance, and nothing in CI could have noticed it change back.
//
// HOW IT READS THE TOOLS. src/index.js calls main() at import, which would start
// a stdio server, and it exports nothing. So the `tools` array literal is
// sliced out of the source and evaluated. It is a pure literal, so that is the
// shipped value rather than a copy of it.
//
// Every assertion is also run against the PRE-CHANGE literal, resolved by
// CONTENT rather than pinned to a ref: a control pinned to HEAD works on the
// branch and then silently grades the new code twice once it merges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const repo = new URL('../', import.meta.url);
const INDEX = 'src/index.js';
const SENTINEL = 'Log MEASURED time on a task';

function toolsFrom(src, label) {
  const start = src.indexOf('const tools = [');
  assert.ok(start > -1, `${label}: "const tools = [" not found — this extractor is stale`);
  const open = src.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    // The literal contains no strings holding unbalanced brackets today; if that
    // ever changes this balance walk breaks LOUDLY (no match / a parse error)
    // rather than returning a truncated list that silently asserts less.
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > -1, `${label}: could not balance the tools array`);
  const arr = new Function(`return ${src.slice(open, end + 1)};`)();
  assert.ok(Array.isArray(arr) && arr.length > 10, `${label}: extracted ${arr?.length} tools, expected the full set`);
  return new Map(arr.map((t) => [t.name, t]));
}

// Resolve "the code before this change" by CONTENT, and distinguish THREE
// outcomes rather than two. The distinction is the whole point and it was paid
// for immediately: the first CI run of this file died because
// `actions/checkout` clones with `fetch-depth: 1`, so there was exactly one
// commit to walk and no pre-change version to find.
//
//   found      -> run the control
//   NO HISTORY -> cannot ask. Report it and skip the control assertions.
//   history, but every commit already has the sentinel -> THROW. That is
//                "asked and got an answer that means this is not a control",
//                which must never pass quietly.
//
// Collapsing the middle case into the third makes the suite unrunnable wherever
// history is shallow (CI, a tarball, an export). Collapsing it into the first
// is worse: the control would silently grade the new code twice. This repo's own
// heartbeat-doctor encodes the same three-way as exit 0 / 1 / 2 for the same
// reason — "could not ask" is not a verdict.
function resolveBase(path, sentinel) {
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });

  let revs;
  try {
    revs = git('log', '-100', '--format=%H', '--', path).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return { ref: null, reason: `git log failed: ${e.message}` };
  }

  // A shallow clone is a real, detectable state — say so rather than inferring
  // it from "I found nothing".
  let shallow = false;
  try { shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true'; } catch { /* old git */ }

  for (const rev of revs) {
    let blob;
    try { blob = git('show', `${rev}:${path}`); } catch { continue; }
    if (!blob.includes(sentinel)) return { ref: rev, reason: null };
  }

  if (shallow || revs.length < 2) {
    return {
      ref: null,
      reason: `no pre-change version reachable: ${revs.length} commit(s) touching ${path}` +
              `${shallow ? ', and this is a shallow clone' : ''}. The control assertions are SKIPPED, ` +
              'not passed. Give the checkout full history (fetch-depth: 0) to run them.'
    };
  }

  throw new Error(
    `every one of the ${revs.length} commits touching ${path} already contains ` +
    `${JSON.stringify(sentinel)}, in a repository with full history. A control that cannot find ` +
    'the pre-change code must fail rather than grade the new code twice — check the sentinel.'
  );
}

const NOW = toolsFrom(readFileSync(new URL(INDEX, repo), 'utf8'), 'working tree');

const { ref: BASE_REF, reason: NO_BASE } = resolveBase(INDEX, SENTINEL);
const BEFORE = BASE_REF
  ? toolsFrom(execFileSync('git', ['show', `${BASE_REF}:${INDEX}`], { cwd: repo, encoding: 'utf8' }),
              `base ${BASE_REF.slice(0, 8)}`)
  : null;

if (NO_BASE) console.error(`# CONTROL SKIPPED: ${NO_BASE}`);

// Every assertion about the OLD literal goes through this, so a skipped control
// is visibly skipped in the output of each test that wanted it, rather than the
// test quietly asserting one thing less than it says it does.
// For a test that asserts BOTH the new wording and the old: the new half always
// runs, and the old half runs only when the control exists. `was(...)` makes
// that explicit at each call site rather than hiding it in a conditional.
function was(fn) {
  if (BEFORE) fn(BEFORE);
}

function control(name, fn) {
  test(name, (t) => {
    if (!BEFORE) return t.skip(`no pre-change literal available — ${NO_BASE}`);
    return fn();
  });
}

const desc = (m, name) => String(m.get(name)?.description || '');
const prop = (m, name, key) => String(m.get(name)?.inputSchema?.properties?.[key]?.description || '');

control('sanity: the control really is the pre-change literal', () => {
  assert.doesNotMatch(desc(BEFORE, 'log_time'), /MEASURED/,
    `the base at ${BASE_REF.slice(0, 8)} already says MEASURED, so it is not a control`);
});

test('crit4: log_time says MEASURED time, and not the old "time spent" framing', () => {
  const d = desc(NOW, 'log_time');
  assert.match(d, /MEASURED time/);
  assert.doesNotMatch(d, /^Log time spent on a task\./,
    'the exact sentence the reporting session cited as misleading must be gone');

  // the control: it said precisely that, and said nothing about measurement
  was((B) => {
    assert.match(desc(B, 'log_time'), /^Log time spent on a task\./);
    assert.doesNotMatch(desc(B, 'log_time'), /estimated_minutes/);
  });
});

test('crit4: log_time sends estimates to estimated_minutes', () => {
  assert.match(desc(NOW, 'log_time'), /estimated_minutes/);
  assert.match(desc(NOW, 'log_time'), /never an estimate|not an estimate|NOT here/i);
});

test('crit4: log_time.minutes is described as measured and positive', () => {
  const p = prop(NOW, 'log_time', 'minutes');
  assert.match(p, /MEASURED/);
  assert.match(p, /positive/i);
  assert.match(p, /estimated_minutes/);
  // control: "Number of minutes to log" — no provenance, no sign constraint
  was((B) => assert.doesNotMatch(prop(B, 'log_time', 'minutes'), /MEASURED|estimate/i));
});

test('crit4: log_time points the caller at start_working / stop_working instead', () => {
  assert.match(desc(NOW, 'log_time'), /stop_working/);
  was((B) => assert.doesNotMatch(desc(B, 'log_time'), /stop_working/));
});

test('crit4: log_time states both refusals, so a model is not surprised by them', () => {
  const d = desc(NOW, 'log_time');
  assert.match(d, /REFUSED|refused/);
  assert.match(d, /Negative minutes/i);
});

test('crit4: quick_log says measured, and separates the estimate', () => {
  const d = desc(NOW, 'quick_log');
  assert.match(d, /MEASURED/);
  assert.match(d, /estimated_minutes/);
  was((B) => assert.doesNotMatch(desc(B, 'quick_log'), /MEASURED|estimated_minutes/));
});

test('crit4: quick_log GAINS an estimated_minutes argument, so its own code can stop conflating them', () => {
  const props = NOW.get('quick_log').inputSchema.properties;
  assert.ok(props.estimated_minutes, 'quick_log must accept an estimate separately from the actual');
  assert.equal(props.estimated_minutes.type, 'number');
  assert.match(prop(NOW, 'quick_log', 'minutes'), /MEASURED/);

  // The defect in the control is in its code, not only its text: it hardcoded
  // estimated_minutes to `minutes`. Assert the property simply did not exist.
  was((B) => assert.equal(B.get('quick_log').inputSchema.properties.estimated_minutes, undefined));
});

test('crit1: stop_working says IT logs the time, and that the caller types no number', () => {
  const d = desc(NOW, 'stop_working');
  assert.match(d, /THIS IS WHAT LOGS YOUR TIME/);
  assert.match(d, /no number/i);
  assert.match(d, /Do NOT call log_time afterwards/);
  assert.match(d, /rounds to zero/i, 'the sub-minute case must be stated, or it reads as a lost measurement');

  was((B) => assert.doesNotMatch(desc(B, 'stop_working'), /log_time/,
    'the control never mentioned the ledger at all — it reported a duration and stopped'));
});

test('crit1: start_working names stop_working as the thing that logs', () => {
  assert.match(desc(NOW, 'start_working'), /LOGS the time/);
});

test('no time-related tool description invites typing an estimate', () => {
  for (const name of ['log_time', 'quick_log', 'start_working', 'stop_working', 'pause_working', 'resume_working']) {
    const d = desc(NOW, name);
    assert.ok(d.length > 0, `${name} must exist and carry a description`);
    assert.doesNotMatch(d, /\bestimate(d)? (?:how long|the time)\b/i, `${name} must not ask for an estimate`);
  }
});

test('the estimate-bearing tools still describe estimated_minutes as an estimate', () => {
  // The other half of criterion 4: having pushed estimates out of logging, the
  // field they were pushed INTO has to still be the right home for them.
  assert.match(prop(NOW, 'create_task', 'estimated_minutes'), /[Ee]stimate/);
  assert.match(prop(NOW, 'update_task', 'estimated_minutes'), /estimate/i);
});
