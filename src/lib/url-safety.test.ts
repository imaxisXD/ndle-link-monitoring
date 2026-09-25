import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as dns from 'node:dns/promises';
import { InvalidUrlError, safeFetch, validateRegistrationUrl, type ResolveHost } from './url-safety';

const lookup = spyOn(dns, 'lookup');
afterEach(() => lookup.mockClear());
afterAll(() => lookup.mockRestore());

function rejection(input: string): InvalidUrlError {
  try { validateRegistrationUrl(input); } catch (error) {
    if (error instanceof InvalidUrlError) return error;
    throw error;
  }
  throw new Error(`${input} was accepted`);
}

describe('registration URL validation', () => {
  test('public hostnames are accepted without a DNS lookup', () => {
    expect(validateRegistrationUrl('https://Example.com/landing?ref=1').toString()).toBe('https://example.com/landing?ref=1');
    expect(validateRegistrationUrl('http://8.8.8.8/').toString()).toBe('http://8.8.8.8/');
    expect(validateRegistrationUrl('https://[2606:4700:4700::1111]/').hostname).toBe('[2606:4700:4700::1111]');
    expect(validateRegistrationUrl('https://[::ffff:8.8.8.8]/').hostname).toBe('[::ffff:808:808]');
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a hostname that does not resolve is still accepted', () => {
    expect(validateRegistrationUrl('https://expired-domain.invalid/offer').toString()).toBe('https://expired-domain.invalid/offer');
    expect(lookup).not.toHaveBeenCalled();
  });

  test('unparseable URLs and other schemes are rejected', () => {
    const unparseable = rejection('not a url');
    expect(unparseable.code).toBe('invalid_url');
    expect(unparseable.message).toBe('Invalid URL');
    for (const input of ['ftp://example.com/file', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
      expect(rejection(input).message).toBe('Only HTTP and HTTPS URLs can be monitored');
    }
  });

  test('URLs with credentials are rejected', () => {
    expect(rejection('https://user:secret@example.com/').message).toContain('credentials');
    expect(rejection('https://user@example.com/').message).toContain('credentials');
  });

  test('localhost names are rejected', () => {
    for (const input of ['http://localhost:3000/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://api.localhost./']) {
      expect(rejection(input).message).toContain('Localhost');
    }
  });

  test('literal private IPv4, IPv6 and IPv4-mapped IPv6 addresses are rejected', () => {
    for (const input of [
      'http://127.0.0.1/', 'http://10.0.0.5/', 'http://172.16.3.4/', 'http://192.168.1.1/', 'http://100.64.0.1/',
      'http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/', 'http://2130706433/', 'http://0x7f.1/',
      'http://[::1]/', 'http://[::]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[64:ff9b::a00:1]/',
      'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.5]/', 'http://[::ffff:169.254.169.254]/',
    ]) {
      const error = rejection(input);
      expect(error.code).toBe('invalid_url');
      expect(error.message).toBe('URL points to a private network address');
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('check-time destination resolution', () => {
  test('a domain that does not resolve fails with a clear message', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA']) {
      const unresolved: ResolveHost = async hostname => {
        throw Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code });
      };
      await expect(safeFetch('https://expired-domain.invalid/', {}, unresolved)).rejects.toThrow(/^Domain does not resolve$/);
    }
  });

  test('a destination that resolves to a private address is refused without echoing it', async () => {
    for (const records of [[{ address: '10.20.30.40', family: 4 }], [{ address: '93.184.215.14', family: 4 }, { address: '::ffff:a14:1e28', family: 6 }]]) {
      const error = await safeFetch('https://internal.example/', {}, async () => records).catch(caught => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('URL resolves to a private network address');
      for (const record of records) expect(error.message).not.toContain(record.address);
    }
  });
});
