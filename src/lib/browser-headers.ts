// Pool of realistic User-Agents (Chrome, Firefox, Safari on different OS)
export const USER_AGENTS = [
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
] as const;

export function getRandomUserAgent(random: () => number = Math.random): string {
  return USER_AGENTS[Math.floor(random() * USER_AGENTS.length)] ?? USER_AGENTS[0];
}

export function getBrowserHeaders(userAgent: string): Record<string, string> {
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
