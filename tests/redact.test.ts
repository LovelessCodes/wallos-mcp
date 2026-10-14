import { describe, expect, it } from 'vitest';
import { redactObject, redactSecrets } from '../src/util/redact.js';

describe('redactObject', () => {
  it('masks credentials wherever they appear', () => {
    const input = {
      user: { username: 'alice', password: 'hunter2', api_key: 'abc123' },
      oidc: { client_secret: 'sh-secret', client_id: 'public-id' },
      discord: { webhook_url: 'https://discord.com/api/webhooks/1/xyz' },
      smtp: { smtp_password: 'mailpass' },
      token: 'tok',
      bot_token: 'bot',
      sendkey: 'send',
    };

    const output = redactObject(input) as typeof input;

    expect(output.user.password).toBe('********');
    expect(output.user.api_key).toBe('********');
    expect(output.oidc.client_secret).toBe('********');
    expect(output.discord.webhook_url).toBe('********');
    expect(output.smtp.smtp_password).toBe('********');
    expect(output.token).toBe('********');
    expect(output.bot_token).toBe('********');
    expect(output.sendkey).toBe('********');
    // Non-credentials are left alone.
    expect(output.user.username).toBe('alice');
    expect(output.oidc.client_id).toBe('public-id');
  });

  it('reaches into arrays and nested objects', () => {
    const output = redactObject({ items: [{ password: 'a' }, { name: 'b' }] }) as {
      items: Array<{ password?: string; name?: string }>;
    };
    expect(output.items[0]?.password).toBe('********');
    expect(output.items[1]?.name).toBe('b');
  });

  it('leaves values Wallos already masked, and empty strings, as they were', () => {
    const output = redactObject({ api_key: '********', password: '' }) as { api_key: string; password: string };
    expect(output.api_key).toBe('********');
    expect(output.password).toBe('');
  });

  it('does not mutate the input', () => {
    const input = { password: 'hunter2' };
    redactObject(input);
    expect(input.password).toBe('hunter2');
  });

  it('passes through primitives', () => {
    expect(redactObject('plain')).toBe('plain');
    expect(redactObject(5)).toBe(5);
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('replaces a leaked secret inside free text', () => {
    const text = 'Wallos answered HTTP 500 for api/x.php: api_key=sk-live-abcdef123456';
    expect(redactSecrets(text, 'sk-live-abcdef123456')).toBe(
      'Wallos answered HTTP 500 for api/x.php: api_key=********',
    );
  });

  it('replaces every occurrence', () => {
    expect(redactSecrets('a s b s', 's')).toBe('a s b s'); // too short to be a secret
    expect(redactSecrets('key SECRETKEY key SECRETKEY', 'SECRETKEY')).toBe('key ******** key ********');
  });

  it('ignores undefined and short values, which would mangle ordinary text', () => {
    expect(redactSecrets('hello world', undefined)).toBe('hello world');
    expect(redactSecrets('hello world', 'o')).toBe('hello world');
  });
});
