import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as dns from 'node:dns/promises';
import {
  CHECK_FAILURES, CheckFailureError, describeCheckFailure, InvalidUrlError, isServerAddress, MAX_REDIRECTS, safeFetch,
  setServerAddresses, validateRegistrationUrl, type ResolveHost, type SendRequest,
} from './url-safety';

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
      expect(error).toBeInstanceOf(CheckFailureError);
      expect(error.message).toBe('Destination is not allowed');
      expect(error.healthStatus).toBe('down');
      for (const record of records) expect(error.message).not.toContain(record.address);
    }
  });

  test('any resolver failure is reported as a domain that does not resolve, without the raw error', async () => {
    for (const code of ['ESERVFAIL', 'EAI_AGAIN', 'ECONNREFUSED']) {
      const failing: ResolveHost = async () => { throw Object.assign(new Error(`queryA ${code} secret.example`), { code }); };
      const error = await safeFetch('https://secret.example/', {}, failing).catch(caught => caught);
      expect(error.message).toBe('Domain does not resolve');
      expect(describeCheckFailure(error, false)).toBe('Domain does not resolve');
    }
    const empty = await safeFetch('https://empty.example/', {}, async () => []).catch(caught => caught);
    expect(empty.message).toBe('Domain does not resolve');
  });

  test('an aborted check stops waiting for a slow resolver', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const error = await safeFetch('https://slow-dns.example/', { signal: controller.signal }, () => new Promise(() => {})).catch(caught => caught);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(describeCheckFailure(error, controller.signal.aborted)).toBe('Connection timed out');
  });
});

const publicRecords: ResolveHost = async () => [{ address: '93.184.215.14', family: 4 }];
const reply = (status: number, headers?: Record<string, string>) => new Response(null, { status, headers });

describe('destination port allowlist', () => {
  test('registration accepts default ports and 80, 443, 8080 and 8443', () => {
    for (const input of [
      'https://example.com/', 'http://example.com:80/', 'https://example.com:443/', 'http://example.com:8080/',
      'https://example.com:8443/', 'https://example.com:80/', 'http://example.com:443/', 'https://[2606:4700:4700::1111]:8443/',
    ]) expect(() => validateRegistrationUrl(input)).not.toThrow();
  });

  test('registration rejects every other explicit port as invalid_url', () => {
    for (const input of ['http://example.com:8000/', 'https://example.com:22/', 'http://example.com:5432/', 'http://8.8.8.8:6379/', 'https://example.com:3000/', 'http://example.com:1/']) {
      const error = rejection(input);
      expect(error.code).toBe('invalid_url');
      expect(error.message).toBe('Only ports 80, 443, 8080 and 8443 can be monitored');
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  test('checks refuse other ports before resolving or requesting, including on redirect hops', async () => {
    const resolveHost = mock(publicRecords);
    const send = mock<SendRequest>(async () => reply(200));
    const direct = await safeFetch('http://example.com:8000/', {}, resolveHost, send).catch(caught => caught);
    expect(direct).toBeInstanceOf(CheckFailureError);
    expect(direct.message).toBe('Destination is not allowed');
    expect(direct.healthStatus).toBe('unknown');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    send.mockImplementationOnce(async () => reply(301, { location: 'http://example.com:8000/admin' }));
    const redirected = await safeFetch('https://example.com/', {}, resolveHost, send).catch(caught => caught);
    expect(redirected.message).toBe('Destination is not allowed');
    expect(send).toHaveBeenCalledTimes(1);

    send.mockImplementationOnce(async () => reply(302, { location: 'https://example.com:8443/next' }));
    expect((await safeFetch('https://example.com/', {}, resolveHost, send)).status).toBe(200);
    expect(send.mock.calls.map(([url]) => url.toString())).toEqual(['https://example.com/', 'https://example.com/', 'https://example.com:8443/next']);
  });
});

describe("this server's own addresses", () => {
  afterEach(() => setServerAddresses([]));

  test('a destination resolving to a server address is refused, in any notation', async () => {
    setServerAddresses(['45.33.32.156', '2a01:4f8:c17:1::1']);
    const send = mock<SendRequest>(async () => reply(200));
    for (const records of [
      [{ address: '45.33.32.156', family: 4 }],
      [{ address: '::ffff:45.33.32.156', family: 6 }],
      [{ address: '2A01:04F8:0C17:0001:0000:0000:0000:0001', family: 6 }],
      [{ address: '93.184.215.14', family: 4 }, { address: '2a01:4f8:c17:1::1', family: 6 }],
    ]) {
      const error = await safeFetch('https://self.example/', {}, async () => records, send).catch(caught => caught);
      expect(error).toBeInstanceOf(CheckFailureError);
      expect(error.message).toBe('Destination is not allowed');
      expect(error.healthStatus).toBe('unknown');
      for (const record of records) expect(error.message).not.toContain(record.address);
    }
    expect(send).not.toHaveBeenCalled();
    expect(isServerAddress('45.33.32.157', 4)).toBe(false);
    expect(isServerAddress('2a01:4f8:c17:1::2', 6)).toBe(false);
  });

  test('a redirect to the server is refused before it is requested', async () => {
    setServerAddresses(['45.33.32.156']);
    const resolveHost: ResolveHost = async hostname => [{ address: hostname === 'coolify.example' ? '45.33.32.156' : '93.184.215.14', family: 4 }];
    const send = mock<SendRequest>(async () => reply(302, { location: 'https://coolify.example/api' }));
    const error = await safeFetch('https://public.example/', {}, resolveHost, send).catch(caught => caught);
    expect(error.message).toBe('Destination is not allowed');
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('clearing the addresses allows the destination again', async () => {
    setServerAddresses(['45.33.32.156']);
    setServerAddresses([]);
    const send = mock<SendRequest>(async () => reply(200));
    expect((await safeFetch('https://self.example/', {}, async () => [{ address: '45.33.32.156', family: 4 }], send)).status).toBe(200);
  });
});

describe('check failure messages', () => {
  const coded = (code: string) => Object.assign(new Error(`connect ${code} 45.33.32.156:443 https://example.com/?token=secret`), { code });

  test('every failure maps to a short fixed message', () => {
    const table: Array<[unknown, boolean, string]> = [
      [coded('ECONNREFUSED'), false, 'Connection refused'],
      [coded('ECONNREFUSED'), true, 'Connection timed out'],
      [coded('ETIMEDOUT'), false, 'Connection timed out'],
      [new DOMException('The operation was aborted.', 'AbortError'), false, 'Connection timed out'],
      [new DOMException('The operation timed out.', 'TimeoutError'), false, 'Connection timed out'],
      [coded('CERT_HAS_EXPIRED'), false, 'Secure connection failed'],
      [coded('ERR_TLS_CERT_ALTNAME_INVALID'), false, 'Secure connection failed'],
      [coded('DEPTH_ZERO_SELF_SIGNED_CERT'), false, 'Secure connection failed'],
      [coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), false, 'Secure connection failed'],
      [coded('ERR_SSL_WRONG_VERSION_NUMBER'), false, 'Secure connection failed'],
      [coded('ECONNRESET'), false, 'Connection failed'],
      [coded('EHOSTUNREACH'), false, 'Connection failed'],
      [new CheckFailureError(CHECK_FAILURES.redirects), false, 'Too many redirects'],
      [new CheckFailureError(CHECK_FAILURES.notAllowed), true, 'Connection timed out'],
      [new InvalidUrlError('Localhost URLs cannot be monitored'), false, 'Destination is not allowed'],
      [new Error('Unexpected token < in https://example.com/?token=secret'), false, 'Unexpected error'],
      [coded('HPE_INVALID_CONSTANT'), false, 'Unexpected error'],
      ['a thrown string', false, 'Unexpected error'],
      [undefined, false, 'Unexpected error'],
    ];
    const allowed: string[] = Object.values(CHECK_FAILURES);
    for (const [error, aborted, expected] of table) {
      const message: string = describeCheckFailure(error, aborted);
      expect(message).toBe(expected);
      expect(allowed).toContain(message);
      expect(message).not.toMatch(/secret|45\.33|https?:/);
    }
  });

  test(`at most ${MAX_REDIRECTS} redirects are followed`, async () => {
    const send = mock<SendRequest>(async url => reply(302, { location: `/hop-${url.pathname.length}` }));
    const error = await safeFetch('https://loop.example/', {}, publicRecords, send).catch(caught => caught);
    expect(error.message).toBe('Too many redirects');
    expect(send).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  test('requests are pinned to the validated addresses', async () => {
    const records = [{ address: '93.184.215.14', family: 4 }, { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }];
    const send = mock<SendRequest>(async () => reply(204));
    await safeFetch('https://pinned.example/', { method: 'HEAD' }, async () => records, send);
    const [[url, request]] = send.mock.calls;
    expect(url.hostname).toBe('pinned.example');
    expect(request.method).toBe('HEAD');
    const all = await new Promise(resolve => request.lookup('pinned.example', { all: true }, (_error, addresses) => resolve(addresses)));
    expect(all).toEqual(records);
    const one = await new Promise(resolve => request.lookup('pinned.example', {}, (_error, address, family) => resolve([address, family])));
    expect(one).toEqual(['93.184.215.14', 4]);
  });
});
