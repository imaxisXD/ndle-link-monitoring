import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 32], ['2002::', 16],
] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isBlockedAddress(address: string, family: number): boolean {
  return family !== 4 && family !== 6 || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// A URL that can never be monitored. The message is safe to return to callers.
export class InvalidUrlError extends Error {
  readonly code = 'invalid_url';
}

export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;
const resolveAll: ResolveHost = hostname => lookup(hostname, { all: true, verbatim: true });
// DNS answers meaning the domain has no address, for example after it expired.
const UNRESOLVED_DOMAIN_CODES = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA']);

function parseHttpUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new InvalidUrlError('Invalid URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InvalidUrlError('Only HTTP and HTTPS URLs can be monitored');
  if (url.username || url.password) throw new InvalidUrlError('URLs with credentials cannot be monitored');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const name = hostname.replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) throw new InvalidUrlError('Localhost URLs cannot be monitored');
  return { url, hostname };
}

// Registration must not depend on DNS: an expired domain should be registered and then reported as down.
// Each check still resolves the hostname, pins the connection and refuses private addresses.
export function validateRegistrationUrl(input: string): URL {
  const { url, hostname } = parseHttpUrl(input);
  const family = isIP(hostname);
  if (family && isBlockedAddress(hostname, family)) throw new InvalidUrlError('URL points to a private network address');
  return url;
}

async function resolveSafeUrl(input: string, resolveHost: ResolveHost) {
  const { url, hostname } = parseHttpUrl(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      // Checks record this message, so replace the raw resolver error with a clear one.
      resolveHost(hostname).catch(error => {
        throw UNRESOLVED_DOMAIN_CODES.has(error?.code) ? new Error('Domain does not resolve') : error;
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('URL hostname lookup timed out')), 5000); }),
    ]);
    if (!records.length || records.some(record => isBlockedAddress(record.address, record.family))) {
      throw new Error('URL resolves to a private network address');
    }
    return { url, records };
  } finally { clearTimeout(timer); }
}

export async function safeFetch(input: string, init: RequestInit, resolveHost = resolveAll): Promise<Response> {
  let target = input;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const { url, records } = await resolveSafeUrl(target, resolveHost);
    // Pin the connection to the addresses we checked. Keeping the URL preserves Host and TLS SNI.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    };
    const response = await new Promise<Response>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(url, {
        method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined, lookup: pinnedLookup,
      }, incoming => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        // Health checks need headers only. Never download an unbounded response body.
        incoming.destroy();
        resolve(new Response(null, { status: incoming.statusCode ?? 502, headers }));
      });
      request.on('error', reject);
      request.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    target = new URL(location, url).toString();
  }
  throw new Error('Too many redirects');
}

export function redactUrlForLogs(input: string): string {
  try { const url = new URL(input); return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`; }
  catch { return '[invalid-url]'; }
}
