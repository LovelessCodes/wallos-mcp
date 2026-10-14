/**
 * An in-memory stand-in for a Wallos instance.
 *
 * It reproduces the parts of the real API that have caught people out, so the
 * tests fail the same way a real instance would:
 *
 * - every response is HTTP 200, `success` in the body is the only signal
 * - write endpoints read `$_POST` only, exactly like PHP: a JSON body arrives
 *   empty and the endpoint reports a missing API key
 * - reads take `api_key` from `$_REQUEST`, so query string or form body
 * - flags such as `convert_currency` are compared with `=== 'true'`
 */

export interface RecordedCall {
  path: string;
  method: string;
  /** Merged query string and form body, i.e. PHP's `$_REQUEST`. */
  request: URLSearchParams;
  /** Form body only, i.e. PHP's `$_POST`. */
  post: URLSearchParams;
  contentType: string;
}

export interface FakeWallos {
  calls: RecordedCall[];
  /** Calls to a given endpoint path, in order. */
  callsTo(path: string): RecordedCall[];
  lastCall(): RecordedCall | undefined;
  restore(): void;
}

export const API_KEY = 'test-api-key-1234567890';

export interface FakeOptions {
  apiKey?: string;
  /** Extra or overriding handlers, keyed by endpoint path. */
  handlers?: Record<string, (call: RecordedCall) => unknown>;
}

const CATEGORIES = [
  { id: 1, name: 'General', order: 1, in_use: true },
  { id: 2, name: 'Entertainment', order: 2, in_use: true },
];

const CURRENCIES = [
  { id: 1, name: 'US Dollar', symbol: '$', code: 'USD', rate: '1.1000', in_use: true },
  { id: 2, name: 'Euro', symbol: '€', code: 'EUR', rate: '1.0000', in_use: true },
];

const PAYMENT_METHODS = [
  { id: 1, name: 'Visa', icon: 'images/uploads/icons/visa.png', enabled: 1, order: 1, in_use: true },
  { id: 2, name: 'PayPal', icon: 'images/uploads/icons/paypal.png', enabled: 1, order: 2, in_use: false },
];

const HOUSEHOLD = [
  { id: 1, name: 'Alice', email: 'alice@example.com', in_use: true },
  { id: 2, name: 'Bob', email: 'bob@example.com', in_use: false },
];

const SUBSCRIPTIONS = [
  {
    id: 1,
    name: 'Netflix',
    logo: 'netflix.png',
    price: 15.99,
    currency_id: 2,
    start_date: '2024-01-15',
    next_payment: '2026-11-15',
    cycle: 3,
    frequency: 1,
    auto_renew: 1,
    notes: 'Premium',
    payment_method_id: 1,
    payer_user_id: 1,
    category_id: 2,
    notify: 1,
    url: 'https://netflix.com',
    inactive: 0,
    notify_days_before: 2,
    user_id: 1,
    category_name: 'Entertainment',
    payer_user_name: 'Alice',
    payment_method_name: 'Visa',
  },
  {
    id: 2,
    name: 'Spotify',
    logo: 'spotify.png',
    price: 9.99,
    currency_id: 2,
    start_date: '2024-03-01',
    next_payment: '2026-11-01',
    cycle: 3,
    frequency: 1,
    auto_renew: 1,
    notes: '',
    payment_method_id: 2,
    payer_user_id: 2,
    category_id: 2,
    notify: 0,
    url: '',
    inactive: 1,
    user_id: 1,
    category_name: 'Entertainment',
    payer_user_name: 'Bob',
    payment_method_name: 'PayPal',
  },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function defaultHandlers(): Record<string, (call: RecordedCall) => unknown> {
  const subscriptions: Array<Record<string, unknown>> = SUBSCRIPTIONS.map((entry) => ({ ...entry }));
  let nextId = 100;

  return {
    'api/categories/get_categories.php': () => ({
      success: true,
      title: 'categories',
      categories: CATEGORIES,
      notes: [],
    }),
    'api/currencies/get_currencies.php': () => ({
      success: true,
      title: 'currencies',
      main_currency: 2,
      currencies: CURRENCIES,
      notes: [],
    }),
    'api/payment_methods/get_payment_methods.php': () => ({
      success: true,
      title: 'payment_methods',
      payment_methods: PAYMENT_METHODS,
      notes: [],
    }),
    'api/household/get_household.php': () => ({
      success: true,
      title: 'household',
      household: HOUSEHOLD,
      notes: [],
    }),

    'api/subscriptions/get_subscriptions.php': (call) => {
      let result = subscriptions;
      if (call.request.has('category')) {
        const wanted = call.request.get('category')?.split(',').map(Number) ?? [];
        result = result.filter((entry) => wanted.includes(Number(entry.category_id)));
      }
      if (call.request.has('state') && call.request.get('state') !== '') {
        const wanted = Number(call.request.get('state'));
        result = result.filter((entry) => entry.inactive === wanted);
      }
      return { success: true, title: 'subscriptions', subscriptions: result, notes: [] };
    },

    'api/subscriptions/get_subscription.php': (call) => {
      const id = Number(call.request.get('id'));
      const found = subscriptions.find((entry) => entry.id === id);
      if (found === undefined) {
        return { success: false, title: 'Subscription not found', message: 'Subscription not found or does not belong to you.' };
      }
      return { success: true, title: 'subscription', subscription: found, notes: [] };
    },

    'api/subscriptions/set_subscriptions.php': (call) => {
      const action = call.post.get('action');
      if (action === 'add') {
        const id = nextId++;
        subscriptions.push({
          id,
          name: String(call.post.get('name')),
          price: Number(call.post.get('price')),
          currency_id: Number(call.post.get('currency_id')),
          cycle: Number(call.post.get('cycle')),
          frequency: Number(call.post.get('frequency')),
          next_payment: String(call.post.get('next_payment')),
          start_date: String(call.post.get('start_date')),
          user_id: 1,
          inactive: 0,
        });
        return { success: true, title: 'Subscription added', subscriptionId: id, message: 'Subscription added successfully.' };
      }
      if (action === 'edit') {
        return { success: true, title: 'Subscription updated', message: 'Subscription updated successfully.' };
      }
      if (action === 'delete') {
        const id = Number(call.post.get('id'));
        const index = subscriptions.findIndex((entry) => entry.id === id);
        if (index === -1) return { success: false, title: 'Subscription not found', message: 'Not found.' };
        subscriptions.splice(index, 1);
        return { success: true, title: 'Subscription deleted', message: 'Subscription deleted successfully.' };
      }
      return { success: false, title: 'Invalid action', message: 'Action must be "add", "edit", or "delete".' };
    },

    'api/subscriptions/get_monthly_cost.php': (call) => {
      if (!call.request.has('month') || !call.request.has('year')) {
        return { success: false, title: 'Missing parameters' };
      }
      return {
        success: true,
        title: 'March 2026',
        monthly_cost: '1,234.56',
        localized_monthly_cost: '€1,235',
        currency_code: 'EUR',
        currency_symbol: '€',
        notes: [],
      };
    },

    'api/subscriptions/get_period_budget.php': () => ({
      success: true,
      title: 'period_budget',
      period_budget: 100,
      amount_needed_this_period: 42.5,
      amount_needed_full_period: 60,
      amount_remaining_this_period: 57.5,
      amount_over_budget: 0,
      is_over_budget: false,
      budget_period_type: 'monthly',
      budget_period_anchor_date: '2026-01-01',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
      period_label: 'March 2026',
      currency_code: 'EUR',
      currency_symbol: '€',
      reference_date: '2026-03-15',
      notes: [],
    }),

    'api/subscriptions/get_ical_feed.php': () => ({ raw: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }),

    'api/users/get_user.php': () => ({
      success: true,
      title: 'user',
      user: {
        id: 1,
        username: 'alice',
        email: 'alice@example.com',
        password: '********',
        main_currency: 2,
        language: 'en',
        budget: 100,
        period_budget: 100,
        totp_enabled: 0,
        api_key: '********',
      },
      notes: [],
    }),

    'api/status/version.php': () => ({
      success: true,
      title: 'version',
      version: 'v5.8.3',
      version_number: '5.8.3',
      notes: [],
    }),

    'api/settings/get_settings.php': () => ({
      success: true,
      title: 'settings',
      settings: { dark_theme: 1, color_theme: 'red', convert_currency: 1 },
      notes: [],
    }),

    'api/notifications/get_notification_settings.php': () => ({
      success: true,
      title: 'notification_settings',
      notification_settings: {
        id: 1,
        days: 1,
        discord_notifications: { enabled: 1, webhook_url: 'https://discord.com/api/webhooks/123/abcdef-secret' },
      },
      notes: [],
    }),

    'api/fixer/get_fixer.php': () => ({
      success: true,
      title: 'fixer',
      fixer: { api_key: '********', provider: 0, provider_name: 'Fixer.io' },
      notes: [],
    }),

    'api/categories/set_categories.php': (call) => {
      if (call.post.get('action') === 'add') {
        return { success: true, title: 'Category added', categoryId: 42, message: 'Category added successfully.' };
      }
      return { success: true, title: 'Category updated', message: 'Category updated successfully.' };
    },

    'api/payment_methods/set_payment_methods.php': (call) => {
      if (call.post.get('action') === 'add') {
        return { success: true, title: 'Payment method added', paymentId: 43, message: 'Payment method added successfully.' };
      }
      return { success: true, title: 'Payment method updated', message: 'Payment method updated successfully.' };
    },

    'api/household/set_household.php': (call) => {
      if (call.post.get('action') === 'add') {
        return { success: true, title: 'Member added', memberId: 44, message: 'Household member added successfully.' };
      }
      return { success: true, title: 'Member updated', message: 'Household member updated successfully.' };
    },

    'api/currencies/set_currencies.php': () => ({
      success: true,
      title: 'Currency added',
      currencyId: 45,
      message: 'Currency added successfully.',
    }),

    'api/settings/set_settings.php': () => ({
      success: true,
      title: 'Settings updated',
      message: 'User settings have been saved successfully.',
    }),

    'api/fixer/set_fixer.php': () => ({
      success: true,
      title: 'Fixer settings updated',
      message: 'Fixer API key has been saved.',
    }),

    'api/users/set_budget.php': () => ({
      success: true,
      title: 'Updated',
      message: 'Budget settings updated successfully.',
    }),

    'api/admin/get_admin_settings.php': () => ({
      success: true,
      title: 'admin_settings',
      admin_settings: { registrations_open: 1, max_users: 100, smtp_password: '********' },
      notes: [],
    }),

    'api/admin/get_oidc_settings.php': () => ({
      success: true,
      title: 'oidc_settings',
      oidc_settings: { name: 'Authentik', client_secret: 'super-secret-value' },
      notes: [],
    }),

    'api/admin/set_admin_settings.php': () => ({
      success: true,
      title: 'Admin settings saved',
      message: 'Global admin settings have been updated successfully.',
    }),

    'api/admin/set_oidc_settings.php': () => ({
      success: true,
      title: 'OIDC settings saved',
      message: 'OIDC configurations have been saved successfully.',
    }),

    'api/admin/set_disable_password_login.php': () => ({
      success: true,
      title: 'Updated',
      message: 'Password login has been disabled.',
    }),
  };
}

export function installFakeWallos(options: FakeOptions = {}): FakeWallos {
  const apiKey = options.apiKey ?? API_KEY;
  const calls: RecordedCall[] = [];
  const originalFetch = globalThis.fetch;
  const handlers = { ...defaultHandlers(), ...options.handlers };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    const path = url.pathname.replace(/^\/+/, '');
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers);
    const contentType = headers.get('content-type') ?? '';

    // PHP fills $_POST only for form-encoded and multipart bodies. A JSON body
    // is invisible to the endpoint, which is a real failure mode for anyone
    // building against this API.
    let post = new URLSearchParams();
    if (typeof init?.body === 'string' && contentType.includes('application/x-www-form-urlencoded')) {
      post = new URLSearchParams(init.body);
    }

    const request = new URLSearchParams(url.searchParams);
    for (const [key, value] of post.entries()) {
      request.set(key, value);
    }

    const call: RecordedCall = { path, method, request, post, contentType };
    calls.push(call);

    // Authentication, as every endpoint performs it.
    const supplied = method === 'POST' ? post.get('api_key') ?? post.get('apiKey') : request.get('api_key') ?? request.get('apiKey');
    if (supplied === null || supplied === '') {
      return json({ success: false, title: 'Missing API key', message: 'API key is required.' });
    }
    if (supplied !== apiKey) {
      return json({ success: false, title: 'Invalid API key', message: 'Unauthorized access.' });
    }

    const handler = handlers[path];
    if (handler === undefined) {
      return new Response('{"error":"no handler"}', { status: 404 });
    }

    const result = handler(call);
    if (result instanceof Response) return result;

    const shaped = result as { raw?: string };
    if (typeof shaped.raw === 'string') {
      return new Response(shaped.raw, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return json(result);
  }) as typeof fetch;

  return {
    calls,
    callsTo: (path: string) => calls.filter((call) => call.path === path),
    lastCall: () => calls[calls.length - 1],
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
