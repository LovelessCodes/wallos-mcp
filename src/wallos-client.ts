import type { ServerConfig } from './config.js';
import { WallosApiError, WallosHttpError } from './errors.js';
import { redactSecrets } from './util/redact.js';

export type Envelope = Record<string, unknown> & {
  success?: unknown;
  title?: unknown;
  notes?: unknown;
};

export interface RequestOptions {
  method?: 'GET' | 'POST';
  /**
   * Return the body as text instead of insisting on the JSON envelope.
   * `get_ical_feed.php` answers with a VCALENDAR document, not JSON.
   */
  raw?: boolean;
}

/** A param value that has already been converted to the exact wire form. */
export type ParamValue = string | number | undefined | null;
export type Params = Record<string, ParamValue>;

const MAX_BODY_CHARS = 4_000_000;

function isSuccess(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function snippet(body: string, limit = 300): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '(empty body)';
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

/**
 * A thin client for the Wallos HTTP API.
 *
 * Three properties of that API shape this class, and all three have bitten
 * people building against it:
 *
 * 1. Every response is HTTP 200, authentication failures included. `success`
 *    in the body is the only signal, so that is what gets checked.
 * 2. Write endpoints read `$_POST` only, which in PHP means the body has to be
 *    form-encoded. A JSON body arrives empty and the endpoint reports a missing
 *    API key.
 * 3. Some flags are compared with `=== 'true'` rather than read as booleans, so
 *    callers pass the exact strings the endpoint expects instead of booleans.
 */
export class WallosClient {
  readonly #config: ServerConfig;

  constructor(config: ServerConfig) {
    this.#config = config;
  }

  get baseUrl(): string {
    return this.#config.baseUrl;
  }

  get readOnly(): boolean {
    return this.#config.readOnly;
  }

  /**
   * Reads use `$_REQUEST`, so either verb works and params may travel in the
   * query string. Writes must be POSTed as form data.
   */
  request<T = Envelope>(endpoint: string, params: Params = {}, options: RequestOptions = {}): Promise<T> {
    return this.#send<T>(endpoint, params, options);
  }

  read<T = Envelope>(endpoint: string, params: Params = {}): Promise<T> {
    return this.#send<T>(endpoint, params, { method: 'GET' });
  }

  write<T = Envelope>(endpoint: string, params: Params = {}): Promise<T> {
    return this.#send<T>(endpoint, params, { method: 'POST' });
  }

  async #send<T>(endpoint: string, params: Params, options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    let url = `${this.#config.baseUrl}/${endpoint.replace(/^\/+/, '')}`;

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.set(key, String(value));
    }
    // Every endpoint authenticates with the key itself, so it always travels
    // with the request: in the body for writes, in the query for reads.
    body.set('api_key', this.#config.apiKey);

    const init: RequestInit = {
      method,
      headers: { accept: 'application/json, text/calendar;q=0.9, */*;q=0.8' },
      signal: AbortSignal.timeout(this.#config.timeoutMs),
      redirect: 'follow',
    };

    if (method === 'GET') {
      url += `?${body.toString()}`;
    } else {
      init.body = body.toString();
      init.headers = {
        ...(init.headers as Record<string, string>),
        'content-type': 'application/x-www-form-urlencoded',
      };
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw this.#transportError(endpoint, error);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new WallosHttpError(endpoint, response.status, `Failed to read the response from ${endpoint}.`, {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new WallosHttpError(
        endpoint,
        response.status,
        `Wallos answered HTTP ${response.status} for ${endpoint}: ${redactSecrets(snippet(text), this.#config.apiKey)}`,
      );
    }

    if (options.raw) {
      return text.slice(0, MAX_BODY_CHARS) as T;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A PHP fatal error still returns 200 with an HTML or empty body, so this
      // is a real possibility rather than a wrong-URL symptom.
      throw new WallosHttpError(
        endpoint,
        response.status,
        `Wallos did not return JSON for ${endpoint}. Response began: ${redactSecrets(snippet(text), this.#config.apiKey)}`,
      );
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return parsed as T;
    }

    const envelope = parsed as Envelope;
    if ('success' in envelope && !isSuccess(envelope.success)) {
      throw new WallosApiError(
        endpoint,
        typeof envelope.title === 'string' ? envelope.title : 'Request failed',
        typeof envelope.message === 'string' ? envelope.message : undefined,
        envelope.notes,
      );
    }

    return envelope as T;
  }

  #transportError(endpoint: string, error: unknown): WallosHttpError {
    const host = this.#config.baseUrl;

    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new WallosHttpError(
        endpoint,
        null,
        `Timed out after ${this.#config.timeoutMs}ms waiting for ${host}/${endpoint}. Raise --timeout if this instance is slow.`,
        { cause: error },
      );
    }

    const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
    const code = cause?.code;
    const hints: Record<string, string> = {
      ENOTFOUND: `The host in ${host} could not be resolved.`,
      ECONNREFUSED: `Nothing is listening at ${host}.`,
      EHOSTUNREACH: `${host} is unreachable from this machine.`,
      ECONNRESET: `The connection to ${host} was reset.`,
      DEPTH_ZERO_SELF_SIGNED_CERT: `${host} presented a self-signed certificate; pass --insecure-tls to accept it.`,
      SELF_SIGNED_CERT_IN_CHAIN: `${host} presented a self-signed certificate; pass --insecure-tls to accept it.`,
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: `The certificate from ${host} could not be verified; pass --insecure-tls to accept it.`,
      CERT_HAS_EXPIRED: `The certificate from ${host} has expired.`,
    };

    const hint = code !== undefined ? hints[code] : undefined;
    if (hint !== undefined) {
      return new WallosHttpError(endpoint, null, `${hint} (${code})`, { cause: error });
    }

    return new WallosHttpError(
      endpoint,
      null,
      `Could not reach ${host}/${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
