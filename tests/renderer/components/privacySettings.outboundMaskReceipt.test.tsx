// ============================================================================
// PrivacySettings 出云掩码替换回执卡（N-PROMPT-SECRET-MASK-FU2 ④）
// 开关关 / 无记录 → 空态文案；开关开且有记录 → 「最近一次请求」摘要 + 展开/收起
// 的 kind → placeholder 行；zh / en 双语；行里只有占位符形态，没有原值。
// ============================================================================
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const invokeDomain = vi.hoisted(() => vi.fn());
const i18nMode = vi.hoisted(() => ({ lang: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: i18nMode.lang === 'zh' ? zh : en }),
}));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({ user: { isAdmin: true } }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn() },
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';

interface ReceiptReplacement { kind: string; placeholder: string }
interface ReceiptRecord { timestamp: number; provider?: string; model?: string; replacements: ReceiptReplacement[] }

const RECORDS: ReceiptRecord[] = [{
  timestamp: new Date('2026-11-02T08:00:00Z').getTime(),
  provider: 'deepseek',
  model: 'deepseek-chat',
  replacements: [
    { kind: 'OPENAI_KEY', placeholder: '{{SECRET_OPENAI_KEY_ab12cd34}}' },
    { kind: 'OPENAI_KEY', placeholder: '{{SECRET_OPENAI_KEY_ab12cd34}}' },
    { kind: 'ENV_SECRET', placeholder: '{{SECRET_ENV_SECRET_deadbeef}}' },
  ],
}];

function mockIpc(settings: Record<string, unknown>, records: ReceiptRecord[]): void {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve(settings);
    if (domain === IPC_DOMAINS.SETTINGS && action === 'set') return Promise.resolve(undefined);
    if (domain === IPC_DOMAINS.SETTINGS && action === 'getOutboundMaskRecords') return Promise.resolve(records);
    if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
      return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
    }
    if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
      return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
    }
    throw new Error(`Unexpected call ${domain}:${action}`);
  });
}

async function renderAndAwait(): Promise<void> {
  render(<PrivacySettings />);
  await screen.findByTestId('privacy-outbound-mask-receipt');
}

describe('PrivacySettings 出云掩码替换回执卡', () => {
  beforeEach(() => {
    invokeDomain.mockReset();
    i18nMode.lang = 'zh';
  });

  afterEach(() => {
    cleanup();
  });

  it('zh：开关关 → 空态文案（不发起回执拉取）', async () => {
    mockIpc({}, []);
    await renderAndAwait();

    expect(screen.getByTestId('privacy-outbound-mask-receipt-empty').textContent).toBe(zh.settings.outboundMaskReceipt.noneYet);
    const recordCalls = invokeDomain.mock.calls.filter((call) => call[1] === 'getOutboundMaskRecords');
    expect(recordCalls).toHaveLength(0);
  });

  it('zh：开关开但无记录 → 空态文案', async () => {
    mockIpc({ privacy: { outboundSecretMask: true } }, []);
    await renderAndAwait();

    expect(screen.getByTestId('privacy-outbound-mask-receipt-empty').textContent).toBe('还没有替换记录');
  });

  it('zh：有记录 → 摘要（种类计数）+ 展开后 kind → placeholder 行与提示', async () => {
    mockIpc({ privacy: { outboundSecretMask: true } }, RECORDS);
    await renderAndAwait();

    const summary = await screen.findByTestId('privacy-outbound-mask-receipt-summary');
    expect(summary.textContent).toBe('最近一次请求：替换 3 处（OPENAI_KEY 2, ENV_SECRET 1）');
    // 未展开：行不渲染
    expect(screen.queryByTestId('privacy-outbound-mask-receipt-rows')).toBeNull();

    fireEvent.click(screen.getByTestId('privacy-outbound-mask-receipt-toggle'));
    const rows = screen.getByTestId('privacy-outbound-mask-receipt-rows');
    expect(rows.textContent).toContain('OPENAI_KEY');
    expect(rows.textContent).toContain('{{SECRET_OPENAI_KEY_ab12cd34}}');
    expect(rows.textContent).toContain('ENV_SECRET');
    expect(rows.textContent).toContain('{{SECRET_ENV_SECRET_deadbeef}}');
    // 元信息行带 provider/model
    expect(rows.textContent).toContain('deepseek');
    // 无原值提示文案在场
    expect(screen.getByText(zh.settings.outboundMaskReceipt.noPlaintextHint)).toBeTruthy();

    // 收起回去
    fireEvent.click(screen.getByTestId('privacy-outbound-mask-receipt-toggle'));
    expect(screen.queryByTestId('privacy-outbound-mask-receipt-rows')).toBeNull();
  });

  it('en：摘要 / 空态按英文文案渲染', async () => {
    i18nMode.lang = 'en';
    mockIpc({ privacy: { outboundSecretMask: true } }, RECORDS);
    await renderAndAwait();

    const summary = await screen.findByTestId('privacy-outbound-mask-receipt-summary');
    expect(summary.textContent).toBe('Last request: 3 replaced (OPENAI_KEY 2, ENV_SECRET 1)');
    fireEvent.click(screen.getByTestId('privacy-outbound-mask-receipt-toggle'));
    expect(screen.getByTestId('privacy-outbound-mask-receipt-rows').textContent)
      .toContain('{{SECRET_ENV_SECRET_deadbeef}}');

    cleanup();
    mockIpc({}, []);
    await renderAndAwait();
    expect(screen.getByTestId('privacy-outbound-mask-receipt-empty').textContent).toBe('No replacements yet');
  });

  it('回执拉取失败 → 静默呈现空态（不炸设置页）', async () => {
    mockIpc({ privacy: { outboundSecretMask: true } }, []);
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'getOutboundMaskRecords') {
        return Promise.reject(new Error('ipc unavailable'));
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return Promise.resolve({ privacy: { outboundSecretMask: true } });
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'set') return Promise.resolve(undefined);
      if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
        return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
      }
      if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
        return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
      }
      throw new Error(`Unexpected call ${domain}:${action}`);
    });
    await renderAndAwait();

    await waitFor(() => {
      expect(screen.getByTestId('privacy-outbound-mask-receipt-empty').textContent).toBe('还没有替换记录');
    });
  });
});
