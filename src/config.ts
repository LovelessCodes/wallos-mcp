import { WallosConfigError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ServerConfig {
  /** Normalised instance URL, e.g. `https://wallos.example.com` or `http://192.168.1.10:8282/wallos`. */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  insecureTls: boolean;
  readOnly: boolean;
  enableAdminTools: boolean;
}

export interface ParsedArgs {
  values: Map<string, string>;
  flags: Set<string>;
  rest: string[];
}

const VALUE_FLAGS = new Set(['url', 'api-key', 'timeout']);
const BOOLEAN_FLAGS = new Set(['insecure-tls', 'read-only', 'admin-tools', 'help', 'version']);

const FLAG_ALIASES: Record<string, string> = {
  u: 'url',
  k: 'api-key',
  h: 'help',
  v: 'version',
};

/**
 * Parses `--flag value`, `--flag=value`, and `-f` style arguments. Unknown flags
 * are collected in `rest` so the caller can report them rather than silently
 * ignoring a typo.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (!arg.startsWith('-')) {
      rest.push(arg);
      continue;
    }

    const withoutDashes = arg.replace(/^--?/, '');
    const equalsIndex = withoutDashes.indexOf('=');
    const rawName = equalsIndex === -1 ? withoutDashes : withoutDashes.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : withoutDashes.slice(equalsIndex + 1);
    const name = FLAG_ALIASES[rawName] ?? rawName;

    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        values.set(name, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        rest.push(arg);
        continue;
      }
      values.set(name, next);
      index += 1;
      continue;
    }

    rest.push(arg);
  }

  return { values, flags, rest };
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Turns whatever a person typed into a base URL. Accepts a bare host, a URL with
 * a subpath, and a URL pasted straight out of the browser with `index.php` on
 * the end.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new WallosConfigError('The Wallos URL is empty. Pass the address you use in your browser, e.g. https://wallos.example.com');
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WallosConfigError(`"${raw}" is not a valid URL. Use something like https://wallos.example.com or http://192.168.1.10:8282`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WallosConfigError(`Wallos must be reached over http or https, but the URL uses "${url.protocol}".`);
  }

  // People often paste the page they were looking at rather than the host, so
  // trailing slashes and a trailing index.php are both stripped.
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/index\.php$/i, '')
    .replace(/\/+$/, '');

  return `${url.origin}${path}${url.search}`;
}

export function resolveConfig(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const { values, flags } = parseArgs(argv);

  const rawUrl = values.get('url') ?? env.WALLOS_URL ?? '';
  const apiKey = (values.get('api-key') ?? env.WALLOS_API_KEY ?? '').trim();

  const timeoutRaw = values.get('timeout') ?? env.WALLOS_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined && timeoutRaw !== '') {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new WallosConfigError(`Timeout must be a positive number of milliseconds, got "${timeoutRaw}".`);
    }
    timeoutMs = parsed;
  }

  if (rawUrl.trim() === '') {
    throw new WallosConfigError(
      'No Wallos instance configured. Set WALLOS_URL (or pass --url) to the address you open in your browser, e.g. https://wallos.example.com',
    );
  }

  if (apiKey === '') {
    throw new WallosConfigError(
      'No Wallos API key configured. Set WALLOS_API_KEY (or pass --api-key). Find yours in Wallos under Profile, in the API Key field; generate one if it is empty.',
    );
  }

  return {
    baseUrl: normalizeBaseUrl(rawUrl),
    apiKey,
    timeoutMs,
    insecureTls: flags.has('insecure-tls') || isTruthyEnv(env.WALLOS_INSECURE_TLS),
    readOnly: flags.has('read-only') || isTruthyEnv(env.WALLOS_READ_ONLY),
    enableAdminTools: flags.has('admin-tools') || isTruthyEnv(env.WALLOS_ENABLE_ADMIN_TOOLS),
  };
}

export const HELP_TEXT = `wallos-mcp - an MCP server for your self-hosted Wallos instance

Usage:
  wallos-mcp [options]

Options:
  -u, --url <url>        Base URL of your Wallos instance
                         (env: WALLOS_URL), e.g. https://wallos.example.com
  -k, --api-key <key>    Wallos API key (env: WALLOS_API_KEY)
                         Find it in Wallos under Profile -> API Key
      --timeout <ms>     Per-request timeout, default 30000 (env: WALLOS_TIMEOUT_MS)
      --read-only        Register no tools that can change anything (env: WALLOS_READ_ONLY)
      --admin-tools      Also register instance-wide admin tools, which can
                         reconfigure logins and mail (env: WALLOS_ENABLE_ADMIN_TOOLS)
      --insecure-tls     Skip TLS certificate verification, for a self-signed
                         certificate (env: WALLOS_INSECURE_TLS)
  -h, --help             Show this help
  -v, --version          Show the version

The server speaks MCP over stdio, so it is normally started by an MCP client
rather than by hand. Example client configuration:

  {
    "mcpServers": {
      "wallos": {
        "command": "npx",
        "args": ["-y", "wallos-mcp"],
        "env": {
          "WALLOS_URL": "https://wallos.example.com",
          "WALLOS_API_KEY": "your-api-key"
        }
      }
    }
  }
`;
