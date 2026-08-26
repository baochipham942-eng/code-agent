// 产品拍板：所有探索性失败（agent 试错，未被 humanizeToolError 分类为需要用户介入的
// 鉴权/额度/限流错误）一律默认折叠成一行，不该把组强制撑开成一面报错墙——
// 只有真正需要用户介入的失败才默认展开+顶红，组头状态徽标已传达失败，用户需要时再点开。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { TraceNode } from '../../../src/shared/contract/trace';

// renderToStaticMarkup 下 zustand 的 useSyncExternalStore 会走 server snapshot，直接 mock useI18n
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

// ToolDetails 依赖 appStore 的两个 selector，mock 掉即可（同 toolDetailsHighlight.test.tsx）。
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
    }),
}));

import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

let nid = 0;
function toolNode(name: string, success: boolean, result?: string): TraceNode {
  nid += 1;
  return {
    id: `tool-${nid}`,
    type: 'tool_call',
    content: '',
    timestamp: nid,
    toolCall: {
      id: `call-${nid}`,
      name,
      args: { url: `https://site${nid}.com` },
      success,
      result: result ?? (success ? 'ok' : 'anti-scraping wall'),
    },
  } as TraceNode;
}

// 展开态才会渲染的内层容器（每工具 ToolCallDisplay 列表的 border-l 框）
const EXPANDED_MARKER = 'border-l border-zinc-800';

describe('ToolStepGroup — 探索性失败默认折叠，需介入的失败默认展开+顶红', () => {
  it('部分失败（partial：有成功有反爬失败，未分类错误）默认折叠，不撑开报错墙', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('WebFetch', false), toolNode('WebFetch', true)]} />,
    );
    expect(html).not.toContain(EXPANDED_MARKER);
  });

  it('全失败（error，未分类错误）默认也折叠', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('WebFetch', false), toolNode('WebFetch', false)]} />,
    );
    expect(html).not.toContain(EXPANDED_MARKER);
  });

  it('defaultExpanded=true 时仍展开（流式态等显式要求不受影响）', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('WebFetch', true), toolNode('WebFetch', true)]} defaultExpanded />,
    );
    expect(html).toContain(EXPANDED_MARKER);
  });

  it('非网络工具（Bash 非零退出码，未分类错误）的探索性失败也默认折叠，不顶红', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('Bash', false, 'command failed with exit code 1')]} />,
    );
    expect(html).not.toContain(EXPANDED_MARKER);
    expect(html).not.toContain('border border-white/[0.04]');
    expect(html).not.toContain('bg-white/[0.015]');
    expect(html).toContain('px-1 py-0.5 text-zinc-400');
    expect(html).not.toContain('bg-mark-danger');
    expect(html).not.toContain('text-badge-danger');
  });

  it('探索性失败的原始报错仅在用户主动展开后显示', () => {
    // 组折叠只影响"要不要强制摊开"，不影响每个工具自己被点开后展示的内容——
    // ToolDetails 是点开单个工具行后挂载的详情视图，验证它没有被本批改动阉割信息。
    const html = renderToStaticMarkup(
      React.createElement(ToolDetails, {
        toolCall: {
          id: 'call-x',
          name: 'Bash',
          arguments: {},
          result: { toolCallId: 'call-x', success: false, error: 'command failed with exit code 1' },
        },
      }),
    );
    expect(html).toContain('查看原始报错');
    expect(html).not.toContain('command failed with exit code 1');
  });

  it('真正需要用户介入的失败（鉴权失效）默认展开并顶红', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('Bash', false, '401 Unauthorized: invalid api key')]} />,
    );
    expect(html).toContain(EXPANDED_MARKER);
    expect(html).toContain('bg-mark-danger');
    expect(html).toContain('text-badge-danger');
    expect(html).toContain('border-badge-danger/30');
    expect(html).toContain('bg-red-400/[0.05]');
  });

  it('需要用户介入的额度耗尽失败也默认展开并顶红', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('image_generate', false, '402 Payment Required: insufficient balance 余额不足')]} />,
    );
    expect(html).toContain(EXPANDED_MARKER);
    expect(html).toContain('bg-mark-danger');
    expect(html).toContain('text-badge-danger');
    expect(html).toContain('border-badge-danger/30');
    expect(html).toContain('bg-red-400/[0.05]');
  });
});

describe('ToolStepGroup — 连接器组头与步骤行说人话', () => {
  function tmeetNode(
    name: 'tmeetMeetingList' | 'tmeetMeetingCreate' | 'tmeetMeetingSearch',
    stepLabel: 'tmeetMeetingListUpcoming' | 'tmeetMeetingListEnded' | 'tmeetMeetingCreate' | 'tmeetMeetingSearch',
    args: Record<string, unknown> = {},
  ): TraceNode {
    nid += 1;
    return {
      id: `tmeet-tool-${nid}`,
      type: 'tool_call',
      content: '',
      timestamp: nid,
      toolCall: {
        id: `tmeet-call-${nid}`,
        name,
        args,
        shortDescription: `Use ${name}`,
        stepLabel,
        success: true,
        result: 'ok',
      },
    };
  }

  it('单步组头直接给连接器名和 scope 对应的人话句', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[
        tmeetNode('tmeetMeetingList', 'tmeetMeetingListEnded', { scope: 'ended' }),
      ]} />,
    );

    expect(html).toContain('腾讯会议 · 查了近 30 天已结束的会议');
    expect(html).not.toContain('tmeetMeetingList');
  });

  it('多步组头只给连接器名和步骤数', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[
        tmeetNode('tmeetMeetingList', 'tmeetMeetingListUpcoming'),
        tmeetNode('tmeetMeetingSearch', 'tmeetMeetingSearch'),
      ]} />,
    );

    expect(html).toContain('腾讯会议 · 执行了 2 个步骤');
    expect(html).not.toMatch(/tmeetMeeting(List|Search)/);
  });

  it('语义 UI 门关闭时，连接器组头仍不回退到内部名', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => key === 'cca.semanticToolUI' ? 'false' : null },
    });
    try {
      const html = renderToStaticMarkup(
        <ToolStepGroup nodes={[
          tmeetNode('tmeetMeetingCreate', 'tmeetMeetingCreate'),
        ]} />,
      );
      expect(html).toContain('腾讯会议 · 创建了一场会议');
      expect(html).not.toContain('tmeetMeetingCreate');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('非连接器继续使用现有人话模板', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('Read', true)]} />,
    );
    expect(html).toContain('读取了一个文件');
    expect(html).not.toContain('Read 执行了一个步骤');
  });
});
