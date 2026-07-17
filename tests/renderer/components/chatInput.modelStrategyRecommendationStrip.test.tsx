import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModelStrategyRecommendationStrip } from '../../../src/renderer/components/features/chat/ChatInput/ModelStrategyRecommendationStrip';
import { buildModelStrategyRecommendation } from '../../../src/renderer/components/features/chat/ChatInput/modelStrategyRecommendation';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh: zhTranslations } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zhTranslations, language: 'zh' }) };
});

function collectButtonElements(node: React.ReactNode): Array<React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }>> {
  const buttons: Array<React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }>> = [];
  if (!React.isValidElement(node)) return buttons;
  if (node.type === 'button') {
    buttons.push(node as React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }>);
  }
  React.Children.forEach(
    (node.props as { children?: React.ReactNode }).children,
    (child) => {
      buttons.push(...collectButtonElements(child));
    },
  );
  return buttons;
}

describe('ModelStrategyRecommendationStrip', () => {
  it('renders warning recommendations with factors and the primary action', () => {
    const html = renderToStaticMarkup(
      <ModelStrategyRecommendationStrip
        recommendation={{
          key: 'external-failure',
          tone: 'warning',
          title: 'Claude Code 最近运行失败',
          body: '2 分钟前失败：认证失败。请完成 Claude CLI 登录后重试。',
          primaryAction: 'switch-native-engine',
          primaryLabel: '切回 Native',
          strategyFactors: [
            { label: '引擎', value: 'Claude Code' },
            { label: '失败', value: '认证失败' },
            { label: '恢复', value: '需处理' },
          ],
        }}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="model-strategy-recommendation"');
    expect(html).toContain('border-amber-500/20');
    expect(html).toContain('Claude Code 最近运行失败');
    expect(html).toContain('2 分钟前失败：认证失败。请完成 Claude CLI 登录后重试。');
    expect(html).toContain('引擎: Claude Code');
    expect(html).toContain('失败: 认证失败');
    expect(html).toContain('恢复: 需处理');
    expect(html).toContain('切回 Native');
    expect(html).toContain('保持当前');
  });

  it('renders info recommendations without a primary button when no action is available', () => {
    const html = renderToStaticMarkup(
      <ModelStrategyRecommendationStrip
        recommendation={{
          key: 'provider-unavailable-warning-only',
          tone: 'info',
          title: '当前 provider 不可用',
          body: '自动策略已开启，本轮可能触发 fallback。',
        }}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain('border-sky-500/20');
    expect(html).toContain('当前 provider 不可用');
    expect(html).toContain('保持当前');
    expect(html).not.toContain('采用建议');
    expect(html).not.toContain('切回 Native');
  });

  it('renders a native-engine action for generated external attachment warnings', () => {
    const recommendation = buildModelStrategyRecommendation(zh, {
      inputValue: '看一下这张截图',
      hasImageAttachments: true,
      engineKind: 'claude_code',
      modelLabel: 'Sonnet',
      modelCapabilities: [],
      adaptiveEnabled: false,
    });

    expect(recommendation?.primaryAction).toBe('switch-native-engine');

    const html = renderToStaticMarkup(
      <ModelStrategyRecommendationStrip
        recommendation={recommendation!}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain('外部引擎暂不接收附件');
    expect(html).toContain('输入: 图片附件');
    expect(html).toContain('切回 Native');
    expect(html).toContain('保持当前');
  });

  it('wires primary and dismiss clicks to the supplied handlers', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const element = ModelStrategyRecommendationStrip({
      recommendation: {
        key: 'switch-search-model',
        tone: 'info',
        title: '建议切到搜索模型',
        body: '这轮需要联网检索，Sonar 更适合当前任务。',
        primaryAction: 'switch-model',
        primaryLabel: '采用建议',
        strategyFactors: [
          { label: '任务', value: '搜索' },
          { label: '候选', value: 'Perplexity / Sonar' },
        ],
      },
      onApply,
      onDismiss,
    });

    // React 19 类型下函数组件可同步/异步双态（FunctionComponent 返回 ReactNode | Promise<ReactNode>），
    // 这里是直接调用组件函数拿同步渲染树（非 JSX 挂载），运行时必为同步结果，去掉 Promise 分支。
    const buttons = collectButtonElements(element as Exclude<typeof element, Promise<unknown>>);
    expect(buttons).toHaveLength(2);
    expect(renderToStaticMarkup(buttons[0])).toContain('采用建议');
    expect(renderToStaticMarkup(buttons[1])).toContain('保持当前');

    buttons[0]?.props.onClick?.();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    buttons[1]?.props.onClick?.();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
