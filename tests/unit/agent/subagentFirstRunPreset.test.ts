// 云货架专家首轮强制 strict 的接线门。
//
// 台账侧（置位/consume）已有用例；这条补的是**真的把这一轮降到 strict** 那一步——
// 它原本内联在 executeInternal 里，改坏了没有任何测试变红（2026-07-25 变异验证实测的盲区）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const consumeFirstRunStrictMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/roleAssets/rolePackInstallService', () => ({
  consumeFirstRunStrict: consumeFirstRunStrictMock,
}));

import { resolveSubagentPreset } from '../../../src/host/agent/subagentFirstRunPreset';

describe('云货架专家首轮强制 strict', () => {
  beforeEach(() => {
    consumeFirstRunStrictMock.mockReset();
  });

  it('首轮压过包自己声明的档位——声明 ci 也按 strict 跑', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(true);

    await expect(resolveSubagentPreset('ci', 'writer', undefined)).resolves.toBe('strict');
    expect(consumeFirstRunStrictMock).toHaveBeenCalledWith('writer');
  });

  it('第二轮起按包声明的档位跑（consume 后不再强制）', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(false);

    await expect(resolveSubagentPreset('ci', 'writer', undefined)).resolves.toBe('ci');
  });

  // 没有 roleId 的子 agent（内置 agent / 动态 agent）不该被这条影响，也不该白查一次台账。
  it('非角色子 agent 不受影响，也不查台账', async () => {
    await expect(resolveSubagentPreset('development', undefined, undefined)).resolves.toBe('development');
    expect(consumeFirstRunStrictMock).not.toHaveBeenCalled();
  });

  it('未声明档位时回落 development（不是悄悄变 strict）', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(false);

    await expect(resolveSubagentPreset(undefined, 'writer', undefined)).resolves.toBe('development');
  });
});
