import type { CheckResult } from '../types/monitoring';
import { getBrowserHeaders, getRandomUserAgent } from './browser-headers';
import {
  classifyResponse,
  shouldFallbackToGet,
} from './check-classification';
import { CHECK_TIMEOUT_MS, DEGRADED_THRESHOLD_MS } from './constants';
import type { logger } from './logger';
import { sleep } from './timeout';
import {
  CHECK_FAILURES,
  CheckFailureError,
  describeCheckFailure,
  redactUrlForLogs,
  safeFetch,
  type ResolveHost,
  type SendRequest,
} from './url-safety';

export type { CheckResult };
export { classifyResponse };

// Politeness: at most this many checks in flight per hostname in this process.
const MAX_CHECKS_PER_HOST = 2;

type SlotWaiter = {
  grant: () => void;
};

const hostSlots = new Map<
  string,
  { active: number; waiting: SlotWaiter[] }
>();

export async function withHostSlot<T>(
  longUrl: string,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException('The operation was aborted.', 'AbortError')
    );
  }

  let host: string;
  try {
    host = new URL(longUrl).hostname.replace(/\.$/, '');
  } catch {
    return run();
  }

  let slots = hostSlots.get(host);
  if (!slots) {
    slots = { active: 0, waiting: [] };
    hostSlots.set(host, slots);
  }

  if (slots.active < MAX_CHECKS_PER_HOST) {
    slots.active++;
  } else {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: SlotWaiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const idx = slots.waiting.indexOf(waiter);
        if (idx !== -1) slots.waiting.splice(idx, 1);
        if (slots.active === 0 && slots.waiting.length === 0) {
          hostSlots.delete(host);
        }
        reject(
          signal?.reason ??
            new DOMException('The operation was aborted.', 'AbortError')
        );
      };

      slots.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  try {
    return await run();
  } finally {
    // Hand the slot to the next waiting check, or release it.
    const next = slots.waiting.shift();
    if (next) next.grant();
    else if (--slots.active === 0) hostSlots.delete(host);
  }
}

export interface CheckOptions {
  resolveHost?: ResolveHost;
  send?: SendRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
  fallbackDelayMs?: number;
}

async function makeRequest(
  url: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string>,
  userAgent: string,
  signal: AbortSignal,
  requestLogger: typeof logger,
  options: CheckOptions
): Promise<Response> {
  requestLogger.debug(
    { method, userAgent: userAgent.slice(0, 50) },
    'Making request'
  );

  return safeFetch(
    url,
    {
      method,
      signal,
      headers,
    },
    options.resolveHost,
    options.send
  );
}

export async function checkUrl(
  longUrl: string,
  requestLogger: typeof logger,
  options: CheckOptions = {}
): Promise<CheckResult> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException('Check timed out', 'TimeoutError')),
    timeoutMs
  );
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    onCallerAbort();
  } else {
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  }

  const waitStart = Date.now();
  try {
    return await withHostSlot(
      longUrl,
      () => measure(longUrl, requestLogger, controller.signal, options),
      controller.signal
    );
  } catch (error) {
    const latencyMs = Date.now() - waitStart;
    return handleCheckError(
      longUrl,
      error,
      controller.signal.aborted,
      latencyMs,
      requestLogger
    );
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function handleCheckError(
  longUrl: string,
  error: unknown,
  aborted: boolean,
  latencyMs: number,
  requestLogger: typeof logger
): CheckResult {
  const redactedUrl = redactUrlForLogs(longUrl);
  // The owner sees only this fixed message; the detailed error is logged below.
  const errorMessage = describeCheckFailure(error, aborted);
  const isTimeout = errorMessage === CHECK_FAILURES.timeout;
  const healthStatus =
    !aborted && error instanceof CheckFailureError ? error.healthStatus : 'down';

  requestLogger.warn(
    {
      component: 'url-checker',
      latencyMs,
      err: error,
      failure: errorMessage,
      healthStatus,
      isTimeout,
      url: redactedUrl,
    },
    `Health check failed - ${errorMessage}`
  );

  return {
    statusCode: isTimeout ? 408 : 0,
    latencyMs,
    isHealthy: false,
    healthStatus,
    errorMessage,
  };
}

async function measure(
  longUrl: string,
  requestLogger: typeof logger,
  signal: AbortSignal,
  options: CheckOptions
): Promise<CheckResult> {
  // Time only the request itself, not the wait for a host slot.
  let start = Date.now();
  const redactedUrl = redactUrlForLogs(longUrl);
  const userAgent = getRandomUserAgent();
  const headers = getBrowserHeaders(userAgent);

  try {
    // Try HEAD first (faster, no body download)
    let response = await makeRequest(
      longUrl,
      'HEAD',
      headers,
      userAgent,
      signal,
      requestLogger,
      options
    );

    // Retry once with GET before classifying a response some servers give only to HEAD.
    if (shouldFallbackToGet(response.status)) {
      requestLogger.debug(
        { status: response.status },
        'HEAD request was not conclusive, retrying with GET'
      );

      // Small abort-aware delay before retry to avoid rate limiting
      const delayMs = options.fallbackDelayMs ?? 100 + Math.random() * 200;
      if (delayMs > 0) await sleep(delayMs, signal);

      // Reset start before GET so a rejected HEAD + sleep does not inflate latency into degraded.
      start = Date.now();
      response = await makeRequest(
        longUrl,
        'GET',
        headers,
        userAgent,
        signal,
        requestLogger,
        options
      );
    }

    const latencyMs = Date.now() - start;
    const { isHealthy, healthStatus } = classifyResponse(
      response.status,
      latencyMs
    );

    const logPayload = {
      component: 'url-checker',
      statusCode: response.status,
      latencyMs,
      healthStatus,
      url: redactedUrl,
    };

    if (healthStatus === 'unknown') {
      // A response proves reachability, but access is still unknown.
      requestLogger.info(
        logPayload,
        `Health check was inconclusive - HTTP ${response.status} response received`
      );
    } else if (healthStatus === 'down') {
      requestLogger.error(
        logPayload,
        `URL is DOWN - HTTP ${response.status} response received`
      );
    } else if (healthStatus === 'degraded') {
      requestLogger.warn(
        {
          ...logPayload,
          threshold: DEGRADED_THRESHOLD_MS,
          exceededBy: latencyMs - DEGRADED_THRESHOLD_MS,
        },
        `URL is DEGRADED - Response took ${latencyMs}ms (threshold: ${DEGRADED_THRESHOLD_MS}ms)`
      );
    } else {
      requestLogger.info(logPayload, 'Health check completed - URL is UP');
    }

    return {
      statusCode: response.status,
      latencyMs,
      isHealthy,
      healthStatus,
    };
  } catch (error) {
    return handleCheckError(
      longUrl,
      error,
      signal.aborted,
      Date.now() - start,
      requestLogger
    );
  }
}
