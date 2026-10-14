import { z } from 'zod';
import { WallosConfigError } from '../errors.js';
import { isIsoDate } from '../util/billing.js';
import type { ToolRegistrar } from './registrar.js';
import { fail, ok, respond, toggle, type ToolContext } from './shared.js';

const THEME_LABELS = { light: '0', dark: '1', auto: '2' } as const;

const darkThemeSchema = z
  .union([z.enum(['light', 'dark', 'auto']), z.coerce.number().int().min(0).max(2)])
  .describe('Interface theme: light, dark, or auto to follow the browser.');

const binarySetting = z.boolean().optional();

const PROVIDER_LABELS = { fixer: '0', apilayer: '1', frankfurter: '2' } as const;

export function registerSettingsTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'get_account',
    {
      title: 'Get the account and instance version',
      description:
        'Who the configured API key belongs to, what the main currency, language and budgets are, and which version of Wallos is running. A good first call to understand the account you are working with.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const [user, version] = await Promise.all([
          ctx.client.read('api/users/get_user.php'),
          ctx.client.read('api/status/version.php'),
        ]);

        return ok({
          user: user.user,
          wallos_version: version.version,
          notes: user.notes,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_settings',
    {
      title: 'Get display settings',
      description:
        'The account’s display preferences: theme, currency conversion, how subscriptions are ordered and hidden on the dashboard, and any custom CSS.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const envelope = await ctx.client.read('api/settings/get_settings.php');
        return respond(envelope, ['settings']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_settings',
    {
      title: 'Update display settings',
      description:
        'Changes display settings. Only the settings you pass are changed; everything else keeps its current value.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        dark_theme: darkThemeSchema.optional(),
        color_theme: z.enum(['blue', 'green', 'red', 'yellow', 'purple', 'custom']).optional(),
        monthly_price: binarySetting.describe('Show prices as a monthly equivalent.'),
        convert_currency: binarySetting.describe('Show all prices in the main currency.'),
        show_original_price: binarySetting.describe('Show the original price beside the converted one.'),
        mobile_nav: binarySetting.describe('Use the mobile navigation menu.'),
        show_subscription_progress: binarySetting.describe('Show a progress bar per subscription.'),
        week_starts_sunday: binarySetting.describe('Start calendar weeks on Sunday.'),
        upcoming_payments_limit: z.coerce.number().int().optional().describe('Upcoming payments on the dashboard: 3, 5, 10 or 20.'),
        disabled_to_bottom: binarySetting.describe('Move inactive subscriptions to the bottom of the list.'),
        hide_disabled: binarySetting.describe('Hide inactive subscriptions entirely.'),
        remove_background: binarySetting.describe('Remove the background from uploaded logos.'),
        square_icons: binarySetting.describe('Use square icon frames.'),
        main_color: z.string().optional().describe('Custom theme primary colour, as #RRGGBB.'),
        accent_color: z.string().optional().describe('Custom theme accent colour, as #RRGGBB.'),
        hover_color: z.string().optional().describe('Custom theme hover colour, as #RRGGBB.'),
        css: z.string().optional().describe('Custom CSS applied to the Wallos web interface.'),
      },
    },
    async (args) => {
      try {
        const params: Record<string, string | number> = {};

        if (args.dark_theme !== undefined) {
          params.dark_theme =
            typeof args.dark_theme === 'number' ? args.dark_theme : THEME_LABELS[args.dark_theme];
        }
        if (args.color_theme !== undefined) params.color_theme = args.color_theme;

        const binaries: Array<[keyof typeof args, string]> = [
          ['monthly_price', 'monthly_price'],
          ['convert_currency', 'convert_currency'],
          ['show_original_price', 'show_original_price'],
          ['mobile_nav', 'mobile_nav'],
          ['show_subscription_progress', 'show_subscription_progress'],
          ['week_starts_sunday', 'week_starts_sunday'],
          ['disabled_to_bottom', 'disabled_to_bottom'],
          ['hide_disabled', 'hide_disabled'],
          ['remove_background', 'remove_background'],
          ['square_icons', 'square_icons'],
        ];

        for (const [key, wire] of binaries) {
          const value = args[key];
          if (typeof value === 'boolean') {
            params[wire] = toggle(value) as string;
          }
        }

        if (args.upcoming_payments_limit !== undefined) {
          if (![3, 5, 10, 20].includes(args.upcoming_payments_limit)) {
            throw new WallosConfigError('upcoming_payments_limit must be 3, 5, 10 or 20.');
          }
          params.upcoming_payments_limit = args.upcoming_payments_limit;
        }

        if (args.main_color !== undefined) params.main_color = args.main_color;
        if (args.accent_color !== undefined) params.accent_color = args.accent_color;
        if (args.hover_color !== undefined) params.hover_color = args.hover_color;
        if (args.css !== undefined) params.css = args.css;

        if (Object.keys(params).length === 0) {
          throw new WallosConfigError('Pass at least one setting to change.');
        }

        const envelope = await ctx.client.write('api/settings/set_settings.php', params);
        return respond(envelope, ['message']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_notification_settings',
    {
      title: 'Get notification settings',
      description:
        'Which notification channels this account has set up (email, Discord, Gotify, ntfy, Pushover, Telegram, webhook, ServerChan), how many days ahead reminders go out, and whether each is enabled. Wallos masks the credentials.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const envelope = await ctx.client.read('api/notifications/get_notification_settings.php');
        return respond(envelope, ['notification_settings']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_fixer_settings',
    {
      title: 'Get exchange rate provider settings',
      description:
        'Which exchange rate provider is configured and whether an API key is present. Rates are what make multi-currency totals possible.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const envelope = await ctx.client.read('api/fixer/get_fixer.php');
        return respond(envelope, ['fixer']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_fixer_settings',
    {
      title: 'Update exchange rate provider settings',
      description:
        'Sets the exchange rate provider, and the API key for Fixer.io or APILayer. Frankfurter needs no key.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        provider: z.enum(['fixer', 'apilayer', 'frankfurter']).optional().describe('Which provider fetches exchange rates.'),
        fixer_api_key: z.string().optional().describe(
          'The provider API key. Leave empty to clear it. Ignored for frankfurter, which needs no key.',
        ),
      },
    },
    async (args) => {
      try {
        // Wallos clears the stored key when this field is absent, so refuse a
        // call that would silently wipe it.
        if (args.provider === undefined && args.fixer_api_key === undefined) {
          throw new WallosConfigError('Pass a provider, an API key, or both.');
        }

        const params: Record<string, string | number> = {};
        if (args.provider !== undefined) params.provider = PROVIDER_LABELS[args.provider];
        if (args.fixer_api_key !== undefined) params.fixer_api_key = args.fixer_api_key;

        const envelope = await ctx.client.write('api/fixer/set_fixer.php', params);
        return respond(envelope, ['message']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_budget',
    {
      title: 'Update budgets',
      description:
        'Sets the monthly budget, or the budget for a rolling period such as weekly, fortnightly or monthly, with an anchor date that decides where periods begin.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        monthly_budget: z.coerce.number().optional().describe('Budget for the month, in the main currency.'),
        period_budget: z.coerce.number().optional().describe('Budget for one budget period.'),
        budget_period_type: z.enum(['weekly', 'fortnightly', 'monthly']).optional().describe('Length of the budget period.'),
        budget_period_anchor_date: z.string().optional().describe('YYYY-MM-DD date that periods are anchored to.'),
      },
    },
    async (args) => {
      try {
        const params: Record<string, string | number> = {};

        if (args.monthly_budget !== undefined) {
          const budget = Number(args.monthly_budget);
          if (!Number.isFinite(budget) || budget < 0) {
            throw new WallosConfigError('monthly_budget must be a positive number.');
          }
          params.monthly_budget = budget;
        }

        if (args.period_budget !== undefined) {
          const budget = Number(args.period_budget);
          if (!Number.isFinite(budget) || budget < 0) {
            throw new WallosConfigError('period_budget must be a positive number.');
          }
          params.period_budget = budget;
        }

        if (args.budget_period_type !== undefined) params.budget_period_type = args.budget_period_type;

        if (args.budget_period_anchor_date !== undefined) {
          if (!isIsoDate(args.budget_period_anchor_date)) {
            throw new WallosConfigError('budget_period_anchor_date must be a real date in YYYY-MM-DD form.');
          }
          params.budget_period_anchor_date = args.budget_period_anchor_date;
        }

        if (Object.keys(params).length === 0) {
          throw new WallosConfigError('Pass a budget amount, a period type, or an anchor date.');
        }

        const envelope = await ctx.client.write('api/users/set_budget.php', params);
        return respond(envelope, ['message']);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
