// ============================================================================
// 底栏分层：专家在主位，权限档/上下文/模型芯片依次弱一档
// ============================================================================
// dogfood 抓到：`○ 上下文 | 安全模式 | 岚析 | Neo · GLM-5 · 思考 · 低` 四样东西同权重
// 并排，用户读不出哪个是人、哪个是设置、哪个是产品名。
//
// 这条门钉三件事：① 专家名与模型芯片的样式类真的不同（不是"看起来不同"）；
// ② 「思考 / effort」不出现在折叠态；③「Neo」不跟模型名并排。
// 任何一条被拍回同权重都会红。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const footerMocks = vi.hoisted(() => ({
  appState: {
    activeAgentId: 'lanxi',
    openSettingsTab: vi.fn(),
    modelConfig: { provider: 'zhipu' as const, model: 'glm-5' },
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  },
  sessionState: {
    currentSessionId: 'session-1',
    sessions: [{ id: 'session-1', engine: undefined }],
  },
  modeState: {
    effortLevel: 'low',
    setEffortLevel: vi.fn(),
    thinkingEnabled: true,
    setThinkingEnabled: vi.fn(),
  },
  agentRegistryState: {
    entries: [{
      id: 'lanxi',
      name: '岚析',
      description: '',
      source: 'user',
      modelTier: 'balanced',
      readonly: false,
      tools: [],
      profession: '内容主理人',
    }],
    isLoaded: true,
    refresh: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof footerMocks.appState) => unknown) => (
    selector ? selector(footerMocks.appState) : footerMocks.appState
  ),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof footerMocks.sessionState) => unknown) => (
    selector ? selector(footerMocks.sessionState) : footerMocks.sessionState
  ),
}));

vi.mock('../../../src/renderer/stores/modeStore', () => ({
  useModeStore: (selector?: (state: typeof footerMocks.modeState) => unknown) => (
    selector ? selector(footerMocks.modeState) : footerMocks.modeState
  ),
}));

vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector?: (state: typeof footerMocks.agentRegistryState) => unknown) => (
    selector ? selector(footerMocks.agentRegistryState) : footerMocks.agentRegistryState
  ),
}));

vi.mock('../../../src/renderer/observability/posthogRenderer', () => ({
  trackRenderer: vi.fn(),
}));

import { AgentChip } from '../../../src/renderer/components/features/chat/ChatInput/AgentChip';
import { ModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

function classAttrOf(html: string, testId: string): string {
  // 取该元素起始标签里的 class 属性（静态 markup，属性顺序稳定）
  const openTag = html.slice(html.indexOf(`data-testid="${testId}"`));
  const tagEnd = openTag.indexOf('>');
  const match = /class="([^"]*)"/.exec(openTag.slice(0, tagEnd));
  return match?.[1] ?? '';
}

// 只留标签之间的文字：属性（title/aria-label）不算"并排在这一行上"
function visibleTextOf(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

const agentHtml = () => renderToStaticMarkup(
  React.createElement(AgentChip, { onOpenAgentCommand: () => {} }),
);
const modelHtml = () => renderToStaticMarkup(
  React.createElement(ModelSwitcher, { currentModel: 'glm-5' }),
);

describe('底栏视觉分层', () => {
  it('专家在主位：头像 + 花名，字号与字重都比模型芯片重', () => {
    const html = agentHtml();

    expect(html).toContain('岚析');
    expect(html).toContain('role-initial-avatar-lanxi');

    const agentClass = classAttrOf(html, 'chat-input-agent-chip');
    expect(agentClass).toContain('text-sm');
    expect(agentClass).toContain('font-medium');
    expect(agentClass).toContain('text-zinc-100');
  });

  it('模型芯片弱一档：与专家名的样式类不同', () => {
    const agentClass = classAttrOf(agentHtml(), 'chat-input-agent-chip');
    const model = modelHtml();

    // 模型芯片没有 testid，取它唯一的 aria-label 定位
    expect(model).toContain('aria-label="切换模型"');
    expect(model).toContain('text-xs');
    expect(model).toContain('text-zinc-400');

    // 承重断言：两者不能落在同一档
    expect(agentClass).not.toContain('text-zinc-400');
    expect(agentClass).not.toContain('text-xs');
  });

  it('折叠态可见文本里没有「思考」与 effort 档名——那是给写代码的人看的', () => {
    const model = modelHtml();

    expect(visibleTextOf(model)).not.toContain('思考');
    expect(visibleTextOf(model)).not.toContain('低');
    // 但信息不丢：hover 的 title 里仍查得到（面板里可改）
    expect(model).toContain('思考');
  });

  it('可见文本里的「Neo」不跟模型名并排——产品名不是模型名', () => {
    const model = modelHtml();

    expect(visibleTextOf(model)).not.toContain('Neo');
    expect(visibleTextOf(model)).toContain('GLM-5');
  });
});
