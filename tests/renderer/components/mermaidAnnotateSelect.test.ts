// @vitest-environment jsdom
// Mermaid 标注即编辑：点击目标 → 可选图元 + label 解析
import { describe, it, expect } from 'vitest';
import { findMermaidSelectable } from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgFrom(html: string): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML = `<svg xmlns="${SVG_NS}">${html}</svg>`;
  return host.querySelector('svg') as SVGSVGElement;
}

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
});
