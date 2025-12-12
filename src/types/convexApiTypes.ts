import { type FunctionReference, anyApi } from 'convex/server';
import { type GenericId as Id } from 'convex/values';

export const api: PublicApiType = anyApi as unknown as PublicApiType;
export const internal: InternalApiType = anyApi as unknown as InternalApiType;

export type PublicApiType = {
  users: {
    store: FunctionReference<'mutation', 'public', Record<string, never>, any>;
  };
  urlMainFuction: {
    createUrl: FunctionReference<
      'mutation',
      'public',
      {
        collectionId?: Id<'collections'>;
        expiresAt?: number;
        qrEnabled?: boolean;
        qrStyle?: {
          bg: string;
          customLogoUrl?: string;
          fg: string;
          logoMode: 'brand' | 'custom' | 'none';
          logoScale: number;
          margin: number;
        };
        slugType: 'random' | 'human';
        trackingEnabled: boolean;
        url: string;
      },
      { docId: Id<'urls'>; slug: string }
    >;
    getUserUrls: FunctionReference<
      'query',
      'public',
      Record<string, never>,
      any
    >;
    getUserUrlsWithAnalytics: FunctionReference<
      'query',
      'public',
      Record<string, never>,
      any
    >;
    getUserUrlsWithAnalyticsByCollection: FunctionReference<
      'query',
      'public',
      { collectionId: Id<'collections'> },
      any
    >;
    deleteUrl: FunctionReference<
      'mutation',
      'public',
      { urlSlug: string },
      any
    >;
  };
  urlAnalytics: {
    getUrlAnalytics: FunctionReference<
      'query',
      'public',
      { urlSlug: string },
      any
    >;
    getUsersTotalClicks: FunctionReference<
      'query',
      'public',
      Record<string, never>,
      any
    >;
    mutateUrlAnalytics: FunctionReference<
      'mutation',
      'public',
      {
        requestId: string;
        sharedSecret: string;
        urlId: string;
        urlStatusCode: number;
        urlStatusMessage: string;
        userId: string;
      },
      { message: string; processed: boolean }
    >;
  };
  collectionMangament: {
    getCollectionById: FunctionReference<
      'query',
      'public',
      { collectionId: string },
      any
    >;
    getUserUrlsNotInCollection: FunctionReference<
      'query',
      'public',
      { collectionId: Id<'collections'> },
      Array<{
        _creationTime: number;
        _id: Id<'urls'>;
        fullurl: string;
        shortUrl: string;
        slugAssigned?: string;
      }>
    >;
    addUrlToCollection: FunctionReference<
      'mutation',
      'public',
      { collectionId: Id<'collections'>; urlId: Id<'urls'> },
      any
    >;
    getUserCollections: FunctionReference<
      'query',
      'public',
      Record<string, never>,
      any
    >;
    createCollection: FunctionReference<
      'mutation',
      'public',
      { collectionColor: string; description?: string; name: string },
      any
    >;
    deleteCollection: FunctionReference<
      'mutation',
      'public',
      { collectionId: Id<'collections'> },
      null
    >;
  };
  analyticsCache: {
    getAnalytics: FunctionReference<
      'query',
      'public',
      {
        linkSlug?: string;
        range:
          | '24h'
          | '7d'
          | '30d'
          | '3mo'
          | '12mo'
          | 'mtd'
          | 'qtd'
          | 'ytd'
          | 'all';
        scope: string;
      },
      {
        cachedAt: number;
        data: any;
        exists: boolean;
        fresh: boolean;
        ttlSec: number;
      }
    >;
    requestRefresh: FunctionReference<
      'mutation',
      'public',
      {
        linkSlug?: string;
        range:
          | '24h'
          | '7d'
          | '30d'
          | '3mo'
          | '12mo'
          | 'mtd'
          | 'qtd'
          | 'ytd'
          | 'all';
        scope: string;
      },
      { scheduled: boolean }
    >;
  };
  linkHealth: {
    recordHealthCheck: FunctionReference<
      'mutation',
      'public',
      {
        checkedAt: number;
        errorMessage?: string;
        healthStatus: 'up' | 'down' | 'degraded';
        isHealthy: boolean;
        latencyMs: number;
        longUrl: string;
        sharedSecret: string;
        shortUrl: string;
        statusCode: number;
        urlId: string;
        userId: string;
      },
      any
    >;
  };
};
export type InternalApiType = {};
