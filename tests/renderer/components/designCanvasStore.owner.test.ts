import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
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

  it('claimCanvasForSession 从 null 属主认领 → 重置 + 设属主', () => {
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], runDir: '/run/a', ownerSessionId: null });
    useDesignCanvasStore.getState().claimCanvasForSession('s2');
    const st = useDesignCanvasStore.getState();
    expect(st.ownerSessionId).toBe('s2');
    expect(st.nodes).toHaveLength(0);
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
});
