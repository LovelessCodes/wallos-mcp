const MASK = '********';

/**
 * Keys whose values are credentials. Wallos masks most of these itself, but a
 * tool result can end up in a model's context or in a transcript, so anything
 * that looks like a secret is masked on the way out regardless.
 */
const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|api_?key|apikey|sendkey|user_?key|headers|webhook_?url|credential|authorization)/i;

function isAlreadyMasked(value: string): boolean {
  return /^\*+$/.test(value);
}

/** Replaces every occurrence of the given secret strings in free text. */
export function redactSecrets(text: string, ...secrets: Array<string | undefined>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 6) continue;
    result = result.split(secret).join(MASK);
  }
  return result;
}

/** Deep-copies a value, masking the contents of credential-shaped keys. */
export function redactObject<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry));
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (typeof entry === 'string' && SENSITIVE_KEY_PATTERN.test(key) && entry !== '' && !isAlreadyMasked(entry)) {
        result[key] = MASK;
        continue;
      }
      result[key] = walk(entry);
    }
    return result;
  }

  return value;
}
