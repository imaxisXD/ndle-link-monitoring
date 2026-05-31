import { lookup } from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 3;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:169.254.') ||
    normalized.startsWith('::ffff:172.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

export async function assertSafeHttpUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS URLs can be monitored');
  }
  if (url.username || url.password) {
    throw new Error('URLs with credentials cannot be monitored');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Localhost URLs cannot be monitored');
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error('URL hostname did not resolve');
  }

  for (const record of records) {
    const family = net.isIP(record.address);
    if (family === 4 && isPrivateIpv4(record.address)) {
      throw new Error('URL resolves to a private network address');
    }
    if (family === 6 && isPrivateIpv6(record.address)) {
      throw new Error('URL resolves to a private network address');
    }
  }

  return url;
}

export async function safeFetch(input: string, init: RequestInit): Promise<Response> {
  let currentUrl = await assertSafeHttpUrl(input);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(currentUrl.toString(), {
      ...init,
      redirect: 'manual',
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    currentUrl = await assertSafeHttpUrl(new URL(location, currentUrl).toString());
  }

  throw new Error('Too many redirects');
}

export function redactUrlForLogs(input: string): string {
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}
