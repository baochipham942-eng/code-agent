// ADR-043 T2 遗留刀1：LiveToolOutput 全展开态全局尾截断。
// 此前渲染全量 pre 块无上限，长命令运行中会无限刷屏；复用 bashOutputPreview 的
// isPending=true 分支（尾 5 行）截断，省略时顶部补一行"…省略 N 行…"提示。
// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LiveToolOutput } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/LiveToolOutput';
import type { ToolCall } from '../../../src/shared/contract';

afterEach(() => {
  cleanup();
});

function toolCallWithLive(stdoutLines: string[], stderrLines?: string[]): ToolCall {
  return {
    id: 'call-1',
    name: 'Bash',
    arguments: {},
    liveOutput: {
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines ? stderrLines.join('\n') : undefined,
    },
  } as ToolCall;
}

describe('LiveToolOutput — 全局尾截断（遗留刀1）', () => {
  it('20 行输出只渲染尾 5 行 + 省略提示', () => {
    const stdoutLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const { container } = render(<LiveToolOutput toolCall={toolCallWithLive(stdoutLines)} />);
    const text = container.textContent || '';

    for (let i = 16; i <= 20; i += 1) {
      expect(text).toMatch(new RegExp(`line${i}\\b`));
    }
    for (let i = 1; i <= 15; i += 1) {
      expect(text).not.toMatch(new RegExp(`line${i}(?!\\d)`));
    }
    expect(text).toContain('…省略 15 行…');
  });

  it('≤5 行输出全部可见，不出现省略提示', () => {
    const { container } = render(<LiveToolOutput toolCall={toolCallWithLive(['a', 'b', 'c'])} />);
    const text = container.textContent || '';
    expect(text).not.toContain('省略');
    expect(text).toContain('a\nb\nc');
  });

  it('stderr 段同样参与尾截断', () => {
    const stderrLines = Array.from({ length: 10 }, (_, i) => `err${i + 1}`);
    const { container } = render(<LiveToolOutput toolCall={toolCallWithLive(['out'], stderrLines)} />);
    const text = container.textContent || '';
    expect(text).toMatch(/err10\b/);
    expect(text).not.toMatch(/err1(?!\d)/);
  });

  it('无 liveOutput 时不渲染任何内容', () => {
    const { container } = render(
      <LiveToolOutput toolCall={{ id: 'call-2', name: 'Bash', arguments: {} } as ToolCall} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
