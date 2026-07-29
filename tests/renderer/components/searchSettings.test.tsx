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

    // 基线：4 个未配 Key 的付费源（perplexity/openai/exa/tavily），brave 已配
    expect(screen.getAllByText('需配 Key')).toHaveLength(4);
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
      expect(screen.getAllByText('需配 Key')).toHaveLength(3);
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
      expect(screen.getAllByText('需配 Key')).toHaveLength(5);
    });
    expect(screen.queryByTestId('search-key-masked-brave')).toBeNull();
    expect(screen.getByTestId('search-key-input-brave')).toBeTruthy();
  });
});
