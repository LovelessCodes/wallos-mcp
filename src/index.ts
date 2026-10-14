#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HELP_TEXT, parseArgs, resolveConfig } from './config.js';
import { describeError, WallosConfigError } from './errors.js';
import { createServer, readVersion } from './server.js';

/**
 * MCP servers speak JSON-RPC over stdio, so stdout belongs to the protocol and
 * every human-readable message goes to stderr, which MCP clients surface as
 * server logs.
 */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv);

  if (flags.has('help')) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (flags.has('version')) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  if (rest.length > 0) {
    throw new WallosConfigError(
      `Unrecognised argument${rest.length > 1 ? 's' : ''}: ${rest.join(' ')}. Run wallos-mcp --help to see the options.`,
    );
  }

  const config = resolveConfig(argv);

  if (config.insecureTls) {
    // Node's fetch has no per-request switch for certificate verification, and
    // this process talks to exactly one host: the instance the user configured.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    log('TLS certificate verification is disabled (--insecure-tls). Only do this for an instance you control.');
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(`wallos-mcp ${readVersion()} connected to ${config.baseUrl}${config.readOnly ? ' (read-only)' : ''}`);
}

main().catch((error: unknown) => {
  log(`wallos-mcp could not start: ${describeError(error)}`);
  process.exit(1);
});
