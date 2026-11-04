// ============================================================================
// guardOutboundText —— 出站 shape-only 掩码（N-OUTBOUND-SENSITIVE-GUARD 验收①④）
// ----------------------------------------------------------------------------
// 出口三件套（cron 推送 / 通道回复 / mail_send）共用的出站掩码判据：
// 只掩数据形状（密钥 / SSN / 卡号 / 大陆身份证号），邮箱、路径、带 query 的
// URL 原样可读、不截断。与 guardSensitiveText（本地派生面，全掩 + 截断）分口径。
// 卡号 4111 1111 1111 1111 是公开的标准测试卡号；身份证号是测试内按 GB 11643
// 算法现造的校验位有效假号，均非真实凭据。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { guardOutboundText } from '../../../src/host/security/sensitiveDataGuard';

/** 标准测试卡号（Luhn 有效，各大支付网关文档通用）。 */
const TEST_CARD = '4111 1111 1111 1111';
/** 假 OpenAI 风格 key：40+ 字符纯 a，只为命中 sk-proj- 形状，非真实凭据。 */
const TEST_SK_KEY = `sk-proj-${'a'.repeat(50)}`;
/** 校验位有效的假身份证（110101 · 1990-01-01 · 顺序码 123，GB 11643 算法算出尾号 7）。 */
const TEST_CHINA_ID = '110101199001011237';

describe('guardOutboundText', () => {
  it('masks Luhn-valid card numbers', () => {
    const { text, redacted } = guardOutboundText(`订单用了卡 ${TEST_CARD}，请查收。`);
    expect(text).toBe('订单用了卡 [credit card hidden]，请查收。');
    expect(redacted).toBe(true);
  });

  it('masks checksum-valid mainland-China resident IDs', () => {
    const { text, redacted } = guardOutboundText(`持证人 ${TEST_CHINA_ID} 已核验。`);
    expect(text).toBe(`持证人 [id number hidden] 已核验。`);
    expect(redacted).toBe(true);
  });

  it.each([
    ['校验位错误的 18 位号', '11010119900101123X'],
    ['日期非法（13 月）的 18 位号', '110101199013011234'],
    ['未来出生日期的 18 位号', '110101209912311237'],
  ])('does not mask %s', (_label, candidate) => {
    const { text, redacted } = guardOutboundText(`流水号 ${candidate} 转账失败。`);
    expect(text).toBe(`流水号 ${candidate} 转账失败。`);
    expect(redacted).toBe(false);
  });

  it('masks 40+ char sk-proj- keys without dumping the whole key', () => {
    const { text, redacted } = guardOutboundText(`用这把 key：${TEST_SK_KEY}`);
    expect(text).not.toContain(TEST_SK_KEY);
    expect(text).toContain('sk-p');
    expect(redacted).toBe(true);
  });

  it('masks US SSN', () => {
    const { text } = guardOutboundText('SSN on file: 123-45-6789');
    expect(text).toBe('SSN on file: [ssn hidden]');
  });

  // 验收④：shape-only——邮箱、路径、URL（含 query）不得被顺手打烂。
  it('keeps emails, file paths and URLs with query strings unchanged', () => {
    const original = '发到 a.b@example.com；报告在 /Users/leo/report.pdf；'
      + '链接 https://example.com/search?q=quarterly+report&lang=en 可查。';
    const { text, redacted } = guardOutboundText(original);
    expect(text).toBe(original);
    expect(redacted).toBe(false);
  });

  it('keeps URLs readable: path survives, secret-named query values are masked', () => {
    // URL query 里的 token 值本身是密钥形状（Grok changelog 口径 "redacts card
    // numbers and access tokens"）——路径可读，token 键值掩掉。这与 guardSensitiveText
    // 的 sanitizeUrlTokens（整条 query 剥除）口径不同：出站只掩密钥形状。
    const { text, redacted } = guardOutboundText('文档在 https://example.com/doc?token=abcdefghijklmnop');
    expect(text).toContain('https://example.com/doc');
    expect(text).not.toContain('token=abcdefghijklmnop');
    expect(redacted).toBe(true);
  });

  it('does not truncate long text', () => {
    const long = `${'日报内容。'.repeat(20000)}${TEST_CARD}`;
    const { text, redacted } = guardOutboundText(long);
    expect(text).toContain('[credit card hidden]');
    expect(text).not.toContain('output truncated');
    expect(redacted).toBe(true);
  });

  it('is idempotent: masking the masked output changes nothing', () => {
    const once = guardOutboundText(`卡 ${TEST_CARD} 证 ${TEST_CHINA_ID}`);
    const twice = guardOutboundText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.redacted).toBe(false);
  });

  it('marks clean text as not redacted', () => {
    const { text, redacted } = guardOutboundText('今日无事，句号。');
    expect(text).toBe('今日无事，句号。');
    expect(redacted).toBe(false);
  });
});
