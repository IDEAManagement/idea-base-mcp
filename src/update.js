// update.js - the customer's update path. IDEA Base issue #448.
//
// =============================================================================
// THE DEFECT THIS EXISTS TO FIX, AND ITS EXACT LINE
// =============================================================================
// `install` never overwrites a heartbeat.sh that is already there. cli.js's
// `if (!local.script.present)` guards the ONLY place the script is ever
// written, so a customer who installed at v2.7.0 keeps the v2.7.0 script
// forever - and `npx @idea-base/mcp-server@latest install` answers "Nothing to
// do - already installed correctly", which is true about the registrations and
// false about the file. That silence is the bug: there was no way for a
// customer to move the installed files forward at all.
//
// Skipping an existing file is the RIGHT default for `install` and is not
// changed here. An installer that clobbers on every run is worse. What was
// missing is a second verb whose whole job is to move a file we wrote forward.
//
// =============================================================================
// WHY THE REFRESH IS DECIDED BY SHA256 AND NOT BY "IT IS DIFFERENT"
// =============================================================================
// "Different from what we ship" has two completely opposite causes: an older
// copy of OURS, which must be replaced, and an edit the CUSTOMER made, which
// must not be. This module cannot tell them apart from the bytes alone, so it
// does not guess - it compares against the list of bodies this package has ever
// shipped, recorded in assets/heartbeat.provenance.json.
//
//   on disk == shipped sha        -> current.  Nothing written. This is what
//                                   makes a second run change nothing.
//   on disk is a PAST shipped sha -> stale.    Refreshed, both shas printed.
//   on disk is absent             -> absent.   Written, same as install.
//   anything else                 -> modified. LEFT EXACTLY AS IT IS.
//
// `modified` is the load-bearing branch. The standing rule in this codebase is
// that rewriting something the customer authored is a clobber and not a merge
// (setup.js's `unguarded` reporting, cli.js's refusal on an unparseable
// settings file). An update command is not an exemption from it.
//
// =============================================================================
// WHY THE VERSION CHECK NEVER AWAITS ANYTHING ON THE TOOL PATH
// =============================================================================
// Criterion 4 is "without failing or slowing any tool call when npm cannot be
// reached". A lookup awaited inside a tool handler cannot satisfy that: even
// with a short timeout, an unreachable registry costs the customer that timeout
// on a real write, and a DNS black hole costs them the whole of it.
//
// So the lookup happens ONCE, fired at server startup and never awaited, and
// the tool path only ever reads an already-settled module variable
// synchronously. When npm is unreachable the variable is never set, nothing is
// ever said, and no tool call is a microsecond slower - there is no slow path
// to measure because there is no await.
//
// What npm is told: one unauthenticated GET for this package's `latest`
// dist-tag. No credential, no request body, no header but `Accept`, nothing
// about the customer, their project, or their data. `IDEA_BASE_UPDATE_CHECK=off`
// turns it off entirely.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// package.json is in every npm tarball regardless of the `files` list, so
// reading the version from it is safe for a published install and removes the
// chance of a second hardcoded version drifting (serverInfo already drifted to
// 1.0.0 once while the package was at 2.5.0).
export const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const PACKAGE_NAME = '@idea-base/mcp-server';
export const UPDATE_COMMAND = `npx ${PACKAGE_NAME}@latest update`;

// The dist-tag endpoint, not the full packument: the full document carries
// every version this package has ever published and grows forever, and we need
// one field out of it.
export const NPM_LATEST_URL = 'https://registry.npmjs.org/@idea-base%2Fmcp-server/latest';

export const VERSION_CHECK_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------
/**
 * Parse `2.9.0`, `v2.9.0` or `2.9.0-rc.1`. Returns null for anything else.
 *
 * Deliberately not a semver dependency. This package has exactly ONE runtime
 * dependency (the MCP SDK) and adding one so that a notice can be printed would
 * be a supply-chain surface bought for a cosmetic feature.
 */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
  };
}

/**
 * Is `candidate` a version worth telling the customer about?
 *
 * Returns FALSE on anything it cannot be sure about - an unparseable version on
 * either side, or a candidate that is a prerelease while the installed one is
 * not. A wrong nudge costs the customer a pointless upgrade of a working
 * server; staying quiet costs nothing, so every ambiguity resolves to quiet.
 */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  // Never steer anyone from a release onto a prerelease. npm's own `latest`
  // dist-tag should not point at one, but this does not depend on that.
  if (a.prerelease && !b.prerelease) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // Same triple: a release beats the prerelease of itself, and nothing else
  // does - two different prereleases of one version are not ranked here.
  if (!a.prerelease && b.prerelease) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The npm lookup
// ---------------------------------------------------------------------------
export function updateCheckDisabled(env = process.env) {
  return ['off', 'OFF', '0', 'false', 'no'].includes((env.IDEA_BASE_UPDATE_CHECK || '').trim());
}

/**
 * The latest published version, or a reason it could not be read.
 *
 * NEVER THROWS and never rejects. Every caller is either a notice nobody asked
 * for or one line of a report, and neither is worth an exception.
 */
export async function fetchLatestVersion({
  fetchImpl = fetch,
  timeoutMs = VERSION_CHECK_TIMEOUT_MS,
  env = process.env,
  url = NPM_LATEST_URL,
} = {}) {
  if (updateCheckDisabled(env)) {
    return { version: null, error: 'disabled by IDEA_BASE_UPDATE_CHECK' };
  }
  const ask = async () => {
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { version: null, error: `HTTP ${res.status}` };
      const body = await res.json();
      const version = typeof body?.version === 'string' ? body.version.trim() : null;
      if (!version || !parseVersion(version)) {
        return { version: null, error: 'the registry did not return a usable version' };
      }
      return { version, error: null };
    } catch (err) {
      // A name that does not resolve, a blocked egress, a proxy that hangs, a
      // registry answering HTML: all the same answer, which is "I do not know".
      return {
        version: null,
        error: err?.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : (err?.message || 'request failed'),
      };
    }
  };

  // THE DEADLINE IS ENFORCED HERE AND NOT ONLY BY THE ABORT SIGNAL, because the
  // signal above works only if the fetch implementation HONOURS it.
  //
  // Found while verifying #448, against a transport that accepts the connection
  // and then streams nothing: the tool path was unaffected (it never awaits
  // this), but `/idea-base:update` DOES await it, and it hung indefinitely. The
  // signal is kept because it also frees the socket; this race is what makes
  // "never hangs" a property of this function rather than a property of
  // whatever `fetchImpl` turns out to be.
  //
  // The timer is NOT unref'd, deliberately. It is cleared in the `finally`
  // below the moment the race settles, so its worst case is holding the loop for
  // `timeoutMs` - whereas an unref'd one can leave the loop empty while the
  // abandoned request is still pending, which is a different and worse kind of
  // surprise (it is what made node:test abandon the rest of this suite while
  // this was being written).
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ version: null, error: `no answer within ${timeoutMs}ms` }), timeoutMs);
  });
  try {
    return await Promise.race([ask(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The background check. Started once; read synchronously forever after.
// ---------------------------------------------------------------------------
let latestSeen = null;
let checkStarted = false;

/**
 * Fire the lookup and return immediately.
 *
 * The returned promise is for tests only. Production callers must NOT await it,
 * and it is built so an unhandled rejection is impossible - an un-awaited
 * promise that rejects terminates the process on Node 20 by default, which
 * would turn a cosmetic notice into a server that will not start.
 */
export function startVersionCheck(opts = {}) {
  if (checkStarted) return Promise.resolve(latestSeen);
  checkStarted = true;
  return fetchLatestVersion(opts)
    .then((r) => { if (r.version) latestSeen = r.version; return latestSeen; })
    .catch(() => latestSeen);
}

/** The version the background check settled on, or null. Synchronous, always. */
export function latestKnownVersion() {
  return latestSeen;
}

/** Test seam. Production never needs to un-ring this bell. */
export function __resetVersionCheck() {
  latestSeen = null;
  checkStarted = false;
}

/**
 * The one-line notice, or '' when there is nothing truthful to say.
 *
 * Pure, synchronous and total: '' covers "npm was never reached", "we are
 * current", and "we are AHEAD of the registry" - which is what a maintainer
 * running an unpublished build sees, and is not something to nag them about.
 */
export function updateNoticeText({ installed = PACKAGE_VERSION, latest = latestKnownVersion() } = {}) {
  if (!latest || !isNewer(latest, installed)) return '';
  return `\n\nIDEA Base MCP ${latest} is available (this session is running ${installed}). `
    + `Update with:  ${UPDATE_COMMAND}  - then restart this session to load it.`;
}

// ---------------------------------------------------------------------------
// The installed-script decision
// ---------------------------------------------------------------------------
export const SCRIPT_STATE = {
  ABSENT: 'absent',
  CURRENT: 'current',
  STALE: 'stale',
  MODIFIED: 'modified',
};

export const PROVENANCE_REL = 'assets/heartbeat.provenance.json';

/**
 * Read the provenance manifest that ships beside the asset.
 *
 * `known_shas` is the list of every heartbeat.sh body this package has ever
 * published, newest first. It is what makes "an older copy of ours" a decidable
 * question rather than a guess, and it must be APPENDED to - never rewritten -
 * when the asset is re-vendored, because a customer sitting on any previously
 * published version is the one this list exists for.
 */
export function readProvenance({ fs = { readFileSync }, path = null } = {}) {
  const target = path || fileURLToPath(new URL(`./${PROVENANCE_REL}`, import.meta.url));
  try {
    const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
    const listed = Array.isArray(manifest.known_shas)
      ? manifest.known_shas.filter((s) => typeof s === 'string')
      : [];
    return {
      path: target,
      sha256: typeof manifest.sha256 === 'string' ? manifest.sha256 : null,
      // The current sha is always a member, whether or not it was listed.
      knownShas: Array.from(new Set([manifest.sha256, ...listed].filter(Boolean))),
      manifest,
      error: null,
    };
  } catch (err) {
    return { path: target, sha256: null, knownShas: [], manifest: null, error: err?.message || 'unreadable' };
  }
}

/**
 * What should happen to the installed heartbeat.sh. PURE. Writes nothing.
 *
 * Returns `{ state, refresh, detail }`. The caller writes if and only if
 * `refresh` is true, which is why "a second run changes nothing" and "a
 * customer's edit survives" are ordinary assertions rather than claims.
 */
export function planScriptRefresh({ installedSha = null, shippedSha = null, knownShas = [] } = {}) {
  const known = new Set([shippedSha, ...knownShas].filter(Boolean));
  const short = (s) => (s ? s.slice(0, 12) : '(none)');

  if (!shippedSha) {
    // A build that cannot say what it ships has no basis for calling anything
    // stale, so it touches nothing. Failing closed here costs a stale script;
    // failing open costs a customer's file.
    return {
      state: SCRIPT_STATE.MODIFIED,
      refresh: false,
      detail: 'this build cannot say what it ships (the provenance manifest is unreadable), so your copy is left alone',
    };
  }
  if (!installedSha) {
    return {
      state: SCRIPT_STATE.ABSENT,
      refresh: true,
      detail: `not installed here - writing the packaged copy (${short(shippedSha)})`,
    };
  }
  if (installedSha === shippedSha) {
    return {
      state: SCRIPT_STATE.CURRENT,
      refresh: false,
      detail: `already the current version (${short(shippedSha)}) - left byte-identical`,
    };
  }
  if (known.has(installedSha)) {
    return {
      state: SCRIPT_STATE.STALE,
      refresh: true,
      detail: `an older version this package shipped (${short(installedSha)}) - refreshing to ${short(shippedSha)}`,
    };
  }
  return {
    state: SCRIPT_STATE.MODIFIED,
    refresh: false,
    detail: `does not match any version this package has shipped (yours ${short(installedSha)}, ours ${short(shippedSha)}), `
      + 'so it reads as your own edit and is LEFT EXACTLY AS IT IS. '
      + 'To take ours instead, move your copy aside and run this again',
  };
}
