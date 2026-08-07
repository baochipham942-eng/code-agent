// 聊天流英文直出第二批（工单 fix/chat-english-leaks）：钉住这批文案走 i18n 后不回退。
// 默认语言 zh，断言渲染 DOM 里出现中文、不出现原英文字面量。
// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LiveToolOutput } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/LiveToolOutput';
import { CodeBlock } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import type { ToolCall } from '../../../src/shared/contract';

afterEach(() => {
  cleanup();
});

describe('toolDisplay i18n — 中文直出防回退', () => {
  it('LiveToolOutput 标题渲染「实时输出」而非 Live output', () => {
    const toolCall = {
      id: 'call-1',
      name: 'Bash',
      arguments: {},
      liveOutput: { stdout: 'hello' },
    } as ToolCall;
    const { container } = render(<LiveToolOutput toolCall={toolCall} />);
    const text = container.textContent || '';
    expect(text).toContain('实时输出');
    expect(text).not.toContain('Live output');
  });

  it('CodeBlock 工具栏渲染「换行」「复制」而非 Wrap / Copy', () => {
    const { container } = render(
      <CodeBlock language="ts" code={'const a = 1;\nconst b = 2;'} />,
    );
    const text = container.textContent || '';
    expect(text).toContain('换行');
    expect(text).toContain('复制');
    expect(text).not.toContain('Wrap');
    expect(text).not.toContain('Copy');
  });
});
