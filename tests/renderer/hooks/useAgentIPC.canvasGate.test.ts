import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withCanvasSnapshotContext } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import { useWorkspaceModeStore } from '../../../src/renderer/stores/workspaceModeStore';
import type { CanvasNode } from '../../../src/renderer/components/design/designCanvasTypes';

// R1（设计 Surface 会话化）：画布注入闸从全局 workspaceMode 解绑，改为 per-session
// 设计激活（isSessionDesignActive）。这组测试只验证「闸门逻辑」——设计会话 + 画布非空才注入，
// 不污染普通编码会话。

function makeNode(id: string): CanvasNode {
  return {
    id,
    src: `${id}.png`,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    createdAt: Date.now(),
  };
}

function setDesignActive(sessionId: string, active: boolean): void {
  useSessionStore.setState({ currentSessionId: sessionId });
  useDesignCanvasStore.setState({
    designActiveSessions: active ? new Set([sessionId]) : new Set<string>(),
  });
}

describe('withCanvasSnapshotContext per-session gate', () => {
  beforeEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], ownerSessionId: null, designActiveSessions: new Set<string>() });
    useSessionStore.setState({ currentSessionId: null });
  });

  afterEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], ownerSessionId: null, designActiveSessions: new Set<string>() });
    useSessionStore.setState({ currentSessionId: null });
  });

  it('injects canvasSnapshot when the session is design-active and owns the canvas', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [], ownerSessionId: 's1' });

    const result = withCanvasSnapshotContext({ workingDirectory: '/tmp' });

    expect(result?.canvasSnapshot).toBeDefined();
    expect(result?.canvasSnapshot?.nodes).toHaveLength(1);
    expect(result?.canvasSnapshot?.nodes[0]?.id).toBe('n1');
    // 原有 context 字段保留
    expect(result?.workingDirectory).toBe('/tmp');
  });

  it('does not inject when the session is not design-active even if canvas has nodes', () => {
    setDesignActive('s1', false);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [], ownerSessionId: 's1' });

    const context = { workingDirectory: '/tmp' };
    const result = withCanvasSnapshotContext(context);

    expect(result).toBe(context);
    expect(result?.canvasSnapshot).toBeUndefined();
  });

  it('does not inject when the session is design-active but the canvas is empty', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [] });

    const context = { workingDirectory: '/tmp' };
    const result = withCanvasSnapshotContext(context);

    expect(result).toBe(context);
    expect(result?.canvasSnapshot).toBeUndefined();
  });

  it('no longer depends on workspaceMode: injects when session is design-active even if workspaceMode is "code"', () => {
    useWorkspaceModeStore.setState({ workspaceMode: 'code' });
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [], ownerSessionId: 's1' });

    const result = withCanvasSnapshotContext({});

    expect(result?.canvasSnapshot).toBeDefined();
    expect(result?.canvasSnapshot?.nodes).toHaveLength(1);
  });

  // H1 回归核心：会话 A 设计激活并拥有画布，切到同样设计激活的会话 B（画布未重载，
  // 属主仍是 A）→ 严格属主闸应拒绝注入，防止把 A 的画布泄漏进 B 的 agent 上下文。
  it('does not inject when current session is design-active but canvas owner is another session (cross-session leak guard)', () => {
    // currentSession = B, B 设计激活；但画布属主是 A，节点是 A 的。
    useSessionStore.setState({
      currentSessionId: 's_B',
      designActiveSessions: new Set(['s_A', 's_B']),
    });
    useDesignCanvasStore.setState({
      nodes: [makeNode('a_node')],
      connectors: [],
      shapes: [],
      ownerSessionId: 's_A',
    });

    const context = { workingDirectory: '/tmp' };
    const result = withCanvasSnapshotContext(context);

    expect(result).toBe(context);
    expect(result?.canvasSnapshot).toBeUndefined();
  });

  it('does not inject when ownerSessionId is null even if session is design-active with nodes (fail-closed)', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [], ownerSessionId: null });

    const context = { workingDirectory: '/tmp' };
    const result = withCanvasSnapshotContext(context);

    expect(result).toBe(context);
    expect(result?.canvasSnapshot).toBeUndefined();
  });
});
