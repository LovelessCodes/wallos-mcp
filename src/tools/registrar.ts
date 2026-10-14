import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * The slice of `McpServer` the tool modules are allowed to touch. Narrowing it
 * keeps the modules free of server wiring and makes the read-only policy below
 * the single thing standing between a tool and a client.
 */
export type ToolRegistrar = Pick<McpServer, 'registerTool'>;

const PLACEHOLDER_TOOL = {
  enabled: false,
  enable() {},
  disable() {},
  remove() {},
  update() {},
  handler() {
    throw new Error('This tool was not registered.');
  },
} as unknown as RegisteredTool;

/**
 * A server that only accepts tools marked `readOnlyHint: true`.
 *
 * Read-only mode is meant to stop a misread prompt from deleting a
 * subscription, so the write tools are never registered rather than registered
 * and then refused: a client should not be offered a tool it cannot use.
 */
export function readOnlyRegistrar(server: McpServer): ToolRegistrar {
  return {
    registerTool: ((name: string, config: { annotations?: ToolAnnotations }, callback: unknown) => {
      if (config?.annotations?.readOnlyHint !== true) {
        return PLACEHOLDER_TOOL;
      }
      return (server.registerTool as (n: string, c: unknown, cb: unknown) => RegisteredTool)(name, config, callback);
    }) as McpServer['registerTool'],
  };
}
