import { describe, expect, it } from 'vitest';
import { redactSecrets, sanitizeLogValue } from '../../../src/main/security/secretRedaction';

describe('secret redaction', () => {
  it('fully redacts OpenAI-style raw and partially masked keys', () => {
    const rawKey = `sk-${'a'.repeat(24)}`;
    const maskedKey = 'sk-2769d*****7e68';
    const output = redactSecrets(`failed with ${rawKey} and ${maskedKey}`);

    expect(output).not.toContain(rawKey);
    expect(output).not.toContain(maskedKey);
    expect(output).toContain('sk-***REDACTED***');
  });

  it('redacts Google API keys and bearer tokens in strings', () => {
    const googleKey = `AIza${'A'.repeat(32)}`;
    const bearer = `Bearer ${'b'.repeat(24)}`;
    const output = redactSecrets(`google=${googleKey} auth=${bearer}`);

    expect(output).not.toContain(googleKey);
    expect(output).not.toContain(bearer);
    expect(output).toContain('AIza***REDACTED***');
    expect(output).toContain('Bearer ***REDACTED***');
  });

  it('recursively sanitizes sensitive structured values without flattening arrays', () => {
    const rawKey = `sk-${'c'.repeat(24)}`;
    const sanitized = sanitizeLogValue({
      message: `provider returned ${rawKey}`,
      nested: {
        apiKey: rawKey,
        safe: 'visible',
      },
      list: [rawKey, { authorization: `Bearer ${'d'.repeat(24)}` }],
    }) as {
      message: string;
      nested: { apiKey: string; safe: string };
      list: Array<string | { authorization: string }>;
    };

    expect(JSON.stringify(sanitized)).not.toContain(rawKey);
    expect(sanitized.message).toContain('sk-***REDACTED***');
    expect(sanitized.nested.apiKey).toBe('***REDACTED***');
    expect(sanitized.nested.safe).toBe('visible');
    expect(Array.isArray(sanitized.list)).toBe(true);
    expect((sanitized.list[1] as { authorization: string }).authorization).toBe('***REDACTED***');
  });
});
