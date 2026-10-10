interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Prozorro.Sale MCP — Ukraine's state and municipal asset sales and leases (keyless).
 *
 * Separate system from ProZorro procurement (mcps/prozorro): Prozorro.Sale runs
 * the auctions where the state, municipalities, bankruptcy managers and state
 * companies SELL or LEASE things — land-lease rights, municipal premises,
 * privatisation lots, bankruptcy estates, timber, railway cargo capacity.
 *
 * Upstream: the public CBD API at https://procedure.prozorro.sale/api (keyless,
 * the same API the prozorro.sale site and the accredited e-platforms read).
 * Endpoints this pack uses, all verified live 2026-10-09:
 *
 *   POST /api/search/procedures                 filtered search (body below)
 *   GET  /api/search/{_id}                      one procedure by internal id
 *   GET  /api/search/byAuctionId/{auctionId}    one procedure by its public id
 *   GET  /api/search/byDateModified/{iso}?limit incremental feed, ascending
 *   GET  /api/registry/assets/{_id}             registry object (asset etc.)
 *
 * The search body is NOT documented as free-form keys. It accepts exactly
 * {limit, page, sort, filters}; anything else is a 422 ("x is not allowed
 * key"). `filters` is a list of {field, operator, value}; the operator set is
 * eq|ne, gt|gte|lt|lte, in|nin, full_text_search|text_search|match, and the
 * field must be on an allowlist (status, sellingMethod, metaInfo.directions,
 * metaInfo.categories, extended_filters.items_address.region|locality,
 * full_text_search, dateModified, value.amount, previousAuctionId,
 * relatedEntities.objectId, …). The upstream answers a bad field with the full
 * allowlist in its 422 body — read that before guessing.
 *
 * TRAP: `metaInfo.directions` is the family filter, and it does not always
 * match the sellingMethod prefix — smallPrivatization-* procedures carry the
 * direction `sellOut`, basicSell-* carry `otherAssets`. Filtering directions by
 * the sellingMethod prefix returns a clean zero.
 *
 * Protected records: every procedure carries `_protected` and `_protect_level`
 * from upstream; they are passed through verbatim (as `protected` /
 * `protect_level`). Upstream already masks bidder addresses, phones and emails
 * with "*****"; this pack additionally drops contact-person names, returns
 * only the party name and its register code, and drops the number when the
 * scheme is UA-IPN (an individual's personal tax number).
 *
 * Text is Ukrainian (uk_UA) as published; field labels are English.
 */


const UA = 'pipeworx-mcp-prozorro-sale/1.0 (+https://pipeworx.io)';
const BASE = 'https://procedure.prozorro.sale/api';
const WEB = 'https://prozorro.sale/auction';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Prozorro.Sale');
}

type Json = Record<string, any>;

/** GET a JSON document; null on 404, throw on any other failure. */
async function getJson(path: string): Promise<any | null> {
  const res = await pwFetch(`${BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await httpError(res, 'Prozorro.Sale');
  return parseJson<any>(res, 'Prozorro.Sale');
}

interface Filter { field: string; operator: string; value: unknown }

async function searchProcedures(filters: Filter[], limit: number, page = 1): Promise<Json> {
  const body: Json = { limit, page, sort: [{ field: 'dateModified', direction: 'desc' }] };
  if (filters.length) body.filters = filters;
  const res = await pwFetch(`${BASE}/search/procedures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 204 = no body at all; the endpoint uses it for an empty GET, never for a
  // valid POST, so treat it as a failure rather than as zero results.
  if (!res.ok || res.status === 204) throw await httpError(res, 'Prozorro.Sale search');
  const data = await parseJson<Json>(res, 'Prozorro.Sale search');
  if (!Array.isArray(data.payload)) {
    throw new Error('Prozorro.Sale search returned a response with no payload array');
  }
  return data;
}

const uk = (v: any): string | null => {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return v.uk_UA ?? v.en_US ?? null;
};

const money = (v: any) => (v && v.amount != null ? { amount: v.amount, currency: v.currency ?? 'UAH' } : null);

const org = (o: any) =>
  o
    ? {
        name: uk(o.name) ?? uk(o.identifier?.legalName),
        identifier_scheme: o.identifier?.scheme ?? null,
        // UA-IPN is an individual's personal tax number; keep the scheme so the
        // caller knows a person is the party, drop the number itself.
        identifier: o.identifier?.scheme === 'UA-IPN' ? null : o.identifier?.id ?? null,
      }
    : null;

function region(p: Json): string | null {
  for (const it of p.items ?? []) {
    const r = uk(it?.address?.region);
    if (r) return r;
  }
  return null;
}

function locality(p: Json): string | null {
  for (const it of p.items ?? []) {
    const r = uk(it?.address?.locality);
    if (r) return r;
  }
  return null;
}

function summary(p: Json) {
  return {
    id: p._id,
    auction_id: p.auctionId ?? null,
    previous_auction_id: p.previousAuctionId ?? null,
    title: uk(p.title),
    status: p.status,
    selling_method: p.sellingMethod,
    directions: p.metaInfo?.directions ?? [],
    categories: p.metaInfo?.categories ?? [],
    ownership_type: p.ownershipType ?? null,
    region: region(p),
    locality: locality(p),
    start_value: money(p.value),
    lease_duration: p.leaseDuration ?? null,
    tender_attempts: p.tenderAttempts ?? null,
    selling_entity: org(p.sellingEntity),
    date_published: p.datePublished ?? null,
    date_modified: p.dateModified ?? null,
    tender_period_end: p.tenderPeriod?.endDate ?? null,
    auction_start: p.auctionPeriod?.startDate ?? null,
    bids_count: Array.isArray(p.bids) ? p.bids.length : 0,
    protected: p._protected ?? null,
    protect_level: p._protect_level ?? null,
    url: p.auctionId ? `${WEB}/${p.auctionId}` : null,
  };
}

function detail(p: Json) {
  return {
    ...summary(p),
    description: uk(p.description),
    minimal_step: money(p.minimalStep),
    guarantee: money(p.guarantee),
    registration_fee: money(p.registrationFee),
    tender_period: p.tenderPeriod ?? null,
    auction_period: p.auctionPeriod ?? null,
    asset_holder: org(p.assetHolder),
    platform: p.owner ?? null,
    items: (p.items ?? []).map((it: Json) => ({
      description: uk(it.description),
      classification: it.classification ? { scheme: it.classification.scheme, id: it.classification.id, description: uk(it.classification.description) } : null,
      additional_classifications: (it.additionalClassifications ?? []).map((c: Json) => ({ scheme: c.scheme, id: c.id, description: uk(c.description) })),
      quantity: it.quantity ?? null,
      unit: uk(it.unit?.name) ?? it.unit?.code ?? null,
      address: [uk(it.address?.streetAddress), uk(it.address?.locality), uk(it.address?.region)].filter(Boolean).join(', ') || null,
      cadastral_number: it.itemProps?.cadastralNumber ?? null,
      land_area_ha: it.itemProps?.landArea ?? null,
      total_object_area_m2: it.itemProps?.totalObjectArea ?? null,
    })),
    bids: (p.bids ?? []).map((b: Json) => ({
      id: b.id,
      status: b.status ?? null,
      value: money(b.value),
      initial_value: b.initialValueAmount ?? null,
      bidders: (b.bidders ?? []).map(org),
      date_published: b.datePublished ?? null,
    })),
    awards: (p.awards ?? []).map((a: Json) => ({
      id: a.id,
      status: a.status ?? null,
      bid_id: a.bidId ?? null,
      value: money(a.value),
      buyers: (a.buyers ?? []).map(org),
      date_published: a.datePublished ?? null,
    })),
    contracts: (p.contracts ?? []).map((c: Json) => ({
      id: c.id,
      status: c.status ?? null,
      award_id: c.awardId ?? null,
      contract_number: c.contractNumber ?? null,
      value: money(c.value),
      total_value: money(c.contractTotalValue),
      buyers: (c.buyers ?? []).map(org),
      date_signed: c.dateSigned ?? null,
      contract_time: c.contractTime ?? null,
    })),
    cancellations: (p.cancellations ?? []).map((c: Json) => ({ reason: uk(c.reason), status: c.status ?? null, date: c.datePublished ?? null })),
    related_entities: (p.relatedEntities ?? []).map((r: Json) => ({ type: r.type, object_id: r.objectId ?? null, registry_id: r._id ?? null, api_url: r.url ? `https://procedure.prozorro.sale${r.url}` : null })),
    documents_count: Array.isArray(p.documents) ? p.documents.length : 0,
  };
}

const HEX24 = /^[0-9a-f]{24}$/i;

async function fetchProcedure(ref: string): Promise<Json | null> {
  const id = ref.trim();
  if (HEX24.test(id)) return getJson(`/search/${id}`);
  return getJson(`/search/byAuctionId/${encodeURIComponent(id)}`);
}

const dataAsOf = () => new Date().toISOString();

const CHAIN_MAX = 10;

async function repeatChain(p: Json) {
  // Backward: follow previousAuctionId. Forward: a later repeat names this one
  // as its previousAuctionId.
  const back: Json[] = [];
  let prev = p.previousAuctionId;
  const seen = new Set<string>([p.auctionId]);
  while (prev && !seen.has(prev) && back.length < CHAIN_MAX) {
    seen.add(prev);
    const q = await getJson(`/search/byAuctionId/${encodeURIComponent(prev)}`);
    if (!q) {
      back.push({ auction_id: prev, found: false });
      break;
    }
    back.push(chainRow(q));
    prev = q.previousAuctionId;
  }
  const fwd: Json[] = [];
  let cur = p.auctionId;
  while (cur && fwd.length < CHAIN_MAX) {
    const r = await searchProcedures([{ field: 'previousAuctionId', operator: 'eq', value: cur }], 5);
    const next = r.payload[0];
    if (!next || seen.has(next.auctionId)) break;
    seen.add(next.auctionId);
    fwd.push(chainRow(next));
    cur = next.auctionId;
  }
  return { earlier: back.reverse(), later: fwd };
}

function chainRow(q: Json) {
  const award = (q.awards ?? []).find((a: Json) => a.status === 'active') ?? (q.awards ?? [])[0];
  return {
    auction_id: q.auctionId,
    id: q._id,
    status: q.status,
    selling_method: q.sellingMethod,
    start_value: money(q.value),
    bids_count: Array.isArray(q.bids) ? q.bids.length : 0,
    award_value: award ? money(award.value) : null,
    date_published: q.datePublished ?? null,
  };
}

const clampLimit = (v: unknown, def: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : def;
};

const tools: McpToolExport['tools'] = [
  {
    name: 'prozorro_sale_search',
    description:
      'Search Prozorro.Sale, Ukraine\'s public auction system for STATE and MUNICIPAL asset sales and leases (not procurement — for tenders use prozorro_search_tenders). Covers land-lease and land-sale auctions, municipal/state property leases, small privatisation, bankruptcy estates, timber, railway cargo, subsoil. Filter by direction (auction family), status, region (oblast), locality, free text, start-price range and modified date. Returns procedures newest-modified first with status, start price, region, seller, bid count and the upstream protected-record flags. Text is Ukrainian as published.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: {
          type: 'string',
          description:
            'Auction family (metaInfo.directions). Known values: landRental (land-lease rights), landSell, landArrested (seized land), legitimatePropertyLease and commercialPropertyLease (state/municipal property leases), regulationsPropertyLease, sellOut (small privatisation), largePrivatization, bankRuptcy, commercialSell, otherAssets, alienation, timber, subsoil, railwayCargo.',
        },
        status: {
          type: 'string',
          description:
            'Procedure status, e.g. active_tendering (open for bids), active_rectification, active_auction, active_qualification, active_awarded, pending_payment, complete, unsuccessful, cancelled.',
        },
        selling_method: { type: 'string', description: 'Exact sellingMethod, e.g. landRental-english, smallPrivatization-dutch, legitimatePropertyLease-priorityEnglish.' },
        category: { type: 'string', description: 'metaInfo category, e.g. agriLandLease, otherLandLease, agriLandSale, realEstateLease, commercialSale, cars.' },
        region: { type: 'string', description: 'Oblast as published in Ukrainian, e.g. "Київська область", "Львівська область". English oblast names (e.g. "Kyiv", "Lviv") are translated.' },
        locality: { type: 'string', description: 'Settlement as published, e.g. "м.Бровари".' },
        query: { type: 'string', description: 'Full-text search over titles and descriptions (Ukrainian works best), e.g. "Бровари" or a cadastral number.' },
        min_value: { type: 'number', description: 'Minimum start price (UAH).' },
        max_value: { type: 'number', description: 'Maximum start price (UAH).' },
        modified_since: { type: 'string', description: 'Only procedures modified on/after this date (YYYY-MM-DD or ISO datetime).' },
        limit: { type: 'number', description: 'Results per page, 1-100 (default 20).' },
        page: { type: 'number', description: 'Page number (default 1).' },
      },
    },
  },
  {
    name: 'prozorro_sale_procedure',
    description:
      'Full detail of one Prozorro.Sale auction by its public auction id (e.g. "LRE001-UA-20260813-89379") or internal 24-hex id: items (cadastral numbers, areas, addresses), start price, guarantee, bids with amounts and bidder organisations, awards, signed contracts, cancellations, related registry assets, and the REPEAT-AUCTION CHAIN (earlier failed attempts and later repeats of the same lot). Protected-record flags are passed through verbatim.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Public auction id (e.g. LRE001-UA-20260813-89379) or the 24-hex internal id.' },
        include_chain: { type: 'boolean', description: 'Walk the repeat-auction chain (default true).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'prozorro_sale_asset',
    description:
      'Look up a Prozorro.Sale registry object — usually a privatisation ASSET (id like "RAS001-UA-20260512-28803") or its 24-hex registry id — with its title, status, holder, items and the auctions it was offered in. Find asset ids in prozorro_sale_procedure related_entities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Asset id (RAS…) or 24-hex registry id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'prozorro_sale_changes',
    description:
      'Incremental feed of Prozorro.Sale procedures modified on/after a timestamp, oldest first — the upstream change feed. Returns summaries plus next_since to continue from. Use to track new auctions, status changes and results since a point in time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'ISO date or datetime, e.g. "2026-10-01" or "2026-10-01T12:00:00".' },
        limit: { type: 'number', description: 'Records to return, 1-100 (default 25).' },
      },
      required: ['since'],
    },
  },
];

const OBLASTS: Record<string, string> = {
  cherkasy: 'Черкаська область', chernihiv: 'Чернігівська область', chernivtsi: 'Чернівецька область',
  dnipropetrovsk: 'Дніпропетровська область', dnipro: 'Дніпропетровська область', donetsk: 'Донецька область',
  'ivano-frankivsk': 'Івано-Франківська область', kharkiv: 'Харківська область', kherson: 'Херсонська область',
  khmelnytskyi: 'Хмельницька область', kirovohrad: 'Кіровоградська область', kropyvnytskyi: 'Кіровоградська область',
  kyiv: 'Київська область', luhansk: 'Луганська область', lviv: 'Львівська область', mykolaiv: 'Миколаївська область',
  odesa: 'Одеська область', odessa: 'Одеська область', poltava: 'Полтавська область', rivne: 'Рівненська область',
  sumy: 'Сумська область', ternopil: 'Тернопільська область', vinnytsia: 'Вінницька область', volyn: 'Волинська область',
  zakarpattia: 'Закарпатська область', zaporizhzhia: 'Запорізька область', zhytomyr: 'Житомирська область',
};

function normRegion(r: string): string {
  const k = r.trim().toLowerCase().replace(/\s+(oblast|region|obl\.?)$/, '');
  return OBLASTS[k] ?? r.trim();
}

function isoDate(s: string, field: string): string {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(t)) {
    throw new Error(`${field} must be YYYY-MM-DD or an ISO datetime, got "${s}"`);
  }
  return t.length === 10 ? `${t}T00:00:00` : t.replace(/Z$/, '');
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'prozorro_sale_search': {
      const f: Filter[] = [];
      const s = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : null);
      if (s('direction')) f.push({ field: 'metaInfo.directions', operator: 'eq', value: s('direction') });
      if (s('status')) f.push({ field: 'status', operator: 'eq', value: s('status') });
      if (s('selling_method')) f.push({ field: 'sellingMethod', operator: 'eq', value: s('selling_method') });
      if (s('category')) f.push({ field: 'metaInfo.categories', operator: 'eq', value: s('category') });
      if (s('region')) f.push({ field: 'extended_filters.items_address.region', operator: 'eq', value: normRegion(s('region')!) });
      if (s('locality')) f.push({ field: 'extended_filters.items_address.locality', operator: 'eq', value: s('locality') });
      if (s('query')) f.push({ field: 'full_text_search', operator: 'full_text_search', value: s('query') });
      if (args.min_value != null) f.push({ field: 'value.amount', operator: 'gte', value: Number(args.min_value) });
      if (args.max_value != null) f.push({ field: 'value.amount', operator: 'lte', value: Number(args.max_value) });
      if (s('modified_since')) f.push({ field: 'dateModified', operator: 'gte', value: isoDate(s('modified_since')!, 'modified_since') });
      const limit = clampLimit(args.limit, 20, 100);
      const page = clampLimit(args.page, 1, 300);
      const r = await searchProcedures(f, limit, page);
      return {
        total: r.current_count,
        page: r.current_page,
        max_page: r.max_page,
        returned: r.payload.length,
        procedures: r.payload.map(summary),
        filters_applied: f,
        source: 'Prozorro.Sale public API (procedure.prozorro.sale)',
        data_as_of: dataAsOf(),
      };
    }
    case 'prozorro_sale_procedure': {
      const id = String(args.id ?? '').trim();
      if (!id) throw new Error('id is required');
      const p = await fetchProcedure(id);
      if (!p) return { found: false, id, source: 'Prozorro.Sale public API (procedure.prozorro.sale)', data_as_of: dataAsOf() };
      const out: Json = { found: true, procedure: detail(p) };
      if (args.include_chain !== false) out.repeat_chain = await repeatChain(p);
      out.source = 'Prozorro.Sale public API (procedure.prozorro.sale)';
      out.data_as_of = dataAsOf();
      return out;
    }
    case 'prozorro_sale_asset': {
      const id = String(args.id ?? '').trim();
      if (!id) throw new Error('id is required');
      let regId: string | null = HEX24.test(id) ? id : null;
      let procs: Json[] = [];
      if (!regId) {
        const r = await searchProcedures([{ field: 'relatedEntities.objectId', operator: 'eq', value: id }], 20);
        procs = r.payload;
        for (const p of procs) {
          const ent = (p.relatedEntities ?? []).find((e: Json) => e.objectId === id);
          if (ent?._id) { regId = ent._id; break; }
          const m = ent?.url?.match(/\/([0-9a-f]{24})$/i);
          if (m) { regId = m[1]; break; }
        }
        if (!regId) return { found: false, id, note: 'No procedure references this registry id.', source: 'Prozorro.Sale public API (procedure.prozorro.sale)', data_as_of: dataAsOf() };
      }
      const a = await getJson(`/registry/assets/${regId}`);
      if (!a) return { found: false, id, source: 'Prozorro.Sale public API (procedure.prozorro.sale)', data_as_of: dataAsOf() };
      if (HEX24.test(id) && a.assetId) {
        const r = await searchProcedures([{ field: 'relatedEntities.objectId', operator: 'eq', value: a.assetId }], 20);
        procs = r.payload;
      }
      return {
        found: true,
        asset: {
          registry_id: a._id,
          asset_id: a.assetId ?? null,
          title: uk(a.title),
          description: uk(a.description),
          status: a.status ?? null,
          asset_holder: org(a.assetHolder),
          asset_custodian: org(a.assetCustodian),
          ownership_type: a.ownershipType ?? null,
          date_published: a.datePublished ?? null,
          date_modified: a.dateModified ?? null,
          items: (a.items ?? []).map((it: Json) => ({
            description: uk(it.description),
            classification: it.classification ? { scheme: it.classification.scheme, id: it.classification.id, description: uk(it.classification.description) } : null,
            quantity: it.quantity ?? null,
            unit: uk(it.unit?.name) ?? it.unit?.code ?? null,
            address: [uk(it.address?.streetAddress), uk(it.address?.locality), uk(it.address?.region)].filter(Boolean).join(', ') || null,
          })),
          protected: a._protected ?? null,
          protect_level: a._protect_level ?? null,
        },
        procedures: procs.map(summary),
        source: 'Prozorro.Sale public API (procedure.prozorro.sale)',
        data_as_of: dataAsOf(),
      };
    }
    case 'prozorro_sale_changes': {
      const since = isoDate(String(args.since ?? ''), 'since');
      const limit = clampLimit(args.limit, 25, 100);
      const rows = await getJson(`/search/byDateModified/${encodeURIComponent(since)}?limit=${limit}`);
      if (!Array.isArray(rows)) throw new Error(`Prozorro.Sale byDateModified returned no array for ${since}`);
      const out = rows.map(summary);
      return {
        since,
        returned: out.length,
        next_since: out.length ? out[out.length - 1].date_modified : null,
        procedures: out,
        source: 'Prozorro.Sale public API (procedure.prozorro.sale)',
        data_as_of: dataAsOf(),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
