// ============================================================================
// customImageModelRegistry — 自定义生图模型注册表（借鉴项①）
//
// 运行时叠加层（Option C）：内置 IMAGE_MODELS 静态表永不改，用户自定义模型存这里
// （主进程落盘 JSON + key 走 SecureStorage）。在 IPC list/generate 处与静态表合并。
// 模型 metadata 落盘文件，API key 单独进 SecureStorage（不进明文 json）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 设计根目录可变 mock：registry 文件落 <cfg>/design 下。
const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../../src/host/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

// SecureStorage in-memory mock：避免落真 ~/.code-agent，且断言 key 进/出/删。
const keyStore = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({
    setApiKey: (p: string, k: string) => keyStore.set(p, k),
    getApiKey: (p: string) => keyStore.get(p),
    deleteApiKey: (p: string) => keyStore.delete(p),
  }),
}));

import {
  listCustomImageModels,
  getCustomImageModel,
  saveCustomImageModel,
  deleteCustomImageModel,
  setCustomModelApiKey,
  getCustomModelApiKey,
  toVisualImageModel,
} from '../../../../src/host/services/media/customImageModelRegistry';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'custom-img-reg-'));
  cfg.root = workDir;
  keyStore.clear();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('saveCustomImageModel / list / get', () => {
  it('保存后可在 list 命中，字段完整且 baseUrl 去尾斜杠', async () => {
    const { id } = await saveCustomImageModel({
      label: '我的 SDXL',
      baseUrl: 'https://api.example.com/v1/',
      modelName: 'sdxl-turbo',
    });
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);

    const models = await listCustomImageModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id,
      label: '我的 SDXL',
      baseUrl: 'https://api.example.com/v1', // 去尾斜杠
      modelName: 'sdxl-turbo',
    });
    expect(typeof models[0].createdAt).toBe('number');

    const got = await getCustomImageModel(id);
    expect(got?.modelName).toBe('sdxl-turbo');
  });

  it('可选 costCnyPerImage 透传保存', async () => {
    const { id } = await saveCustomImageModel({
      label: 'X', baseUrl: 'https://api.x.com', modelName: 'm', costCnyPerImage: 0.3,
    });
    expect((await getCustomImageModel(id))?.costCnyPerImage).toBe(0.3);
  });

  it('未知 id 返回 null', async () => {
    expect(await getCustomImageModel('nope-123')).toBeNull();
  });

  it('空 label 抛错', async () => {
    await expect(
      saveCustomImageModel({ label: '  ', baseUrl: 'https://api.x.com', modelName: 'm' }),
    ).rejects.toThrow();
  });

  it('空 modelName 抛错', async () => {
    await expect(
      saveCustomImageModel({ label: 'X', baseUrl: 'https://api.x.com', modelName: ' ' }),
    ).rejects.toThrow();
  });

  it('不安全 baseUrl（私网/非 https）被 SSRF 守卫拒绝，不落盘', async () => {
    await expect(
      saveCustomImageModel({ label: 'X', baseUrl: 'http://127.0.0.1/v1', modelName: 'm' }),
    ).rejects.toThrow();
    expect(await listCustomImageModels()).toHaveLength(0);
  });

  it('两次保存生成不同 id，list 累积', async () => {
    await saveCustomImageModel({ label: 'A', baseUrl: 'https://a.com', modelName: 'm' });
    await saveCustomImageModel({ label: 'B', baseUrl: 'https://b.com', modelName: 'm' });
    expect(await listCustomImageModels()).toHaveLength(2);
  });
});

describe('deleteCustomImageModel', () => {
  it('删除后 list 不再含该模型且 key 被清除', async () => {
    const { id } = await saveCustomImageModel({ label: 'X', baseUrl: 'https://api.x.com', modelName: 'm' });
    setCustomModelApiKey(id, 'sk-secret');
    expect(getCustomModelApiKey(id)).toBe('sk-secret');

    await deleteCustomImageModel(id);
    expect(await listCustomImageModels()).toHaveLength(0);
    expect(getCustomModelApiKey(id)).toBeUndefined();
  });

  it('删除不存在的 id 安全返回（不抛）', async () => {
    await expect(deleteCustomImageModel('nope')).resolves.toEqual({ ok: true });
  });
});

describe('key 存取（SecureStorage，不进明文 json）', () => {
  it('setCustomModelApiKey → getCustomModelApiKey 往返', async () => {
    const { id } = await saveCustomImageModel({ label: 'X', baseUrl: 'https://api.x.com', modelName: 'm' });
    setCustomModelApiKey(id, 'sk-abc');
    expect(getCustomModelApiKey(id)).toBe('sk-abc');
    // metadata 文件不含 key 值
    const models = await listCustomImageModels();
    expect(JSON.stringify(models)).not.toContain('sk-abc');
  });
});

describe('磁盘篡改防御（防御纵深）', () => {
  it('被篡改成私网 baseUrl 的条目在读盘时被 SSRF 守卫丢弃，不进 list', async () => {
    const storePath = join(workDir, 'design', 'custom-image-models.json');
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
    const models = await listCustomImageModels();
    expect(models.map((m) => m.id)).toEqual(['good-1']); // evil-1 被丢弃
  });
});

describe('toVisualImageModel 映射', () => {
  it('custom provider + openai-compat engine + caps 固定 [t2i]', () => {
    const vm = toVisualImageModel({
      id: 'x-1', label: 'X', baseUrl: 'https://api.x.com', modelName: 'm', createdAt: 0, updatedAt: 0,
    });
    expect(vm).toEqual({ id: 'x-1', label: 'X', provider: 'custom', engine: 'openai-compat', caps: ['t2i'] });
  });
});
