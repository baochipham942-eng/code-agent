// @vitest-environment jsdom
// useCapabilityInventory 的 renderHook 测试：IPC-backed hook 的代表样例。
// mock ipcService.invokeDomain，覆盖挂载自动 reload / setEnabled / installDraft /
// removeDraft 的成功与错误分支 + actionKey 生命周期 + items 派生 + clearActionResult。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...a: unknown[]) => invokeDomain(...a) },
}));

import { useCapabilityInventory } from '../../../src/renderer/hooks/useCapabilityInventory';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const item = (over: Record<string, unknown> = {}) =>
  ({ id: 'cap1', name: '搜索', kind: 'skill', ...over }) as never;
const inventory = (items: unknown[] = [item()]) => ({ items }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  invokeDomain.mockResolvedValue(inventory());
});

async function mountReady() {
  const view = renderHook(() => useCapabilityInventory());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

describe('挂载自动 reload', () => {
  it('加载成功后填充 inventory 与派生 items', async () => {
    const { result } = await mountReady();
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.CAPABILITY, 'list');
    expect(result.current.inventory).toEqual(inventory());
    expect(result.current.items).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('加载失败 → error 置位、inventory 为 null、items 退化为空', async () => {
    invokeDomain.mockRejectedValue(new Error('list boom'));
    const { result } = await mountReady();
    expect(result.current.error).toBe('list boom');
    expect(result.current.inventory).toBeNull();
    expect(result.current.items).toEqual([]);
  });
});

describe('setEnabled', () => {
  it('成功 → 调用 toggle 请求、更新 inventory、给出中文 actionResult', async () => {
    const { result } = await mountReady();
    const updated = inventory([item({ name: '搜索' })]);
    invokeDomain.mockResolvedValueOnce(updated);
    await act(async () => {
      await result.current.setEnabled(item(), true);
    });
    expect(invokeDomain).toHaveBeenLastCalledWith(IPC_DOMAINS.CAPABILITY, 'setEnabled', {
      id: 'cap1',
      kind: 'skill',
      enabled: true,
    });
    expect(result.current.actionResult).toEqual({ type: 'success', text: '搜索 已启用' });
    expect(result.current.actionKey).toBeNull(); // finally 清空
  });

  it('禁用文案区分', async () => {
    const { result } = await mountReady();
    await act(async () => {
      await result.current.setEnabled(item(), false);
    });
    expect(result.current.actionResult?.text).toBe('搜索 已禁用');
  });

  it('失败 → error 置位且无 actionResult', async () => {
    const { result } = await mountReady();
    invokeDomain.mockRejectedValueOnce(new Error('toggle fail'));
    await act(async () => {
      await result.current.setEnabled(item(), true);
    });
    expect(result.current.error).toBe('toggle fail');
    expect(result.current.actionResult).toBeNull();
    expect(result.current.actionKey).toBeNull();
  });
});

describe('installDraft / removeDraft', () => {
  it('installDraft 透传 inputs 并给草稿生成文案', async () => {
    const { result } = await mountReady();
    await act(async () => {
      await result.current.installDraft(item(), { token: 'x' });
    });
    expect(invokeDomain).toHaveBeenLastCalledWith(IPC_DOMAINS.CAPABILITY, 'installDraft', {
      id: 'cap1',
      kind: 'skill',
      inputs: { token: 'x' },
    });
    expect(result.current.actionResult?.text).toBe('搜索 草稿已生成');
  });

  it('installDraft 无 inputs 时不带该字段', async () => {
    const { result } = await mountReady();
    await act(async () => {
      await result.current.installDraft(item());
    });
    expect(invokeDomain).toHaveBeenLastCalledWith(IPC_DOMAINS.CAPABILITY, 'installDraft', {
      id: 'cap1',
      kind: 'skill',
    });
  });

  it('installDraft 失败 → error', async () => {
    const { result } = await mountReady();
    invokeDomain.mockRejectedValueOnce(new Error('draft fail'));
    await act(async () => {
      await result.current.installDraft(item());
    });
    expect(result.current.error).toBe('draft fail');
  });

  it('removeDraft 成功文案', async () => {
    const { result } = await mountReady();
    await act(async () => {
      await result.current.removeDraft(item());
    });
    expect(invokeDomain).toHaveBeenLastCalledWith(IPC_DOMAINS.CAPABILITY, 'removeDraft', {
      id: 'cap1',
      kind: 'skill',
    });
    expect(result.current.actionResult?.text).toBe('搜索 草稿已删除');
  });

  it('removeDraft 失败 → error', async () => {
    const { result } = await mountReady();
    invokeDomain.mockRejectedValueOnce(new Error('rm fail'));
    await act(async () => {
      await result.current.removeDraft(item());
    });
    expect(result.current.error).toBe('rm fail');
  });
});

describe('clearActionResult + reload', () => {
  it('clearActionResult 清掉提示', async () => {
    const { result } = await mountReady();
    await act(async () => {
      await result.current.setEnabled(item(), true);
    });
    expect(result.current.actionResult).not.toBeNull();
    act(() => result.current.clearActionResult());
    expect(result.current.actionResult).toBeNull();
  });

  it('手动 reload 重新拉取', async () => {
    const { result } = await mountReady();
    invokeDomain.mockClear();
    await act(async () => {
      await result.current.reload();
    });
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.CAPABILITY, 'list');
  });
});
