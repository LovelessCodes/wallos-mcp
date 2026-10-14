import { z } from 'zod';
import { WallosConfigError } from '../errors.js';
import {
  CYCLE_DAYS,
  CYCLE_MONTHS,
  CYCLE_WEEKS,
  CYCLE_YEARS,
  deriveNextPayment,
  isIsoDate,
  parseBillingPeriod,
  todayIso,
  type Billing,
  type Cycle,
} from '../util/billing.js';
import { parseMoney } from '../util/money.js';
import type { Params } from '../wallos-client.js';
import type { ToolRegistrar } from './registrar.js';
import { boolFlag, createResolver, fail, ok, okText, respond, toggle, type ToolContext } from './shared.js';

const ENTITY_REF = z.union([z.string(), z.coerce.number().int()]);
const ENTITY_REF_LIST = z.union([ENTITY_REF, z.array(ENTITY_REF)]);

const SORT_OPTIONS = [
  'name',
  'id',
  'next_payment',
  'price',
  'payer_user_id',
  'category_id',
  'payment_method_id',
  'inactive',
  'alphanumeric',
] as const;

const BILLING_PERIOD_HELP =
  'Accepts daily, weekly, biweekly, monthly, quarterly, semiannually, yearly, or "every N days|weeks|months|years".';

interface SubscriptionInput {
  name?: string | undefined;
  price?: number | undefined;
  currency?: string | number | undefined;
  cycle?: number | undefined;
  frequency?: number | undefined;
  billing_period?: string | undefined;
  start_date?: string | undefined;
  next_payment?: string | undefined;
  category?: string | number | null | undefined;
  payment_method?: string | number | null | undefined;
  payer?: string | number | null | undefined;
  notes?: string | null | undefined;
  url?: string | null | undefined;
  logo_url?: string | undefined;
  notify?: boolean | undefined;
  notify_days_before?: number | null | undefined;
  auto_renew?: boolean | undefined;
  inactive?: boolean | undefined;
  cancellation_date?: string | null | undefined;
  replacement_subscription?: number | undefined;
  create_missing?: boolean | undefined;
}

/** Resolves a value that may be absent, a reference, or an explicit clearing. */
async function resolveMaybeClear(
  resolver: ReturnType<typeof createResolver>,
  kind: 'category' | 'payment_method' | 'household' | 'currency',
  value: string | number | null | undefined,
  createIfMissing: boolean,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value === null) return '';
  const id = await resolver.resolve(kind, value, createIfMissing);
  return id === undefined ? '' : String(id);
}

function resolveBilling(input: SubscriptionInput): Billing {
  // Raw cycle/frequency wins when both are given: it is the API's own shape and
  // whoever passed it meant it.
  if (input.cycle !== undefined || input.frequency !== undefined) {
    const cycle = input.cycle;
    const frequency = input.frequency ?? 1;
    if (cycle === undefined) {
      throw new WallosConfigError('A cycle is required alongside a frequency. Use 1 for days, 2 for weeks, 3 for months, 4 for years.');
    }
    if (![CYCLE_DAYS, CYCLE_WEEKS, CYCLE_MONTHS, CYCLE_YEARS].includes(cycle as Cycle)) {
      throw new WallosConfigError(`Wallos cycle must be 1 (days), 2 (weeks), 3 (months), or 4 (years); got ${cycle}.`);
    }
    if (!Number.isInteger(frequency) || frequency < 1) {
      throw new WallosConfigError(`Frequency must be a whole number of periods, got ${frequency}.`);
    }
    return { cycle: cycle as Cycle, frequency };
  }

  const period = input.billing_period ?? 'monthly';
  const billing = parseBillingPeriod(period);
  if (billing === null) {
    throw new WallosConfigError(`Could not read "${period}" as a billing period. ${BILLING_PERIOD_HELP}`);
  }
  return billing;
}

function requireIsoDate(value: string, field: string): string {
  if (!isIsoDate(value)) {
    throw new WallosConfigError(`${field} must be a real date in YYYY-MM-DD form, got "${value}".`);
  }
  return value;
}

async function buildParams(
  ctx: ToolContext,
  input: SubscriptionInput,
  mode: 'create' | 'update',
): Promise<Params> {
  const resolver = createResolver(ctx);
  const createMissing = input.create_missing ?? true;
  const params: Params = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === '') {
      throw new WallosConfigError('A subscription name cannot be empty.');
    }
    params.name = name;
  }

  if (input.price !== undefined) {
    if (!Number.isFinite(input.price) || input.price < 0) {
      throw new WallosConfigError(`Price must be a positive number, got ${input.price}.`);
    }
    params.price = input.price;
  }

  if (input.currency !== undefined) {
    const id = await resolver.resolve('currency', input.currency);
    if (id === undefined) {
      throw new WallosConfigError(`Could not find the currency "${input.currency}" on this Wallos instance.`);
    }
    params.currency_id = id;
  } else if (mode === 'create') {
    const { mainCurrencyId } = await resolver.data();
    if (mainCurrencyId === null || !Number.isFinite(mainCurrencyId)) {
      throw new WallosConfigError('This Wallos user has no main currency set, so a currency is required. Pass currency: "EUR" (or another code) explicitly.');
    }
    params.currency_id = mainCurrencyId;
  }

  if (mode === 'create' || input.cycle !== undefined || input.frequency !== undefined || input.billing_period !== undefined) {
    const billing = resolveBilling(input);
    params.cycle = billing.cycle;
    params.frequency = billing.frequency;
  }

  if (input.start_date !== undefined) {
    params.start_date = requireIsoDate(input.start_date, 'start_date');
  }

  if (input.next_payment !== undefined) {
    params.next_payment = requireIsoDate(input.next_payment, 'next_payment');
  } else if (mode === 'create') {
    // Wallos insists on a next payment date, and a date in the past would mean
    // the subscription is already overdue the moment it is created.
    const startDate = (params.start_date as string | undefined) ?? todayIso();
    const billing = resolveBilling(input);
    params.next_payment = deriveNextPayment(startDate, billing);
  }

  const category = await resolveMaybeClear(resolver, 'category', input.category, createMissing);
  if (category !== undefined) params.category_id = category;

  const paymentMethod = await resolveMaybeClear(resolver, 'payment_method', input.payment_method, createMissing);
  if (paymentMethod !== undefined) params.payment_method_id = paymentMethod;

  const payer = await resolveMaybeClear(resolver, 'household', input.payer, createMissing);
  if (payer !== undefined) params.payer_user_id = payer;

  if (input.notes !== undefined) params.notes = input.notes ?? '';
  if (input.url !== undefined) params.url = input.url ?? '';
  if (input.logo_url !== undefined) params.logo_url = input.logo_url;

  if (input.notify !== undefined) params.notify = toggle(input.notify);
  if (input.notify_days_before !== undefined) {
    params.notify_days_before = input.notify_days_before === null ? '' : input.notify_days_before;
  }
  if (input.auto_renew !== undefined) params.auto_renew = toggle(input.auto_renew);
  if (input.inactive !== undefined) params.inactive = toggle(input.inactive);
  if (input.cancellation_date !== undefined) {
    params.cancellation_date =
      input.cancellation_date === null || input.cancellation_date === ''
        ? ''
        : requireIsoDate(input.cancellation_date, 'cancellation_date');
  }
  if (input.replacement_subscription !== undefined) {
    params.replacement_subscription_id = input.replacement_subscription;
  }

  return params;
}

const NAME_FIELD = z.string().describe('Subscription name, e.g. "Netflix".');
const PRICE_FIELD = z.coerce.number().describe('Amount charged per billing period.');

/** Everything except the name and the price, which differ between create and update. */
const subscriptionFields = {
  currency: ENTITY_REF.optional().describe(
    'Currency code or id, e.g. "EUR". Defaults to the main currency on create.',
  ),
  billing_period: z.string().optional().describe(`How often it is charged. ${BILLING_PERIOD_HELP}`),
  cycle: z.coerce.number().int().optional().describe('Raw Wallos cycle: 1 days, 2 weeks, 3 months, 4 years.'),
  frequency: z.coerce.number().int().optional().describe('Raw Wallos frequency, i.e. how many cycles.'),
  start_date: z.string().optional().describe('First billing date, YYYY-MM-DD. Defaults to today on create.'),
  next_payment: z.string().optional().describe(
    'Next charge date, YYYY-MM-DD. Derived from start_date when omitted.',
  ),
  category: ENTITY_REF.nullable().optional().describe(
    'Category name or id. Created if it does not exist, unless create_missing is false. Null clears it.',
  ),
  payment_method: ENTITY_REF.nullable().optional().describe(
    'Payment method name or id. Created if it does not exist, unless create_missing is false. Null clears it.',
  ),
  payer: ENTITY_REF.nullable().optional().describe(
    'Household member who pays, by name or id. Null clears it.',
  ),
  notes: z.string().nullable().optional().describe('Free text; Markdown is rendered by Wallos.'),
  url: z.string().nullable().optional().describe('Link to the subscription’s management page.'),
  logo_url: z.string().optional().describe(
    'Image URL that this Wallos instance downloads as the logo. It must be able to reach that URL.',
  ),
  notify: z.boolean().optional().describe('Whether Wallos sends payment reminders.'),
  notify_days_before: z.coerce.number().int().nullable().optional().describe(
    'Days before the charge to notify, when reminders are on.',
  ),
  auto_renew: z.boolean().optional().describe('Whether it renews automatically. Defaults to true in Wallos.'),
  inactive: z.boolean().optional().describe('Mark it as cancelled or no longer used.'),
  cancellation_date: z.string().nullable().optional().describe('Cancellation date, YYYY-MM-DD.'),
  replacement_subscription: z.coerce.number().int().optional().describe(
    'Id of the subscription that replaced this one. Only kept when the subscription is inactive.',
  ),
  create_missing: z.boolean().optional().describe(
    'Create categories, payment methods and household members named here when they do not exist. Defaults to true.',
  ),
};

export function registerSubscriptionTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'list_subscriptions',
    {
      title: 'List subscriptions',
      description:
        'Lists the subscriptions in this Wallos account with their price, billing period and next payment date. Filters accept names or ids. This is the tool to reach for when asked what someone pays for, what is due, or what a category or person costs.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        categories: ENTITY_REF_LIST.optional().describe('Only these categories, by name or id.'),
        payment_methods: ENTITY_REF_LIST.optional().describe('Only these payment methods, by name or id.'),
        members: ENTITY_REF_LIST.optional().describe('Only subscriptions paid by these household members.'),
        state: z.enum(['active', 'inactive', 'all']).optional().describe('Defaults to "all".'),
        sort: z.enum(SORT_OPTIONS).optional().describe('Sort order. Defaults to next_payment.'),
        convert_currency: z.boolean().optional().describe(
          'Convert prices into the main currency using the current exchange rates.',
        ),
        all_users: z.boolean().optional().describe(
          'Return every user’s subscriptions instead of just this one. Admin (user id 1) only.',
        ),
        disabled_to_bottom: z.boolean().optional().describe('Sort inactive subscriptions last.'),
      },
    },
    async (args) => {
      try {
        const resolver = createResolver(ctx);
        const params: Params = {};

        const category = await resolver.resolveFilter('category', args.categories);
        if (category !== undefined) params.category = category;

        const payment = await resolver.resolveFilter('payment_method', args.payment_methods);
        if (payment !== undefined) params.payment = payment;

        const member = await resolver.resolveFilter('household', args.members);
        if (member !== undefined) params.member = member;

        if (args.state !== undefined && args.state !== 'all') {
          params.state = args.state === 'inactive' ? 1 : 0;
        }
        if (args.sort !== undefined) params.sort = args.sort;
        if (args.convert_currency !== undefined) params.convert_currency = boolFlag(args.convert_currency);
        if (args.disabled_to_bottom !== undefined) params.disabled_to_bottom = boolFlag(args.disabled_to_bottom);
        if (args.all_users === true) params['all-user-subscription'] = 1;

        const envelope = await ctx.client.read('api/subscriptions/get_subscriptions.php', params);
        const subscriptions = Array.isArray(envelope.subscriptions) ? envelope.subscriptions : [];

        if (subscriptions.length === 0) {
          return ok({ subscriptions: [], summary: 'No subscriptions matched those filters.' });
        }

        return respond(envelope, ['subscriptions', 'users']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_subscription',
    {
      title: 'Get one subscription',
      description: 'Reads a single subscription by id, including its category, payer and payment method names.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        id: z.coerce.number().int().describe('Subscription id, as returned by list_subscriptions.'),
        convert_currency: z.boolean().optional().describe('Convert the price into the main currency.'),
      },
    },
    async (args) => {
      try {
        const envelope = await ctx.client.read('api/subscriptions/get_subscription.php', {
          id: args.id,
          convert_currency: args.convert_currency === undefined ? undefined : boolFlag(args.convert_currency),
        });
        return respond(envelope, ['subscription']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'create_subscription',
    {
      title: 'Create a subscription',
      description:
        'Adds a subscription. Only a name and a price are required: the billing period defaults to monthly, the start date to today, the next payment date is derived from the start date, and the currency to the account’s main one. Categories, payment methods and household members named here are created when missing, so "category: Entertainment" works on a fresh instance.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        name: NAME_FIELD,
        price: PRICE_FIELD,
        ...subscriptionFields,
      },
    },
    async (args) => {
      try {
        const params = await buildParams(ctx, args, 'create');
        params.action = 'add';

        const envelope = await ctx.client.write('api/subscriptions/set_subscriptions.php', params);
        const result: Record<string, unknown> = {
          subscriptionId: envelope.subscriptionId,
          message: envelope.message ?? 'Subscription added.',
        };

        if (typeof envelope.logo_warning === 'string' && envelope.logo_warning !== '') {
          result.logo_warning = envelope.logo_warning;
        }
        const notes = envelope.notes;
        if (Array.isArray(notes) && notes.length > 0) result.notes = notes;

        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_subscription',
    {
      title: 'Update a subscription',
      description:
        'Changes fields on an existing subscription. Only the fields you pass are touched, everything else is left as it was. Pass null to clear a field such as category, payer or notes.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        id: z.coerce.number().int().describe('Id of the subscription to change.'),
        name: NAME_FIELD.optional(),
        price: PRICE_FIELD.optional(),
        ...subscriptionFields,
      },
    },
    async (args) => {
      try {
        const { id, ...rest } = args;
        const params = await buildParams(ctx, rest, 'update');
        params.action = 'edit';
        params.id = id;

        const envelope = await ctx.client.write('api/subscriptions/set_subscriptions.php', params);
        return ok({ subscriptionId: id, message: envelope.message ?? 'Subscription updated.' });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'delete_subscription',
    {
      title: 'Delete a subscription',
      description:
        'Permanently removes a subscription from Wallos. There is no undo, so confirm the id first with list_subscriptions. To stop paying for something but keep the history, prefer setting inactive: true instead.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        id: z.coerce.number().int().describe('Id of the subscription to delete.'),
      },
    },
    async (args) => {
      try {
        // Read it first so the confirmation can name what was deleted: "deleted
        // id 2" in a transcript is much harder to check afterwards than
        // "deleted Spotify", and this is not reversible.
        const current = await ctx.client.read('api/subscriptions/get_subscription.php', { id: args.id });
        const subscription = current.subscription as { name?: unknown } | undefined;
        const name = typeof subscription?.name === 'string' ? subscription.name : null;

        const envelope = await ctx.client.write('api/subscriptions/set_subscriptions.php', {
          action: 'delete',
          id: args.id,
        });

        return ok({
          deleted: { id: args.id, name },
          message: envelope.message ?? 'Subscription deleted.',
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_monthly_cost',
    {
      title: 'Get the cost of a month',
      description:
        'Total spend for a calendar month, converted into the main currency, as Wallos computes it on the dashboard. Defaults to the current month.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        month: z.coerce.number().int().min(1).max(12).optional().describe('Month number 1-12. Defaults to the current month.'),
        year: z.coerce.number().int().min(2000).max(2100).optional().describe('Four digit year. Defaults to the current year.'),
      },
    },
    async (args) => {
      try {
        const now = new Date();
        const month = args.month ?? now.getUTCMonth() + 1;
        const year = args.year ?? now.getUTCFullYear();

        const envelope = await ctx.client.read('api/subscriptions/get_monthly_cost.php', { month, year });

        // Wallos formats this figure for display ("88,242.55"), so the number is
        // recovered here rather than left for the caller to parse.
        const total = parseMoney(envelope.monthly_cost);

        return ok({
          month,
          year,
          label: envelope.title,
          total,
          localised_total: envelope.localized_monthly_cost,
          currency_code: envelope.currency_code,
          currency_symbol: envelope.currency_symbol,
          notes: envelope.notes,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_period_budget',
    {
      title: 'Get budget status',
      description:
        'How the current budget period is going: what the budget is, what this period is projected to cost, and how much is left or over. Defaults to the period containing today.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        reference_date: z.string().optional().describe('Evaluate the period containing this YYYY-MM-DD date instead of today.'),
      },
    },
    async (args) => {
      try {
        const envelope = await ctx.client.read('api/subscriptions/get_period_budget.php', {
          reference_date: args.reference_date,
        });
        return ok({
          period_budget: envelope.period_budget,
          amount_needed_this_period: envelope.amount_needed_this_period,
          amount_needed_full_period: envelope.amount_needed_full_period,
          amount_remaining_this_period: envelope.amount_remaining_this_period,
          amount_over_budget: envelope.amount_over_budget,
          is_over_budget: envelope.is_over_budget,
          budget_period_type: envelope.budget_period_type,
          budget_period_anchor_date: envelope.budget_period_anchor_date,
          period_start: envelope.period_start,
          period_end: envelope.period_end,
          period_label: envelope.period_label,
          currency_code: envelope.currency_code,
          currency_symbol: envelope.currency_symbol,
          reference_date: envelope.reference_date,
          notes: envelope.notes,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_ical_feed',
    {
      title: 'Export the calendar feed',
      description:
        'The same calendar feed Wallos serves for subscribing in a calendar app: one all-day event per upcoming payment, as an iCalendar document. Useful when someone wants the raw export rather than a summary.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        convert_currency: z.boolean().optional().describe('Convert prices into the main currency.'),
      },
    },
    async (args) => {
      try {
        const feed = await ctx.client.request<string>(
          'api/subscriptions/get_ical_feed.php',
          { convert_currency: args.convert_currency === undefined ? undefined : boolFlag(args.convert_currency) },
          { raw: true },
        );

        if (feed.trim() === '') {
          return okText('The calendar feed is empty, which means there are no active subscriptions.');
        }

        const limit = 40_000;
        const truncated = feed.length > limit;
        const body = truncated ? feed.slice(0, limit) : feed;
        const note = truncated ? `\n\n[feed truncated after ${limit} of ${feed.length} characters]` : '';
        return okText(`${body}${note}`);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
