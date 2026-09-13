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

describe('会话操作里的模型下拉必须说真话（N-MOBILE-MODELPICK-LIES）', () => {
  afterEach(cleanup);

  // 爸 2026-09-12 真机：会话实为 custom-glm-coding/glm-5.3-flash，下拉却写着
  // "DeepSeek · DeepSeek V4.1 Flash"，而紧挨着就是「使用此模型」——一点就把会话换掉了。
  // 根因：library.models 由电脑侧 buildRuntimeModelOptions 产出，会剔掉没配 key 的 provider。
  const offListSession = {
    sessions: [{ id: 's1', title: '用一句话说明 cowork 是什么', projectId: 'one',
      provider: 'custom-glm-coding', model: 'glm-5.3-flash' }],
  } as unknown as Partial<CompanionLibrary>;

  function mountMore() {
    const manage = vi.fn(async () => {});
    render(<LibrarySheet library={{ ...library, ...offListSession }} sessionId="s1" text={text} busy={false} mode="more"
      select={() => {}} loadMore={() => {}} manage={manage} />);
    return { manage, select: screen.getByLabelText(text.model) as HTMLSelectElement };
  }

  it('会话用的模型不在列表里时，下拉显示的是它本身，不是拿别的模型冒充', () => {
    const { select } = mountMore();
    expect(select.value).toBe(key('custom-glm-coding', 'glm-5.3-flash'));
    // 显示文案要让人看懂它为什么不在列表里，而不是假装一切正常
    expect(screen.getByText(`${text.modelNotConfigured} · glm-5.3-flash`)).toBeTruthy();
    // 绝不能显示成列表里那两个真实模型中的任何一个
    expect(select.value).not.toBe(key('deepseek', 'deepseek-chat'));
    expect(select.value).not.toBe(key('moonshot', 'kimi-k2.6'));
  });

  it('「使用此模型」在没真正改选之前保持禁用——它不是「确认当前」', () => {
    mountMore();
    expect((screen.getByRole('button', { name: text.useModel }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('真的改选了别的模型，按钮才可点，且按改选的那个提交', () => {
    const { manage, select } = mountMore();
    fireEvent.change(select, { target: { value: key('deepseek', 'deepseek-chat') } });
    const use = screen.getByRole('button', { name: text.useModel }) as HTMLButtonElement;
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    expect(manage).toHaveBeenCalledWith('session.model', { provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('会话用的模型在列表里时不许多长出一条只读项', () => {
    const inList = { sessions: [{ id: 's1', title: 'x', projectId: 'one', provider: 'deepseek', model: 'deepseek-chat' }] } as unknown as Partial<CompanionLibrary>;
    render(<LibrarySheet library={{ ...library, ...inList }} sessionId="s1" text={text} busy={false} mode="more"
      select={() => {}} loadMore={() => {}} manage={vi.fn(async () => {})} />);
    expect(document.querySelectorAll('#model-select option').length).toBe(library.models.length);
    expect(screen.queryByText(new RegExp(text.modelNotConfigured))).toBeNull();
  });
});
