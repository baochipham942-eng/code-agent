import { describe, expect, it } from 'vitest';
import { redactSecrets, redactToolResultSecrets, sanitizeLogValue } from '../../../src/host/security/secretRedaction';
import { sanitizeToolResultForHistory } from '../../../src/host/agent/messageHandling/converter';
import type { ToolResult } from '../../../src/shared/contract';

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

  it('redacts URL credentials and Cookie headers in strings', () => {
    const output = redactSecrets([
      'request=https://ledger-user:ledger-password@example.test/private',
      'Cookie: session_id=session-cookie-secret; theme=dark',
      'Set-Cookie: refresh_token=set-cookie-secret; Path=/; HttpOnly',
      'session_cookie=session-cookie-assignment',
    ].join('\n'));

    expect(output).not.toContain('ledger-user');
    expect(output).not.toContain('ledger-password');
    expect(output).not.toContain('session-cookie-secret');
    expect(output).not.toContain('set-cookie-secret');
    expect(output).not.toContain('session-cookie-assignment');
    expect(output).toContain('https://***REDACTED***@example.test/private');
    expect(output).toContain('Cookie: ***REDACTED***');
    expect(output).toContain('Set-Cookie: ***REDACTED***');
  });

  it('recursively sanitizes sensitive structured values without flattening arrays', () => {
    const rawKey = `sk-${'c'.repeat(24)}`;
    const sanitized = sanitizeLogValue({
      message: `provider returned ${rawKey}`,
      nested: {
        apiKey: rawKey,
        safe: 'visible',
        cookie: 'cookie-secret',
        setCookie: 'set-cookie-secret',
        session_cookie: 'session-cookie-secret',
      },
      list: [rawKey, { authorization: `Bearer ${'d'.repeat(24)}` }],
    }) as {
      message: string;
      nested: {
        apiKey: string;
        safe: string;
        cookie: string;
        setCookie: string;
        session_cookie: string;
      };
      list: Array<string | { authorization: string }>;
    };

    expect(JSON.stringify(sanitized)).not.toContain(rawKey);
    expect(sanitized.message).toContain('sk-***REDACTED***');
    expect(sanitized.nested.apiKey).toBe('***REDACTED***');
    expect(sanitized.nested.safe).toBe('visible');
    expect(sanitized.nested.cookie).toBe('***REDACTED***');
    expect(sanitized.nested.setCookie).toBe('***REDACTED***');
    expect(sanitized.nested.session_cookie).toBe('***REDACTED***');
    expect(Array.isArray(sanitized.list)).toBe(true);
    expect((sanitized.list[1] as { authorization: string }).authorization).toBe('***REDACTED***');
  });
});

describe('tool result 脱敏（transcript / 导出 / 事件流）', () => {
  const configDump = JSON.stringify({
    env: { ANTHROPIC_API_KEY: 'sk-ant-api03-realkeyvalue0001' },
    githubToken: `ghp_${'g'.repeat(36)}`,
    note: 'MAX_TOKENS = 128000',
  }, null, 2);

  it('redactToolResultSecrets 脱敏 output/error 里的密钥，正常内容原样保留', () => {
    const result: ToolResult = {
      toolCallId: 'call-1',
      success: true,
      output: `jq 读取 ~/.claude.json:\n${configDump}`,
      duration: 5,
    };

    const redacted = redactToolResultSecrets(result);

    expect(redacted.output).not.toContain('sk-ant-api03-realkeyvalue0001');
    expect(redacted.output).not.toContain(`ghp_${'g'.repeat(36)}`);
    // 不误伤：普通数字配置与非密钥文本原样保留
    expect(redacted.output).toContain('MAX_TOKENS = 128000');
    expect(redacted.output).toContain('jq 读取 ~/.claude.json');
    // 原对象不被改写
    expect(result.output).toContain('sk-ant-api03-realkeyvalue0001');
  });

  it('无密钥的结果原样返回（同引用，零拷贝路径）', () => {
    const result: ToolResult = {
      toolCallId: 'call-2',
      success: true,
      output: 'const token = userToken; // 普通代码',
      duration: 1,
    };

    expect(redactToolResultSecrets(result)).toBe(result);
  });

  it('error 字段同样脱敏', () => {
    const result: ToolResult = {
      toolCallId: 'call-3',
      success: false,
      error: `curl failed: Authorization: Bearer ${'b'.repeat(24)}`,
      duration: 1,
    };

    const redacted = redactToolResultSecrets(result);
    expect(redacted.error).not.toContain('b'.repeat(24));
  });

  it('sanitizeToolResultForHistory（会话落库收口）对 tool_result 脱敏', () => {
    const result: ToolResult = {
      toolCallId: 'call-4',
      success: true,
      output: configDump,
      duration: 3,
    };

    const sanitized = sanitizeToolResultForHistory(result);

    expect(sanitized.output).not.toContain('sk-ant-api03-realkeyvalue0001');
    expect(sanitized.output).not.toContain(`ghp_${'g'.repeat(36)}`);
    expect(sanitized.output).toContain('MAX_TOKENS = 128000');
  });
});
