// @vitest-environment jsdom
// Mermaid 标注即编辑：点击目标 → 可选图元 + label 解析
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  findMermaidSelectable,
  MermaidDiagram,
} from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';

const mocks = vi.hoisted(() => ({
  renderMermaid: vi.fn(),
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/mermaidLoader', () => ({
  loadMermaid: async () => ({ render: mocks.renderMermaid }),
}));

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgFrom(html: string): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML = `<svg xmlns="${SVG_NS}">${html}</svg>`;
  return host.querySelector('svg') as SVGSVGElement;
}

afterEach(() => {
  cleanup();
  useMessageActionStore.getState().unregister();
  mocks.renderMermaid.mockReset();
  vi.unstubAllGlobals();
});

describe('findMermaidSelectable', () => {
  it('flowchart：点击 g.node 内部任意图元命中节点 label', () => {
    const svg = svgFrom(`
      <g class="node default">
        <rect class="basic"></rect>
        <g class="label"><foreignObject><div><span class="nodeLabel">鉴权</span></div></foreignObject></g>
      </g>
    `);
    const rect = svg.querySelector('rect') as Element;
    const found = findMermaidSelectable(rect);
    expect(found?.label).toBe('鉴权');
    expect((found?.el as Element).classList.contains('node')).toBe(true);
  });

  it('flowchart：点击 edgeLabel 命中连线标签', () => {
    const svg = svgFrom('<g class="edgeLabel"><g class="label"><text>成功</text></g></g>');
    const text = svg.querySelector('text') as Element;
    expect(findMermaidSelectable(text)?.label).toBe('成功');
  });

  it('sequence：点击 actor 文本命中参与者', () => {
    const svg = svgFrom('<g><rect class="actor"></rect><text class="actor"><tspan>Alice</tspan></text></g>');
    const text = svg.querySelector('text') as Element;
    expect(findMermaidSelectable(text)?.label).toBe('Alice');
  });

  it('sequence：点击 actor 矩形回退到同组 text 的 label', () => {
    const svg = svgFrom('<g><rect class="actor"></rect><text class="actor">Bob</text></g>');
    const rect = svg.querySelector('rect') as Element;
    expect(findMermaidSelectable(rect)?.label).toBe('Bob');
  });

  it('sequence：点击消息文本命中消息', () => {
    const svg = svgFrom('<text class="messageText">登录请求</text>');
    const text = svg.querySelector('text') as Element;
    expect(findMermaidSelectable(text)?.label).toBe('登录请求');
  });

  it('点击空白区域返回 null', () => {
    const svg = svgFrom('<g class="background"><path d=""></path></g>');
    const path = svg.querySelector('path') as Element;
    expect(findMermaidSelectable(path)).toBeNull();
  });

  it('单遍填充编辑 prompt，不展开 $ replacement token，也不重扫插入的占位符', async () => {
    const injected = "$& $' $$ $` {codeBlock}";
    const code = 'flowchart TD\nA[原节点] --> B[目标节点]';
    mocks.renderMermaid.mockResolvedValue({
      svg: `<svg xmlns="${SVG_NS}" viewBox="0 0 100 50"><g class="node"><text>${injected}</text></g></svg>`,
    });
    const sendPrompt = vi.fn();
    useAppStore.setState({ language: 'en', isProcessing: false });
    useMessageActionStore.getState().register(sendPrompt, () => []);
    vi.stubGlobal('PointerEvent', MouseEvent);

    const { container } = render(React.createElement(MermaidDiagram, { code }));
    const node = await waitFor(() => {
      const found = container.querySelector('g.node');
      expect(found).not.toBeNull();
      return found as SVGGElement;
    });
    const viewport = node.closest('div[title]') as HTMLDivElement;
    viewport.setPointerCapture = vi.fn();
    fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(node, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.change(screen.getByPlaceholderText('Describe the change, e.g. "split into two steps"'), {
      target: { value: injected },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const codeBlock = `\`\`\`mermaid\n${code}\n\`\`\`\n`;
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(
      `Please update "${injected}" in this Mermaid diagram: ${injected}\n\nCurrent diagram source:\n${codeBlock}\nReply with the complete updated mermaid code block, keeping everything else unchanged.`,
      undefined,
    ));
  });
});
