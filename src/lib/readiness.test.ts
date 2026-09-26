import { afterEach, describe, expect, test } from 'bun:test';
import { validateConfiguration } from './config';
import { componentsReady, serviceState } from './service-state';
import { isBlockedAddress, safeFetch } from './url-safety';

const saved = { ...process.env };
afterEach(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });

describe('monitor startup and destination protection', () => {
  test('production workers need only the production Convex address', () => {
    Object.assign(process.env, { DATABASE_URL: 'test', REDIS_URL: 'test', MONITORING_API_SECRET: 'test', MONITORING_SHARED_SECRET: 'test', CONVEX_URL_PROD: 'https://example.convex.cloud', MONITORING_ENVIRONMENTS: 'prod' });
    delete process.env.CONVEX_URL_DEV;
    expect(() => validateConfiguration(true)).not.toThrow();
    delete process.env.CONVEX_URL_PROD;
    expect(() => validateConfiguration(true)).toThrow('CONVEX_URL_PROD');
  });
  test('a stopped worker or stale scheduler is not ready', () => {
    Object.assign(serviceState, { started: true, stopping: false, workerReady: true, lastSchedulerSuccess: 100_000 });
    expect(componentsReady(true, true, 110_000)).toBe(true);
    expect(componentsReady(true, true, 170_000)).toBe(false);
    serviceState.workerReady = false;
    expect(componentsReady(true, true, 110_000)).toBe(false);
  });
  test('private IPv4, mapped IPv6 and link-local ranges are blocked', () => {
    expect(isBlockedAddress('127.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('::ffff:7f00:1', 6)).toBe(true);
    expect(isBlockedAddress('fe90::1', 6)).toBe(true);
    expect(isBlockedAddress('fec0::1', 6)).toBe(true);
    expect(isBlockedAddress('64:ff9b::7f00:1', 6)).toBe(true);
    expect(isBlockedAddress('8.8.8.8', 4)).toBe(false);
  });
  test('checks refuse local destinations and URL credentials with a fixed message', async () => {
    for (const input of ['http://localhost/private', 'http://name:secret@example.test', 'http://127.0.0.1/private', 'http://127.0.0.1:5432/']) {
      await expect(safeFetch(input, {})).rejects.toThrow(/^Destination is not allowed$/);
    }
  });
  test('an invalid SERVER_PUBLIC_IPS stops startup', () => {
    Object.assign(process.env, { DATABASE_URL: 'test', REDIS_URL: 'test', MONITORING_API_SECRET: 'test', SERVER_PUBLIC_IPS: '45.33.32.156, not-an-ip' });
    expect(() => validateConfiguration(false)).toThrow('SERVER_PUBLIC_IPS');
    process.env.SERVER_PUBLIC_IPS = '45.33.32.156, 2a01:4f8:c17:1::1';
    expect(() => validateConfiguration(false)).not.toThrow();
  });
});
