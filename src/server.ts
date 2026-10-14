import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from './config.js';
import { registerAdminTools } from './tools/admin.js';
import { registerMasterDataTools } from './tools/master-data.js';
import { readOnlyRegistrar } from './tools/registrar.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerSubscriptionTools } from './tools/subscriptions.js';
import { WallosClient } from './wallos-client.js';

export const SERVER_NAME = 'wallos-mcp';

/**
 * Read from the package manifest so the version reported over MCP cannot drift
 * from the published package. Both layouts resolve: `../package.json` is the
 * project root from `src/` and from `dist/`.
 */
export function readVersion(): string {
  try {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(manifest) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version !== '') {
      return parsed.version;
    }
  } catch {
    // Fall through: a missing manifest should not stop the server.
  }
  return '0.0.0';
}

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: readVersion() },
    {
      instructions:
        'This server talks to a self-hosted Wallos subscription tracker. Use get_account and get_master_data for context, list_subscriptions to see what is being paid for, create_subscription and update_subscription to change it (categories, payment methods and household members can be given by name), and get_monthly_cost and get_period_budget for spend and budget questions. Money is reported in the account\u2019s main currency.',
    },
  );

  const client = new WallosClient(config);
  const ctx = { client, config };

  // In read-only mode the registrar drops every tool that is not annotated as a
  // read, so a client is never offered something it cannot use.
  const registrar = config.readOnly ? readOnlyRegistrar(server) : server;

  registerSubscriptionTools(registrar, ctx);
  registerMasterDataTools(registrar, ctx);
  registerSettingsTools(registrar, ctx);

  if (config.enableAdminTools) {
    registerAdminTools(registrar, ctx);
  }

  return server;
}
