// ============================================================================
// workspace.ipc — 自定义生视频模型管理 handler（视觉模型设置 tab · 配置层）
//
// 与 image 对称的薄 handler：list/save(apiKey 必填)/delete，仅编排 customVideoModelRegistry。
// ⚠️ 配置层 only：不接出片生成（无 generateDesignVideo custom 分支）。绝不回 key 值。
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/host/services/media/customVideoModelRegistry', () => ({
  getCustomVideoModelApiKey: vi.fn((id: string) => (id === 'has-key' ? 'sk-x' : undefined)),
  listCustomVideoModels: vi.fn(async () => [
    { id: 'has-key', label: 'V1', baseUrl: 'https://a.com/v1', modelName: 'm', costCnyPerVideo: 1.2, createdAt: 0, updatedAt: 0 },
    { id: 'no-key', label: 'V2', baseUrl: 'https://b.com/v1', modelName: 'm', createdAt: 0, updatedAt: 0 },
  ]),
  saveCustomVideoModel: vi.fn(async () => ({ id: 'v-abc' })),
  deleteCustomVideoModel: vi.fn(async () => ({ ok: true })),
  setCustomVideoModelApiKey: vi.fn(),
}));

import {
  handleListCustomVideoModels,
  handleSaveCustomVideoModel,
  handleDeleteCustomVideoModel,
} from '../../../src/host/ipc/workspace.ipc';
import {
  saveCustomVideoModel as regSave,
  setCustomVideoModelApiKey as regSetKey,
} from '../../../src/host/services/media/customVideoModelRegistry';

beforeEach(() => vi.clearAllMocks());

describe('handleListCustomVideoModels', () => {
  it('回 metadata + available（看 key 是否配），绝不含 key 值', async () => {
    const { models } = await handleListCustomVideoModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: 'has-key', label: 'V1', baseUrl: 'https://a.com/v1', modelName: 'm', costCnyPerVideo: 1.2, available: true });
    expect(models[1].available).toBe(false); // no-key
    expect(JSON.stringify(models)).not.toContain('sk-x');
  });
});

describe('handleSaveCustomVideoModel', () => {
  it('落盘注册表 + 存 key，返回 id', async () => {
    const res = await handleSaveCustomVideoModel({ label: 'X', baseUrl: 'https://api.x.com/v1', modelName: 'm', apiKey: 'sk-secret' });
    expect(res).toEqual({ id: 'v-abc' });
    expect(regSave).toHaveBeenCalledWith({ label: 'X', baseUrl: 'https://api.x.com/v1', modelName: 'm', costCnyPerVideo: undefined });
    expect(regSetKey).toHaveBeenCalledWith('v-abc', 'sk-secret');
  });

  it('空 apiKey 抛错且不落盘', async () => {
    await expect(
      handleSaveCustomVideoModel({ label: 'X', baseUrl: 'https://api.x.com/v1', modelName: 'm', apiKey: '  ' }),
    ).rejects.toThrow();
    expect(regSave).not.toHaveBeenCalled();
  });
});

describe('handleDeleteCustomVideoModel', () => {
  it('转发注册表删除', async () => {
    await expect(handleDeleteCustomVideoModel({ id: 'v-abc' })).resolves.toEqual({ ok: true });
  });
  it('缺 id 抛错', async () => {
    await expect(handleDeleteCustomVideoModel({ id: '' })).rejects.toThrow();
  });
});
