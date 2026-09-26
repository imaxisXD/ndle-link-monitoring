import { logger } from './logger';
import { CHECK_TIMEOUT_MS, DEGRADED_THRESHOLD_MS } from './constants';
import {
  CHECK_FAILURES,
  CheckFailureError,
  describeCheckFailure,
  redactUrlForLogs,
  safeFetch,
  type ResolveHost,
  type SendRequest,
} from './url-safety';

export interface CheckResult {
  statusCode: number;
  latencyMs: number;
  isHealthy: boolean;
  healthStatus: 'up' | 'down' | 'degraded' | 'unknown';
  errorMessage?: string;
}

// Pool of realistic User-Agents (Chrome, Firefox, Safari on different OS)
const USER_AGENTS = [
  // Chrome on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Chrome on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Firefox on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  // Safari on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  // Chrome on Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Edge on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders(userAgent: string): Record<string, string> {
  const isChrome = userAgent.includes('Chrome') && !userAgent.includes('Edg');
  const isFirefox = userAgent.includes('Firefox');
  const isEdge = userAgent.includes('Edg');
  const isSafari =
    userAgent.includes('Safari') && !userAgent.includes('Chrome');

  const baseHeaders: Record<string, string> = {
    'User-Agent': userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    Referer: 'https://www.google.com/',
  };

  // Add Sec-CH-UA headers for Chromium-based browsers (required by modern sites)
  if (isChrome || isEdge) {
    baseHeaders['Sec-CH-UA'] = isEdge
      ? '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"'
      : '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    baseHeaders['Sec-CH-UA-Mobile'] = '?0';
    baseHeaders['Sec-CH-UA-Platform'] = userAgent.includes('Windows')
      ? '"Windows"'
      : userAgent.includes('Macintosh')
        ? '"macOS"'
        : '"Linux"';
    baseHeaders['Sec-Fetch-Dest'] = 'document';
    baseHeaders['Sec-Fetch-Mode'] = 'navigate';
    baseHeaders['Sec-Fetch-Site'] = 'none';
    baseHeaders['Sec-Fetch-User'] = '?1';
  }

  // Firefox-specific adjustments
  if (isFirefox) {
    baseHeaders['Accept'] =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  }

  // Safari-specific adjustments
  if (isSafari) {
    baseHeaders['Accept'] =
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  }

  return baseHeaders;
}

// Servers that mishandle HEAD often answer these; a GET decides the result.
const HEAD_FALLBACK_CODES = new Set([400, 403, 404, 405, 406, 501]);
// Authentication, bot protection and rate limiting say nothing about whether visitors can reach the page.
const INCONCLUSIVE_CODES = new Set([401, 403, 405, 406, 429, 503]);

export function classifyResponse(
  status: number,
  latencyMs: number
): Pick<CheckResult, 'isHealthy' | 'healthStatus'> {
  const isHealthy = status >= 200 && status < 400;
  if (isHealthy) {
    return {
      isHealthy,
      healthStatus: latencyMs > DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
    };
  }
  return {
    isHealthy,
    healthStatus: INCONCLUSIVE_CODES.has(status) ? 'unknown' : 'down',
  };
}

// Politeness: at most this many checks in flight per hostname in this process.
const MAX_CHECKS_PER_HOST = 2;
const hostSlots = new Map<
  string,
  { active: number; waiting: Array<() => void> }
>();

async function withHostSlot<T>(
  longUrl: string,
  run: () => Promise<T>
): Promise<T> {
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
  if (slots.active < MAX_CHECKS_PER_HOST) slots.active++;
  else await new Promise<void>(resolve => slots.waiting.push(resolve));
  try {
    return await run();
  } finally {
    // Hand the slot to the next waiting check, or release it.
    const next = slots.waiting.shift();
    if (next) next();
    else if (--slots.active === 0) hostSlots.delete(host);
  }
}

export interface CheckOptions {
  resolveHost?: ResolveHost;
  send?: SendRequest;
  timeoutMs?: number;
}

async function makeRequest(
  url: string,
  method: 'HEAD' | 'GET',
  signal: AbortSignal,
  requestLogger: typeof logger,
  options: CheckOptions
): Promise<Response> {
  const userAgent = getRandomUserAgent();
  const headers = getBrowserHeaders(userAgent);

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

export function checkUrl(
  longUrl: string,
  requestLogger: typeof logger,
  options: CheckOptions = {}
): Promise<CheckResult> {
  return withHostSlot(longUrl, () => measure(longUrl, requestLogger, options));
}

async function measure(
  longUrl: string,
  requestLogger: typeof logger,
  options: CheckOptions
): Promise<CheckResult> {
  // Time only the request itself, not the wait for a host slot.
  const start = Date.now();
  const redactedUrl = redactUrlForLogs(longUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? CHECK_TIMEOUT_MS
  );
  try {
    // Try HEAD first (faster, no body download)
    let response = await makeRequest(
      longUrl,
      'HEAD',
      controller.signal,
      requestLogger,
      options
    );

    // Retry once with GET before classifying a response some servers give only to HEAD.
    if (HEAD_FALLBACK_CODES.has(response.status)) {
      requestLogger.debug(
        { status: response.status },
        'HEAD request was not conclusive, retrying with GET'
      );

      // Small delay before retry to avoid rate limiting
      await new Promise(resolve =>
        setTimeout(resolve, 100 + Math.random() * 200)
      );

      response = await makeRequest(
        longUrl,
        'GET',
        controller.signal,
        requestLogger,
        options
      );
    }

    const latencyMs = Date.now() - start;
    const { isHealthy, healthStatus } = classifyResponse(
      response.status,
      latencyMs
    );

    // Log based on health status with appropriate severity and details
    if (healthStatus === 'unknown') {
      // A response proves reachability, but access is still unknown.
      requestLogger.info(
        {
          component: 'url-checker',
          statusCode: response.status,
          latencyMs,
          healthStatus,
          url: redactedUrl,
        },
        `Health check was inconclusive - HTTP ${response.status} response received`
      );
    } else if (healthStatus === 'down') {
      requestLogger.error(
        {
          component: 'url-checker',
          statusCode: response.status,
          latencyMs,
          healthStatus,
          url: redactedUrl,
        },
        `URL is DOWN - HTTP ${response.status} response received`
      );
    } else if (healthStatus === 'degraded') {
      requestLogger.warn(
        {
          component: 'url-checker',
          statusCode: response.status,
          latencyMs,
          healthStatus,
          url: redactedUrl,
          threshold: DEGRADED_THRESHOLD_MS,
          exceededBy: latencyMs - DEGRADED_THRESHOLD_MS,
        },
        `URL is DEGRADED - Response took ${latencyMs}ms (threshold: ${DEGRADED_THRESHOLD_MS}ms)`
      );
    } else {
      requestLogger.info(
        {
          component: 'url-checker',
          statusCode: response.status,
          latencyMs,
          healthStatus,
          url: redactedUrl,
        },
        'Health check completed - URL is UP'
      );
    }

    return {
      statusCode: response.status,
      latencyMs,
      isHealthy,
      healthStatus,
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const aborted = controller.signal.aborted;
    // The owner sees only this fixed message; the detailed error is logged below.
    const errorMessage = describeCheckFailure(error, aborted);
    const isTimeout = errorMessage === CHECK_FAILURES.timeout;
    const healthStatus =
      !aborted && error instanceof CheckFailureError
        ? error.healthStatus
        : 'down';

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
  } finally {
    clearTimeout(timeoutId);
  }
}
