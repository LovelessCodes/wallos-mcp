import { z } from 'zod';
import { WallosConfigError } from '../errors.js';
import type { ToolRegistrar } from './registrar.js';
import { createResolver, fail, ok, respond, type ToolContext } from './shared.js';

const ENTITY_REF = z.union([z.string(), z.coerce.number().int()]);

const ACTION = z.enum(['add', 'edit', 'delete']).describe('What to do: add a new entry, edit an existing one, or delete it.');
const TARGET = ENTITY_REF.optional().describe(
  'The entry to edit or delete, by name or id. Required for edit and delete, ignored for add.',
);

/**
 * The four "master data" endpoints Wallos exposes all take the same
 * `action` + `name` + `id` shape, so the tools are shaped the same way.
 */
export function registerMasterDataTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'get_master_data',
    {
      title: 'Get categories, currencies, payment methods and household',
      description:
        'Everything a subscription can point at, in one call: categories, currencies with the main one flagged, payment methods and household members, each with its id. Call this before changing a subscription so the names you pass are real, and to answer questions about how someone organises their spending.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const resolver = createResolver(ctx);
        const data = await resolver.data();

        const mainCurrency = data.currencies.find((currency) => currency.id === data.mainCurrencyId);

        return ok({
          main_currency: mainCurrency ? { id: mainCurrency.id, code: mainCurrency.code, name: mainCurrency.name } : null,
          categories: data.categories.map((entry) => ({
            id: entry.id,
            name: entry.name,
            in_use: entry.in_use ?? null,
          })),
          currencies: data.currencies.map((entry) => ({
            id: entry.id,
            name: entry.name,
            code: entry.code,
            symbol: entry.symbol,
            rate: entry.rate,
            in_use: entry.in_use ?? null,
          })),
          payment_methods: data.paymentMethods.map((entry) => ({
            id: entry.id,
            name: entry.name,
            enabled: entry.enabled,
            in_use: entry.in_use ?? null,
          })),
          household: data.household.map((entry) => ({
            id: entry.id,
            name: entry.name,
            email: entry.email,
            in_use: entry.in_use ?? null,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'manage_category',
    {
      title: 'Manage a category',
      description:
        'Adds, renames or deletes a spending category. Wallos refuses to delete a category that subscriptions still use, and will name the ones in the way.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        action: ACTION,
        id: TARGET,
        name: z.string().optional().describe('Category name: the new one for add and edit.'),
      },
    },
    async (args) => {
      try {
        const resolver = createResolver(ctx);
        const params: Record<string, string | number> = { action: args.action };

        if (args.action !== 'add') {
          if (args.id === undefined) {
            throw new WallosConfigError(`A category is required for "${args.action}".`);
          }
          const id = await resolver.resolve('category', args.id);
          if (id === undefined) throw new WallosConfigError('Could not resolve that category.');
          params.id = id;
        }

        if (args.action !== 'delete') {
          const name = args.name?.trim();
          if (name === undefined || name === '') {
            throw new WallosConfigError(`A name is required to ${args.action} a category.`);
          }
          params.name = name;
        }

        const envelope = await ctx.client.write('api/categories/set_categories.php', params);
        return respond(envelope, ['categoryId', 'message']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'manage_currency',
    {
      title: 'Manage a currency',
      description:
        'Adds, edits or deletes a currency on the account. A currency needs a name, a symbol and an ISO code, and its rate is relative to the main currency. Wallos refuses to delete one that subscriptions still use.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        action: ACTION,
        id: TARGET,
        name: z.string().optional().describe('Currency name, e.g. "Euro". Required for add and edit.'),
        symbol: z.string().optional().describe('Currency symbol, e.g. "€". Required for add and edit.'),
        code: z.string().optional().describe('ISO currency code, e.g. "EUR". Required for add and edit.'),
        rate: z.coerce.number().optional().describe('Exchange rate against the account’s main currency. Defaults to 1.'),
      },
    },
    async (args) => {
      try {
        const resolver = createResolver(ctx);
        const params: Record<string, string | number> = { action: args.action };

        if (args.action !== 'add') {
          if (args.id === undefined) {
            throw new WallosConfigError(`A currency is required for "${args.action}".`);
          }
          const id = await resolver.resolve('currency', args.id);
          if (id === undefined) throw new WallosConfigError('Could not resolve that currency.');
          params.id = id;
        }

        if (args.action !== 'delete') {
          const missing = (['name', 'symbol', 'code'] as const).filter((field) => {
            const value = args[field];
            return value === undefined || value.trim() === '';
          });
          if (missing.length > 0) {
            throw new WallosConfigError(`A currency needs ${missing.join(', ')}. For example: name "Euro", symbol "€", code "EUR".`);
          }
          params.name = args.name as string;
          params.symbol = args.symbol as string;
          params.code = args.code as string;
          if (args.rate !== undefined) params.rate = args.rate;
        }

        const envelope = await ctx.client.write('api/currencies/set_currencies.php', params);
        return respond(envelope, ['currencyId', 'message']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'manage_payment_method',
    {
      title: 'Manage a payment method',
      description:
        'Adds, renames, enables, disables or deletes a payment method. Wallos refuses to delete one that subscriptions still use.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        action: ACTION,
        id: TARGET,
        name: z.string().optional().describe('Payment method name, e.g. "Visa". Required for add.'),
        enabled: z.boolean().optional().describe('Whether it shows up when picking a payment method.'),
        icon_url: z.string().optional().describe('Image URL that the Wallos instance downloads as the icon.'),
      },
    },
    async (args) => {
      try {
        const resolver = createResolver(ctx);
        const params: Record<string, string | number> = { action: args.action };

        if (args.action !== 'add') {
          if (args.id === undefined) {
            throw new WallosConfigError(`A payment method is required for "${args.action}".`);
          }
          const id = await resolver.resolve('payment_method', args.id);
          if (id === undefined) throw new WallosConfigError('Could not resolve that payment method.');
          params.id = id;
        }

        if (args.action !== 'delete') {
          if (args.action === 'add') {
            const name = args.name?.trim();
            if (name === undefined || name === '') {
              throw new WallosConfigError('A name is required to add a payment method.');
            }
            params.name = name;
          } else if (args.name !== undefined) {
            params.name = args.name.trim();
          }
          if (args.enabled !== undefined) params.enabled = args.enabled ? '1' : '0';
          if (args.icon_url !== undefined) params.icon_url = args.icon_url;
        }

        const envelope = await ctx.client.write('api/payment_methods/set_payment_methods.php', params);
        return respond(envelope, ['paymentId', 'message']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'manage_household',
    {
      title: 'Manage a household member',
      description:
        'Adds, edits or deletes a household member. Members are who subscriptions are attributed to, not login accounts. Wallos refuses to delete a member that subscriptions are still attributed to.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        action: ACTION,
        id: TARGET,
        name: z.string().optional().describe('Member name. Required for add.'),
        email: z.string().optional().describe('Member email, used when Wallos emails them about their subscriptions.'),
      },
    },
    async (args) => {
      try {
        const resolver = createResolver(ctx);
        const params: Record<string, string | number> = { action: args.action };

        if (args.action !== 'add') {
          if (args.id === undefined) {
            throw new WallosConfigError(`A household member is required for "${args.action}".`);
          }
          const id = await resolver.resolve('household', args.id);
          if (id === undefined) throw new WallosConfigError('Could not resolve that household member.');
          params.id = id;
        }

        if (args.action !== 'delete') {
          if (args.action === 'add') {
            const name = args.name?.trim();
            if (name === undefined || name === '') {
              throw new WallosConfigError('A name is required to add a household member.');
            }
            params.name = name;
          } else if (args.name !== undefined) {
            params.name = args.name.trim();
          }
          if (args.email !== undefined) params.email = args.email;
        }

        const envelope = await ctx.client.write('api/household/set_household.php', params);
        return respond(envelope, ['memberId', 'message']);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
