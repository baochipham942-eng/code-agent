import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withDesignCanvasActiveIntent } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { ConversationEnvelopeContext } from '../../../src/shared/contract/conversationEnvelope';

// R1（设计 Surface 会话化）跨进程硬控：设计会话激活 + 画布属主==当前会话时，
// 在 envelope.executionIntent 上打 designCanvasActive=true，main 侧 shell 据此硬拦代码画图。
// 闸口径与 withCanvasSnapshotContext 完全一致（per-session 设计激活 + 画布属主）。

function setDesignActive(sessionId: string, active: boolean): void {
  useSessionStore.setState({ currentSessionId: sessionId });
  useDesignCanvasStore.setState({
    designActiveSessions: active ? new Set([sessionId]) : new Set<string>(),
  });
}

describe('withDesignCanvasActiveIntent', () => {
  beforeEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], ownerSessionId: null, designActiveSessions: new Set<string>() });
    useSessionStore.setState({ currentSessionId: null });
  });

  afterEach(() => {
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], ownerSessionId: null, designActiveSessions: new Set<string>() });
    useSessionStore.setState({ currentSessionId: null });
  });

  it('sets designCanvasActive=true when session is design-active and owns the canvas', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ ownerSessionId: 's1' });

    const result = withDesignCanvasActiveIntent({ workingDirectory: '/tmp' }, 's1');

    expect(result?.executionIntent?.designCanvasActive).toBe(true);
    // 原有 context 字段保留
    expect(result?.workingDirectory).toBe('/tmp');
  });

  it('sets designCanvasActive=false when the session is not design-active', () => {
    setDesignActive('s1', false);
    useDesignCanvasStore.setState({ ownerSessionId: 's1' });

    const result = withDesignCanvasActiveIntent({}, 's1');

    expect(result?.executionIntent?.designCanvasActive).toBe(false);
  });

  it('sets designCanvasActive=false when canvas owner is another session (cross-session leak guard)', () => {
    useSessionStore.setState({ currentSessionId: 's_B' });
    useDesignCanvasStore.setState({ ownerSessionId: 's_A', designActiveSessions: new Set(['s_A', 's_B']) });

    const result = withDesignCanvasActiveIntent({}, 's_B');

    expect(result?.executionIntent?.designCanvasActive).toBe(false);
  });

  it('sets designCanvasActive=false when sessionId is null/undefined', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ ownerSessionId: 's1' });

    expect(withDesignCanvasActiveIntent({}, null)?.executionIntent?.designCanvasActive).toBe(false);
    expect(withDesignCanvasActiveIntent({}, undefined)?.executionIntent?.designCanvasActive).toBe(false);
  });

  it('merges into existing executionIntent without clobbering other fields', () => {
    setDesignActive('s1', true);
    useDesignCanvasStore.setState({ ownerSessionId: 's1' });

    const context: ConversationEnvelopeContext = {
      executionIntent: { browserSessionMode: 'managed', preferBrowserSession: true },
    };
    const result = withDesignCanvasActiveIntent(context, 's1');

    expect(result?.executionIntent?.designCanvasActive).toBe(true);
    expect(result?.executionIntent?.browserSessionMode).toBe('managed');
    expect(result?.executionIntent?.preferBrowserSession).toBe(true);
  });
});
