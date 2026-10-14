import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from '../config.js';
import { describeError } from '../errors.js';
import { redactObject } from '../util/redact.js';
import { loadMasterData, resolveEntityId, type EntityKind, type EntityRef, type MasterData } from '../util/resolve.js';
import type { Envelope, WallosClient } from '../wallos-client.js';

export interface ToolContext {
  client: WallosClient;
  config: ServerConfig;
}

const MAX_TEXT_CHARS = 60_000;

export function ok(data: unknown): CallToolResult {
  // Everything leaving this server has been through redaction: a tool result
  // can end up in a model's context, a transcript, or a log.
  const text = JSON.stringify(redactObject(data), null, 2);
  if (text.length > MAX_TEXT_CHARS) {
    return {
      content: [
        {
          type: 'text',
          text: `${text.slice(0, MAX_TEXT_CHARS)}\n... (truncated ${text.length - MAX_TEXT_CHARS} characters)`,
        },
      ],
    };
  }
  return { content: [{ type: 'text', text }] };
}

export function okText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: describeError(error) }], isError: true };
}

/**
 * Narrows an envelope to the parts worth putting in front of a model: the
 * payload itself and any warnings Wallos attached to it. `success` and `title`
 * carry no information once we are past the client's error check.
 */
export function respond(envelope: Envelope, keys: string[]): CallToolResult {
  const payload: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in envelope && envelope[key] !== undefined) {
      payload[key] = envelope[key];
    }
  }

  const notes = envelope.notes;
  if (Array.isArray(notes) && notes.length > 0) {
    payload.notes = notes;
  } else if (typeof notes === 'string' && notes !== '') {
    payload.notes = notes;
  }

  return ok(payload);
}

/**
 * Resolves names to ids against a single snapshot of the instance's master
 * data, so one tool call does not re-fetch categories for every field.
 *
 * A reference is either a name or a numeric id, which is what a person or a
 * model will have to hand: "Entertainment" or 3.
 */
export function createResolver(ctx: ToolContext) {
  let cached: MasterData | null = null;

  async function data(): Promise<MasterData> {
    cached ??= await loadMasterData(ctx.client);
    return cached;
  }

  async function resolve(
    kind: EntityKind,
    value: string | number | undefined,
    createIfMissing = false,
  ): Promise<number | undefined> {
    if (value === undefined) return undefined;
    if (typeof value === 'number') return value;

    const ref: EntityRef = /^\d+$/.test(value.trim()) ? { id: Number(value.trim()) } : { name: value };
    return resolveEntityId({ client: ctx.client, data: await data(), kind, ref, createIfMissing });
  }

  return {
    data,
    resolve,

    /**
     * A filter takes names or ids and never creates anything, so an unknown
     * name is an error that lists what does exist.
     */
    async resolveFilter(
      kind: EntityKind,
      value: string | number | Array<string | number> | undefined,
    ): Promise<string | undefined> {
      if (value === undefined) return undefined;
      const items = Array.isArray(value) ? value : [value];
      if (items.length === 0) return undefined;

      const ids: number[] = [];
      for (const item of items) {
        const id = await resolve(kind, item);
        if (id !== undefined) ids.push(id);
      }

      return ids.length > 0 ? ids.join(',') : undefined;
    },
  };
}

export type Resolver = ReturnType<typeof createResolver>;

/** Wallos compares several flags against the literal string "true". */
export function boolFlag(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? 'true' : 'false';
}

/** Wallos stores its own on/off columns as the strings "1" and "0". */
export function toggle(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? '1' : '0';
}
