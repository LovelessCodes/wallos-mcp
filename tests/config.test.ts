import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, parseArgs, resolveConfig } from '../src/config.js';
import { WallosConfigError } from '../src/errors.js';

describe('normalizeBaseUrl', () => {
  it('accepts a bare host and assumes https', () => {
    expect(normalizeBaseUrl('wallos.example.com')).toBe('https://wallos.example.com');
  });

  it('keeps the scheme and port that were given', () => {
    expect(normalizeBaseUrl('http://192.168.1.10:8282')).toBe('http://192.168.1.10:8282');
    expect(normalizeBaseUrl('https://wallos.example.com:8443')).toBe('https://wallos.example.com:8443');
  });

  it('strips a trailing slash, the page someone was looking at, or both', () => {
    expect(normalizeBaseUrl('https://wallos.example.com/')).toBe('https://wallos.example.com');
    expect(normalizeBaseUrl('https://wallos.example.com/index.php')).toBe('https://wallos.example.com');
    expect(normalizeBaseUrl('https://wallos.example.com/index.php/')).toBe('https://wallos.example.com');
  });

  it('keeps a subpath, since Wallos is often served from one', () => {
    expect(normalizeBaseUrl('https://example.com/wallos')).toBe('https://example.com/wallos');
    expect(normalizeBaseUrl('https://example.com/wallos/')).toBe('https://example.com/wallos');
    expect(normalizeBaseUrl('https://example.com/wallos/index.php')).toBe('https://example.com/wallos');
  });

  it('rejects what it cannot use', () => {
    expect(() => normalizeBaseUrl('')).toThrow(WallosConfigError);
    expect(() => normalizeBaseUrl('   ')).toThrow(WallosConfigError);
    expect(() => normalizeBaseUrl('://not a url')).toThrow(WallosConfigError);
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow(/http or https/);
  });
});

describe('parseArgs', () => {
  it('reads value flags in both spellings', () => {
    expect(parseArgs(['--url', 'https://a.example']).values.get('url')).toBe('https://a.example');
    expect(parseArgs(['--url=https://a.example']).values.get('url')).toBe('https://a.example');
    expect(parseArgs(['-u', 'https://a.example']).values.get('url')).toBe('https://a.example');
    expect(parseArgs(['-k', 'abc']).values.get('api-key')).toBe('abc');
  });

  it('reads boolean flags', () => {
    const parsed = parseArgs(['--read-only', '--insecure-tls']);
    expect(parsed.flags.has('read-only')).toBe(true);
    expect(parsed.flags.has('insecure-tls')).toBe(true);
  });

  it('collects unknown arguments instead of ignoring them', () => {
    expect(parseArgs(['--nope']).rest).toEqual(['--nope']);
    expect(parseArgs(['stray']).rest).toEqual(['stray']);
    // A value flag with nothing after it is a mistake, not an empty value.
    expect(parseArgs(['--url']).rest).toEqual(['--url']);
    expect(parseArgs(['--url', '--read-only']).rest).toEqual(['--url']);
  });
});

describe('resolveConfig', () => {
  const env = { WALLOS_URL: 'https://env.example', WALLOS_API_KEY: 'env-key' };

  it('reads from the environment', () => {
    const config = resolveConfig([], env);
    expect(config.baseUrl).toBe('https://env.example');
    expect(config.apiKey).toBe('env-key');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.readOnly).toBe(false);
    expect(config.enableAdminTools).toBe(false);
  });

  it('lets arguments win over the environment', () => {
    const config = resolveConfig(['--url', 'https://flag.example', '--api-key', 'flag-key'], env);
    expect(config.baseUrl).toBe('https://flag.example');
    expect(config.apiKey).toBe('flag-key');
  });

  it('reads the boolean environment variables', () => {
    const config = resolveConfig([], {
      ...env,
      WALLOS_READ_ONLY: '1',
      WALLOS_ENABLE_ADMIN_TOOLS: 'true',
      WALLOS_INSECURE_TLS: 'yes',
      WALLOS_TIMEOUT_MS: '5000',
    });
    expect(config.readOnly).toBe(true);
    expect(config.enableAdminTools).toBe(true);
    expect(config.insecureTls).toBe(true);
    expect(config.timeoutMs).toBe(5000);
  });

  it('treats "0" and "false" as off', () => {
    const config = resolveConfig([], { ...env, WALLOS_READ_ONLY: '0', WALLOS_INSECURE_TLS: 'false' });
    expect(config.readOnly).toBe(false);
    expect(config.insecureTls).toBe(false);
  });

  it('explains what is missing rather than starting broken', () => {
    expect(() => resolveConfig([], { WALLOS_API_KEY: 'k' })).toThrow(/WALLOS_URL/);
    expect(() => resolveConfig([], { WALLOS_URL: 'https://a.example' })).toThrow(/Profile/);
    expect(() => resolveConfig(['--timeout', 'soon'], env)).toThrow(/positive number/);
  });
});
