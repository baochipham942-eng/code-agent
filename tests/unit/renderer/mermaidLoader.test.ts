import { describe, expect, it, vi, beforeEach } from 'vitest';

const initialize = vi.fn();
const render = vi.fn(async () => ({ svg: '<svg></svg>' }));

vi.mock('mermaid', () => ({ default: { initialize, render } }));

async function freshLoader() {
  vi.resetModules();
  return import('../../../src/renderer/components/features/chat/MessageBubble/mermaidLoader');
}

describe('loadMermaid', () => {
  beforeEach(() => {
    initialize.mockClear();
    render.mockClear();
  });

  it('动态 import mermaid 并返回实例', async () => {
    const { loadMermaid } = await freshLoader();
    const m = await loadMermaid();
    expect(m.render).toBe(render);
  });

  it('多次调用只 initialize 一次(懒加载 + 初始化幂等)', async () => {
    const { loadMermaid } = await freshLoader();
    await loadMermaid();
    await loadMermaid();
    await loadMermaid();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('initialize 用 dark 主题(渲染主题不丢)', async () => {
    const { loadMermaid } = await freshLoader();
    await loadMermaid();
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark', startOnLoad: false }));
  });
});
