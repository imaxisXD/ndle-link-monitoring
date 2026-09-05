import { ConvexHttpClient } from 'convex/browser';
import { enabledEnvironments } from './config';

export type Environment = 'dev' | 'prod';
const clients = new Map<Environment, ConvexHttpClient>();

export function getConvexClient(environment: Environment): ConvexHttpClient {
  if (!enabledEnvironments().includes(environment)) {
    throw new Error(`Checks for ${environment} are not enabled on this worker`);
  }
  let client = clients.get(environment);
  if (!client) {
    const address = process.env[`CONVEX_URL_${environment.toUpperCase()}`];
    if (!address) throw new Error(`Convex URL for ${environment} is required`);
    client = new ConvexHttpClient(address);
    clients.set(environment, client);
  }
  return client;
}
