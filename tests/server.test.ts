import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { API_KEY, installFakeWallos, type FakeWallos } from './helpers/fake-wallos.js';

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

interface Harness {
  client: Client;
  close: () => Promise<void>;
}

async function connect(config: ServerConfig): Promise<Harness> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/\n\.\.\. \(truncated.*$/, '')) as Record<string, unknown>;
}

let fake: FakeWallos;

beforeEach(() => {
  fake = installFakeWallos();
});

afterEach(() => {
  fake.restore();
});

describe('tool registration', () => {
  it('offers the read tools, the write tools and no admin tools by default', async () => {
    const harness = await connect(makeConfig());
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('list_subscriptions');
    expect(names).toContain('get_subscription');
    expect(names).toContain('create_subscription');
    expect(names).toContain('update_subscription');
    expect(names).toContain('delete_subscription');
    expect(names).toContain('get_monthly_cost');
    expect(names).toContain('get_period_budget');
    expect(names).toContain('get_ical_feed');
    expect(names).toContain('get_master_data');
    expect(names).toContain('manage_category');
    expect(names).toContain('manage_currency');
    expect(names).toContain('manage_payment_method');
    expect(names).toContain('manage_household');
    expect(names).toContain('get_account');
    expect(names).toContain('get_settings');
    expect(names).toContain('update_settings');
    expect(names).toContain('get_notification_settings');
    expect(names).toContain('get_fixer_settings');
    expect(names).toContain('update_fixer_settings');
    expect(names).toContain('update_budget');

    // Instance-wide admin tools are off unless asked for.
    expect(names).not.toContain('get_admin_settings');
    expect(names).not.toContain('set_password_login_disabled');

    await harness.close();
  });

  it('every tool has a description and a schema a client can render', async () => {
    const harness = await connect(makeConfig());
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.inputSchema.type, `${tool.name} has no schema`).toBe('object');
    }

    await harness.close();
  });

  it('marks reads as reads and deletes as destructive', async () => {
    const harness = await connect(makeConfig());
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get('list_subscriptions')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('create_subscription')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('delete_subscription')?.annotations?.destructiveHint).toBe(true);

    await harness.close();
  });

  it('registers no tool that can write when running read-only', async () => {
    const harness = await connect(makeConfig({ readOnly: true }));
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('list_subscriptions');
    expect(names).toContain('get_master_data');
    expect(names).toContain('get_account');

    // Nothing that changes data may be offered at all in read-only mode.
    expect(names).not.toContain('create_subscription');
    expect(names).not.toContain('update_subscription');
    expect(names).not.toContain('delete_subscription');
    expect(names).not.toContain('manage_category');
    expect(names).not.toContain('manage_currency');
    expect(names).not.toContain('manage_payment_method');
    expect(names).not.toContain('manage_household');
    expect(names).not.toContain('update_settings');
    expect(names).not.toContain('update_fixer_settings');
    expect(names).not.toContain('update_budget');

    await harness.close();
  });

  it('adds the admin tools only when they are enabled', async () => {
    const harness = await connect(makeConfig({ enableAdminTools: true }));
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('get_admin_settings');
    expect(names).toContain('update_admin_settings');
    expect(names).toContain('get_oidc_settings');
    expect(names).toContain('update_oidc_settings');
    expect(names).toContain('set_password_login_disabled');

    await harness.close();
  });

  it('keeps the admin read tools but drops the admin writes in read-only mode', async () => {
    const harness = await connect(makeConfig({ enableAdminTools: true, readOnly: true }));
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('get_admin_settings');
    expect(names).toContain('get_oidc_settings');
    expect(names).not.toContain('update_admin_settings');
    expect(names).not.toContain('set_password_login_disabled');

    await harness.close();
  });
});

describe('reading subscriptions', () => {
  it('lists them', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'list_subscriptions', arguments: {} });
    const data = parse(textOf(result));

    const subscriptions = data.subscriptions as Array<{ name: string }>;
    expect(subscriptions.map((entry) => entry.name)).toEqual(['Netflix', 'Spotify']);

    await harness.close();
  });

  it('turns a category name into the id the API filters on', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({ name: 'list_subscriptions', arguments: { categories: ['Entertainment'] } });

    const call = fake.callsTo('api/subscriptions/get_subscriptions.php')[0];
    expect(call?.request.get('category')).toBe('2');

    await harness.close();
  });

  it('uses the "payment" parameter, which is what the endpoint actually reads', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({ name: 'list_subscriptions', arguments: { payment_methods: ['Visa'] } });

    const call = fake.callsTo('api/subscriptions/get_subscriptions.php')[0];
    expect(call?.request.get('payment')).toBe('1');
    // The docblock calls it payment_method, but the code never reads that.
    expect(call?.request.has('payment_method')).toBe(false);

    await harness.close();
  });

  it('sends state as 0 for active rather than the word', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({ name: 'list_subscriptions', arguments: { state: 'active' } });

    expect(fake.callsTo('api/subscriptions/get_subscriptions.php')[0]?.request.get('state')).toBe('0');

    await harness.close();
  });

  it('explains an unknown filter instead of returning everything', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({
      name: 'list_subscriptions',
      arguments: { categories: ['Nonsense'] },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const message = textOf(result);
    expect(message).toContain('No category named "Nonsense"');
    expect(message).toContain('Entertainment');
    expect(message).toContain('General');

    await harness.close();
  });

  it('reads one subscription by id', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'get_subscription', arguments: { id: 1 } });
    const data = parse(textOf(result));

    expect((data.subscription as { name: string }).name).toBe('Netflix');

    await harness.close();
  });

  it('reports a missing subscription as an error', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'get_subscription', arguments: { id: 999 } });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('Subscription not found');

    await harness.close();
  });
});

describe('creating a subscription', () => {
  it('resolves names to ids and sends them form-encoded', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({
      name: 'create_subscription',
      arguments: {
        name: 'Disney+',
        price: 8.99,
        billing_period: 'monthly',
        category: 'Entertainment',
        payment_method: 'Visa',
        payer: 'Alice',
      },
    });

    const data = parse(textOf(result));
    expect(data.subscriptionId).toBe(100);

    const call = fake.callsTo('api/subscriptions/set_subscriptions.php')[0];
    expect(call?.request.get('action')).toBe('add');
    expect(call?.request.get('name')).toBe('Disney+');
    expect(call?.request.get('price')).toBe('8.99');
    expect(call?.request.get('category_id')).toBe('2');
    expect(call?.request.get('payment_method_id')).toBe('1');
    expect(call?.request.get('payer_user_id')).toBe('1');
    expect(call?.request.get('cycle')).toBe('3');
    expect(call?.request.get('frequency')).toBe('1');
    // No currency was given, so the account's main currency is used.
    expect(call?.request.get('currency_id')).toBe('2');

    await harness.close();
  });

  it('derives a next payment date in the future when none is given', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({
      name: 'create_subscription',
      arguments: { name: 'Gym', price: 30, start_date: '2024-01-15', billing_period: 'monthly' },
    });

    const call = fake.callsTo('api/subscriptions/set_subscriptions.php')[0];
    const nextPayment = call?.request.get('next_payment') ?? '';

    expect(nextPayment).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nextPayment >= new Date().toISOString().slice(0, 10)).toBe(true);
    // It is anchored to the start date's day of the month.
    expect(nextPayment.endsWith('-15')).toBe(true);

    await harness.close();
  });

  it('honours an explicit next payment date', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({
      name: 'create_subscription',
      arguments: { name: 'Gym', price: 30, next_payment: '2026-12-01' },
    });

    const call = fake.callsTo('api/subscriptions/set_subscriptions.php')[0];
    expect(call?.request.get('next_payment')).toBe('2026-12-01');

    await harness.close();
  });

  it('creates a category that does not exist yet, then uses its id', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({
      name: 'create_subscription',
      arguments: { name: 'Hetzner', price: 12, category: 'Hosting' },
    });

    const created = fake.callsTo('api/categories/set_categories.php')[0];
    expect(created?.request.get('action')).toBe('add');
    expect(created?.request.get('name')).toBe('Hosting');

    const subscription = fake.callsTo('api/subscriptions/set_subscriptions.php')[0];
    expect(subscription?.request.get('category_id')).toBe('42');

    await harness.close();
  });

  it('refuses to create a category when create_missing says not to, and lists what exists', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({
      name: 'create_subscription',
      arguments: { name: 'Hetzner', price: 12, category: 'Hosting', create_missing: false },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('Entertainment');
    // Nothing should have been created.
    expect(fake.callsTo('api/categories/set_categories.php')).toHaveLength(0);

    await harness.close();
  });

  it('rejects a billing period it cannot read, with the options', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({
      name: 'create_subscription',
      arguments: { name: 'Odd', price: 1, billing_period: 'whenever' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('billing period');
    expect(fake.callsTo('api/subscriptions/set_subscriptions.php')).toHaveLength(0);

    await harness.close();
  });

  it('rejects a date that is not a real calendar date', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({
      name: 'create_subscription',
      arguments: { name: 'Odd', price: 1, start_date: '2026-02-30' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('2026-02-30');

    await harness.close();
  });

  it('sends booleans as the 1 and 0 Wallos stores', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({
      name: 'create_subscription',
      arguments: { name: 'Cloud', price: 5, notify: true, notify_days_before: 3, auto_renew: false, inactive: true },
    });

    const call = fake.callsTo('api/subscriptions/set_subscriptions.php')[0];
    expect(call?.request.get('notify')).toBe('1');
    expect(call?.request.get('notify_days_before')).toBe('3');
    expect(call?.request.get('auto_renew')).toBe('0');
    expect(call?.request.get('inactive')).toBe('1');

    await harness.close();
  });
});

describe('updating and deleting', () => {
  it('sends only the fields that were given, so nothing else is overwritten', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({ name: 'update_subscription', arguments: { id: 1, price: 17.99 } });

    const call = fake.callsTo('api/subscriptions/set_subscriptions.php')[0];
    expect(call?.request.get('action')).toBe('edit');
    expect(call?.request.get('id')).toBe('1');
    expect(call?.request.get('price')).toBe('17.99');
    expect(call?.request.has('name')).toBe(false);
    expect(call?.request.has('cycle')).toBe(false);
    expect(call?.request.has('category_id')).toBe(false);

    await harness.close();
  });

  it('clears a field when null is passed', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({
      name: 'update_subscription',
      arguments: { id: 1, category: null, payer: null },
    });

    const call = fake.callsTo('api/subscriptions/set_subscriptions.php')[0];
    expect(call?.request.get('category_id')).toBe('');
    expect(call?.request.get('payer_user_id')).toBe('');

    await harness.close();
  });

  it('deletes by id', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'delete_subscription', arguments: { id: 2 } });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(fake.callsTo('api/subscriptions/set_subscriptions.php')[0]?.request.get('action')).toBe('delete');
    expect(textOf(result)).toContain('Spotify');

    // The subscription is gone from the instance too.
    const list = await harness.client.callTool({ name: 'list_subscriptions', arguments: {} });
    const names = (parse(textOf(list)).subscriptions as Array<{ name: string }>).map((entry) => entry.name);
    expect(names).toEqual(['Netflix']);

    await harness.close();
  });

  it('checks the subscription exists before deleting it', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'delete_subscription', arguments: { id: 999 } });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('Subscription not found');
    // Nothing was deleted, because it never existed.
    expect(fake.callsTo('api/subscriptions/set_subscriptions.php')).toHaveLength(0);

    await harness.close();
  });
});

describe('spend and budget', () => {
  it('parses the display string Wallos returns for monthly cost', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({
      name: 'get_monthly_cost',
      arguments: { month: 3, year: 2026 },
    });
    const data = parse(textOf(result));

    // "1,234.56" is not a number until it is parsed, and a model reading it
    // will happily do arithmetic on the wrong value.
    expect(data.total).toBe(1234.56);
    expect(data.localised_total).toBe('€1,235');
    expect(data.currency_code).toBe('EUR');

    await harness.close();
  });

  it('defaults the month to the current one', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({ name: 'get_monthly_cost', arguments: {} });

    const call = fake.callsTo('api/subscriptions/get_monthly_cost.php')[0];
    expect(call?.request.get('month')).toBe(String(new Date().getUTCMonth() + 1));
    expect(call?.request.get('year')).toBe(String(new Date().getUTCFullYear()));

    await harness.close();
  });

  it('reports budget status', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'get_period_budget', arguments: {} });
    const data = parse(textOf(result));

    expect(data.period_budget).toBe(100);
    expect(data.amount_remaining_this_period).toBe(57.5);
    expect(data.is_over_budget).toBe(false);

    await harness.close();
  });
});

describe('master data', () => {
  it('returns every list with ids and flags the main currency', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'get_master_data', arguments: {} });
    const data = parse(textOf(result));

    expect((data.main_currency as { code: string }).code).toBe('EUR');
    expect((data.categories as unknown[]).length).toBe(2);
    expect((data.payment_methods as unknown[]).length).toBe(2);
    expect((data.household as unknown[]).length).toBe(2);

    await harness.close();
  });

  it('refuses to delete a category without saying which one', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'manage_category', arguments: { action: 'delete' } });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('A category is required');

    await harness.close();
  });

  it('edits a category addressed by name', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({
      name: 'manage_category',
      arguments: { action: 'edit', id: 'Entertainment', name: 'Fun' },
    });

    const call = fake.callsTo('api/categories/set_categories.php')[0];
    expect(call?.request.get('id')).toBe('2');
    expect(call?.request.get('name')).toBe('Fun');

    await harness.close();
  });

  it('requires the parts a currency cannot be guessed without', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({
      name: 'manage_currency',
      arguments: { action: 'add', name: 'Pound' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('symbol');
    expect(textOf(result)).toContain('code');

    await harness.close();
  });
});

describe('account and settings', () => {
  it('reports the account and the instance version together', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'get_account', arguments: {} });
    const data = parse(textOf(result));

    expect((data.user as { username: string }).username).toBe('alice');
    expect(data.wallos_version).toBe('v5.8.3');

    await harness.close();
  });

  it('masks credentials that come back from notification settings', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'get_notification_settings', arguments: {} });
    const text = textOf(result);

    expect(text).not.toContain('abcdef-secret');
    expect(text).toContain('********');
    // The useful part survives redaction.
    expect(text).toContain('discord_notifications');

    await harness.close();
  });

  it('maps friendly theme names onto the numbers Wallos stores', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({
      name: 'update_settings',
      arguments: { dark_theme: 'auto', convert_currency: true, hide_disabled: false },
    });

    const call = fake.callsTo('api/settings/set_settings.php')[0];
    expect(call?.request.get('dark_theme')).toBe('2');
    expect(call?.request.get('convert_currency')).toBe('1');
    expect(call?.request.get('hide_disabled')).toBe('0');

    await harness.close();
  });

  it('refuses a settings call that would change nothing', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'update_settings', arguments: {} });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fake.callsTo('api/settings/set_settings.php')).toHaveLength(0);

    await harness.close();
  });

  it('refuses to clear the exchange rate key by accident', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'update_fixer_settings', arguments: {} });

    // Wallos clears the stored key when the field is absent, so an empty call
    // has to be a refusal rather than a silent wipe.
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fake.callsTo('api/fixer/set_fixer.php')).toHaveLength(0);

    await harness.close();
  });

  it('sets a budget', async () => {
    const harness = await connect(makeConfig());
    await harness.client.callTool({ name: 'update_budget', arguments: { monthly_budget: 250 } });

    expect(fake.callsTo('api/users/set_budget.php')[0]?.request.get('monthly_budget')).toBe('250');

    await harness.close();
  });
});

describe('the calendar feed', () => {
  it('returns the iCalendar document as text rather than JSON', async () => {
    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'get_ical_feed', arguments: {} });

    expect(textOf(result)).toContain('BEGIN:VCALENDAR');

    await harness.close();
  });
});

describe('errors from the instance', () => {
  it('passes a rejection through with what Wallos said', async () => {
    fake.restore();
    fake = installFakeWallos({
      handlers: {
        'api/subscriptions/get_subscriptions.php': () => ({
          success: false,
          title: 'Invalid API key',
          message: 'Unauthorized access.',
        }),
      },
    });

    const harness = await connect(makeConfig());
    const result = await harness.client.callTool({ name: 'list_subscriptions', arguments: {} });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('Invalid API key');
    expect(textOf(result)).toContain('Unauthorized access.');

    await harness.close();
  });

  it('explains an unreachable instance instead of throwing a stack trace', async () => {
    const harness = await connect(makeConfig({ baseUrl: 'http://unreachable.example' }));
    fake.restore();
    globalThis.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as typeof fetch;

    const result = await harness.client.callTool({ name: 'list_subscriptions', arguments: {} });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('could not be resolved');
    expect(textOf(result)).not.toContain(API_KEY);

    await harness.close();
  });
});
