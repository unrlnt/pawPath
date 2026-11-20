/**
 * Transport for Overpass: retry policy, instance rotation, slot-aware waiting,
 * timeouts, throttling and error classification. Knows nothing about layers or
 * features.
 *
 * The retry policy is the heart of this file, and it exists because of a
 * misdiagnosis. Phase 1's recon read its own failures as "the instances are
 * unreachable". They are not: the same queries succeed by hand from
 * overpass-turbo, on the same browser and the same IP. What actually happened
 * is that a single network-class error rotated us through every instance in a
 * few seconds and we gave up in 10–18 s having never genuinely retried
 * anything. Transient errors are normal and clear on retry.
 *
 * So: retry the SAME instance several times with jittered backoff, consult
 * `/api/status` rather than guessing on 429, and only then rotate.
 *
 * The usage policy also forbids parallel requests from one IP block, which is
 * why concurrency is pinned at 1 (see `OVERPASS_MAX_CONCURRENCY`).
 */

import {
  OVERPASS_ACCEPT_HEADER,
  OVERPASS_ATTEMPTS_PER_INSTANCE,
  OVERPASS_CONTENT_TYPE,
  OVERPASS_INTER_REQUEST_DELAY_MS,
  OVERPASS_MAX_ATTEMPTS,
  OVERPASS_MAX_CONCURRENCY,
  OVERPASS_MAX_SLOT_WAIT_MS,
  OVERPASS_REQUEST_TIMEOUT_MS,
  OVERPASS_SESSION_BYTE_BUDGET,
  OVERPASS_SESSION_REQUEST_BUDGET,
} from '../../config';
import {
  isFatalStatus,
  isRetryableStatus,
  parseOverpassStatus,
  slotWaitMs,
} from '../../lib/overpassRetry';
import {
  cacheStatus,
  cachedStatus,
  instancesInPreferenceOrder,
  recordFailure,
  recordSuccess,
  statusUrlFor,
} from './overpassHealth';
import { TileSourceError } from './tileSource';

/* ------------------------------------------------------------------ *
 * Raw Overpass shapes
 * ------------------------------------------------------------------ */

export interface OverpassLatLon {
  readonly lat: number;
  readonly lon: number;
}

export interface OverpassElement {
  readonly type: 'node' | 'way' | 'relation';
  readonly id: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly center?: OverpassLatLon;
  readonly geometry?: readonly OverpassLatLon[];
  readonly bounds?: {
    readonly minlat: number;
    readonly minlon: number;
    readonly maxlat: number;
    readonly maxlon: number;
  };
  readonly tags?: Readonly<Record<string, string>>;
}

interface OverpassResponse {
  readonly elements?: readonly OverpassElement[];
  /** Overpass reports in-band failures here, inside an HTTP 200. */
  readonly remark?: string;
}

/* ------------------------------------------------------------------ *
 * Progress reporting
 *
 * A stalled request must never look like a hung app: every wait is announced.
 * ------------------------------------------------------------------ */

export type RetryPhase =
  | { readonly kind: 'requesting'; readonly attempt: number; readonly maxAttempts: number }
  | {
      readonly kind: 'retrying';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly waitMs: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'waitingForSlot';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly waitMs: number;
    }
  | { readonly kind: 'rotating'; readonly from: string; readonly to: string };

export interface RetryProgress extends Record<string, unknown> {
  readonly phase: RetryPhase;
  readonly endpoint: string;
  /** Human-readable one-liner for the UI, e.g. "retrying (2/5)". */
  readonly message: string;
}

export type RetryProgressListener = (progress: RetryProgress) => void;

function describe(phase: RetryPhase, label: string): string {
  switch (phase.kind) {
    case 'requesting':
      return phase.attempt === 1
        ? `querying ${label}`
        : `querying ${label} (attempt ${phase.attempt}/${phase.maxAttempts})`;
    case 'retrying':
      return `retrying (${phase.attempt}/${phase.maxAttempts}) in ${Math.round(
        phase.waitMs / 1000,
      )}s — ${phase.reason}`;
    case 'waitingForSlot':
      return `waiting for a free slot (~${Math.round(phase.waitMs / 1000)}s)`;
    case 'rotating':
      return `switching to ${phase.to}`;
  }
}

/* ------------------------------------------------------------------ *
 * Session budget  (usage policy compliance)
 * ------------------------------------------------------------------ */

export interface SessionUsage {
  requests: number;
  bytes: number;
  readonly requestBudget: number;
  readonly byteBudget: number;
}

const usage: SessionUsage = {
  requests: 0,
  bytes: 0,
  requestBudget: OVERPASS_SESSION_REQUEST_BUDGET,
  byteBudget: OVERPASS_SESSION_BYTE_BUDGET,
};

export function sessionUsage(): Readonly<SessionUsage> {
  return { ...usage };
}

export function resetSessionUsage(): void {
  usage.requests = 0;
  usage.bytes = 0;
}

function budgetExhausted(): boolean {
  return usage.requests >= usage.requestBudget || usage.bytes >= usage.byteBudget;
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

export interface OverpassRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
  readonly onProgress?: RetryProgressListener;
}

export interface OverpassAttempt {
  readonly endpoint: string;
  readonly durationMs: number;
  readonly error: TileSourceError;
}

export type OverpassRunResult =
  | {
      readonly ok: true;
      readonly elements: readonly OverpassElement[];
      readonly endpoint: string;
      readonly attempts: number;
      readonly durationMs: number;
      readonly failures: readonly OverpassAttempt[];
    }
  | {
      readonly ok: false;
      readonly error: TileSourceError;
      readonly endpoint: string | undefined;
      readonly attempts: number;
      readonly durationMs: number;
      readonly failures: readonly OverpassAttempt[];
    };

/* ------------------------------------------------------------------ *
 * Throttle — one request at a time, per the usage policy
 * ------------------------------------------------------------------ */

let inFlight = 0;
const waiting: (() => void)[] = [];
let lastRequestFinishedAt = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Abortable sleep, so a cancelled tile does not hold the queue for 30 s. */
function sleepUnlessAborted(ms: number, maybeSignal: AbortSignal | undefined): Promise<void> {
  if (maybeSignal === undefined) return sleep(ms);
  const signal = maybeSignal;
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

async function acquireSlot(minIntervalMs: number): Promise<void> {
  if (inFlight >= OVERPASS_MAX_CONCURRENCY) {
    // The slot is handed over directly by releaseSlot, which keeps the count
    // raised across the handover — otherwise a caller arriving between the
    // release and the waiter resuming would slip in over the limit.
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  } else {
    inFlight += 1;
  }
  const sinceLast = Date.now() - lastRequestFinishedAt;
  if (sinceLast < minIntervalMs) {
    await sleep(minIntervalMs - sinceLast);
  }
}

function releaseSlot(): void {
  lastRequestFinishedAt = Date.now();
  const next = waiting.shift();
  if (next === undefined) inFlight -= 1;
  else next();
}

/* ------------------------------------------------------------------ *
 * Error classification
 * ------------------------------------------------------------------ */

function classifyHttp(status: number, endpoint: string, body: string): TileSourceError {
  if (status === 429) {
    return new TileSourceError('rateLimited', 'Overpass rate limited (429)', { endpoint, status });
  }
  if (status === 406) {
    // OUR BUG, not the instance's. Overpass serves JSON and refuses content
    // negotiation it cannot satisfy, so a 406 means we advertised an `Accept`
    // it cannot meet. Loud, because it will affect every instance identically
    // and no amount of retrying or rotating will help.
    console.error(
      '[overpass] CLIENT BUG: 406 Not Acceptable. We sent an Accept header ' +
        'Overpass cannot satisfy — it only returns JSON/XML/CSV. Check ' +
        'OVERPASS_ACCEPT_HEADER in src/config.ts. This is not an instance fault.',
      { endpoint, accept: OVERPASS_ACCEPT_HEADER },
    );
    return new TileSourceError(
      'invalidRequest',
      `Client bug: ${endpoint} returned 406 for Accept: ${OVERPASS_ACCEPT_HEADER}. ` +
        'Overpass returns JSON and refuses negotiation it cannot satisfy. ' +
        'Fix the request shape — retrying and rotating cannot help.',
      { endpoint, status },
    );
  }
  if (status === 400) {
    // Overpass answers a malformed query with 400 and an HTML error page.
    // Retrying cannot fix our own QL.
    return new TileSourceError(
      'invalidRequest',
      `Overpass rejected the query (400): ${summarise(body)}`,
      { endpoint, status },
    );
  }
  if (status === 504) {
    return new TileSourceError('timeout', 'Overpass gateway timeout (504)', { endpoint, status });
  }
  if (status >= 500) {
    return new TileSourceError('server', `Overpass server error (${status})`, { endpoint, status });
  }
  return new TileSourceError('server', `Unexpected Overpass response (${status})`, {
    endpoint,
    status,
  });
}

function classifyRemark(remark: string, endpoint: string): TileSourceError {
  const lowered = remark.toLowerCase();
  if (lowered.includes('timed out') || lowered.includes('timeout')) {
    return new TileSourceError('timeout', `Overpass query timed out: ${summarise(remark)}`, {
      endpoint,
    });
  }
  if (lowered.includes('too many') || lowered.includes('rate') || lowered.includes('slot')) {
    return new TileSourceError('rateLimited', `Overpass refused the slot: ${summarise(remark)}`, {
      endpoint,
    });
  }
  return new TileSourceError('server', `Overpass runtime error: ${summarise(remark)}`, { endpoint });
}

function summarise(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

/**
 * Describes a pre-HTTP fetch rejection in full.
 *
 * "Could not reach X" was the single most misleading string in Phase 1: it
 * collapsed CORS rejections, DNS failures, offline states and aborted requests
 * into one message that read like the server was down. `fetch` rejects with a
 * bare `TypeError` for all of them, so the name, the message and the elapsed
 * time are the only evidence there is — keep all of it.
 */
function describeFetchRejection(
  cause: unknown,
  endpoint: string,
  elapsedMs: number,
): TileSourceError {
  const name = cause instanceof Error ? cause.name : typeof cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new TileSourceError(
    'network',
    `${endpoint} — fetch rejected before any response after ${elapsedMs} ms ` +
      `(${name}: ${message || 'no message'}). Typically CORS, DNS, or offline.`,
    { endpoint, cause, elapsedMs, responseReceived: false, errorName: name },
  );
}

/* ------------------------------------------------------------------ *
 * A single request
 * ------------------------------------------------------------------ */

async function runOnce(
  endpoint: string,
  ql: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ elements: readonly OverpassElement[]; bytes: number } | { error: TileSourceError }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let responseReceived = false;
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Overpass request timed out', 'TimeoutError'));
  }, timeoutMs);
  const onExternalAbort = (): void => {
    controller.abort(signal?.reason);
  };
  signal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      // Overpass accepts the query as a urlencoded `data` field; POST avoids
      // the URL length ceiling a multi-selector union would hit.
      //
      // Both headers are CORS-SAFELISTED, so this request is never preflighted.
      // Changing Content-Type to application/json would add an OPTIONS
      // preflight, and a failed preflight surfaces as a bare TypeError with no
      // status — indistinguishable from the server being down. See
      // OVERPASS_CONTENT_TYPE.
      //
      // No User-Agent: browsers forbid setting it. The app identifies itself
      // in the query comment instead, and the browser sends Origin and Referer
      // automatically, which tell an operator the app's domain.
      headers: {
        'Content-Type': OVERPASS_CONTENT_TYPE,
        Accept: OVERPASS_ACCEPT_HEADER,
      },
      body: new URLSearchParams({ data: ql }).toString(),
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    responseReceived = true;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { error: classifyHttp(response.status, endpoint, body) };
    }

    const text = await response.text();
    const bytes = text.length;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      return {
        error: new TileSourceError(
          'parse',
          `Overpass returned a 200 that is not JSON: ${summarise(text.slice(0, 300))}`,
          { endpoint, cause, responseReceived: true },
        ),
      };
    }

    if (typeof raw !== 'object' || raw === null) {
      return {
        error: new TileSourceError('parse', 'Overpass returned a non-object body', { endpoint }),
      };
    }

    const parsed = raw as OverpassResponse;
    if (typeof parsed.remark === 'string' && parsed.remark.length > 0) {
      return { error: classifyRemark(parsed.remark, endpoint) };
    }
    if (!Array.isArray(parsed.elements)) {
      return {
        error: new TileSourceError('parse', 'Overpass response had no elements array', { endpoint }),
      };
    }
    return { elements: parsed.elements, bytes };
  } catch (cause) {
    const elapsedMs = Date.now() - startedAt;
    if (cause instanceof TileSourceError) return { error: cause };

    // The caller aborting is not a failure of the instance.
    if (signal?.aborted === true) {
      return {
        error: new TileSourceError('aborted', 'Request cancelled by caller', {
          endpoint,
          cause,
          elapsedMs,
          responseReceived,
        }),
      };
    }
    if (
      cause instanceof DOMException &&
      (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    ) {
      return {
        error: new TileSourceError('timeout', `${endpoint} — no response within ${timeoutMs} ms`, {
          endpoint,
          cause,
          elapsedMs,
          responseReceived,
          errorName: cause.name,
        }),
      };
    }
    return { error: describeFetchRejection(cause, endpoint, elapsedMs) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/* ------------------------------------------------------------------ *
 * Slot-aware waiting
 * ------------------------------------------------------------------ */

/**
 * Reads `/api/status` so a 429 wait is informed rather than guessed.
 *
 * Overpass sends no `Retry-After` and its 429 body is HTML, but `/api/status`
 * is plain text and states how many slots we hold and when the next frees.
 * Failure here is non-fatal: the caller falls back to blind backoff.
 */
async function fetchStatus(
  interpreterUrl: string,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof parseOverpassStatus> | undefined> {
  const cached = cachedStatus(interpreterUrl);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(statusUrlFor(interpreterUrl), {
      method: 'GET',
      credentials: 'omit',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return undefined;
    const status = parseOverpassStatus(await response.text());
    cacheStatus(interpreterUrl, status);
    return status;
  } catch {
    // A status check is a courtesy, never a hard dependency.
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * The retry loop
 * ------------------------------------------------------------------ */

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Runs a query, retrying the same instance with jittered backoff before
 * rotating. Never rejects: every failure resolves to `ok: false` with a typed
 * error.
 */
export async function runOverpassQuery(
  ql: string,
  options: OverpassRunOptions = {},
): Promise<OverpassRunResult> {
  const timeoutMs = options.timeoutMs ?? OVERPASS_REQUEST_TIMEOUT_MS;
  const minIntervalMs = options.minIntervalMs ?? OVERPASS_INTER_REQUEST_DELAY_MS;
  const startedAt = Date.now();
  const failures: OverpassAttempt[] = [];
  let attempts = 0;
  let lastEndpoint: string | undefined;

  const report = (phase: RetryPhase, endpoint: string, label: string): void => {
    options.onProgress?.({ phase, endpoint, message: describe(phase, label) });
  };

  if (isAborted(options.signal)) {
    return {
      ok: false,
      error: new TileSourceError('aborted', 'Request cancelled before it started'),
      endpoint: undefined,
      attempts: 0,
      durationMs: 0,
      failures,
    };
  }

  if (budgetExhausted()) {
    return {
      ok: false,
      error: new TileSourceError(
        'budgetExhausted',
        `Session request budget spent (${usage.requests}/${usage.requestBudget} requests, ` +
          `${Math.round(usage.bytes / 1024 / 1024)}/${Math.round(
            usage.byteBudget / 1024 / 1024,
          )} MB). Reload to reset. This guard exists to stay inside the Overpass usage policy.`,
      ),
      endpoint: undefined,
      attempts: 0,
      durationMs: 0,
      failures,
    };
  }

  const instances = instancesInPreferenceOrder();

  for (const [instanceIndex, instance] of instances.entries()) {
    if (instanceIndex > 0) {
      const previous = instances[instanceIndex - 1];
      report(
        { kind: 'rotating', from: previous?.label ?? 'previous', to: instance.label },
        instance.url,
        instance.label,
      );
    }

    for (let attempt = 0; attempt < OVERPASS_ATTEMPTS_PER_INSTANCE; attempt += 1) {
      if (attempts >= OVERPASS_MAX_ATTEMPTS) break;
      attempts += 1;
      lastEndpoint = instance.url;
      const attemptStartedAt = Date.now();

      report(
        { kind: 'requesting', attempt: attempts, maxAttempts: OVERPASS_MAX_ATTEMPTS },
        instance.url,
        instance.label,
      );

      await acquireSlot(minIntervalMs);
      let outcome:
        | { elements: readonly OverpassElement[]; bytes: number }
        | { error: TileSourceError };
      try {
        outcome = await runOnce(instance.url, ql, timeoutMs, options.signal);
      } finally {
        releaseSlot();
      }
      usage.requests += 1;

      if ('elements' in outcome) {
        usage.bytes += outcome.bytes;
        recordSuccess(instance.url);
        return {
          ok: true,
          elements: outcome.elements,
          endpoint: instance.url,
          attempts,
          durationMs: Date.now() - startedAt,
          failures,
        };
      }

      const error = outcome.error;
      failures.push({
        endpoint: instance.url,
        durationMs: Date.now() - attemptStartedAt,
        error,
      });

      // Full detail to the console: the UI shows a summary, but a diagnosis
      // needs the underlying error object.
      console.warn('[overpass] attempt failed', {
        endpoint: instance.url,
        attempt: attempts,
        kind: error.kind,
        status: error.status,
        errorName: error.errorName,
        elapsedMs: error.elapsedMs,
        responseReceived: error.responseReceived,
        message: error.message,
        cause: error.cause,
      });

      if (error.kind === 'aborted') {
        return {
          ok: false,
          error,
          endpoint: instance.url,
          attempts,
          durationMs: Date.now() - startedAt,
          failures,
        };
      }

      // 400 and 406 are both OUR bug: a malformed query, or an Accept header
      // Overpass cannot satisfy. Every instance will answer identically, so
      // rotating wastes their slots as well as our time. Deliberately NOT
      // recorded against the instance: it says nothing about its health, and
      // three of them in a row would otherwise park a healthy instance.
      if (error.status !== undefined && isFatalStatus(error.status)) {
        return {
          ok: false,
          error,
          endpoint: instance.url,
          attempts,
          durationMs: Date.now() - startedAt,
          failures,
        };
      }

      recordFailure(instance.url, error.message);

      const retryable =
        error.kind === 'network' ||
        error.kind === 'timeout' ||
        error.kind === 'rateLimited' ||
        error.kind === 'server' ||
        (error.status !== undefined && isRetryableStatus(error.status));

      if (!retryable) break; // rotate

      const attemptsLeftHere =
        attempt < OVERPASS_ATTEMPTS_PER_INSTANCE - 1 && attempts < OVERPASS_MAX_ATTEMPTS;
      if (!attemptsLeftHere) break; // rotate

      // On 429, ask the instance when a slot frees instead of guessing.
      let waitMs: number;
      let reason: 'slot' | 'backoff';
      if (error.kind === 'rateLimited') {
        const status = await fetchStatus(instance.url, options.signal);
        ({ waitMs, reason } = slotWaitMs(status, attempt, OVERPASS_MAX_SLOT_WAIT_MS));
      } else {
        ({ waitMs, reason } = slotWaitMs(undefined, attempt, OVERPASS_MAX_SLOT_WAIT_MS));
      }

      report(
        reason === 'slot'
          ? { kind: 'waitingForSlot', attempt: attempts, maxAttempts: OVERPASS_MAX_ATTEMPTS, waitMs }
          : {
              kind: 'retrying',
              attempt: attempts,
              maxAttempts: OVERPASS_MAX_ATTEMPTS,
              waitMs,
              reason: error.kind,
            },
        instance.url,
        instance.label,
      );

      await sleepUnlessAborted(waitMs, options.signal);
      if (isAborted(options.signal)) {
        return {
          ok: false,
          error: new TileSourceError('aborted', 'Request cancelled during backoff', {
            endpoint: instance.url,
          }),
          endpoint: instance.url,
          attempts,
          durationMs: Date.now() - startedAt,
          failures,
        };
      }
    }

    if (attempts >= OVERPASS_MAX_ATTEMPTS) break;
  }

  const lastFailure = failures[failures.length - 1];
  return {
    ok: false,
    error: new TileSourceError(
      'exhausted',
      `Gave up after ${attempts} attempt(s) across ${
        new Set(failures.map((f) => f.endpoint)).size
      } instance(s). Last: ${lastFailure?.error.message ?? 'unknown error'}`,
      {
        ...(lastEndpoint === undefined ? {} : { endpoint: lastEndpoint }),
        cause: lastFailure?.error,
      },
    ),
    endpoint: lastEndpoint,
    attempts,
    durationMs: Date.now() - startedAt,
    failures,
  };
}

/* ------------------------------------------------------------------ *
 * Connectivity test
 * ------------------------------------------------------------------ */

export interface ConnectivityResult {
  readonly label: string;
  readonly url: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly status: number | undefined;
  readonly detail: string;
}

/**
 * Fires one trivial `out count` query at an instance, bypassing the tile
 * pipeline entirely.
 *
 * Separate from `runOverpassQuery` on purpose: when the map is failing you need
 * to know whether the instance is reachable *at all*, without retries, caching,
 * the breaker or the queue confusing the answer.
 */
export async function testInstanceConnectivity(
  instanceUrl: string,
  label: string,
  ql = '[out:json][timeout:10];node(50.746,7.154,50.748,7.156);out count;',
): Promise<ConnectivityResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(instanceUrl, {
      method: 'POST',
      // Same shape as the real path, or the test proves nothing.
      headers: {
        'Content-Type': OVERPASS_CONTENT_TYPE,
        Accept: OVERPASS_ACCEPT_HEADER,
      },
      body: new URLSearchParams({ data: ql }).toString(),
      credentials: 'omit',
      signal: AbortSignal.timeout(OVERPASS_REQUEST_TIMEOUT_MS),
    });
    const durationMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return {
        label,
        url: instanceUrl,
        ok: false,
        durationMs,
        status: response.status,
        detail:
          response.status === 406
            ? `HTTP 406 — CLIENT BUG, not an instance fault: our Accept header ` +
              `(${OVERPASS_ACCEPT_HEADER}) is one Overpass cannot satisfy.`
            : `HTTP ${response.status}: ${summarise(text.slice(0, 200))}`,
      };
    }
    return {
      label,
      url: instanceUrl,
      ok: true,
      durationMs,
      status: response.status,
      detail: `OK — ${summarise(text.slice(0, 120))}`,
    };
  } catch (cause) {
    const durationMs = Date.now() - startedAt;
    const name = cause instanceof Error ? cause.name : typeof cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    console.warn('[overpass] connectivity test failed', { instanceUrl, cause });
    return {
      label,
      url: instanceUrl,
      ok: false,
      durationMs,
      status: undefined,
      detail: `No response (${name}: ${message || 'no message'}) — CORS, DNS or offline.`,
    };
  }
}
