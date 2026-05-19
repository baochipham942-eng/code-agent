// ============================================================================
// GapCard 单测 — Step 7 PR 3
//
// 拆两层：
//   1. 渲染层：renderToStaticMarkup → HTML 字符串断言（项目无 jsdom）
//   2. 行为层：getGapCardActions 纯函数 → spy / 直接断言返回值
//
// 不引入 @testing-library/react，遵守现有 tests/renderer/components/ 风格。
// ============================================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityGap } from '../../../src/shared/contract/capabilityGap';
import type { SettingsTab } from '../../../src/renderer/utils/settingsTabs';

// ── 必须在 import GapCard 之前 mock appStore ────────────────────────────────
const openSettingsTabMock = vi.fn();
const appState = {
  openSettingsTab: openSettingsTabMock,
};

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof appState) => unknown) =>
      selector ? selector(appState) : appState,
    { getState: () => appState },
  ),
}));

import {
  GapCard,
  getGapCardActions,
  getGapHeadline,
  getGapSubtext,
} from '../../../src/renderer/components/features/capability/GapCard';

// ── Fixture factories ───────────────────────────────────────────────────────

const pluginGap: CapabilityGap = {
  type: 'plugin',
  missing: 'image-generation',
  candidates: [],
};

const modelGap: CapabilityGap = {
  type: 'model',
  missing: 'vision',
  candidates: [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'anthropic', model: 'claude-3-5-sonnet' },
  ],
};

const modelGapEmpty: CapabilityGap = {
  type: 'model',
  missing: 'reasoning',
  candidates: [],
};

const apikeyGap: CapabilityGap = {
  type: 'apikey',
  missing: 'vision',
  provider: 'openai',
};

// ───────────────────────────────────────────────────────────────────────────
// 纯函数层：getGapCardActions / getGapHeadline / getGapSubtext
// ───────────────────────────────────────────────────────────────────────────

describe('getGapCardActions', () => {
  let openSettingsTab: ReturnType<typeof vi.fn<(tab: SettingsTab) => void>>;
  let onDismiss: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    openSettingsTab = vi.fn<(tab: SettingsTab) => void>();
    onDismiss = vi.fn<() => void>();
  });

  it('PluginGap → 主 CTA disabled + tooltip "marketplace 接入后开放"', () => {
    const action = getGapCardActions(pluginGap, { openSettingsTab, onDismiss });
    expect(action.disabled).toBe(true);
    expect(action.tooltip).toBe('marketplace 接入后开放');
    // disabled 时 onClick 应是 no-op，不触发任何路由
    action.onClick();
    expect(openSettingsTab).not.toHaveBeenCalled();
  });

  it('ModelGap → onClick 调用 openSettingsTab("model")', () => {
    const action = getGapCardActions(modelGap, { openSettingsTab, onDismiss });
    expect(action.disabled).toBe(false);
    expect(action.label).toBe('去切换模型');
    action.onClick();
    expect(openSettingsTab).toHaveBeenCalledTimes(1);
    expect(openSettingsTab).toHaveBeenCalledWith('model');
  });

  it('ApiKeyGap → onClick 调用 openSettingsTab("model") + label/hint 携带 provider', () => {
    const action = getGapCardActions(apikeyGap, { openSettingsTab, onDismiss });
    expect(action.disabled).toBe(false);
    expect(action.label).toBe('去填 openai API key');
    expect(action.hint).toBe('在 Providers 区块找到 openai 配置 key');
    action.onClick();
    expect(openSettingsTab).toHaveBeenCalledWith('model');
  });
});

describe('getGapHeadline / getGapSubtext', () => {
  it('PluginGap headline + 空候选 subtext 兜底文案', () => {
    expect(getGapHeadline(pluginGap, 'image-generation')).toBe(
      '需要安装支持 image-generation 的插件',
    );
    expect(getGapSubtext(pluginGap)).toBe('marketplace 未接入，本地暂无候选插件');
  });

  it('ModelGap headline + 候选列表 subtext', () => {
    expect(getGapHeadline(modelGap, 'vision')).toBe('当前模型不支持 vision 能力');
    const sub = getGapSubtext(modelGap);
    expect(sub).toContain('openai/gpt-4o');
    expect(sub).toContain('anthropic/claude-3-5-sonnet');
  });

  it('ModelGap 空候选 subtext 给出兜底', () => {
    expect(getGapSubtext(modelGapEmpty)).toBe(
      '所有已注册模型都不具备该能力，请考虑切换 provider',
    );
  });

  it('ApiKeyGap headline + subtext', () => {
    expect(getGapHeadline(apikeyGap, 'vision')).toBe('openai 未配置 API key');
    expect(getGapSubtext(apikeyGap)).toBe('已有模型支持 vision，缺一把 key 即可启用');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 渲染层：renderToStaticMarkup smoke
// ───────────────────────────────────────────────────────────────────────────

describe('GapCard 渲染', () => {
  beforeEach(() => {
    openSettingsTabMock.mockReset();
  });

  it('空 gaps 时不渲染（返回 null）', () => {
    const html = renderToStaticMarkup(
      React.createElement(GapCard, {
        requiredCapability: 'image-generation',
        gaps: [],
        onDismiss: () => {},
      }),
    );
    expect(html).toBe('');
  });

  it('PluginGap 渲染：headline + disabled CTA + marketplace 兜底', () => {
    const html = renderToStaticMarkup(
      React.createElement(GapCard, {
        requiredCapability: 'image-generation',
        gaps: [pluginGap],
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('image-generation');
    expect(html).toContain('需要安装支持 image-generation 的插件');
    expect(html).toContain('安装插件');
    expect(html).toContain('marketplace 未接入');
    expect(html).toContain('disabled');
    expect(html).toContain('marketplace 接入后开放'); // tooltip
  });

  it('ModelGap 渲染：headline + 候选 provider/model + 主 CTA 文案', () => {
    const html = renderToStaticMarkup(
      React.createElement(GapCard, {
        requiredCapability: 'vision',
        gaps: [modelGap],
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('当前模型不支持 vision 能力');
    expect(html).toContain('openai/gpt-4o');
    expect(html).toContain('去切换模型');
  });

  it('ApiKeyGap 渲染：headline + provider 主 CTA + provider hint', () => {
    const html = renderToStaticMarkup(
      React.createElement(GapCard, {
        requiredCapability: 'vision',
        gaps: [apikeyGap],
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('openai 未配置 API key');
    expect(html).toContain('去填 openai API key');
    expect(html).toContain('在 Providers 区块找到 openai 配置 key');
  });

  it('多 gap 同时渲染（plugin + model + apikey）', () => {
    // 同一次诊断同时返回三类 gap：requiredCapability=vision 触发的真实场景
    const visionPluginGap: CapabilityGap = {
      type: 'plugin',
      missing: 'vision',
      candidates: [],
    };
    const html = renderToStaticMarkup(
      React.createElement(GapCard, {
        requiredCapability: 'vision',
        gaps: [visionPluginGap, modelGap, apikeyGap],
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('需要安装支持 vision 的插件');
    expect(html).toContain('当前模型不支持 vision 能力');
    expect(html).toContain('openai 未配置 API key');
  });

  it('未传 onDismiss 时不渲染关闭按钮', () => {
    const html = renderToStaticMarkup(
      React.createElement(GapCard, {
        requiredCapability: 'vision',
        gaps: [modelGap],
      }),
    );
    expect(html).not.toContain('gap-card-dismiss');
  });

  it('传了 onDismiss 时渲染关闭按钮（aria-label 验证）', () => {
    const html = renderToStaticMarkup(
      React.createElement(GapCard, {
        requiredCapability: 'vision',
        gaps: [modelGap],
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('gap-card-dismiss');
    expect(html).toContain('关闭能力缺口提示');
  });
});
