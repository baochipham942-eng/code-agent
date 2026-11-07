import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelOverrideFailureToast } from '../../../src/renderer/components/StatusBar/modelOverrideErrorCopy';

// FB-746：模型覆盖加载/清除 toast 不许直出浏览器原文（"Load failed" / "Failed to fetch"），
// 一律归成一句人话：网络类给下一步，其余「请稍后重试」。
// ai-review 复核（PR #2901）：原文只从 toast 收走还不够——helper 必须 console.error
// 留痕（testing.md「降级路径必须留痕」），否则 host 返回 session not found、IPC 抛错
// 等非网络失败在 renderer 侧零记录，无法判因。
describe('modelOverrideFailureToast', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('网络类失败给「网络不通，请检查网络后重试」，不回传原文', () => {
    for (const message of ['Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Request timed out', 'fetch failed: ETIMEDOUT']) {
      expect(modelOverrideFailureToast('load', message), message).toBe('加载模型覆盖失败: 网络不通，请检查网络后重试');
    }
    expect(modelOverrideFailureToast('clear', new Error('Load failed'))).toBe('清除模型覆盖失败: 网络不通，请检查网络后重试');
  });

  it('其他消息（含未知 / 非字符串）统一「请稍后重试」，绝不把原文拼进 toast', () => {
    for (const raw of ['boom', 'HTTP 500 Internal Server Error', null, undefined, new Error('boom'), 42]) {
      expect(modelOverrideFailureToast('load', raw)).toBe('加载模型覆盖失败: 请稍后重试');
    }
    expect(modelOverrideFailureToast('clear', null)).toBe('清除模型覆盖失败: 请稍后重试');
  });

  it('原始错误经 console.error 留痕（可判因），toast 文案不含原文', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = new Error('session not found');
    const toast = modelOverrideFailureToast('load', raw);
    expect(toast).toBe('加载模型覆盖失败: 请稍后重试');
    expect(toast).not.toContain('session not found');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('模型覆盖');
    expect(errorSpy.mock.calls[0]).toContain(raw);
  });

  it('字符串原始错误（IPC error.message）同样留痕', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toast = modelOverrideFailureToast('clear', 'session not found');
    expect(toast).toBe('清除模型覆盖失败: 请稍后重试');
    expect(toast).not.toContain('session not found');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.join(' ')).toContain('session not found');
  });

  it('ModelSwitcher 四个 toast 调用点全部走 helper，不再拼 err.message / 未知错误', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/StatusBar/ModelSwitcher.tsx'),
      'utf8',
    );
    const toastLines = source.split('\n').filter((line) => line.includes("modelOverrideFailureToast('"));
    expect(toastLines).toHaveLength(4);
    for (const line of toastLines) {
      expect(line).toContain('toast.error(');
      expect(line).not.toMatch(/err\.message|error\?\.message\s*\?\?/);
      expect(line).not.toContain('未知错误');
    }
  });
});
