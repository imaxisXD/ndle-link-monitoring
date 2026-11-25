import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

export type PinnedRequest = {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  lookup: LookupFunction;
};

// Sends one request and resolves with its status and headers. Tests replace it to avoid the network.
export type SendRequest = (
  url: URL,
  request: PinnedRequest
) => Promise<Response>;

export function buildPinnedRequestHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'connection') continue;
    sanitized[name] = value;
  }
  sanitized['Connection'] = 'close';
  return sanitized;
}

export const sendPinnedRequest: SendRequest = (
  url,
  { method, headers, signal, lookup: pinnedLookup }
) =>
  new Promise<Response>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const pinnedHeaders = buildPinnedRequestHeaders(headers);
    // Settle as soon as the check is aborted, even if the socket is slow to close.
    const onAbort = () => {
      request.destroy();
      reject(signal?.reason);
    };
    // Disable agent connection pooling and request Connection: close so sockets
    // are never reused across pinned DNS resolutions.
    const request = send(
      url,
      {
        method,
        headers: pinnedHeaders,
        signal,
        lookup: pinnedLookup,
        agent: false,
      },
      incoming => {
        signal?.removeEventListener('abort', onAbort);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        // Health checks need headers only. Never download an unbounded response body.
        incoming.destroy();
        resolve(
          new Response(null, {
            status: incoming.statusCode ?? 502,
            headers: responseHeaders,
          })
        );
      }
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', error => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    request.end();
  });
