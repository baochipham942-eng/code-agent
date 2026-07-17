// ADR-043 T2：ToolStepGroup 三态折叠预览。
// 流式中默认中间档（运行中那步 compact 预览 + 已完成计数行），
// 流式结束/用户手动操作/失败态各自的档位规则见 ADR 决策 1-5。
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { TraceNode } from '../../../src/shared/contract/trace';

// renderToStaticMarkup/RTL 下 zustand 的 useSyncExternalStore 在部分环境需要 server snapshot，
// 直接 mock useI18n 同 toolStepGroup.failCollapse.test.tsx 先例。
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

// ToolDetails 依赖 appStore 的两个 selector，mock 掉即可（同 toolStepGroup.failCollapse.test.tsx）。
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
      processingSessionIds: new Set(),
    }),
}));

afterEach(() => {
  cleanup();
});

let nid = 0;
function runningNode(name: string): TraceNode {
  nid += 1;
  return {
    id: `tool-${nid}`,
    type: 'tool_call',
    content: '',
    timestamp: nid,
    toolCall: {
      id: `call-${nid}`,
      name,
      args: {},
      // 无 result = 运行中（真实"正在跑"信号，非 _streaming 参数流标记）
    },
  } as TraceNode;
}

function doneNode(name: string, success = true, result = 'ok'): TraceNode {
  nid += 1;
  return {
    id: `tool-${nid}`,
    type: 'tool_call',
    content: '',
    timestamp: nid,
    toolCall: {
      id: `call-${nid}`,
      name,
      args: {},
      success,
      result,
    },
  } as TraceNode;
}

function runningNodeWithLiveOutput(name: string, stdoutLines: string[]): TraceNode {
  nid += 1;
  return {
    id: `tool-${nid}`,
    type: 'tool_call',
    content: '',
    timestamp: nid,
    toolCall: {
      id: `call-${nid}`,
      name,
      args: {},
      liveOutput: { stdout: stdoutLines.join('\n') },
    },
  } as TraceNode;
}

const EXPANDED_MARKER = 'border-l border-zinc-800';

describe('ToolStepGroup 三态折叠预览（ADR-043 T2）', () => {
  it('① 流式中未手动操作 → 渲染中间档：运行中那步可见 + 已完成计数行', () => {
    render(
      <ToolStepGroup
        nodes={[doneNode('Read'), doneNode('Read'), runningNode('Bash')]}
        isStreamingTurn
      />,
    );
    // 运行中那步（Bash）以 compact 行渲染出来
    expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();
    // 已完成 2 步的计数行
    expect(screen.getByText('已完成 2 步')).toBeTruthy();
    // 未进入全展开：不出现全展开专属容器
    expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);
  });

  it('② 流式结束 → 自动回收起（不再渲染运行中预览/计数行）', () => {
    const { rerender } = render(
      <ToolStepGroup nodes={[doneNode('Read'), runningNode('Bash')]} isStreamingTurn />,
    );
    expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();

    // 流式收尾：这一步也跑完了，isStreamingTurn 降为 false
    rerender(
      <ToolStepGroup nodes={[doneNode('Read'), doneNode('Bash')]} isStreamingTurn={false} />,
    );
    expect(screen.queryByTestId('tool-call-row-Bash')).toBeNull();
    expect(screen.queryByText(/已完成 \d+ 步/)).toBeNull();
  });

  it('③a 用户手动点开后冻结自动档：流式中点开保持展开，即便流式结束也不缩回中间档/收起', () => {
    const { rerender } = render(
      <ToolStepGroup nodes={[doneNode('Read'), runningNode('Bash')]} isStreamingTurn />,
    );
    // 组头按钮永远是文档序里第一个 button（内层运行中工具行也是 role=button，取第一个才是组头）
    const button = screen.getAllByRole('button')[0] as HTMLElement;
    fireEvent.click(button);
    expect(document.body.innerHTML).toContain(EXPANDED_MARKER);

    // 流式结束，若未冻结会被自动收起——冻结后应仍保持全展开
    rerender(
      <ToolStepGroup nodes={[doneNode('Read'), doneNode('Bash')]} isStreamingTurn={false} />,
    );
    expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
  });

  it('③b 用户手动点收后冻结：流式中点收保持收起，不再被自动中间档抢回', () => {
    render(
      <ToolStepGroup
        nodes={[doneNode('Read'), runningNode('Bash')]}
        isStreamingTurn
        defaultExpanded
      />,
    );
    // defaultExpanded=true 起始为全展开态
    expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
    const button = screen.getAllByRole('button')[0] as HTMLElement;
    fireEvent.click(button);
    // 点收后：既不是全展开，也不该被中间档接管（用户已冻结）
    expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);
    expect(screen.queryByTestId('tool-call-row-Bash')).toBeNull();
  });

  it('④ 需介入失败 → 直接全展开，不进中间档（即便仍在流式中）', () => {
    render(
      <ToolStepGroup
        nodes={[doneNode('Bash', false, '401 Unauthorized: invalid api key')]}
        isStreamingTurn
      />,
    );
    expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
    expect(document.body.innerHTML).toContain('bg-red-400');
  });

  it('⑤ 探索性失败 → 保持收起，不因流式中而进中间档', () => {
    render(
      <ToolStepGroup
        nodes={[doneNode('WebFetch', false, 'anti-scraping wall'), runningNode('Bash')]}
        isStreamingTurn
      />,
    );
    expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);
    expect(screen.queryByTestId('tool-call-row-Bash')).toBeNull();
    expect(screen.queryByText(/已完成 \d+ 步/)).toBeNull();
  });

  it('⑥ 中间档时 aria-expanded=false（未全展开语义不变）', () => {
    render(<ToolStepGroup nodes={[doneNode('Read'), runningNode('Bash')]} isStreamingTurn />);
    const button = screen.getAllByRole('button')[0] as HTMLElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('⑦ 计数行 N=0 时不渲染（全部工具都在运行/无已完成步骤）', () => {
    render(<ToolStepGroup nodes={[runningNode('Bash')]} isStreamingTurn />);
    expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();
    expect(screen.queryByText(/已完成 \d+ 步/)).toBeNull();
  });

  it('⑧ 中间档实时输出截尾 5 行（拍板决策 4）：早期行不见，末尾行仍在', () => {
    const stdoutLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    render(
      <ToolStepGroup nodes={[runningNodeWithLiveOutput('Bash', stdoutLines)]} isStreamingTurn />,
    );
    // 尾 5 行（line16~line20）应该在
    for (let i = 16; i <= 20; i += 1) {
      expect(screen.queryByText(new RegExp(`line${i}\\b`))).not.toBeNull();
    }
    // 早期行（line1~line15）应该被截掉，不再出现在 DOM 里
    for (let i = 1; i <= 15; i += 1) {
      expect(document.body.innerHTML).not.toMatch(new RegExp(`line${i}(?!\\d)`));
    }
  });

  it('⑧b 全展开态也走 LiveToolOutput 全局尾截断（遗留刀1）：早期行不见，末尾行仍在', () => {
    const stdoutLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    render(
      <ToolStepGroup
        nodes={[runningNodeWithLiveOutput('Bash', stdoutLines)]}
        isStreamingTurn={false}
        defaultExpanded
      />,
    );
    expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
    // 尾 5 行（line16~line20）应该在
    for (let i = 16; i <= 20; i += 1) {
      expect(document.body.innerHTML).toMatch(new RegExp(`line${i}\\b`));
    }
    // 早期行（line1~line15）应该被截掉，不再出现在 DOM 里
    for (let i = 1; i <= 15; i += 1) {
      expect(document.body.innerHTML).not.toMatch(new RegExp(`line${i}(?!\\d)`));
    }
  });

  it('⑨ 中间档运行中途出现需介入失败（rerender）→ 立刻切到全展开，不停留在中间档', () => {
    const { rerender } = render(
      <ToolStepGroup nodes={[doneNode('Read'), runningNode('Bash')]} isStreamingTurn />,
    );
    // 起点：中间档
    expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);

    // 流式中途：Bash 那步以需介入失败收尾（同一 turn 仍在流式中）
    rerender(
      <ToolStepGroup
        nodes={[doneNode('Read'), doneNode('Bash', false, '401 Unauthorized: invalid api key')]}
        isStreamingTurn
      />,
    );
    expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
    // Read 成功 + Bash 需介入失败 = partial 态，顶色是 amber（error 态才是 red）
    expect(document.body.innerHTML).toContain('bg-amber-400');
  });
});
