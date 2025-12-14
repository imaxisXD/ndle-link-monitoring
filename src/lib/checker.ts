import { logger } from './logger';
import { CHECK_TIMEOUT_MS, DEGRADED_THRESHOLD_MS } from './constants';

export interface CheckResult {
  statusCode: number;
  latencyMs: number;
  isHealthy: boolean;
  healthStatus: 'up' | 'down' | 'degraded';
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

// Status codes that indicate bot blocking - retry with GET
const BOT_BLOCKED_CODES = [403, 405, 406, 429, 503];

// Cloudflare and similar challenge page indicators
function isLikelyBotChallenge(status: number): boolean {
  return BOT_BLOCKED_CODES.includes(status);
}

async function makeRequest(
  url: string,
  method: 'HEAD' | 'GET',
  signal: AbortSignal,
  requestLogger: typeof logger
): Promise<Response> {
  const userAgent = getRandomUserAgent();
  const headers = getBrowserHeaders(userAgent);

  requestLogger.debug(
    { method, userAgent: userAgent.slice(0, 50) },
    'Making request'
  );

  return fetch(url, {
    method,
    redirect: 'follow',
    signal,
    headers,
  });
}

export async function checkUrl(
  longUrl: string,
  requestLogger: typeof logger
): Promise<CheckResult> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    // Try HEAD first (faster, no body download)
    let response = await makeRequest(
      longUrl,
      'HEAD',
      controller.signal,
      requestLogger
    );

    // If blocked or method not allowed, retry with GET
    if (isLikelyBotChallenge(response.status)) {
      requestLogger.debug(
        { status: response.status },
        'HEAD request possibly blocked, retrying with GET'
      );

      // Small delay before retry to avoid rate limiting
      await new Promise(resolve =>
        setTimeout(resolve, 100 + Math.random() * 200)
      );

      response = await makeRequest(
        longUrl,
        'GET',
        controller.signal,
        requestLogger
      );
    }

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    // Consider 403 from GET as actually blocked/down
    const isHealthy = response.status >= 200 && response.status < 400;
    const healthStatus: 'up' | 'down' | 'degraded' = !isHealthy
      ? 'down'
      : latencyMs > DEGRADED_THRESHOLD_MS
        ? 'degraded'
        : 'up';

    // Log based on health status with appropriate severity and details
    if (healthStatus === 'down') {
      requestLogger.error(
        {
          statusCode: response.status,
          latencyMs,
          healthStatus,
          url: longUrl,
          possibleCauses: [
            response.status >= 500
              ? 'Server error - the target server may be experiencing issues or overloaded'
              : null,
            response.status === 404
              ? 'Not Found - the URL path may have changed or been removed'
              : null,
            response.status === 403
              ? 'Forbidden - request may be blocked by WAF, firewall, or bot protection'
              : null,
            response.status === 401
              ? 'Unauthorized - the resource requires authentication'
              : null,
            response.status === 400
              ? 'Bad Request - malformed URL or request parameters'
              : null,
          ].filter(Boolean),
          recommendation:
            response.status >= 500
              ? 'Check if the target server is operational and responding to other requests'
              : response.status === 403
                ? 'The site may have bot protection enabled; consider whitelisting or alternative monitoring'
                : 'Verify the URL is correct and accessible from a browser',
        },
        `URL is DOWN - HTTP ${response.status} response received`
      );
    } else if (healthStatus === 'degraded') {
      requestLogger.warn(
        {
          statusCode: response.status,
          latencyMs,
          healthStatus,
          url: longUrl,
          threshold: DEGRADED_THRESHOLD_MS,
          exceededBy: latencyMs - DEGRADED_THRESHOLD_MS,
          possibleCauses: [
            'High server load or resource contention on target server',
            'Network latency or routing issues between monitoring service and target',
            'Slow DNS resolution',
            'SSL/TLS handshake delays',
            'Large response payload or slow backend processing',
            'Geographic distance to server causing latency',
          ],
          recommendation:
            'Monitor for patterns - occasional spikes may be normal, persistent degradation indicates performance issues',
        },
        `URL is DEGRADED - Response took ${latencyMs}ms (threshold: ${DEGRADED_THRESHOLD_MS}ms)`
      );
    } else {
      requestLogger.info(
        {
          statusCode: response.status,
          latencyMs,
          healthStatus,
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
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    const isTimeout =
      errorMessage.includes('abort') || errorMessage.includes('timeout');

    requestLogger.warn(
      {
        latencyMs,
        error: errorMessage,
        isTimeout,
      },
      'Health check failed'
    );

    return {
      statusCode: isTimeout ? 408 : 0,
      latencyMs,
      isHealthy: false,
      healthStatus: 'down',
      errorMessage,
    };
  }
}
