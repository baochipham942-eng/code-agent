// @vitest-environment jsdom
// ============================================================================
// 代码块紧邻 !copy 去重（工单 N-CODEBLOCK-DUPCOPY）——组件级钉板：
// 紧邻围栏块的纯 !copy 段不再渲染出第二个复制按钮（块头自带的仍在）；
// 正文中间/夹说明文字的 !copy 按钮照常渲染，行内功能不回退。
// IACTCopyButton 的 DOM 标记是 title="复制到剪贴板"；块头复制按钮文案走 i18n（zh 默认「复制」）。
// ============================================================================

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

// MarkdownRenderer 是 lazy + Suspense（fallback 为纯文本），需等核心加载完再断言
async function renderAssistant(content: string) {
  const utils = render(<MessageContent content={content} isUser={false} messageId="assistant-1" />);
  await waitFor(() => {
    expect(utils.container.querySelector('p, [data-code-block-lines]')).toBeTruthy();
  });
  return utils;
}

const iactCopyButtons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button[title="复制到剪贴板"]'));

describe('代码块紧邻 !copy 去重', () => {
  afterEach(() => cleanup());

  it('紧邻 ⇒ 去重：代码块后的 [复制命令](!copy) 不再渲染，块头「复制」仍在', async () => {
    const { container } = await renderAssistant('```bash\nnpm install -g agent-neo\n```\n[复制命令](!copy)');

    // 第二个入口（IACT 按钮）消失
    expect(iactCopyButtons(container)).toHaveLength(0);
    // 块头自带复制按钮仍在：代码块容器内文案恰为「复制」的按钮
    const codeBlock = container.querySelector('[data-code-block-lines]');
    expect(codeBlock).toBeTruthy();
    const headerCopy = Array.from(codeBlock!.querySelectorAll('button'))
      .find((b) => b.textContent === '复制');
    expect(headerCopy).toBeTruthy();
  });

  it('不紧邻 ⇒ 保留：正文中间独立的 [sk-xxx](!copy) 照常渲染成按钮', async () => {
    const { container } = await renderAssistant('这是你的令牌：\n\n[sk-abc123](!copy)\n\n拿去配置即可。');

    const buttons = iactCopyButtons(container);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('sk-abc123');
  });

  it('不紧邻 ⇒ 保留：代码块与 !copy 之间夹说明文字段，按钮照常渲染', async () => {
    const { container } = await renderAssistant(
      '```bash\nls -la\n```\n\n安装完先看这段说明。\n\n[复制命令](!copy)',
    );

    expect(iactCopyButtons(container)).toHaveLength(1);
  });

  it('无语言单行围栏渲染为行内 code（无块头按钮），相邻 !copy 是唯一复制入口，保留', async () => {
    const { container } = await renderAssistant('```\nls -la ~/backup\n```\n[复制命令](!copy)');

    expect(iactCopyButtons(container)).toHaveLength(1);
  });

  it('两块之间无空行的 !copy 段去重后，两个代码块仍独立渲染不拼接', async () => {
    const { container } = await renderAssistant(
      '```bash\nls\n```\n[复制](!copy)\n```ts\nconst a = 1;\n```',
    );

    expect(iactCopyButtons(container)).toHaveLength(0);
    expect(container.querySelectorAll('[data-code-block-lines]')).toHaveLength(2);
  });

  it('四反引号围栏内的三反引号示例与 !copy 字面量是代码内容，原样展示', async () => {
    const { container } = await renderAssistant('````\n```\n[x](!copy)\n```\n````\n\n正文说明');

    expect(iactCopyButtons(container)).toHaveLength(0);
    expect(container.textContent).toContain('[x](!copy)');
  });

  it('引用内的代码块 + !copy 段同样去重：块头「复制」在、第二个按钮消失', async () => {
    const { container } = await renderAssistant('> ```bash\n> ls -la\n> ```\n>\n> [复制命令](!copy)');

    expect(iactCopyButtons(container)).toHaveLength(0);
    const codeBlock = container.querySelector('[data-code-block-lines]');
    expect(codeBlock).toBeTruthy();
  });
});
