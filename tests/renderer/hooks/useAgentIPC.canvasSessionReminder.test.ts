import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatDesignCanvasSessionReminder,
  applyDesignCanvasSessionToContent,
} from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { CanvasNode } from '../../../src/renderer/components/design/designCanvasTypes';

// R1 设计 Surface 会话化：冷启动引导。设计会话激活（即使画布空）时给 agent prepend 一段
// system-reminder，告诉它用 proposeCanvasOps / RequestDesignAutonomy 操作画布，别用 shell/python 绕开。

function makeNode(id: string): CanvasNode {
  return { id, src: `${id}.png`, x: 0, y: 0, width: 100, height: 100, createdAt: Date.now() };
}

function setDesignActive(sessionId: string, active: boolean): void {
  useSessionStore.setState({
    currentSessionId: sessionId,
    designActiveSessions: active ? new Set([sessionId]) : new Set<string>(),
  });
}

describe('formatDesignCanvasSessionReminder', () => {
  it('includes proposeCanvasOps + RequestDesignAutonomy + anti shell/python + empty wording when canvas empty', () => {
    const reminder = formatDesignCanvasSessionReminder(true);
    expect(reminder).toContain('proposeCanvasOps');
    expect(reminder).toContain('RequestDesignAutonomy');
    expect(reminder).toMatch(/shell/i);
    expect(reminder).toMatch(/python/i);
    expect(reminder).toContain('为空');
    expect(reminder).toContain('design-canvas-session');
  });

  it('uses non-empty wording when canvas has elements', () => {
    const reminder = formatDesignCanvasSessionReminder(false);
    expect(reminder).toContain('proposeCanvasOps');
    expect(reminder).toContain('RequestDesignAutonomy');
    expect(reminder).toContain('已有元素');
    expect(reminder).not.toContain('为空');
  });
});

describe('applyDesignCanvasSessionToContent', () => {
  beforeEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], ownerSessionId: null });
    useSessionStore.setState({ currentSessionId: null, designActiveSessions: new Set<string>() });
  });

  afterEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], ownerSessionId: null });
    useSessionStore.setState({ currentSessionId: null, designActiveSessions: new Set<string>() });
  });

  it('prepends reminder when session is design-active and owns the canvas, even if canvas empty', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], ownerSessionId: 's1' });

    const result = applyDesignCanvasSessionToContent('生成一张图', 's1');

    expect(result).not.toBe('生成一张图');
    expect(result).toContain('proposeCanvasOps');
    expect(result).toContain('为空');
    expect(result.endsWith('生成一张图')).toBe(true);
  });

  it('uses non-empty wording when the design-active canvas has nodes', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [], ownerSessionId: 's1' });

    const result = applyDesignCanvasSessionToContent('改一下', 's1');

    expect(result).toContain('已有元素');
    expect(result).toContain('proposeCanvasOps');
  });

  it('returns content unchanged when session is not design-active', () => {
    setDesignActive('s1', false);
    useDesignCanvasStore.setState({ nodes: [makeNode('n1')], connectors: [], shapes: [], ownerSessionId: 's1' });

    const result = applyDesignCanvasSessionToContent('hello', 's1');

    expect(result).toBe('hello');
  });

  it('returns content unchanged when canvas owner is another session (cross-session guard)', () => {
    useSessionStore.setState({
      currentSessionId: 's_B',
      designActiveSessions: new Set(['s_A', 's_B']),
    });
    useDesignCanvasStore.setState({ nodes: [makeNode('a')], connectors: [], shapes: [], ownerSessionId: 's_A' });

    const result = applyDesignCanvasSessionToContent('hello', 's_B');

    expect(result).toBe('hello');
  });

  it('returns content unchanged when sessionId is null', () => {
    const result = applyDesignCanvasSessionToContent('hello', null);
    expect(result).toBe('hello');
  });
});
