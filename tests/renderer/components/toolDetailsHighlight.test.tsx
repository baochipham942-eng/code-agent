import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentFailureCode, HostReasonCode, type ToolCall } from '../../../src/shared/contract';
import { renderToStaticMarkupAsync } from './renderToStaticMarkupAsync';

// ToolDetails 依赖 appStore 的两个 selector，mock 掉即可。
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
    }),
}));
// humanizeToolError 迁 i18n 后 ToolDetails 新接了 useI18n，同 turnDiffSummary.confirmation.test.tsx 先例直接 mock。
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

function render(toolCall: ToolCall): string {
  return renderToStaticMarkup(React.createElement(ToolDetails, { toolCall }));
}

// JsonHighlight 内部的 Shiki 组件走 React.lazy；服务端静态渲染只证明异步组件边界
// resolve 后仍保留 code 语义，token 颜色由浏览器 effect 在输入静默后补上。
function renderHighlighted(toolCall: ToolCall): Promise<string> {
  return renderToStaticMarkupAsync(React.createElement(ToolDetails, { toolCall }));
}

describe('ToolDetails 语法高亮（#13 收窄版：仅 JSON 走高亮）', () => {
  it('结构化 host reason 只渲染登记表文案，modelText 不进入默认或折叠输出', () => {
    const modelText = 'MODEL_TEXT_LEAK_SENTINEL: approval backend exploded';
    const markup = render({
      id: 'host-reason-deny',
      name: 'Bash',
      arguments: { command: 'echo ok' },
      result: {
        success: false,
        error: modelText,
        metadata: {
          failureCode: AgentFailureCode.PermissionDenied,
          hostReason: {
            code: HostReasonCode.PermissionDeniedNoApprovalUi,
            metadata: { toolName: 'Bash' },
            modelText,
          },
        },
      },
    } as unknown as ToolCall);

    expect(markup).toContain('当前运行环境无法显示审批');
    expect(markup).not.toContain(modelText);
    expect(markup).not.toContain('MODEL_TEXT_LEAK_SENTINEL');
  });
  it('default 分支工具的参数（JSON 转储）走语法高亮', async () => {
    // 非结构化工具名 → formatArgs 走 default JSON.stringify 分支
    const markup = await renderHighlighted({
      id: 't1',
      name: 'mcp_custom_tool',
      arguments: { query: 'hello', limit: 5 },
    } as ToolCall);
    expect(markup).toContain('<code');
    expect(markup).toContain('data-code-preview="plain"');
    expect(markup).toContain('query');
  });

  it('Read 工具的参数（人话标签）保持纯文本 pre，不高亮', () => {
    const markup = render({
      id: 't2',
      name: 'Read',
      arguments: { file_path: '/tmp/a.ts' },
    } as ToolCall);
    expect(markup).toContain('文件: /tmp/a.ts');
    // 标签文本块是纯 <pre>，不应出现高亮 <code> token
    expect(markup).not.toContain('<code');
  });

  it('字符串型 result.output（日志/带行号）保持纯文本，不走 JSON 高亮', () => {
    const markup = render({
      id: 't3',
      name: 'Read',
      arguments: { file_path: '/tmp/a.ts' },
      result: { success: true, output: '     1→const x = 1\n     2→const y = 2' },
    } as unknown as ToolCall);
    expect(markup).toContain('const x = 1');
    // 行号前缀的纯文本输出不应被当 JSON 高亮
    expect(markup).not.toContain('color:#');
  });

  it('对象型 result.output 走 JSON 高亮', async () => {
    const markup = await renderHighlighted({
      id: 't4',
      name: 'mcp_custom_tool',
      arguments: { q: 1 },
      result: { success: true, output: { items: [1, 2, 3], ok: true } },
    } as unknown as ToolCall);
    expect(markup).toContain('<code');
    expect(markup).toContain('items');
    expect(markup).toContain('data-code-preview="plain"');
  });

  it('工具详情标题走 i18n，未分类错误不在主层直出原串', () => {
    const success = render({
      id: 't-i18n-success',
      name: 'Read',
      arguments: { file_path: '/tmp/a.ts' },
      result: { toolCallId: 't-i18n-success', success: true, output: 'ok' },
    } as ToolCall);
    expect(success).toContain('结果');
    expect(success).not.toContain('>Result<');

    const rawError = 'VendorWidget crashed at InternalRouter.ts:419';
    const failed = render({
      id: 't-i18n-failed',
      name: 'futureVendorTool',
      arguments: {},
      result: { toolCallId: 't-i18n-failed', success: false, error: rawError },
    } as ToolCall);
    expect(failed).toContain('这一步没有完成');
    expect(failed).toContain('查看原始报错');
    expect(failed).not.toContain(rawError);
  });

  it('取消闭合占位结果只显示人话中断态', () => {
    const markup = render({
      id: 't-cancelled',
      name: 'Read',
      arguments: { file_path: '/tmp/要点笔记.md' },
      result: {
        toolCallId: 't-cancelled',
        success: false,
        error: '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]',
      },
    } as ToolCall);

    expect(markup).toContain('已取消');
    expect(markup).toContain('应用重启时中断');
    expect(markup).not.toContain('[no result');
    expect(markup).not.toContain('cancelled before');
    expect(markup).not.toContain('复制错误');
    expect(markup).not.toContain('查看原始报错');
  });
});
