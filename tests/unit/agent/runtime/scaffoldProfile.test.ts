// ============================================================================
// B7 scaffold profile 单测 — 模型能力档 → 脚手架厚度映射
// 覆盖：三档矩阵 / flag 关闭身份保证 / catalog 标注消费 / shouldThink 接线契约
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import {
  resolveScaffoldProfile,
  resolveScaffoldProfileForModel,
} from '../../../../src/host/agent/runtime/scaffoldProfile';
import { getModelScaffoldTier } from '../../../../src/shared/constants/models';
import { SCAFFOLD_PROFILE } from '../../../../src/shared/constants/agent';
import { shouldThink } from '../../../../src/host/agent/runtime/contextAssembly/modeInjection';
import type { ContextAssemblyCtx } from '../../../../src/host/agent/runtime/contextAssembly/inference';

describe('resolveScaffoldProfile 三档矩阵', () => {
  it('strong → 关 thinking 注入 + audit 间隔 ×2', () => {
    const p = resolveScaffoldProfile('strong');
    expect(p.tier).toBe('strong');
    expect(p.thinkingInjection).toBe(false);
    expect(p.auditNudgeIntervalMultiplier).toBe(2);
  });

  it('standard → 现状（注入开 + 倍率 1）', () => {
    const p = resolveScaffoldProfile('standard');
    expect(p.thinkingInjection).toBe(true);
    expect(p.auditNudgeIntervalMultiplier).toBe(1);
  });

  it('lite → P0 与 standard 同行为，仅 tier 标注不同（加厚不在本期）', () => {
    const p = resolveScaffoldProfile('lite');
    expect(p.tier).toBe('lite');
    expect(p.thinkingInjection).toBe(true);
    expect(p.auditNudgeIntervalMultiplier).toBe(1);
  });
});

describe('catalog 标注消费（getModelScaffoldTier）', () => {
  it('已标注 strong 的旗舰档命中', () => {
    expect(getModelScaffoldTier('glm-5')).toBe('strong');
    expect(getModelScaffoldTier('claude-opus-4-7')).toBe('strong');
    expect(getModelScaffoldTier('gpt-5.5')).toBe('strong');
  });

  it('已标注 lite 的弱档命中', () => {
    expect(getModelScaffoldTier('LongCat-2.0-Preview')).toBe('lite');
  });

  it('未标注模型 → standard（fail-safe 默认）', () => {
    expect(getModelScaffoldTier('some-unknown-model')).toBe('standard');
  });

  it('主力模型 kimi-k2.5 保持未标注 = standard（P0 保守约定：flag 开也不改主力行为）', () => {
    expect(getModelScaffoldTier('kimi-k2.5')).toBe('standard');
  });
});

describe('flag 关闭的身份保证', () => {
  it('SCAFFOLD_PROFILE.ENABLED 当前为 false（default-on 前必须有 eval 非劣证据）', () => {
    expect(SCAFFOLD_PROFILE.ENABLED).toBe(false);
  });

  it('flag 关闭时，strong 标注模型也恒返 standard profile（现状行为逐字不变）', () => {
    const p = resolveScaffoldProfileForModel('glm-5');
    expect(p.tier).toBe('standard');
    expect(p.thinkingInjection).toBe(true);
    expect(p.auditNudgeIntervalMultiplier).toBe(1);
  });
});

describe('flag 开启路径（vi.mock 翻转，臂激活自证）', () => {
  it('flag 开 + strong 标注模型 → strong profile 真生效', async () => {
    vi.resetModules();
    vi.doMock('../../../../src/shared/constants/agent', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../../src/shared/constants/agent')>();
      return { ...actual, SCAFFOLD_PROFILE: { ENABLED: true } };
    });
    const { resolveScaffoldProfileForModel: resolveEnabled } = await import(
      '../../../../src/host/agent/runtime/scaffoldProfile'
    );
    const p = resolveEnabled('glm-5');
    expect(p.tier).toBe('strong');
    expect(p.thinkingInjection).toBe(false);
    vi.doUnmock('../../../../src/shared/constants/agent');
    vi.resetModules();
  });

  it('flag 开 + 未标注模型 → standard 直通（不误伤）', async () => {
    vi.resetModules();
    vi.doMock('../../../../src/shared/constants/agent', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../../src/shared/constants/agent')>();
      return { ...actual, SCAFFOLD_PROFILE: { ENABLED: true } };
    });
    const { resolveScaffoldProfileForModel: resolveEnabled } = await import(
      '../../../../src/host/agent/runtime/scaffoldProfile'
    );
    expect(resolveEnabled('kimi-k2.5').tier).toBe('standard');
    vi.doUnmock('../../../../src/shared/constants/agent');
    vi.resetModules();
  });
});

describe('shouldThink 接线契约', () => {
  function mockCtx(profile?: { thinkingInjection: boolean }): ContextAssemblyCtx {
    return {
      runtime: {
        effortLevel: 'xhigh', // 现状下 xhigh 恒注入 → 最能暴露 profile 是否真拦
        thinkingStepCount: 0,
        scaffoldProfile: profile
          ? { tier: 'strong', thinkingInjection: profile.thinkingInjection, auditNudgeIntervalMultiplier: 2 }
          : undefined,
      },
    } as unknown as ContextAssemblyCtx;
  }

  it('strong profile（注入关）→ xhigh 也不注入（臂真拦住）', () => {
    const ctx = mockCtx({ thinkingInjection: false });
    expect(shouldThink(ctx, false)).toBe(false);
  });

  it('无 profile（现状路径）→ xhigh 照常注入（mutation 对照：摘掉接线本测不红、上测红）', () => {
    const ctx = mockCtx(undefined);
    expect(shouldThink(ctx, false)).toBe(true);
  });

  it('profile 拦截时计数器仍自增（flag 翻转不改变 thinkingStepCount 语义）', () => {
    const ctx = mockCtx({ thinkingInjection: false });
    shouldThink(ctx, false);
    expect((ctx as unknown as { runtime: { thinkingStepCount: number } }).runtime.thinkingStepCount).toBe(1);
  });
});
