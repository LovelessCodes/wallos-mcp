import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config.js';
import { WallosApiError, WallosHttpError } from '../src/errors.js';
import { WallosClient } from '../src/wallos-client.js';

const API_KEY = 'sk-secret-key-abcdef';

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    baseUrl: 'https://wallos.example.com',
    apiKey: API_KEY,
    timeoutMs: 5_000,
    insecureTls: false,
    readOnly: false,
    enableAdminTools: false,
    ...overrides,
  };
}

interface Captured {
  url: URL;
  init: RequestInit;
}

let captured: Captured[] = [];
const originalFetch = globalThis.fetch;

function stubFetch(respond: (captured: Captured) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const entry: Captured = {
      url: new URL(String(input)),
      init: init ?? {},
    };
    captured.push(entry);
    return respond(entry);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WallosClient request shaping', () => {
  it('puts reads in the query string, including the API key', async () => {
    stubFetch(() => jsonResponse({ success: true, title: 'categories', categories: [] }));

    await new WallosClient(makeConfig()).read('api/categories/get_categories.php', { state: 0 });

    const [call] = captured;
    expect(call?.init.method).toBe('GET');
    expect(call?.url.pathname).toBe('/api/categories/get_categories.php');
    expect(call?.url.searchParams.get('api_key')).toBe(API_KEY);
    expect(call?.url.searchParams.get('state')).toBe('0');
    expect(call?.init.body).toBeUndefined();
  });

  it('sends writes as a form-encoded body, because the endpoints only read $_POST', async () => {
    stubFetch(() => jsonResponse({ success: true, title: 'Subscription added', subscriptionId: 1 }));

    await new WallosClient(makeConfig()).write('api/subscriptions/set_subscriptions.php', {
      action: 'add',
      name: 'Netflix',
      price: 15.99,
    });

    const [call] = captured;
    expect(call?.init.method).toBe('POST');
    const contentType = new Headers(call?.init.headers).get('content-type');
    expect(contentType).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(String(call?.init.body));
    expect(body.get('api_key')).toBe(API_KEY);
    expect(body.get('action')).toBe('add');
    expect(body.get('name')).toBe('Netflix');
    expect(body.get('price')).toBe('15.99');
    // A JSON body would arrive as an empty $_POST and the endpoint would answer
    // "Missing API key", so the body must never be JSON.
    expect(String(call?.init.body)).not.toContain('{');
    expect(call?.url.search).toBe('');
  });

  it('keeps a subpath from the configured base URL', async () => {
    stubFetch(() => jsonResponse({ success: true }));
    await new WallosClient(makeConfig({ baseUrl: 'http://192.168.1.10:8282/wallos' })).read(
      'api/status/version.php',
    );
    expect(captured[0]?.url.href).toContain('/wallos/api/status/version.php');
  });

  it('drops undefined and null parameters rather than sending them as text', async () => {
    stubFetch(() => jsonResponse({ success: true }));
    await new WallosClient(makeConfig()).read('api/subscriptions/get_subscriptions.php', {
      sort: 'name',
      category: undefined,
      member: null,
    });
    const params = captured[0]?.url.searchParams;
    expect(params?.has('category')).toBe(false);
    expect(params?.has('member')).toBe(false);
    expect(params?.get('sort')).toBe('name');
  });

  it('sends flags as the literal strings the endpoints compare against', async () => {
    stubFetch(() => jsonResponse({ success: true }));
    await new WallosClient(makeConfig()).read('api/subscriptions/get_subscriptions.php', {
      convert_currency: 'true',
      disabled_to_bottom: 'false',
    });
    expect(captured[0]?.url.searchParams.get('convert_currency')).toBe('true');
    expect(captured[0]?.url.searchParams.get('disabled_to_bottom')).toBe('false');
  });
});

describe('WallosClient error handling', () => {
  it('turns an application failure into an error, since the HTTP status is always 200', async () => {
    stubFetch(() => jsonResponse({ success: false, title: 'Invalid API key', message: 'Unauthorized access.' }));

    const error = await new WallosClient(makeConfig())
      .read('api/users/get_user.php')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WallosApiError);
    expect((error as WallosApiError).title).toBe('Invalid API key');
    expect((error as WallosApiError).message).toContain('Unauthorized access.');
  });

  it('carries the notes Wallos attaches to a refusal', async () => {
    stubFetch(() =>
      jsonResponse({
        success: false,
        title: 'Invalid parameter',
        message: 'reference_date must be a valid calendar date.',
        notes: ['Check the format.'],
      }),
    );

    const error = (await new WallosClient(makeConfig())
      .read('api/subscriptions/get_period_budget.php')
      .catch((caught: unknown) => caught)) as WallosApiError;

    expect(error.notes).toEqual(['Check the format.']);
  });

  it('accepts success reported as 1 as well as true', async () => {
    stubFetch(() => jsonResponse({ success: 1, title: 'ok' }));
    await expect(new WallosClient(makeConfig()).read('api/status/version.php')).resolves.toBeDefined();
  });

  it('reports a non-2xx status', async () => {
    stubFetch(() => new Response('<html>nope</html>', { status: 502 }));

    const error = (await new WallosClient(makeConfig())
      .read('api/status/version.php')
      .catch((caught: unknown) => caught)) as WallosHttpError;

    expect(error).toBeInstanceOf(WallosHttpError);
    expect(error.status).toBe(502);
    expect(error.message).toContain('HTTP 502');
  });

  it('explains a non-JSON body, which is what a PHP fatal error looks like', async () => {
    stubFetch(() => new Response('<br /><b>Fatal error</b>: SQL logic error', { status: 200 }));

    const error = (await new WallosClient(makeConfig())
      .read('api/subscriptions/get_subscriptions.php')
      .catch((caught: unknown) => caught)) as WallosHttpError;

    expect(error.message).toContain('did not return JSON');
    expect(error.message).toContain('Fatal error');
  });

  it('returns raw bodies untouched when asked, for the calendar feed', async () => {
    stubFetch(() => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 }));
    const feed = await new WallosClient(makeConfig()).request<string>(
      'api/subscriptions/get_ical_feed.php',
      {},
      { raw: true },
    );
    expect(feed).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  });

  it('never lets the API key escape in an error message', async () => {
    stubFetch(
      () => new Response(`<b>Fatal error</b>: api_key=${API_KEY} rejected`, { status: 200 }),
    );

    const error = (await new WallosClient(makeConfig())
      .read('api/status/version.php')
      .catch((caught: unknown) => caught)) as Error;

    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('********');
  });

  it('names a timeout as a timeout', async () => {
    globalThis.fetch = (async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    }) as typeof fetch;

    const error = (await new WallosClient(makeConfig({ timeoutMs: 1500 }))
      .read('api/status/version.php')
      .catch((caught: unknown) => caught)) as WallosHttpError;

    expect(error.message).toContain('Timed out after 1500ms');
    expect(error.message).toContain('--timeout');
  });

  it('suggests --insecure-tls when the certificate is self-signed', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      });
    }) as typeof fetch;

    const error = (await new WallosClient(makeConfig())
      .read('api/status/version.php')
      .catch((caught: unknown) => caught)) as WallosHttpError;

    expect(error.message).toContain('--insecure-tls');
  });

  it('names an unreachable host', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;

    const error = (await new WallosClient(makeConfig())
      .read('api/status/version.php')
      .catch((caught: unknown) => caught)) as WallosHttpError;

    expect(error.message).toContain('Nothing is listening');
  });
});
