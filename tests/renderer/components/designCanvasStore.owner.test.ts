import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDesignCanvasStore, persistDesignCanvas } from '../../../src/renderer/components/design/designCanvasStore';
import type { CanvasNode } from '../../../src/renderer/components/design/designCanvasTypes';

// H1.a：画布 store 加 ownerSessionId（属主会话）+ claim/clear 两个 action。
// 属主隔离是跨会话泄漏防线，认领不匹配会话时重置画布为空再换属主。

function makeNode(id: string): CanvasNode {
  return { id, src: `${id}.png`, x: 0, y: 0, width: 100, height: 100, createdAt: Date.now() };
}

function resetStore(): void {
  useDesignCanvasStore.setState({
    nodes: [],
    connectors: [],
    shapes: [],
    runDir: null,
    ownerSessionId: null,
    selectedIds: [],
    selectedDiagram: null,
  });
}

describe('designCanvasStore 属主会话隔离', () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it('初始 ownerSessionId 为 null（fail-closed）', () => {
    expect(useDesignCanvasStore.getState().ownerSessionId).toBeNull();
  });

  it('claimCanvasForSession 同 session 是 no-op，保留现有画布', () => {
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], runDir: '/run/a', ownerSessionId: 's1' });
    useDesignCanvasStore.getState().claimCanvasForSession('s1');
    const st = useDesignCanvasStore.getState();
    expect(st.ownerSessionId).toBe('s1');
    expect(st.nodes).toHaveLength(1);
    expect(st.runDir).toBe('/run/a');
  });

  it('claimCanvasForSession 不同 session → 重置画布为空 + 换属主', () => {
    useDesignCanvasStore.setState({
      nodes: [makeNode('n1')],
      connectors: [],
      shapes: [],
      runDir: '/run/a',
      ownerSessionId: 's1',
    });
    useDesignCanvasStore.getState().claimCanvasForSession('s2');
    const st = useDesignCanvasStore.getState();
    expect(st.ownerSessionId).toBe('s2');
    expect(st.nodes).toHaveLength(0);
    expect(st.connectors).toHaveLength(0);
    expect(st.shapes).toHaveLength(0);
    expect(st.runDir).toBeNull();
  });

  // M1-R2.b 行为修正：原断言「owner=null 认领时重置」改为「认领现有画布（保留）」。
  // 理由：刷新后 ownerSessionId 随 runDir 持久化恢复，但存在 owner=null + 有盘画布的边界
  //（旧 persist 不存 owner）。无主画布归属当前点击者，认领时**保留** nodes/runDir，不丢数据。
  it('claimCanvasForSession 从 null 属主认领 → 保留现有画布 + 设属主（不丢数据）', () => {
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], runDir: '/run/a', ownerSessionId: null });
    useDesignCanvasStore.getState().claimCanvasForSession('s2');
    const st = useDesignCanvasStore.getState();
    expect(st.ownerSessionId).toBe('s2');
    expect(st.nodes).toHaveLength(1); // 保留，不重置
    expect(st.runDir).toBe('/run/a'); // runDir 不被清，UI 仍能找回画布
  });

  // M1-R2.b：真·跨会话（owner=非空他会话）→ 重置为空 + 换属主 + 清运行态（generating/error）。
  it('claimCanvasForSession 真·跨会话 → 重置 + 换属主 + 清 generating/error', () => {
    useDesignCanvasStore.setState({
      nodes: [makeNode('n1')],
      runDir: '/run/a',
      ownerSessionId: 's1',
      generating: true,
      error: '上个会话的错误',
    });
    useDesignCanvasStore.getState().claimCanvasForSession('s2');
    const st = useDesignCanvasStore.getState();
    expect(st.ownerSessionId).toBe('s2');
    expect(st.nodes).toHaveLength(0);
    expect(st.runDir).toBeNull();
    expect(st.generating).toBe(false); // L2-R2：不继承上个会话的出图遮罩
    expect(st.error).toBeNull();
  });

  it('clearCanvasOwner 仅在属主匹配时清空 + 置 null', () => {
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], runDir: '/run/a', ownerSessionId: 's1' });
    useDesignCanvasStore.getState().clearCanvasOwner('s1');
    const st = useDesignCanvasStore.getState();
    expect(st.ownerSessionId).toBeNull();
    expect(st.nodes).toHaveLength(0);
  });

  it('clearCanvasOwner 属主不匹配时不动画布', () => {
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], runDir: '/run/a', ownerSessionId: 's1' });
    useDesignCanvasStore.getState().clearCanvasOwner('s2');
    const st = useDesignCanvasStore.getState();
    expect(st.ownerSessionId).toBe('s1');
    expect(st.nodes).toHaveLength(1);
  });

  // M1-R2.a：ownerSessionId 须随 runDir 一起持久化——刷新后属主跟着恢复，
  // 同会话回来 claim 命中 no-op 保画布，避免 owner=null 走重置分支孤儿化画布。
  // partialize 抽成具名纯函数 persistDesignCanvas（store 的 persist 选项即引用它）。
  it('persist partialize 同时含 runDir 与 ownerSessionId', () => {
    expect(persistDesignCanvas({ runDir: '/run/x', ownerSessionId: 's9' })).toEqual({
      runDir: '/run/x',
      ownerSessionId: 's9',
    });
    expect(persistDesignCanvas({ runDir: null, ownerSessionId: null })).toEqual({
      runDir: null,
      ownerSessionId: null,
    });
  });
});
