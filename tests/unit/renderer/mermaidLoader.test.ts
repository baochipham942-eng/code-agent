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
    const m = await loadMermaid('dark');
    expect(m.render).toBe(render);
  });

  it('同一主题多次调用只 initialize 一次(懒加载 + 初始化幂等)', async () => {
    const { loadMermaid } = await freshLoader();
    await loadMermaid('dark');
    await loadMermaid('dark');
    await loadMermaid('dark');
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('dark 档用 mermaid dark 主题且 darkMode 为真', async () => {
    const { loadMermaid } = await freshLoader();
    await loadMermaid('dark');
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      theme: 'dark',
      startOnLoad: false,
      themeVariables: expect.objectContaining({ darkMode: true, background: '#18181b' }),
    }));
  });

  // N-L5-MERMAIDTHEME 的核心断言：浅色档不能再发深色配色，
  // 否则浅色模式下节点是纯黑块压白底（ECOUP 验收图抓出的既存问题）。
  it('light 档用浅色底且文字是深色(不再发深色配色)', async () => {
    const { loadMermaid } = await freshLoader();
    await loadMermaid('light');
    const config = initialize.mock.calls[0]![0] as {
      theme: string;
      themeVariables: { darkMode: boolean; background: string; primaryTextColor: string };
    };
    expect(config.theme).toBe('default');
    expect(config.themeVariables.darkMode).toBe(false);
    expect(config.themeVariables.background).toBe('#ffffff');
    // 文字必须是深色——浅底深字才读得出来
    expect(config.themeVariables.primaryTextColor).toBe('#18181b');
  });

  // 反向变异守的就是「幂等把主题切换吞掉」这个失败形态：
  // 旧实现用布尔 initialized，切主题后不会重初始化，改动等于没接电。
  it('主题变了必须重初始化(幂等不许吞掉切换)', async () => {
    const { loadMermaid } = await freshLoader();
    await loadMermaid('dark');
    await loadMermaid('light');
    expect(initialize).toHaveBeenCalledTimes(2);
    expect((initialize.mock.calls[1]![0] as { theme: string }).theme).toBe('default');
    // 切回去也要再初始化一次，不能因为「曾经初始化过 dark」就跳过
    await loadMermaid('dark');
    expect(initialize).toHaveBeenCalledTimes(3);
    expect((initialize.mock.calls[2]![0] as { theme: string }).theme).toBe('dark');
  });
});
