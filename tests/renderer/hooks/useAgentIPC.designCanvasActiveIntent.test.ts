import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withDesignCanvasActiveIntent } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useWorkspaceModeStore } from '../../../src/renderer/stores/workspaceModeStore';
import type { ConversationEnvelopeContext } from '../../../src/shared/contract/conversationEnvelope';

// 2b 跨进程硬控：设计模式（workspaceMode==='design'）激活时，在 envelope.executionIntent 上打
// designCanvasActive=true，main 侧据此把画布工具提进工具表 + shell 硬拦代码画图 + 注入会话引导。
// 适配 main：main 的设计 surface 是全局 workspaceMode（无 per-session 画布属主），口径与
// withCanvasSnapshotContext 一致。

describe('withDesignCanvasActiveIntent（设计模式 → designCanvasActive）', () => {
  beforeEach(() => {
    useWorkspaceModeStore.setState({ workspaceMode: 'code' });
  });
  afterEach(() => {
    useWorkspaceModeStore.setState({ workspaceMode: 'code' });
  });

  it('workspaceMode==="design" → designCanvasActive=true，且保留原有 context 字段', () => {
    useWorkspaceModeStore.setState({ workspaceMode: 'design' });
    const result = withDesignCanvasActiveIntent({ workingDirectory: '/tmp' });
    expect(result?.executionIntent?.designCanvasActive).toBe(true);
    expect(result?.workingDirectory).toBe('/tmp');
  });

  it('workspaceMode==="code"（普通会话）→ designCanvasActive=false', () => {
    useWorkspaceModeStore.setState({ workspaceMode: 'code' });
    const result = withDesignCanvasActiveIntent({});
    expect(result?.executionIntent?.designCanvasActive).toBe(false);
  });

  it('合并进已有 executionIntent，不覆盖其它字段（browserSessionMode 等）', () => {
    useWorkspaceModeStore.setState({ workspaceMode: 'design' });
    const context: ConversationEnvelopeContext = {
      executionIntent: { browserSessionMode: 'managed', preferBrowserSession: true },
    };
    const result = withDesignCanvasActiveIntent(context);
    expect(result?.executionIntent?.designCanvasActive).toBe(true);
    expect(result?.executionIntent?.browserSessionMode).toBe('managed');
    expect(result?.executionIntent?.preferBrowserSession).toBe(true);
  });

  it('context 为 undefined → 返回仅含 executionIntent 的对象', () => {
    useWorkspaceModeStore.setState({ workspaceMode: 'design' });
    const result = withDesignCanvasActiveIntent(undefined);
    expect(result?.executionIntent?.designCanvasActive).toBe(true);
  });
});
