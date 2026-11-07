// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: vi.fn(() => () => undefined), invoke: vi.fn(async () => undefined), invokeDomain: vi.fn(async () => undefined) },
}));

import { FlatFeeBudgetNote } from '../../../src/renderer/components/features/cron/FlatFeeBudgetNote';
import { CronWebhookScheduleFields } from '../../../src/renderer/components/features/cron/CronWebhookScheduleFields';
import { CronMailEventFields } from '../../../src/renderer/components/features/cron/CronMailEventFields';
import { CronEventScheduleFields } from '../../../src/renderer/components/features/cron/CronEventScheduleFields';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { ModelConfig } from '../../../src/shared/contract/model';

function setModel(provider: string, model: string, language: 'zh' | 'en') {
  const base = useAppStore.getState().modelConfig;
  useAppStore.setState({ language, modelConfig: { ...base, provider, model } as ModelConfig });
}

afterEach(cleanup);

describe('FlatFeeBudgetNote', () => {
  it('包月默认模型：zh 提示点名模型并给出路', () => {
    setModel('xiaomi', 'mimo-v2.6-flash', 'zh');
    render(<FlatFeeBudgetNote variant="cron" />);
    const note = screen.getByTestId('flat-fee-budget-note');
    expect(note.textContent).toContain('mimo-v2.6-flash');
    expect(note.textContent).toContain('包月模型，不按美元计费，美元上限对它不生效');
    expect(note.textContent).toContain('执行超时');
  });

  it('包月默认模型：en 提示', () => {
    setModel('xiaomi', 'mimo-v2.6-flash', 'en');
    render(<FlatFeeBudgetNote variant="settings" />);
    expect(screen.getByTestId('flat-fee-budget-note').textContent)
      .toContain('flat-fee model and is not billed in USD');
  });

  it.each(['zh', 'en'] as const)('glm-5.3 按量计价：%s 下不渲染', (language) => {
    setModel('zhipu', 'glm-5.3', language);
    const { container } = render(<FlatFeeBudgetNote variant="cron" />);
    expect(container.innerHTML).toBe('');
  });

  it('三个 cron 预算字段在包月模型下都渲染提示，按量模型下没有', () => {
    const noop = () => undefined;
    const renderAll = () => render(
      <>
        <CronWebhookScheduleFields loading={false} configured onGotoSettings={noop} maxRunBudget="1" onBudgetChange={noop} validationMessage={null} />
        <CronMailEventFields accountId="a" mailbox="" onAccountChange={noop} onMailboxChange={noop} maxRunBudget="1" onBudgetChange={noop} violation={null} />
        <CronEventScheduleFields accountId="a" chatId="" onAccountChange={noop} onChatChange={noop} maxRunBudget="1" onBudgetChange={noop} validationMessage={null} />
      </>,
    );
    setModel('xiaomi', 'mimo-v2.6-flash', 'zh');
    renderAll();
    expect(screen.getAllByTestId('flat-fee-budget-note')).toHaveLength(3);
    cleanup();
    setModel('zhipu', 'glm-5.3', 'zh');
    renderAll();
    expect(screen.queryAllByTestId('flat-fee-budget-note')).toHaveLength(0);
  });
});
