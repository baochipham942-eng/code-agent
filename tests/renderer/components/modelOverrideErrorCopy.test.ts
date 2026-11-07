import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelOverrideFailureReason } from '../../../src/renderer/components/StatusBar/modelOverrideErrorCopy';

// FB-746：模型覆盖加载/清除 toast 不许直出浏览器原文（"Load failed" / "Failed to fetch"），
// 一律归成一句人话：网络类给下一步，其余「请稍后重试」。
describe('modelOverrideFailureReason', () => {
  it('网络类失败给「网络不通，请检查网络后重试」', () => {
    for (const message of ['Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Request timed out', 'fetch failed: ETIMEDOUT']) {
      expect(modelOverrideFailureReason(message), message).toBe('网络不通，请检查网络后重试');
    }
  });

  it('其他消息（含未知 / 非字符串）统一「请稍后重试」，绝不回传原文', () => {
    for (const raw of ['boom', 'HTTP 500 Internal Server Error', null, undefined, new Error('boom'), 42]) {
      expect(modelOverrideFailureReason(raw)).toBe('请稍后重试');
    }
    // Error 对象取 message 归类，但仍只给人话
    expect(modelOverrideFailureReason(new Error('Load failed'))).toBe('网络不通，请检查网络后重试');
  });

  it('ModelSwitcher 四个 toast 调用点全部走 helper，不再拼 err.message / 未知错误', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/StatusBar/ModelSwitcher.tsx'),
      'utf8',
    );
    const toastLines = source.split('\n').filter((line) =>
      line.includes('加载模型覆盖失败') || line.includes('清除模型覆盖失败'),
    );
    expect(toastLines).toHaveLength(4);
    for (const line of toastLines) {
      expect(line).toContain('modelOverrideFailureReason(');
      expect(line).not.toMatch(/err\.message|error\?\.message\s*\?\?/);
      expect(line).not.toContain('未知错误');
    }
  });
});
