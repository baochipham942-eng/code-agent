// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh: zhMessages }, { en: enMessages }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return {
    useI18n: () => ({
      t: state.language === 'en' ? enMessages : zhMessages,
      language: state.language,
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    dismissPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

function mailRequest(outboundMasked?: boolean): PermissionRequest {
  return {
    id: 'permission-outbound-mask',
    tool: 'mail_send',
    type: 'file_write',
    forceConfirm: true,
    details: {
      subject: 'Quarterly report',
      to: ['a@example.com'],
      content: 'The report is attached.',
      outboundMasked,
    } as PermissionRequest['details'],
    timestamp: 1,
  };
}

function enterEdit(messages: typeof zh | typeof en) {
  fireEvent.click(screen.getByRole('button', {
    name: new RegExp(messages.decisionCard.permission.writeback.optionEdit),
  }));
}

const locales = [
  ['zh', zh, '已去掉敏感信息'],
  ['en', en, 'Sensitive information removed'],
] as const;

describe('PermissionCard outbound mask notice', () => {
  afterEach(() => {
    cleanup();
    state.request = null;
    state.language = 'zh';
  });

  it.each(locales)('%s initial and edit views show the real localized note', (language, messages, text) => {
    state.language = language;
    state.request = mailRequest(true);
    render(<PermissionCard />);

    expect(screen.getByTestId('outbound-mask-notice').textContent).toContain(text);
    expect(screen.getByRole('note').textContent).toBe(messages.decisionCard.permission.writeback.outboundMaskedNote);

    enterEdit(messages);
    expect(screen.getByTestId('writeback-edit-form')).toBeTruthy();
    expect(screen.getByTestId('outbound-mask-notice').textContent).toContain(text);
    expect(screen.getByRole('note').textContent).toBe(messages.decisionCard.permission.writeback.outboundMaskedNote);
  });

  it.each(locales)('%s initial and edit views hide the note when the flag is false', (language, messages) => {
    state.language = language;
    state.request = mailRequest(false);
    render(<PermissionCard />);

    expect(screen.queryByTestId('outbound-mask-notice')).toBeNull();
    enterEdit(messages);
    expect(screen.getByTestId('writeback-edit-form')).toBeTruthy();
    expect(screen.queryByTestId('outbound-mask-notice')).toBeNull();
  });
});
