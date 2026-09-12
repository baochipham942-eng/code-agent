// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LibrarySheet } from '../../../packages/mobile/src/features/sessions/LibrarySheet';
import { messages } from '../../../packages/mobile/src/i18n';
import type { CompanionLibrary } from '../../../src/shared/contract/companionLibrary';

const text = messages('zh');
const key = (provider: string, model: string) => JSON.stringify([provider, model]);

// 列表第一项是手机上真实看到的 Kimi，电脑的默认是 deepseek（FB-141 的现场）
const library: CompanionLibrary = {
  nextOffset: null,
  projects: [{ id: 'one', name: 'One', canCreate: true }],
  sessions: [],
  models: [
    { provider: 'moonshot', model: 'kimi-k2.6', label: 'Kimi K2.6', providerLabel: 'Kimi' },
    { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true },
  ],
};

function mount(overrides: Partial<CompanionLibrary> = {}) {
  const manage = vi.fn(async () => {});
  render(<LibrarySheet library={{ ...library, ...overrides }} sessionId={null} text={text} busy={false} mode="projects"
    select={() => {}} loadMore={() => {}} manage={manage} />);
  return { manage, select: screen.getByLabelText(text.model) as HTMLSelectElement };
}

describe('mobile model picker default', () => {
  afterEach(cleanup);

  it('preselects the computer default instead of the first list entry', () => {
    const { select } = mount();
    expect(select.value).toBe(key('deepseek', 'deepseek-chat'));
  });

  it('creates the session with the computer default', () => {
    const { manage, select } = mount();
    expect(select.value).not.toBe(key('moonshot', 'kimi-k2.6'));
    fireEvent.click(screen.getByRole('button', { name: text.newSession }));
    expect(manage).toHaveBeenCalledWith('session.create',
      expect.objectContaining({ provider: 'deepseek', model: 'deepseek-chat' }), 'project:one');
  });

  it('falls back to the first entry when the computer default is not selectable', () => {
    const { select } = mount({ models: library.models.map(({ isDefault: _drop, ...model }) => model) });
    expect(select.value).toBe(key('moonshot', 'kimi-k2.6'));
  });
});
