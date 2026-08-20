// ============================================================================
// V4 Host 侧持久化：routing.memory 的 null 哨兵
// merge 遇 models.routing.memory === null 时显式删除该键（回到跟随快速模型），
// 其余路径的 null 仍按原样赋值，不做全局 null 语义改造。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../../src/host/services/core/configService';
import type { AppSettings } from '../../../src/shared/contract';

type MergeFn = (base: AppSettings, updates: Partial<AppSettings>) => AppSettings;

function mergeAppSettings(base: AppSettings, updates: unknown): AppSettings {
  const service = new ConfigService();
  const fn = (service as unknown as { mergeAppSettings: MergeFn }).mergeAppSettings;
  return fn.call(service, base, updates as Partial<AppSettings>);
}

const baseSettings = {
  models: {
    routing: {
      code: { provider: 'xiaomi', model: 'code-model' },
      vision: { provider: 'xiaomi', model: 'vision-model' },
      fast: { provider: 'zhipu', model: 'fast-model' },
      memory: { provider: 'deepseek', model: 'memory-model' },
      gui: { provider: 'zhipu', model: 'gui-model' },
    },
  },
  design: { defaultImageModelId: 'img-1' },
} as unknown as AppSettings;

describe('configService mergeAppSettings routing.memory null 哨兵', () => {
  it('updates.models.routing.memory = null 时删除 memory 键（不残留 null/空串）', () => {
    const merged = mergeAppSettings(baseSettings, { models: { routing: { memory: null } } });

    expect('memory' in merged.models.routing).toBe(false);
    expect(merged.models.routing.fast).toEqual({ provider: 'zhipu', model: 'fast-model' });
  });

  it('updates 带具体 route 时正常写入 memory 键', () => {
    const merged = mergeAppSettings(baseSettings, {
      models: { routing: { memory: { provider: 'xiaomi', model: 'new-memory-model' } } },
    });

    expect(merged.models.routing.memory).toEqual({ provider: 'xiaomi', model: 'new-memory-model' });
  });

  it('其他路径的 null 不做删除语义（非全局 null 改造）', () => {
    const merged = mergeAppSettings(baseSettings, { design: { defaultImageModelId: null } });

    expect(merged.design?.defaultImageModelId).toBeNull();
    expect(merged.models.routing.memory).toEqual({ provider: 'deepseek', model: 'memory-model' });
  });
});
