// @vitest-environment jsdom
// ============================================================================
// SearchSettings 搜索源 API Key 配置测试：
// 1. 未配 Key 的付费源就地渲染输入框，保存走 setServiceApiKey 且状态就地翻转
// 2. 已配 Key 的源默认收起（打码值 + 更换），不渲染明文输入框
// 3. 静态不变量：SEARCH_SOURCE_CATALOG 所有 serviceKey 都在 getAllServiceKeys 枚举里
//    （防「新增付费源忘了加枚举 → 永远显示需配 Key」回潮）
// 4. 空串保存 = 清除，需先过 ConfirmDialog
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { SEARCH_SOURCE_CATALOG } from '../../../src/shared/constants';
import { MASKED_SERVICE_KEY_LIST } from '../../../src/shared/contract/configService';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invokeDomain,
  default: { invokeDomain },
}));

import { SearchSettings } from '../../../src/renderer/components/features/settings/tabs/SearchSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

/** 默认载荷：brave 已配 Key（打码值），其余付费源未配。 */
function mockBaseline() {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'get') return Promise.resolve({});
    if (action === 'getAllServiceKeys') return Promise.resolve({ brave: 'bravekey...' });
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  invokeDomain.mockReset();
  mockBaseline();
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('SearchSettings 搜索源 API Key', () => {
  it('未配 Key 的源渲染输入框；保存调 setServiceApiKey 且状态就地翻成「已配 Key」', async () => {
    render(<SearchSettings />);
    const input = await screen.findByTestId('search-key-input-tavily');

    // 基线：4 个未配 Key 的付费源（perplexity/openai/exa/tavily）+ 2 个外部搜索源
    // 凭据（zhipu-search/minimax-search），brave 已配
    expect(screen.getAllByText('需配 Key')).toHaveLength(6);
    expect(screen.getAllByText('已配 Key')).toHaveLength(1);

    fireEvent.change(input, { target: { value: 'tvly-test-key-123' } });
    fireEvent.click(screen.getByTestId('search-key-save-tavily'));

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'tavily', apiKey: 'tvly-test-key-123' },
      );
    });

    // 就地翻转：不整页 reload（不再有 get 调用），状态文案与打码值直接更新
    await waitFor(() => {
      expect(screen.getAllByText('需配 Key')).toHaveLength(5);
      expect(screen.getAllByText('已配 Key')).toHaveLength(2);
    });
    expect(screen.getByTestId('search-key-masked-tavily').textContent).toBe('tvly-tes...');
    expect(screen.queryByTestId('search-key-input-tavily')).toBeNull();
    expect(invokeDomain.mock.calls.filter(([, action]) => action === 'get')).toHaveLength(1);
  });

  it('已配 Key 的源默认收起：显示打码值 + 更换，不渲染明文输入框', async () => {
    render(<SearchSettings />);
    await screen.findByTestId('search-key-masked-brave');

    expect(screen.getByTestId('search-key-masked-brave').textContent).toBe('bravekey...');
    expect(screen.queryByTestId('search-key-input-brave')).toBeNull();

    // 点「更换」才展开输入框
    fireEvent.click(screen.getByTestId('search-key-change-brave'));
    expect(screen.getByTestId('search-key-input-brave')).toBeTruthy();
  });

  it('不变量：catalog 里每个 serviceKey 都在 getAllServiceKeys 的枚举列表里', () => {
    const enumerated = new Set<string>(MASKED_SERVICE_KEY_LIST);
    // flatMap 收窄而不是 `is string` 谓词：serviceKey 的联合类型比 string 窄，
    // 谓词写 string 会 TS2677；用 as 抹平则等于把门的类型信息丢掉。
    const missing = SEARCH_SOURCE_CATALOG
      .flatMap((entry) => (entry.serviceKey ? [entry.serviceKey] : []))
      .filter((serviceKey) => !enumerated.has(serviceKey));
    expect(missing).toEqual([]);
  });

  it('空串保存 = 清除 Key，需先过 ConfirmDialog 确认', async () => {
    render(<SearchSettings />);
    await screen.findByTestId('search-key-masked-brave');

    fireEvent.click(screen.getByTestId('search-key-change-brave'));
    invokeDomain.mockClear();

    // 已配 Key + 空输入 → 保存按钮可用，点击先弹确认而不是直接写
    fireEvent.click(screen.getByTestId('search-key-save-brave'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'brave', apiKey: '' },
      );
    });

    // 状态翻回「需配 Key」，输入框重新展开
    await waitFor(() => {
      expect(screen.getAllByText('需配 Key')).toHaveLength(7);
    });
    expect(screen.queryByTestId('search-key-masked-brave')).toBeNull();
    expect(screen.getByTestId('search-key-input-brave')).toBeTruthy();
  });

  it('外部搜索源凭据：渲染两行独立输入，保存走 zhipu-search / minimax-search 且状态就地翻转', async () => {
    render(<SearchSettings />);
    const input = await screen.findByTestId('external-search-key-input-zhipu-search');

    // 两行都在，且各自带「与模型 key 不同」的占位提示
    expect(screen.getByTestId('external-search-key-input-minimax-search')).toBeTruthy();
    expect(input.getAttribute('placeholder')).toContain('与模型 key 不同');

    fireEvent.change(input, { target: { value: 'zhipu-official-key-1' } });
    fireEvent.click(screen.getByTestId('external-search-key-save-zhipu-search'));

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'zhipu-search', apiKey: 'zhipu-official-key-1' },
      );
    });

    // 就地翻转成打码值 + 更换，不整页 reload
    await waitFor(() => {
      expect(screen.getByTestId('external-search-key-masked-zhipu-search').textContent).toBe('zhipu-of...');
    });
    expect(screen.queryByTestId('external-search-key-input-zhipu-search')).toBeNull();
  });

  it('只配模型 key 不算配了搜索凭据：getAllServiceKeys 里出现 zhipu/minimax 也不翻转外部搜索源状态', async () => {
    // 模型 provider 的 key 与搜索凭据是两把。模拟后端只返回了模型 key 的场景，
    // 两行外部搜索源必须仍显示「需配 Key」、输入框保持展开。
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'get') return Promise.resolve({});
      if (action === 'getAllServiceKeys') return Promise.resolve({ brave: 'bravekey...', zhipu: 'modelkey...', minimax: 'modelkey...' });
      return Promise.resolve(undefined);
    });

    render(<SearchSettings />);
    await screen.findByTestId('external-search-key-input-zhipu-search');

    expect(screen.getByTestId('external-search-key-input-zhipu-search')).toBeTruthy();
    expect(screen.getByTestId('external-search-key-input-minimax-search')).toBeTruthy();
    expect(screen.queryByTestId('external-search-key-masked-zhipu-search')).toBeNull();
    expect(screen.queryByTestId('external-search-key-masked-minimax-search')).toBeNull();
  });
});
