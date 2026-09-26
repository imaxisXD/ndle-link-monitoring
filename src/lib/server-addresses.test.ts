import { afterEach, describe, expect, mock, test } from 'bun:test';
import { configuredServerAddresses, createServerAddressRefresher, parseTraceAddress } from './server-addresses';
import { isServerAddress, setServerAddresses } from './url-safety';

const saved = process.env.SERVER_PUBLIC_IPS;
afterEach(() => {
  setServerAddresses([]);
  if (saved === undefined) delete process.env.SERVER_PUBLIC_IPS; else process.env.SERVER_PUBLIC_IPS = saved;
});

const trace = (ip: string) => `fl=123f45\nh=1.1.1.1\nip=${ip}\nts=1790000000.1\nvisit_scheme=https\nuag=Bun\ncolo=FRA\nhttp=http/1.1\nloc=DE\ntls=TLSv1.3\nsni=off\nwarp=off\ngateway=off\n`;
const addressFor = (input: string | URL | Request) => String(input).includes('[') ? '2a01:4f8:c17:1::1' : '45.33.32.156';

describe("learning this server's public addresses", () => {
  test('the ip= line of the IPv4 and IPv6 trace responses is blocked, each request with a timeout', async () => {
    delete process.env.SERVER_PUBLIC_IPS;
    const requests: Array<{ url: string; signal: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), signal: init?.signal });
      return new Response(trace(addressFor(input)));
    }) as typeof fetch;
    const warn = mock(() => {});
    expect(await createServerAddressRefresher(fetchImpl, { warn })()).toEqual(['45.33.32.156', '2a01:4f8:c17:1::1']);
    expect(requests.map(request => request.url).sort()).toEqual(['https://1.1.1.1/cdn-cgi/trace', 'https://[2606:4700:4700::1111]/cdn-cgi/trace']);
    for (const request of requests) expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(isServerAddress('45.33.32.156', 4)).toBe(true);
    expect(isServerAddress('2a01:4f8:c17:1::1', 6)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test('SERVER_PUBLIC_IPS is always blocked, and a failed lookup warns once per address family', async () => {
    process.env.SERVER_PUBLIC_IPS = ' 45.33.32.200 , 2a01:4f8:c17:1::5 ';
    const fetchImpl = (async () => { throw new Error('Network is unreachable'); }) as unknown as typeof fetch;
    const warn = mock(() => {});
    const refresh = createServerAddressRefresher(fetchImpl, { warn });
    for (let hour = 0; hour < 3; hour++) expect(await refresh()).toEqual(['45.33.32.200', '2a01:4f8:c17:1::5']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(isServerAddress('45.33.32.200', 4)).toBe(true);
    expect(isServerAddress('2a01:4f8:c17:1::5', 6)).toBe(true);
  });

  test('a later failed lookup keeps the last learned address', async () => {
    delete process.env.SERVER_PUBLIC_IPS;
    let online = true;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (!online) return new Response('upstream error', { status: 502 });
      return new Response(trace(addressFor(input)));
    }) as typeof fetch;
    const refresh = createServerAddressRefresher(fetchImpl, { warn: () => {} });
    await refresh();
    online = false;
    expect(await refresh()).toEqual(['45.33.32.156', '2a01:4f8:c17:1::1']);
    expect(isServerAddress('45.33.32.156', 4)).toBe(true);
  });

  test('a trace response without an address of the expected family is ignored', () => {
    expect(parseTraceAddress(trace('45.33.32.156'), 4)).toBe('45.33.32.156');
    expect(parseTraceAddress(trace('2a01:4f8:c17:1::1'), 6)).toBe('2a01:4f8:c17:1::1');
    expect(parseTraceAddress(trace('2a01:4f8:c17:1::1'), 4)).toBeNull();
    expect(parseTraceAddress(trace('not-an-address'), 4)).toBeNull();
    expect(parseTraceAddress('<html>captive portal</html>', 4)).toBeNull();
  });

  test('SERVER_PUBLIC_IPS must contain only IP addresses', () => {
    expect(configuredServerAddresses(undefined)).toEqual([]);
    expect(configuredServerAddresses('')).toEqual([]);
    expect(configuredServerAddresses('45.33.32.156,2a01:4f8::1')).toEqual(['45.33.32.156', '2a01:4f8::1']);
    expect(() => configuredServerAddresses('45.33.32.156, monitor.ndle.app')).toThrow('SERVER_PUBLIC_IPS');
    expect(() => configuredServerAddresses('45.33.32.0/24')).toThrow('SERVER_PUBLIC_IPS');
  });
});
