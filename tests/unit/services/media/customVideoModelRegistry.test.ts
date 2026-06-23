// ============================================================================
// customVideoModelRegistry — 自定义生视频模型注册表（视觉模型设置 tab · 配置层）
//
// 与 customImageModelRegistry 对称：内置 VIDEO_MODELS 静态表永不改，用户自定义视频端点
// 存这里（metadata 落盘 JSON + key 走 SecureStorage）。配置层 only，不接出片生成。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../../src/main/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/main/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

const keyStore = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../../src/main/services/core/secureStorage', () => ({
  getSecureStorage: () => ({
    setApiKey: (p: string, k: string) => keyStore.set(p, k),
    getApiKey: (p: string) => keyStore.get(p),
    deleteApiKey: (p: string) => keyStore.delete(p),
  }),
}));

import {
  listCustomVideoModels,
  getCustomVideoModel,
  saveCustomVideoModel,
  deleteCustomVideoModel,
  setCustomVideoModelApiKey,
  getCustomVideoModelApiKey,
} from '../../../../src/main/services/media/customVideoModelRegistry';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'custom-vid-reg-'));
  cfg.root = workDir;
  keyStore.clear();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('saveCustomVideoModel / list / get', () => {
  it('保存后可在 list 命中，字段完整且 baseUrl 去尾斜杠', async () => {
    const { id } = await saveCustomVideoModel({
      label: '我的视频模型',
      baseUrl: 'https://api.example.com/v1/',
      modelName: 'sora-like',
    });
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);

    const models = await listCustomVideoModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id,
      label: '我的视频模型',
      baseUrl: 'https://api.example.com/v1', // 去尾斜杠
      modelName: 'sora-like',
    });
    expect(typeof models[0].createdAt).toBe('number');

    expect((await getCustomVideoModel(id))?.modelName).toBe('sora-like');
  });

  it('可选 costCnyPerVideo 透传保存', async () => {
    const { id } = await saveCustomVideoModel({
      label: 'X', baseUrl: 'https://api.x.com', modelName: 'm', costCnyPerVideo: 1.5,
    });
    expect((await getCustomVideoModel(id))?.costCnyPerVideo).toBe(1.5);
  });

  it('未知 id 返回 null', async () => {
    expect(await getCustomVideoModel('nope-123')).toBeNull();
  });

  it('空 label / 空 modelName 抛错', async () => {
    await expect(saveCustomVideoModel({ label: ' ', baseUrl: 'https://api.x.com', modelName: 'm' })).rejects.toThrow();
    await expect(saveCustomVideoModel({ label: 'X', baseUrl: 'https://api.x.com', modelName: ' ' })).rejects.toThrow();
  });

  it('不安全 baseUrl（私网/非 https）被 SSRF 守卫拒绝，不落盘', async () => {
    await expect(
      saveCustomVideoModel({ label: 'X', baseUrl: 'http://127.0.0.1/v1', modelName: 'm' }),
    ).rejects.toThrow();
    expect(await listCustomVideoModels()).toHaveLength(0);
  });

  it('两次保存生成不同 id，list 累积', async () => {
    await saveCustomVideoModel({ label: 'A', baseUrl: 'https://a.com', modelName: 'm' });
    await saveCustomVideoModel({ label: 'B', baseUrl: 'https://b.com', modelName: 'm' });
    expect(await listCustomVideoModels()).toHaveLength(2);
  });
});

describe('deleteCustomVideoModel', () => {
  it('删除后 list 不再含该模型且 key 被清除', async () => {
    const { id } = await saveCustomVideoModel({ label: 'X', baseUrl: 'https://api.x.com', modelName: 'm' });
    setCustomVideoModelApiKey(id, 'sk-secret');
    expect(getCustomVideoModelApiKey(id)).toBe('sk-secret');

    await deleteCustomVideoModel(id);
    expect(await listCustomVideoModels()).toHaveLength(0);
    expect(getCustomVideoModelApiKey(id)).toBeUndefined();
  });

  it('删除不存在的 id 安全返回（不抛）', async () => {
    await expect(deleteCustomVideoModel('nope')).resolves.toEqual({ ok: true });
  });
});

describe('key 存取（SecureStorage，不进明文 json）', () => {
  it('往返存取 + metadata 文件不含 key 值', async () => {
    const { id } = await saveCustomVideoModel({ label: 'X', baseUrl: 'https://api.x.com', modelName: 'm' });
    setCustomVideoModelApiKey(id, 'sk-abc');
    expect(getCustomVideoModelApiKey(id)).toBe('sk-abc');
    expect(JSON.stringify(await listCustomVideoModels())).not.toContain('sk-abc');
  });
});

describe('磁盘篡改防御（防御纵深）', () => {
  it('被篡改成私网 baseUrl 的条目在读盘时被 SSRF 守卫丢弃，不进 list', async () => {
    const storePath = join(workDir, 'design', 'custom-video-models.json');
    await mkdir(join(workDir, 'design'), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({
        models: [
          { id: 'evil-1', label: 'E', baseUrl: 'https://127.0.0.1/v1', modelName: 'm', createdAt: 0, updatedAt: 0 },
          { id: 'good-1', label: 'G', baseUrl: 'https://api.x.com/v1', modelName: 'm', createdAt: 0, updatedAt: 0 },
        ],
      }),
    );
    expect((await listCustomVideoModels()).map((m) => m.id)).toEqual(['good-1']);
  });
});
