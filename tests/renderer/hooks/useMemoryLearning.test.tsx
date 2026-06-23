// @vitest-environment jsdom
// useMemoryLearning：监听 AI 学习/确认请求事件、显示 toast、处理确认队列。
// mock uiStore(showToast selector) + ipcService(on/invoke/isAvailable)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const showToast = vi.fn();
const ipc = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  invoke: vi.fn(async () => {}),
  handlers: {} as Record<string, (e: unknown) => void>,
  unsub: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/uiStore', () => ({
  useUIStore: (selector: (s: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => ipc.isAvailable(),
    invoke: (...a: unknown[]) => ipc.invoke(...a),
    on: (ch: string, cb: (e: unknown) => void) => {
      ipc.handlers[ch] = cb;
      return ipc.unsub;
    },
  },
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { useMemoryLearning, getCategoryLabel, getTypeLabel } from '../../../src/renderer/hooks/useMemoryLearning';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

beforeEach(() => {
  vi.clearAllMocks();
  ipc.isAvailable.mockReturnValue(true);
  ipc.invoke.mockResolvedValue(undefined);
  ipc.handlers = {};
});

async function mountReady() {
  const view = renderHook(() => useMemoryLearning());
  await waitFor(() => expect(ipc.handlers[IPC_CHANNELS.MEMORY_LEARNED]).toBeTypeOf('function'));
  return view;
}

describe('事件监听注册', () => {
  it('挂载注册 learned + confirm 两个监听', async () => {
    await mountReady();
    expect(ipc.handlers[IPC_CHANNELS.MEMORY_LEARNED]).toBeTypeOf('function');
    expect(ipc.handlers[IPC_CHANNELS.MEMORY_CONFIRM_REQUEST]).toBeTypeOf('function');
  });

  it('ipc 不可用 → 不注册', async () => {
    ipc.isAvailable.mockReturnValue(false);
    renderHook(() => useMemoryLearning());
    await act(async () => {});
    expect(ipc.handlers[IPC_CHANNELS.MEMORY_LEARNED]).toBeUndefined();
  });

  it('卸载取消订阅', async () => {
    const { unmount } = await mountReady();
    unmount();
    expect(ipc.unsub).toHaveBeenCalled();
  });
});

describe('学习完成事件 → toast', () => {
  it('短内容原样显示', async () => {
    await mountReady();
    act(() => ipc.handlers[IPC_CHANNELS.MEMORY_LEARNED]({ id: '1', category: 'preference', content: '喜欢深色' }));
    expect(showToast).toHaveBeenCalledWith('info', '我记住了: 喜欢深色', 5000);
  });

  it('超 50 字内容截断加省略号', async () => {
    await mountReady();
    const long = 'x'.repeat(60);
    act(() => ipc.handlers[IPC_CHANNELS.MEMORY_LEARNED]({ id: '1', category: 'learned', content: long }));
    expect(showToast).toHaveBeenCalledWith('info', `我记住了: ${'x'.repeat(50)}...`, 5000);
  });
});

describe('确认请求队列', () => {
  const req = (id: string) => ({ id, content: 'c', category: 'preference', type: 'pattern', confidence: 0.5, timestamp: 1 });

  it('收到确认请求 → 进 pendingConfirms', async () => {
    const { result } = await mountReady();
    act(() => ipc.handlers[IPC_CHANNELS.MEMORY_CONFIRM_REQUEST](req('a')));
    expect(result.current.pendingConfirms).toHaveLength(1);
    expect(result.current.pendingConfirms[0]).toMatchObject({ id: 'a', confidence: 0.5 });
  });

  it('confirmMemory → invoke confirmed:true + 移出队列 + success toast', async () => {
    const { result } = await mountReady();
    act(() => ipc.handlers[IPC_CHANNELS.MEMORY_CONFIRM_REQUEST](req('a')));
    await act(async () => {
      await result.current.confirmMemory('a');
    });
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE, { id: 'a', confirmed: true });
    expect(result.current.pendingConfirms).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith('success', '已确认并保存', 3000);
  });

  it('declineMemory → confirmed:false + 已跳过 toast', async () => {
    const { result } = await mountReady();
    act(() => ipc.handlers[IPC_CHANNELS.MEMORY_CONFIRM_REQUEST](req('b')));
    await act(async () => {
      await result.current.declineMemory('b');
    });
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE, { id: 'b', confirmed: false });
    expect(showToast).toHaveBeenCalledWith('info', '已跳过', 3000);
  });

  it('invoke 抛错 → error toast，队列不变', async () => {
    const { result } = await mountReady();
    act(() => ipc.handlers[IPC_CHANNELS.MEMORY_CONFIRM_REQUEST](req('c')));
    ipc.invoke.mockRejectedValueOnce(new Error('net'));
    await act(async () => {
      await result.current.confirmMemory('c');
    });
    expect(showToast).toHaveBeenCalledWith('error', '响应失败', 3000);
    expect(result.current.pendingConfirms).toHaveLength(1); // 失败未移除
  });
});

describe('label 纯函数', () => {
  it('getCategoryLabel 映射 + fallback', () => {
    expect(getCategoryLabel('about_me')).toBe('关于我');
    expect(getCategoryLabel('unknown')).toBe('unknown');
  });

  it('getTypeLabel 映射 + fallback', () => {
    expect(getTypeLabel('code_style')).toBe('代码风格');
    expect(getTypeLabel('xyz')).toBe('xyz');
  });
});
