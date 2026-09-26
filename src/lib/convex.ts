import { ConvexHttpClient } from 'convex/browser';
import { enabledEnvironments } from './config';

export type Environment = 'dev' | 'prod';
const clients = new Map<Environment, ConvexHttpClient>();

export const CONVEX_REQUEST_TIMEOUT_MS = 10_000;

// Each Convex request gets its own deadline, so one hung delivery cannot hold a worker slot.
export function withRequestTimeout(
  fetchImpl: typeof fetch,
  timeoutMs = CONVEX_REQUEST_TIMEOUT_MS
): typeof fetch {
  return ((input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetchImpl(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  }) as typeof fetch;
}

// Mutations share this client. Callers pass `{ skipQueue: true }` so deliveries run in parallel
// instead of waiting behind the client's single mutation queue.
export function getConvexClient(environment: Environment): ConvexHttpClient {
  if (!enabledEnvironments().includes(environment)) {
    throw new Error(`Checks for ${environment} are not enabled on this worker`);
  }
  let client = clients.get(environment);
  if (!client) {
    const address = process.env[`CONVEX_URL_${environment.toUpperCase()}`];
    if (!address) throw new Error(`Convex URL for ${environment} is required`);
    client = new ConvexHttpClient(address, {
      fetch: withRequestTimeout(fetch),
    });
    clients.set(environment, client);
  }
  return client;
}
