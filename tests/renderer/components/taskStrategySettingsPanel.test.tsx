import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TaskStrategySettingsPanel } from '../../../src/renderer/components/features/settings/tabs/TaskStrategySettingsPanel';
import type { AppSettings, TaskModelStrategySettings } from '../../../src/shared/contract';
import { DEFAULT_MODELS } from '../../../src/shared/constants';

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
  rules: [
    { id: 'simple-chat-fast', label: '短问答 / 格式整理', intent: 'simple_chat', enabled: true, profile: 'fast', reason: '短输入使用快速模型' },
    { id: 'research-deep', label: '研究 / 规划 / 重构', intent: 'research', enabled: true, profile: 'deep', reason: '研究使用深度模型' },
  ],
};

const settings = {
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
    },
    taskStrategy: strategy,
  },
} as AppSettings;

describe('TaskStrategySettingsPanel', () => {
  it('renders auto-switch toggle and the three task profiles (auto mode)', () => {
    const html = renderToStaticMarkup(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain('开启自动切换');
    expect(html).toContain('快速任务模型');
    expect(html).toContain('深度任务模型');
    expect(html).toContain('视觉任务模型');
    // 改动即存：无保存按钮；不展示主任务档（主=默认模型）、fallback/规则。
    expect(html).not.toContain('保存策略');
    expect(html).not.toContain('任务主模型');
    expect(html).not.toContain('研究 / 规划 / 重构');
  });
});
