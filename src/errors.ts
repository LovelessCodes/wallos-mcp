export class WallosError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WallosError';
  }
}

/** Raised when the server is misconfigured (bad URL, missing key, ...). */
export class WallosConfigError extends WallosError {
  constructor(message: string) {
    super(message);
    this.name = 'WallosConfigError';
  }
}

/**
 * Wallos answers `{ success: false, title, message, notes }` with HTTP 200 for
 * every application-level failure, so this is the API's own way of saying no.
 */
export class WallosApiError extends WallosError {
  readonly endpoint: string;
  readonly title: string;
  readonly notes: string[];

  constructor(endpoint: string, title: string, message?: string, notes: unknown = []) {
    const detail = message && message !== title ? `: ${message}` : '';
    super(`Wallos rejected ${endpoint} (${title})${detail}`);
    this.name = 'WallosApiError';
    this.endpoint = endpoint;
    this.title = title;
    this.notes = Array.isArray(notes) ? notes.map((note) => String(note)) : [];
  }
}

/** Raised for transport-level failures: DNS, TLS, timeouts, and non-2xx statuses. */
export class WallosHttpError extends WallosError {
  readonly endpoint: string;
  readonly status: number | null;

  constructor(endpoint: string, status: number | null, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WallosHttpError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof WallosApiError) {
    const notes = error.notes.length > 0 ? ` Notes: ${error.notes.join(' ')}` : '';
    return `${error.message}.${notes}`;
  }
  if (error instanceof WallosError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
