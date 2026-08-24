import { describe, expect, it } from 'vitest';
import { en, zh } from '../../../src/renderer/i18n';
import { formatReceiptSummary } from '../../../src/renderer/utils/receiptPresentation';

describe('formatReceiptSummary', () => {
  it('多人收件人摘要按当前语言组装', () => {
    const recipient = { first: 'a@example.com', count: 3 };
    expect(formatReceiptSummary('已发送邮件：周报', recipient, zh.receiptPresentation))
      .toBe('已发送邮件：周报 · 发给 a@example.com 等 3 人');
    expect(formatReceiptSummary('Weekly report sent', recipient, en.receiptPresentation))
      .toBe('Weekly report sent · Sent to a@example.com and others (3 recipients)');
  });

  it('单人摘要与无收件人摘要不串语言', () => {
    expect(formatReceiptSummary(
      'Weekly report sent',
      { first: 'a@example.com', count: 1 },
      en.receiptPresentation,
    )).toBe('Weekly report sent · Sent to a@example.com');
    expect(formatReceiptSummary('Weekly report sent', undefined, en.receiptPresentation))
      .toBe('Weekly report sent');
  });
});
