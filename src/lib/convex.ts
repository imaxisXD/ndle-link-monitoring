import { ConvexHttpClient } from 'convex/browser';

export type Environment = 'dev' | 'prod';

const CONVEX_URLS: Record<Environment, string> = {
  dev: process.env.CONVEX_URL_DEV || '',
  prod: process.env.CONVEX_URL_PROD || '',
};

// Validate configuration on startup
if (!CONVEX_URLS.dev) {
  console.warn(
    '[Monitoring Service] CONVEX_URL_DEV not set - dev Convex writes will fail'
  );
}
if (!CONVEX_URLS.prod) {
  console.warn(
    '[Monitoring Service] CONVEX_URL_PROD not set - prod Convex writes will fail'
  );
}

// Create clients for each environment
export const convexClients: Record<Environment, ConvexHttpClient> = {
  dev: new ConvexHttpClient(CONVEX_URLS.dev),
  prod: new ConvexHttpClient(CONVEX_URLS.prod),
};

/**
 * Get the Convex client for the specified environment
 */
export function getConvexClient(env: Environment): ConvexHttpClient {
  return convexClients[env];
}
