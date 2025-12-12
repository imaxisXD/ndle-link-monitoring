import { ConvexHttpClient } from 'convex/browser';

const CONVEX_URL = process.env.CONVEX_URL;

if (!CONVEX_URL) {
  console.warn(
    '[Monitoring Service] CONVEX_URL not set - Convex writes will fail'
  );
}

export const convexClient = new ConvexHttpClient(CONVEX_URL || '');
