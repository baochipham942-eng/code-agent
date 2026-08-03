// @vitest-environment jsdom
// 产品拍板（2026-08-02）：用户点聊天正文链接开出来的那扇窗**不是「agent 在干活」**——
// 不进对话流卡片、不点亮侧栏圆点；但它必须照常进右栏 workbench 的投影，那才是它该在的地方。
// 这条规则的两半缺一不可：只测「不出现」会把「整个功能被滤没了」也判成通过。
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceExecutionConversationPanel } from '../../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionConversationPanel';
import { useSurfaceExecutionRunSession } from '../../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionRunStatus';
import {
  selectActiveBrowserSurfaceSessionV1,
  selectSurfaceExecutionRunSessionV1,
  useSurfaceExecutionStore,
} from '../../../../src/renderer/stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../../../../src/renderer/utils/surfaceExecutionProjection';
import type { RendererSurfaceSessionProjectionV1 } from '../../../../src/renderer/utils/surfaceExecutionProjection';
import { surfaceSession } from './fixtures';

vi.mock('../../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const CONVERSATION = 'conversation-user-link';

/** 用户拥有的轻量 run 开出来的 surface：scope 与 session 两侧 agentId 必须一致，否则不过归属校验。 */
function userOpenedSession(): RendererSurfaceSessionProjectionV1 {
  const base = surfaceSession({ id: 'user-link', conversationId: CONVERSATION, state: 'running' });
  base.scope = { ...base.scope, agentId: SURFACE_USER_BROWSER_AGENT_ID };
  base.session = { ...base.session, agentId: SURFACE_USER_BROWSER_AGENT_ID };
  return base;
}

function agentSession(): RendererSurfaceSessionProjectionV1 {
  return surfaceSession({ id: 'agent-run', conversationId: CONVERSATION, state: 'running' });
}

function putSessions(...sessions: RendererSurfaceSessionProjectionV1[]): void {
  act(() => {
    useSurfaceExecutionStore.setState({
      sessionsByScope: Object.fromEntries(sessions.map((session) => [
        surfaceExecutionScopeKeyV1(session.scope),
        session,
      ])),
    });
  });
}

function SidebarDotProbe() {
  const session = useSurfaceExecutionRunSession(CONVERSATION);
  return <span data-testid="dot-probe">{session ? session.scope.agentId : 'none'}</span>;
}

beforeEach(() => useSurfaceExecutionStore.getState().reset());
afterEach(() => {
  cleanup();
  useSurfaceExecutionStore.getState().reset();
});

describe('用户点链接开的 surface 不算「agent 在干活」', () => {
  it('不进对话流卡片，而同会话里 agent 自己的 surface 照常进', () => {
    const user = userOpenedSession();
    const agent = agentSession();
    const { rerender } = render(
      <SurfaceExecutionConversationPanel conversationId={CONVERSATION} sessions={[user]} />,
    );
    // 只有用户那扇窗时，整块面板不该出现（没有可报的 agent 工作）
    expect(screen.queryByTestId('surface-execution-conversation-panel')).toBeNull();

    rerender(
      <SurfaceExecutionConversationPanel conversationId={CONVERSATION} sessions={[user, agent]} />,
    );
    // agent 那扇窗必须还在——否则就是把功能整个滤没了
    expect(screen.getByText(/Target agent-run|agent-run/)).toBeTruthy();
  });

  it('不点亮侧栏圆点，但 agent 的 surface 依然点亮', async () => {
    putSessions(userOpenedSession());
    render(<SidebarDotProbe />);
    await waitFor(() => expect(screen.getByTestId('dot-probe').textContent).toBe('none'));

    putSessions(userOpenedSession(), agentSession());
    await waitFor(() => expect(screen.getByTestId('dot-probe').textContent).toBe('agent-agent-run'));
  });

  it('仍然照常进右栏投影——右栏用的是另一条 selector，不许被这条规则波及', () => {
    const user = userOpenedSession();
    const byScope = { [surfaceExecutionScopeKeyV1(user.scope)]: user };

    // 右栏实时帧走这条
    expect(selectActiveBrowserSurfaceSessionV1(byScope, CONVERSATION)).toBe(user);
    // 右栏终态留影走这条（BrowserAgentWindow 的 displaySurfaceSession）
    expect(selectSurfaceExecutionRunSessionV1(byScope, { conversationId: CONVERSATION })).toBe(user);
  });
});
