# Security review — @idea-base/mcp-server

**Date:** 2026-09-09
**Scope:** `src/index.js`, `package.json`, `.github/workflows/publish.yml`
**Reviewed at:** v1.3.0 (after merging PRs #2, #3, #4)
**Threat model:** the server runs on a developer's machine, holds a live IDEA Base API
key, and takes its tool arguments from a language model. The model is *not* trusted:
arguments may be adversarial (prompt injection reaching a tool call). The API is
trusted for correctness but not for shape — it can return HTML, redirects, or very
large bodies.

Legend: **Fixed** (changed in this pass) · **Accepted** (understood, no change) ·
**N/A** (does not apply to this codebase).

## Credential handling

| Check | Result |
|---|---|
| `IDEA_BASE_API_KEY` read only from the environment, never a tool argument | **Accepted** — already true; no tool schema accepts a credential. |
| Key never logged | **Fixed** — added `redact()`, applied to every thrown/returned error string, the fatal handler, and the tool-call catch-all. The key was never deliberately logged, but a stack frame or an echoing upstream could have carried it. |
| Key never in error text or tool output | **Fixed** — upstream error strings are now capped at 300 chars and passed through `redact()` before being surfaced. |
| Clear exit when the key is missing | **Accepted** — `process.exit(1)` with an explicit message. **Fixed** additionally: the value is trimmed, so a whitespace-only key is treated as missing rather than sent as `Bearer  `. |
| Requests only over https | **Fixed** — the default base URL is an https constant; an `IDEA_BASE_API_URL` override is parsed with `new URL()` and the process exits if it is not https, is malformed, or embeds userinfo. |
| Poisoned base URL is visible | **Fixed** — a non-default host is announced once on stderr at startup (`API host overridden to <host>`), so a hijacked environment shows up in the client log instead of silently exfiltrating the key. |
| Credentialed redirect | **Fixed** — `fetch(..., { redirect: 'error' })`. The API has no legitimate redirect, and following one is how an `Authorization` header ends up on a host we did not choose. Verified against prod: all tool calls still succeed. |

## Injection / argument handling

| Check | Result |
|---|---|
| No tool argument can influence host or path prefix | **Fixed** — the base URL is fixed before any tool runs; every endpoint is built from a literal prefix plus validated segments. |
| Ids validated as positive integers before interpolation | **Fixed** — schema-driven `validateArgs()` runs in the `CallToolRequest` handler before dispatch. Any property named `id` or `*_id` declared `type: 'number'` must be a positive safe integer, so `task_id: "../../admin/users"` is rejected rather than interpolated into the path. Verified live: `Error: get_task: "task_id" must be a positive integer id`. |
| Enums validated client-side | **Fixed** — the same validator enforces every `enum` in the tool schemas. Verified live: `update_task_status {status:"bogus"}` is refused before any request is made. |
| String arguments length-capped | **Fixed** — 20 000 chars by default, 500 for `query`, 32 for date fields. |
| Unknown arguments dropped | **Fixed** — only properties declared in the tool's own `inputSchema` are forwarded; anything else is discarded, so a model cannot smuggle an undeclared field into a request body. |
| Query parameters encoded | **Fixed** — `encodeURIComponent` on every interpolated query value (defence in depth; the values are already type-checked). |
| Required arguments enforced | **Fixed** — missing required fields fail with a named error instead of producing a `/tasks/undefined` request. |

## Dangerous primitives

| Check | Result |
|---|---|
| `child_process` | **N/A** — not imported. |
| `eval` / `new Function` | **N/A** — not present. |
| Dynamic `import()` from arguments | **N/A** — all imports are static and literal. |
| Filesystem access | **N/A** — the server does no `fs` work; it is stdio + fetch only. |

## Fetch hygiene

| Check | Result |
|---|---|
| Request timeout | **Fixed** — `AbortController` with a 30 s deadline; an abort surfaces as a clean "timed out" message. Previously a hung API stalled the tool call indefinitely. |
| Guarded JSON parse | **Fixed** — the response body is only parsed when `content-type` is JSON. The IDEA Base API serves an HTML shell for some unknown paths; that body used to reach `response.json()` and throw a `SyntaxError` whose message quoted the raw markup back into the tool result. Now the failure reads `API returned 404 as text/html rather than JSON (the endpoint may not exist)` and the HTML is discarded. |
| Response size cap | **Fixed** — 5 MB, enforced both on `content-length` and while streaming, with the reader cancelled on breach. |
| No retry storms | **Accepted** — there is no retry logic anywhere in the server; one tool call is one request. |

## Output hygiene

| Check | Result |
|---|---|
| Results never echo request headers or the key | **Accepted** — results are `JSON.stringify` of the parsed API payload; headers are never serialised. Reinforced by `redact()` on the error path. |
| Compact rows by default | **Accepted** — shipped in PR #3. `list_tasks` and `search_tasks` return compact rows (a 160-char snippet in place of the full description) unless `verbose: true`. Measured against prod: `search_tasks{query:"timer"}` = 6 991 bytes for 20 rows, `list_tasks{project_id:990065}` = 4 815 bytes. |

## Supply chain

| Check | Result |
|---|---|
| `npm audit --omit=dev` | **Fixed** — was 7 findings (1 low / 3 moderate / 3 high) in `qs` and `ip-address` via `express-rate-limit`, all transitive under `@modelcontextprotocol/sdk`'s HTTP-transport dependencies, none on the stdio path this server uses. `npm audit fix --package-lock-only` resolved all 7 without moving the SDK. **Now 0 vulnerabilities.** |
| SDK pinned `~1.29.0` | **Accepted** — kept. 1.29.0 is the only 1.29.x release and no advisory targets the SDK itself, so nothing forces a bump to 1.30.0. |
| `files` allowlist | **Fixed** — was `src/` (a whole directory, so any future file there would ship silently); now the explicit `src/index.js`, `README.md`, `LICENSE`. `npm pack --dry-run` confirms exactly 4 files, 12.8 kB. |
| No secrets in the repo | **Accepted** — grep for `ib_`, `sk_`, `ghp_`, and `token` patterns finds no literal credential; `.gitignore` covers `node_modules/`, `.DS_Store`, `*.log`. No `.env` file exists or is referenced. |
| `engines.node` | **Fixed** — raised from `>=18.0.0` to `>=20.0.0`. Node 18 is end-of-life and the code relies on stable `fetch`/`AbortController`/web streams. |
| `publishConfig` | **Accepted** — `access: public` and `provenance: true` were already set. |

## Release workflow

| Check | Result |
|---|---|
| Least-privilege permissions | **Accepted** — already exactly `id-token: write` + `contents: read`, which is the minimum for an OIDC Trusted Publisher release. |
| Trigger scope | **Accepted** — `on: release: types: [published]` only. No `push`, no `workflow_dispatch`, no `pull_request_target`. |
| Node 24 | **Accepted** — required for the npm 11.5.1+ that Trusted Publishing needs. |
| Actions pinned | **Fixed** — `actions/checkout` and `actions/setup-node` moved from floating `@v4` tags to full commit SHAs, so a moved tag cannot change what runs inside a job that holds an id-token. |
| Checkout credentials | **Fixed** — added `persist-credentials: false`; the publish job never pushes, so leaving a git credential in the workspace is needless exposure. |
| Version/tag agreement | **Fixed** — a new step refuses to publish when `package.json` disagrees with the release tag, so a mistyped tag cannot ship an unintended version under the package's provenance. |
| Dependency audit in CI | **Fixed** — `npm audit --omit=dev` runs on every release, `continue-on-error: true` so a fresh transitive advisory surfaces in the log without turning a release into an outage. |

## Not in scope, noted

- `action.yml` (the composite GitHub Action for task updates) is not part of the published
  tarball and was not reviewed in depth. It passes the API key through job `env` and calls
  the API with `curl` over https, which is the expected shape. Worth a look if it is ever
  used outside this org's own repos.
- `.npmignore` still exists alongside the `files` allowlist. `files` takes precedence, so it
  is inert rather than wrong. Left alone.
