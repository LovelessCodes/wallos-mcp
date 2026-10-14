#!/usr/bin/env node
/**
 * End-to-end check against a real Wallos instance.
 *
 * It starts the built server as a child process and speaks MCP over stdio, so
 * what is exercised is the same binary an MCP client would spawn:
 *
 *   WALLOS_URL=https://wallos.example.com WALLOS_API_KEY=... npm run e2e
 *   WALLOS_URL=... WALLOS_API_KEY=... npm run e2e -- --write
 *
 * The read pass is safe to run against a live instance. The write pass creates
 * a category, a payment method, a household member and a subscription, then
 * removes them again; it needs --write to run.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WRITE = process.argv.includes('--write');

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) {
    console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

interface ToolResult {
  text: string;
  data: Record<string, unknown>;
  isError: boolean;
}

async function main(): Promise<void> {
  const url = process.env.WALLOS_URL;
  const apiKey = process.env.WALLOS_API_KEY;

  if (url === undefined || apiKey === undefined) {
    console.error('Set WALLOS_URL and WALLOS_API_KEY before running this.');
    process.exit(2);
  }

  console.log(`Against ${url}${WRITE ? ' (including writes)' : ' (reads only; pass --write for the full pass)'}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      WALLOS_URL: url,
      WALLOS_API_KEY: apiKey,
      WALLOS_TIMEOUT_MS: '20000',
    } as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'wallos-mcp-e2e', version: '1.0.0' });
  await client.connect(transport);

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = await client.callTool({ name, arguments: args });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
    return { text, data, isError: (result as { isError?: boolean }).isError === true };
  }

  section('Handshake');
  const { tools } = await client.listTools();
  check(`tool list is populated (${tools.length} tools)`, tools.length > 15);
  check('write tools are offered', tools.some((tool) => tool.name === 'create_subscription'));
  check('admin tools are withheld without opt-in', !tools.some((tool) => tool.name === 'get_admin_settings'));

  section('Account');
  const account = await call('get_account');
  const user = account.data.user as { id?: number; username?: string } | undefined;
  check('account reads back', account.isError === false && typeof user?.username === 'string', account.text);
  check('instance reports a version', typeof account.data.wallos_version === 'string', account.data.wallos_version);
  console.log(`        user ${user?.username} (id ${user?.id}) on Wallos ${String(account.data.wallos_version)}`);

  const versionNumber = String(account.data.wallos_version ?? '').replace(/^v/, '');
  const [major = 0, minor = 0] = versionNumber.split('.').map(Number);
  const supportsPeriodBudget = major > 5 || (major === 5 && minor >= 3);
  if (!supportsPeriodBudget) {
    console.log('        period budget needs Wallos 5.3 or newer; skipping that check');
  }

  section('Master data');
  const master = await call('get_master_data');
  const categories = (master.data.categories as Array<{ id: number; name: string }>) ?? [];
  const paymentMethods = (master.data.payment_methods as Array<{ id: number; name: string }>) ?? [];
  const household = (master.data.household as Array<{ id: number; name: string }>) ?? [];
  const mainCurrency = master.data.main_currency as { code?: string } | null;
  check('categories read back', Array.isArray(master.data.categories), master.text);
  check('currencies read back', Array.isArray(master.data.currencies));
  check('payment methods read back', Array.isArray(master.data.payment_methods));
  check('household read back', Array.isArray(master.data.household));
  check('main currency is flagged', typeof mainCurrency?.code === 'string', mainCurrency);
  console.log(
    `        ${categories.length} categories, ${paymentMethods.length} payment methods, ${household.length} members, main currency ${String(mainCurrency?.code)}`,
  );

  section('Subscriptions');
  const listed = await call('list_subscriptions');
  const subscriptions = (listed.data.subscriptions as Array<Record<string, unknown>>) ?? [];
  check('subscriptions read back', listed.isError === false && Array.isArray(listed.data.subscriptions), listed.text);
  console.log(`        ${subscriptions.length} subscriptions`);

  if (subscriptions.length > 0) {
    const first = subscriptions[0] as { id: number };
    const single = await call('get_subscription', { id: first.id });
    check('a single subscription reads back by id', single.isError === false, single.text);
  }

  section('Spend');
  const cost = await call('get_monthly_cost', {});
  check('monthly cost reads back', cost.isError === false, cost.text);
  check('monthly cost is a number, not a display string', typeof cost.data.total === 'number', cost.data.total);
  console.log(`        ${String(cost.data.localised_total)} (${String(cost.data.currency_code)}) in ${String(cost.data.label)}`);

  if (supportsPeriodBudget) {
    const budget = await call('get_period_budget', {});
    check('budget status reads back', budget.isError === false, budget.text);
  }

  section('Calendar feed');
  const feed = await call('get_ical_feed');
  check('calendar feed is a VCALENDAR document', feed.text.includes('BEGIN:VCALENDAR'), feed.text.slice(0, 120));

  section('Settings');
  const settings = await call('get_settings');
  check('display settings read back', settings.isError === false, settings.text);
  const notifications = await call('get_notification_settings');
  check('notification settings read back', notifications.isError === false, notifications.text);
  const fixer = await call('get_fixer_settings');
  check('exchange rate settings read back', fixer.isError === false, fixer.text);

  section('Security');
  const leak = tools.some((tool) => JSON.stringify(tool.inputSchema).includes(apiKey));
  check('the API key never appears in a tool schema', !leak);
  const everything = JSON.stringify([account.data, master.data, listed.data, settings.data, notifications.data]);
  check('the API key never appears in a tool result', !everything.includes(apiKey));

  section('Errors');
  const missing = await call('get_subscription', { id: 987654 });
  check('a missing subscription reports an error', missing.isError, missing.text);
  const unknownCategory = await call('list_subscriptions', { categories: ['No Such Category Here'] });
  check('an unknown filter lists what exists', unknownCategory.isError && unknownCategory.text.includes('Existing category'), unknownCategory.text);

  if (WRITE) {
    await writePass(call);
  } else {
    console.log('\nSkipping the write pass. Re-run with --write to create and remove a subscription.');
  }

  await client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function writePass(call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>): Promise<void> {
  const stamp = Date.now();
  const categoryName = `E2E Category ${stamp}`;
  const renamedCategory = `${categoryName} (renamed)`;
  const methodName = `E2E Method ${stamp}`;
  const memberName = `E2E Member ${stamp}`;
  const subscriptionName = `E2E Subscription ${stamp}`;

  let categoryId: number | undefined;
  let methodId: number | undefined;
  let memberId: number | undefined;
  let subscriptionId: number | undefined;

  try {
    section('Write pass: master data');

    const category = await call('manage_category', { action: 'add', name: categoryName });
    categoryId = Number(category.data.categoryId);
    check('category created', category.isError === false && Number.isFinite(categoryId), category.text);

    const method = await call('manage_payment_method', { action: 'add', name: methodName });
    methodId = Number(method.data.paymentId);
    check('payment method created', method.isError === false && Number.isFinite(methodId), method.text);

    const member = await call('manage_household', { action: 'add', name: memberName, email: 'e2e@example.com' });
    memberId = Number(member.data.memberId);
    check('household member created', member.isError === false && Number.isFinite(memberId), member.text);

    const renamed = await call('manage_category', { action: 'edit', id: categoryId, name: renamedCategory });
    check('category renamed by id', renamed.isError === false, renamed.text);

    section('Write pass: subscription');

    // Deliberately referenced by name, and by the name it has *after* the
    // rename, so this covers name resolution as well as the rename itself.
    const created = await call('create_subscription', {
      name: subscriptionName,
      price: 12.34,
      billing_period: 'quarterly',
      start_date: '2024-01-31',
      category: renamedCategory,
      payment_method: methodName,
      payer: memberName,
      notes: 'Created by the wallos-mcp end-to-end check.',
      url: 'https://example.com/e2e',
      notify: true,
      notify_days_before: 3,
    });
    subscriptionId = Number(created.data.subscriptionId);
    check('subscription created by name, not id', created.isError === false && Number.isFinite(subscriptionId), created.text);

    const readBack = await call('get_subscription', { id: subscriptionId });
    const subscription = readBack.data.subscription as Record<string, unknown> | undefined;
    check('subscription reads back', readBack.isError === false, readBack.text);
    check('price stored', Number(subscription?.price) === 12.34, subscription?.price);
    check('category resolved to the created one', Number(subscription?.category_id) === categoryId, subscription?.category_id);
    check('payment method resolved', Number(subscription?.payment_method_id) === methodId, subscription?.payment_method_id);
    check('payer resolved', Number(subscription?.payer_user_id) === memberId, subscription?.payer_user_id);
    check('billing period stored as months x3', Number(subscription?.cycle) === 3 && Number(subscription?.frequency) === 3, {
      cycle: subscription?.cycle,
      frequency: subscription?.frequency,
    });
    check('notifications enabled', Number(subscription?.notify) === 1, subscription?.notify);

    // The start date is on the 31st and in the past, so next_payment has to have
    // been advanced and must land on a 31st where the month allows it.
    const nextPayment = String(subscription?.next_payment ?? '');
    check(
      'next payment is in the future',
      nextPayment >= new Date().toISOString().slice(0, 10),
      nextPayment,
    );
    console.log(`        next payment derived as ${nextPayment}`);

    const updated = await call('update_subscription', { id: subscriptionId, price: 99.5, notes: 'updated by e2e' });
    check('partial update accepted', updated.isError === false, updated.text);

    const afterUpdate = await call('get_subscription', { id: subscriptionId });
    const changed = afterUpdate.data.subscription as Record<string, unknown> | undefined;
    check('the changed field took', Number(changed?.price) === 99.5, changed?.price);
    check('the untouched name survived the partial update', changed?.name === subscriptionName, changed?.name);
    check('the untouched category survived the partial update', Number(changed?.category_id) === categoryId, changed?.category_id);
    check('the untouched billing period survived', Number(changed?.cycle) === 3 && Number(changed?.frequency) === 3, {
      cycle: changed?.cycle,
      frequency: changed?.frequency,
    });
    check('the untouched next payment survived', String(changed?.next_payment) === nextPayment, changed?.next_payment);

    section('Write pass: cleanup');
  } finally {
    if (subscriptionId !== undefined) {
      const deleted = await call('delete_subscription', { id: subscriptionId });
      check('subscription deleted', deleted.isError === false, deleted.text);
      check('the deletion names what was removed', deleted.text.includes(subscriptionName), deleted.text);

      const gone = await call('get_subscription', { id: subscriptionId });
      check('subscription is really gone', gone.isError, gone.text);
    }
    if (categoryId !== undefined) {
      const removed = await call('manage_category', { action: 'delete', id: categoryId });
      check('category deleted', removed.isError === false, removed.text);
    }
    if (methodId !== undefined) {
      const removed = await call('manage_payment_method', { action: 'delete', id: methodId });
      check('payment method deleted', removed.isError === false, removed.text);
    }
    if (memberId !== undefined) {
      const removed = await call('manage_household', { action: 'delete', id: memberId });
      check('household member deleted', removed.isError === false, removed.text);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`\nEnd-to-end run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
