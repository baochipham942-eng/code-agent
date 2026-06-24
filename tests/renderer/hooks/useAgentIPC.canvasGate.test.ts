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
  useSessionStore.setState({
    currentSessionId: sessionId,
    designActiveSessions: active ? new Set([sessionId]) : new Set<string>(),
  });
}

describe('withCanvasSnapshotContext per-session gate', () => {
  beforeEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [] });
    useSessionStore.setState({ currentSessionId: null, designActiveSessions: new Set<string>() });
  });

  afterEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [] });
    useSessionStore.setState({ currentSessionId: null, designActiveSessions: new Set<string>() });
  });

  it('injects canvasSnapshot when the session is design-active and canvas has nodes', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [] });

    const result = withCanvasSnapshotContext({ workingDirectory: '/tmp' });

    expect(result?.canvasSnapshot).toBeDefined();
    expect(result?.canvasSnapshot?.nodes).toHaveLength(1);
    expect(result?.canvasSnapshot?.nodes[0]?.id).toBe('n1');
    // 原有 context 字段保留
    expect(result?.workingDirectory).toBe('/tmp');
  });

  it('does not inject when the session is not design-active even if canvas has nodes', () => {
    setDesignActive('s1', false);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [] });

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
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [] });

    const result = withCanvasSnapshotContext({});

    expect(result?.canvasSnapshot).toBeDefined();
    expect(result?.canvasSnapshot?.nodes).toHaveLength(1);
  });
});
