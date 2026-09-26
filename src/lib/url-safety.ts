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

// This server's public addresses. Coolify, the analytics service, PostgreSQL and Redis share it,
// so a destination that resolves here is never requested. Rebuilt whenever the addresses change.
let serverAddresses = new BlockList();

export function setServerAddresses(addresses: string[]): void {
  const next = new BlockList();
  for (const address of addresses) {
    const family = isIP(address);
    if (family) next.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
  }
  serverAddresses = next;
}

export function isServerAddress(address: string, family: number): boolean {
  return (family === 4 || family === 6) && serverAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Explicit ports other than the usual web ports could reach internal services. '' is the scheme default.
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

// A URL that can never be monitored. The message is safe to return to callers.
export class InvalidUrlError extends Error {
  readonly code = 'invalid_url';
}

// Link owners see only these messages. Details stay in server logs.
export const CHECK_FAILURES = {
  unresolved: 'Domain does not resolve',
  refused: 'Connection refused',
  timeout: 'Connection timed out',
  connection: 'Connection failed',
  tls: 'Secure connection failed',
  redirects: 'Too many redirects',
  notAllowed: 'Destination is not allowed',
  unexpected: 'Unexpected error',
} as const;
export type CheckFailure = (typeof CHECK_FAILURES)[keyof typeof CHECK_FAILURES];

// A failed check with an owner-safe message. `cause` keeps the detail for logs. A destination the
// service refuses to request, although visitors may reach it, is `unknown` rather than `down`.
export class CheckFailureError extends Error {
  constructor(readonly failure: CheckFailure, cause?: unknown, readonly healthStatus: 'down' | 'unknown' = 'down') {
    super(failure, { cause });
  }
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR']);
const CONNECTION_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL']);
const TLS_CODE = /CERT|SSL|TLS|EPROTO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HANDSHAKE/;

// An aborted request is a timeout whatever it rejected with: in Bun an aborted pinned request can reject with ECONNREFUSED.
export function describeCheckFailure(error: unknown, aborted: boolean): CheckFailure {
  if (aborted) return CHECK_FAILURES.timeout;
  if (error instanceof CheckFailureError) return error.failure;
  if (error instanceof InvalidUrlError) return CHECK_FAILURES.notAllowed;
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  const errorCode = typeof code === 'string' ? code : '';
  if (name === 'AbortError' || name === 'TimeoutError' || TIMEOUT_CODES.has(errorCode)) return CHECK_FAILURES.timeout;
  if (errorCode === 'ECONNREFUSED') return CHECK_FAILURES.refused;
  if (TLS_CODE.test(errorCode)) return CHECK_FAILURES.tls;
  if (CONNECTION_CODES.has(errorCode)) return CHECK_FAILURES.connection;
  return CHECK_FAILURES.unexpected;
}

export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;
const resolveAll: ResolveHost = hostname => lookup(hostname, { all: true, verbatim: true });

export type PinnedRequest = { method: string; headers: Record<string, string>; signal?: AbortSignal; lookup: LookupFunction };
// Sends one request and resolves with its status and headers. Tests replace it to avoid the network.
export type SendRequest = (url: URL, request: PinnedRequest) => Promise<Response>;

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
  if (!ALLOWED_PORTS.has(url.port)) throw new InvalidUrlError('Only ports 80, 443, 8080 and 8443 can be monitored');
  const family = isIP(hostname);
  if (family && isBlockedAddress(hostname, family)) throw new InvalidUrlError('URL points to a private network address');
  return url;
}

async function resolveSafeUrl(input: string, resolveHost: ResolveHost, signal?: AbortSignal | null) {
  let parsed: ReturnType<typeof parseHttpUrl>;
  try { parsed = parseHttpUrl(input); } catch (error) { throw new CheckFailureError(CHECK_FAILURES.notAllowed, error); }
  const { url, hostname } = parsed;
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new CheckFailureError(CHECK_FAILURES.notAllowed, new Error('Destination port is not allowed'), 'unknown');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const records = await Promise.race([
      // Any resolver failure means visitors cannot reach the name either; the raw error stays in `cause`.
      resolveHost(hostname).catch(error => { throw new CheckFailureError(CHECK_FAILURES.unresolved, error); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckFailureError(CHECK_FAILURES.unresolved, new Error('Hostname lookup timed out'))), 5000);
        onAbort = () => reject(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    if (!records.length) throw new CheckFailureError(CHECK_FAILURES.unresolved, new Error('Hostname has no addresses'));
    if (records.some(record => isBlockedAddress(record.address, record.family))) {
      throw new CheckFailureError(CHECK_FAILURES.notAllowed, new Error('Destination resolves to a private network address'));
    }
    if (records.some(record => isServerAddress(record.address, record.family))) {
      throw new CheckFailureError(CHECK_FAILURES.notAllowed, new Error("Destination resolves to this server's public address"), 'unknown');
    }
    return { url, records };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

const sendPinnedRequest: SendRequest = (url, { method, headers, signal, lookup: pinnedLookup }) =>
  new Promise<Response>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    // Settle as soon as the check is aborted, even if the socket is slow to close.
    const onAbort = () => { request.destroy(); reject(signal?.reason); };
    const request = send(url, { method, headers, signal, lookup: pinnedLookup }, incoming => {
      signal?.removeEventListener('abort', onAbort);
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      // Health checks need headers only. Never download an unbounded response body.
      incoming.destroy();
      resolve(new Response(null, { status: incoming.statusCode ?? 502, headers: responseHeaders }));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', error => { signal?.removeEventListener('abort', onAbort); reject(error); });
    request.end();
  });

// Browsers allow 20; ten covers real redirect chains such as tracking links and locale redirects.
export const MAX_REDIRECTS = 10;

export async function safeFetch(input: string, init: RequestInit, resolveHost = resolveAll, send = sendPinnedRequest): Promise<Response> {
  let target = input;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    // Every hop is validated again: scheme, port, private ranges and this server's addresses.
    const { url, records } = await resolveSafeUrl(target, resolveHost, init.signal);
    // Pin the connection to the addresses we checked. Keeping the URL preserves Host and TLS SNI.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    };
    const response = await send(url, {
      method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal ?? undefined, lookup: pinnedLookup,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    try { target = new URL(location, url).toString(); } catch {
      throw new CheckFailureError(CHECK_FAILURES.unexpected, new Error('Redirect location is not a valid URL'));
    }
  }
  throw new CheckFailureError(CHECK_FAILURES.redirects);
}

export function redactUrlForLogs(input: string): string {
  try { const url = new URL(input); return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`; }
  catch { return '[invalid-url]'; }
}
