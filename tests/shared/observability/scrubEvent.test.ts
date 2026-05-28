// ============================================================================
// scrubEvent 单测 — 锁住崩溃上报隐私红线
// ============================================================================
//
// 红线：发往 Sentry 的崩溃事件永远不能携带密钥 / 家目录绝对路径 / request body。
// 这些断言一旦红，说明脱敏破了，必须修而不是改测试。
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import { scrubString, scrubEvent, type ScrubbableEvent } from '@shared/observability/scrubEvent';

describe('scrubString', () => {
  describe('密钥打码', () => {
    it('打码 OpenAI 风格 sk- key', () => {
      const out = scrubString('key is sk-abcDEF1234567890xyz here');
      expect(out).not.toContain('sk-abcDEF1234567890xyz');
      expect(out).toContain('[REDACTED]');
    });

    it('打码 GitHub token ghp_', () => {
      const out = scrubString('token=ghp_0123456789abcdefABCDEF0123456789ab');
      expect(out).not.toContain('ghp_0123456789abcdefABCDEF0123456789ab');
      expect(out).toContain('[REDACTED]');
    });

    it('打码 Authorization Bearer', () => {
      const out = scrubString('Authorization: Bearer abcdef1234567890.token-XYZ');
      expect(out).not.toContain('abcdef1234567890.token-XYZ');
      expect(out).toContain('[REDACTED]');
    });

    it('打码 JWT (eyJ...)', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart';
      const out = scrubString(`session ${jwt} end`);
      expect(out).not.toContain(jwt);
      expect(out).toContain('[REDACTED]');
    });

    it('打码 key: value / password= 形态', () => {
      expect(scrubString('api_key: "s3cr3t-value-1234"')).toContain('[REDACTED]');
      expect(scrubString('password=supersecret123')).not.toContain('supersecret123');
      expect(scrubString('password=supersecret123')).toContain('[REDACTED]');
    });
  });

  describe('家目录抹除', () => {
    it('把 homeDir 前缀替换成 ~', () => {
      const out = scrubString('/Users/linchen/proj/src/secret.ts', { homeDir: '/Users/linchen' });
      expect(out).toBe('~/proj/src/secret.ts');
      expect(out).not.toContain('/Users/linchen');
    });

    it('未传 homeDir 时不改路径、不抛错', () => {
      const out = scrubString('/Users/linchen/proj/a.ts');
      expect(out).toContain('/Users/linchen/proj/a.ts');
    });

    it('空字符串 / 根目录 homeDir 不误伤', () => {
      expect(scrubString('/usr/local/bin', { homeDir: '' })).toBe('/usr/local/bin');
      expect(scrubString('/usr/local/bin', { homeDir: '/' })).toBe('/usr/local/bin');
    });
  });

  it('干净文本原样返回', () => {
    const clean = '普通错误信息 TypeError: cannot read property foo of undefined';
    expect(scrubString(clean)).toBe(clean);
  });
});

describe('scrubEvent', () => {
  const homeDir = '/Users/linchen';

  it('清洗 message 里的密钥', () => {
    const event: ScrubbableEvent = { message: 'crashed with sk-abcDEF1234567890xyz' };
    scrubEvent(event, { homeDir });
    expect(event.message).not.toContain('sk-abcDEF1234567890xyz');
  });

  it('清洗 exception value + 堆栈帧的 filename/abs_path', () => {
    const event: ScrubbableEvent = {
      exception: {
        values: [
          {
            value: 'Error near token ghp_0123456789abcdefABCDEF0123456789ab',
            stacktrace: {
              frames: [
                { filename: '/Users/linchen/proj/src/app.ts', abs_path: '/Users/linchen/proj/src/app.ts' },
              ],
            },
          },
        ],
      },
    };
    scrubEvent(event, { homeDir });
    const ex = event.exception!.values![0];
    expect(ex.value).toContain('[REDACTED]');
    expect(ex.value).not.toContain('ghp_0123456789abcdefABCDEF0123456789ab');
    expect(ex.stacktrace!.frames![0].filename).toBe('~/proj/src/app.ts');
    expect(ex.stacktrace!.frames![0].abs_path).toBe('~/proj/src/app.ts');
  });

  it('清洗 breadcrumb message', () => {
    const event: ScrubbableEvent = {
      breadcrumbs: [{ message: 'fetch with Bearer abcdef1234567890token' }],
    };
    scrubEvent(event, { homeDir });
    expect(event.breadcrumbs![0].message).toContain('[REDACTED]');
  });

  it('丢弃 request.data 和 request.cookies（可能夹带用户内容/凭证）', () => {
    const event: ScrubbableEvent = {
      request: { data: { prompt: '我的私有源码…' }, cookies: 'session=abc' },
    };
    scrubEvent(event, { homeDir });
    expect(event.request!.data).toBeUndefined();
    expect(event.request!.cookies).toBeUndefined();
  });

  it('就地修改并返回同一对象', () => {
    const event: ScrubbableEvent = { message: 'hello' };
    const out = scrubEvent(event, { homeDir });
    expect(out).toBe(event);
  });

  it('空 event / 缺字段不抛错', () => {
    expect(() => scrubEvent({}, { homeDir })).not.toThrow();
    expect(() => scrubEvent({ exception: { values: [] } })).not.toThrow();
    expect(() => scrubEvent({ exception: { values: [{}] } })).not.toThrow();
  });
});
