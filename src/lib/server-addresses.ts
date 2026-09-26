import { isIP } from 'node:net';
import { logger } from './logger';
import { setServerAddresses } from './url-safety';

// Cloudflare echoes the caller's public address. The IPv6 request fails harmlessly on IPv4-only servers.
const TRACE_ENDPOINTS = [
  { family: 4, url: 'https://1.1.1.1/cdn-cgi/trace' },
  { family: 6, url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace' },
] as const;
const TRACE_TIMEOUT_MS = 5000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// SERVER_PUBLIC_IPS lists addresses that are always blocked, in addition to the learned ones.
export function configuredServerAddresses(value = process.env.SERVER_PUBLIC_IPS): string[] {
  const addresses = (value ?? '').split(',').map(address => address.trim()).filter(Boolean);
  if (addresses.some(address => !isIP(address))) {
    throw new Error('SERVER_PUBLIC_IPS must be a comma-separated list of IP addresses');
  }
  return addresses;
}

export function parseTraceAddress(body: string, family: 4 | 6): string | null {
  const address = body.split('\n').find(line => line.startsWith('ip='))?.slice(3).trim() ?? '';
  return isIP(address) === family ? address : null;
}

// Returns a refresh function that keeps the last learned address per family when a lookup fails.
export function createServerAddressRefresher(fetchImpl: typeof fetch = fetch, log: Pick<typeof logger, 'warn'> = logger) {
  const learned = new Map<4 | 6, string>();
  const warned = new Set<4 | 6>();
  return async function refreshServerAddresses(): Promise<string[]> {
    await Promise.all(TRACE_ENDPOINTS.map(async ({ family, url }) => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`Address lookup returned HTTP ${response.status}`);
        const address = parseTraceAddress(await response.text(), family);
        if (!address) throw new Error('Address lookup did not return an address');
        learned.set(family, address);
      } catch (error) {
        // Checks continue with the addresses already known. Warn once, not every hour.
        if (warned.has(family)) return;
        warned.add(family);
        log.warn({ err: error, family }, "Could not learn this server's public address");
      }
    }));
    const addresses = [...new Set([...configuredServerAddresses(), ...learned.values()])];
    setServerAddresses(addresses);
    return addresses;
  };
}

let interval: Timer | null = null;

// Learns the addresses before the worker starts, then hourly.
export async function startServerAddressRefresh(refresh = createServerAddressRefresher()): Promise<void> {
  if (interval) return;
  await refresh();
  interval = setInterval(() => {
    refresh().catch(error => logger.warn({ err: error }, 'Server address refresh failed'));
  }, REFRESH_INTERVAL_MS);
  interval.unref();
}

export function stopServerAddressRefresh(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
