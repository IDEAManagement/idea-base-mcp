---
name: track-the-work
description: Keep IDEA Base true to the work as it happens — find or create the task before starting, log real time against it, record what was decided, and leave enough context that a cold session can resume. Use whenever doing development work on a project tracked in IDEA Base.
---

# Track the work

Wiring up the tools is not the same as forming the habit. This skill is the habit.

The point of IDEA Base is that the board reflects what was actually built, without anyone
remembering to update it. That only holds if the work is recorded as it happens rather than
reconstructed on Friday from memory.

## Before starting

Find the task. `search_tasks` or `list_tasks` on the project. If none exists, `create_task`
before writing code — a task created afterwards to explain a commit is bookkeeping, not
tracking, and the estimate is worthless because you already know the answer.

Move it to in progress. Someone looking at the board should be able to tell what is being
worked on right now without asking.

## While working

Record decisions where they will be found again. Use `add_work_note` for reasoning that
matters later — why an approach was rejected, what turned out to be harder than it looked,
what a test proved. Use `add_comment` for anything the client should see. These are different
audiences and mixing them is how an internal aside ends up in front of a customer.

Do not log a comment for every file touched. A note nobody reads is noise, and noise is what
makes people stop trusting the record.

## When finishing

Log the real time with `log_time` or `quick_log`. The actual figure, not a tidy one. The value
of the estimate-versus-actual gap comes entirely from it being honest; rounding it to look
competent destroys the only number that could improve the next estimate.

Set the status. If it is genuinely done, say so. If it merely looks done — the code runs but
was never exercised against a real case — say that instead, in the note. The difference between
finished and appears-finished is the thing a tracker is for.

## Before stopping

Leave the next session a way in. `set_resume_context` with what state the work is in, what was
just tried, and what the next concrete step is. A cold session that has to rediscover the
problem will usually solve it differently, and the inconsistency shows up later as a bug.

## What not to do

Never invent a time figure, a status, or a completion. An incorrect record is worse than an
absent one, because absence is obvious and a wrong entry is believed.

Never mark a task done to close a loop. The board's only value is that it can be trusted; one
optimistic completion costs more than the tidiness gains.
