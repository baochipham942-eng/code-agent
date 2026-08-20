// @vitest-environment jsdom
// ============================================================================
// V4 记忆整理模型「跟随快速模型」可恢复：
// 1. Select 含「跟随快速模型（默认）」选项
// 2. 已单独配置时选中该选项 → onMemoryRouteChange(null)（清除 routing.memory 覆盖）
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TaskStrategySettingsPanel } from '../../../src/renderer/components/features/settings/tabs/TaskStrategySettingsPanel';
import type { AppSettings, TaskModelStrategySettings } from '../../../src/shared/contract';
import { DEFAULT_MODELS } from '../../../src/shared/constants';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const strategy: TaskModelStrategySettings = {
  mode: 'auto',
  defaultProfile: 'main',
  profiles: {
    fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick, reasoningEffort: 'low', maxTokens: 4096 },
    main: { provider: 'xiaomi', model: DEFAULT_MODELS.chat, reasoningEffort: 'medium', maxTokens: 16384 },
    deep: { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reasoningEffort: 'high', maxTokens: 32768 },
    vision: { provider: 'xiaomi', model: DEFAULT_MODELS.vision, reasoningEffort: 'medium', maxTokens: 4096 },
  },
  fallback: {
    enabled: true,
    preferSameProvider: true,
    allowCrossProvider: true,
  },
  rules: [],
};

function buildSettings(memoryRoute: { provider: 'deepseek'; model: string } | null): AppSettings {
  return {
    models: {
      default: 'xiaomi',
      defaultProvider: 'xiaomi',
      providers: {
        xiaomi: { enabled: true, apiKeyConfigured: true },
        zhipu: { enabled: true, apiKeyConfigured: true },
        deepseek: { enabled: true, apiKeyConfigured: true },
      },
      routing: {
        code: { provider: 'xiaomi', model: DEFAULT_MODELS.code },
        vision: { provider: 'xiaomi', model: DEFAULT_MODELS.vision },
        fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
        gui: { provider: 'zhipu', model: DEFAULT_MODELS.visionFast },
        ...(memoryRoute ? { memory: memoryRoute } : {}),
      },
      taskStrategy: strategy,
    },
  } as unknown as AppSettings; // 面板只读 settings.models，其余 AppSettings 顶层字段本用例不需要
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('TaskStrategySettingsPanel 记忆整理模型跟随快速模型', () => {
  it('未配置 routing.memory 时 Select 选中「跟随快速模型（默认）」', () => {
    const settings = buildSettings(null);
    render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        onChange={vi.fn()}
        onMemoryRouteChange={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('记忆整理模型') as HTMLSelectElement;
    expect(select.value).toBe('__follow_fast__');
    expect(screen.getByText('跟随快速模型（默认）')).toBeTruthy();
  });

  it('已配置 routing.memory 时选「跟随快速模型」→ onMemoryRouteChange(null)', () => {
    const settings = buildSettings({ provider: 'deepseek', model: DEFAULT_MODELS.reasoning });
    const onMemoryRouteChange = vi.fn();
    render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        onChange={vi.fn()}
        onMemoryRouteChange={onMemoryRouteChange}
      />,
    );

    const select = screen.getByLabelText('记忆整理模型') as HTMLSelectElement;
    expect(select.value).toBe(`deepseek:::${DEFAULT_MODELS.reasoning}`);

    fireEvent.change(select, { target: { value: '__follow_fast__' } });
    expect(onMemoryRouteChange).toHaveBeenCalledWith(null);
  });
});
