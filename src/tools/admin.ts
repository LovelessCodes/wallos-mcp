import { z } from 'zod';
import { WallosConfigError } from '../errors.js';
import type { ToolRegistrar } from './registrar.js';
import { fail, ok, respond, toggle, type ToolContext } from './shared.js';

const binary = z.boolean().optional();

/**
 * These tools change how everyone signs in to the instance and how it sends
 * mail, so they are registered only when the operator asks for them with
 * --admin-tools, and every description says what a mistake costs.
 */
export function registerAdminTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'get_admin_settings',
    {
      title: 'Get instance-wide admin settings',
      description:
        'Registration and SMTP settings for the whole Wallos instance, plus the login-disabled flag and webhook allowlist. Requires the configured API key to belong to the admin user (id 1).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const envelope = await ctx.client.read('api/admin/get_admin_settings.php');
        return respond(envelope, ['admin_settings']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_admin_settings',
    {
      title: 'Update instance-wide admin settings',
      description:
        'Changes registration, SMTP and webhook settings for everyone on this instance. Only the fields you pass are changed. Passing login_disabled: true locks out password login for every current and future user, so treat it as a last resort and be sure another sign-in method works first.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        registrations_open: binary.describe('Allow new people to sign up.'),
        max_users: z.coerce.number().int().optional().describe('Maximum number of accounts allowed.'),
        require_email_verification: binary.describe('Require new accounts to verify their email address.'),
        server_url: z.string().optional().describe('Public URL of this instance, used in emails.'),
        smtp_address: z.string().optional().describe('SMTP server hostname.'),
        smtp_port: z.coerce.number().int().optional().describe('SMTP port, e.g. 587.'),
        smtp_username: z.string().optional().describe('SMTP login username.'),
        smtp_password: z.string().optional().describe('SMTP login password.'),
        from_email: z.string().optional().describe('Address outgoing mail is sent from.'),
        encryption: z.enum(['tls', 'ssl']).optional().describe('SMTP encryption.'),
        login_disabled: binary.describe('Disable password login instance-wide. Only safe when OIDC is working.'),
        update_notification: binary.describe('Notify admins about new Wallos releases.'),
        oidc_oauth_enabled: binary.describe('Offer OIDC sign-in on the login page.'),
        local_webhook_notifications_allowlist: z
          .string()
          .optional()
          .describe('Comma-separated hosts that webhooks, SMTP and OIDC may target on private addresses.'),
        allow_standard_users_local_webhooks: binary.describe(
          'Let non-admin users target allowlisted private addresses with their own webhooks.',
        ),
      },
    },
    async (args) => {
      try {
        const params: Record<string, string | number> = {};

        const binaries = [
          'registrations_open',
          'require_email_verification',
          'login_disabled',
          'update_notification',
          'oidc_oauth_enabled',
          'allow_standard_users_local_webhooks',
        ] as const;

        for (const key of binaries) {
          const value = args[key];
          if (typeof value === 'boolean') {
            params[key] = toggle(value) as string;
          }
        }

        const strings = [
          'server_url',
          'smtp_address',
          'smtp_username',
          'smtp_password',
          'from_email',
          'local_webhook_notifications_allowlist',
        ] as const;

        for (const key of strings) {
          const value = args[key];
          if (value !== undefined) params[key] = value;
        }

        if (args.max_users !== undefined) params.max_users = args.max_users;
        if (args.smtp_port !== undefined) params.smtp_port = args.smtp_port;
        if (args.encryption !== undefined) params.encryption = args.encryption;

        if (Object.keys(params).length === 0) {
          throw new WallosConfigError('Pass at least one admin setting to change.');
        }

        const envelope = await ctx.client.write('api/admin/set_admin_settings.php', params);
        return respond(envelope, ['message']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_oidc_settings',
    {
      title: 'Get OIDC settings',
      description:
        'The configured OIDC/OAuth provider: endpoints, scopes, and whether auto-creation and password-login disabling are on. The client secret is masked.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const envelope = await ctx.client.read('api/admin/get_oidc_settings.php');
        return respond(envelope, ['oidc_settings']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_oidc_settings',
    {
      title: 'Update OIDC settings',
      description:
        'Reconfigures OIDC sign-in for the instance. Only the fields you pass are changed. A wrong issuer or client secret can lock everyone out, so verify with get_oidc_settings first and keep password login enabled until OIDC is confirmed working.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        oidc_enabled: binary.describe('Turn OIDC sign-in on or off.'),
        name: z.string().optional().describe('Display name of the provider, e.g. "Authentik".'),
        client_id: z.string().optional(),
        client_secret: z.string().optional(),
        authorization_url: z.string().optional().describe('Provider authorization endpoint.'),
        token_url: z.string().optional().describe('Provider token endpoint.'),
        user_info_url: z.string().optional().describe('Provider userinfo endpoint.'),
        redirect_url: z.string().optional().describe('Callback URL registered with the provider.'),
        logout_url: z.string().optional().describe('Provider end-session endpoint.'),
        user_identifier_field: z.string().optional().describe('Claim to identify users by, e.g. "sub".'),
        scopes: z.string().optional().describe('Space-separated scopes, e.g. "openid email profile".'),
        auth_style: z.enum(['auto', 'header', 'params']).optional().describe('How credentials are sent to the token endpoint.'),
        auto_create_user: binary.describe('Create a Wallos account for first-time OIDC users.'),
        password_login_disabled: binary.describe('Disable password login once OIDC works. Lock-out risk.'),
        require_email_verified: binary.describe('Require a verified email before linking to an existing account.'),
      },
    },
    async (args) => {
      try {
        const params: Record<string, string | number> = {};

        const binaries = ['oidc_enabled', 'auto_create_user', 'password_login_disabled', 'require_email_verified'] as const;
        for (const key of binaries) {
          const value = args[key];
          if (typeof value === 'boolean') {
            params[key] = toggle(value) as string;
          }
        }

        const strings = [
          'name',
          'client_id',
          'client_secret',
          'authorization_url',
          'token_url',
          'user_info_url',
          'redirect_url',
          'logout_url',
          'user_identifier_field',
          'scopes',
          'auth_style',
        ] as const;

        for (const key of strings) {
          const value = args[key];
          if (value !== undefined) params[key] = value;
        }

        if (Object.keys(params).length === 0) {
          throw new WallosConfigError('Pass at least one OIDC setting to change.');
        }

        const envelope = await ctx.client.write('api/admin/set_oidc_settings.php', params);
        return respond(envelope, ['message']);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'set_password_login_disabled',
    {
      title: 'Disable or enable password login',
      description:
        'Turns password sign-in on or off for everyone on the instance. Disabling it without a working OIDC provider makes the instance unreachable through the web interface, so only do this once OIDC sign-in has been verified.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        disable: z.boolean().describe('true disables password login, false re-enables it.'),
      },
    },
    async (args) => {
      try {
        const envelope = await ctx.client.write('api/admin/set_disable_password_login.php', {
          disable: toggle(args.disable) as string,
        });
        return ok({
          password_login_disabled: args.disable,
          message: envelope.message ?? (args.disable ? 'Password login disabled.' : 'Password login enabled.'),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
