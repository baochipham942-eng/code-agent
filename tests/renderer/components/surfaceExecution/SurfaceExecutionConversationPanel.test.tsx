// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurfaceExecutionConversationPanel } from '../../../../src/renderer/components/features/surfaceExecution';
import { surfaceExecutionZh } from '../../../../src/renderer/i18n/surfaceExecution';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { surfaceEvent, surfaceEvidence, surfaceScope, surfaceSession } from './fixtures';

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  vi.clearAllMocks();
});

describe('SurfaceExecutionConversationPanel', () => {
  it('keeps three concurrent sessions independently visible at conversation level', async () => {
    const managed = surfaceSession({
      id: 'managed',
      title: '旅行网站首页',
      updatedAt: 9_000,
      evidence: [surfaceEvidence('shot-managed')],
      outputs: [{ ref: 'artifact-managed', kind: 'artifact', label: '旅行网站 HTML' }],
    });
    const relayScope = surfaceScope('relay');
    const relay = surfaceSession({
      id: 'relay',
      title: '订单确认页',
      provider: 'relay',
      state: 'waiting_human',
      updatedAt: 8_000,
      events: [surfaceEvent(relayScope, {
        provider: 'relay',
        sessionState: 'waiting_human',
        phase: 'human',
        status: 'waiting',
        userSummary: '请完成验证码后继续',
      })],
      outputs: [{ ref: 'download-relay', kind: 'download', label: '订单回执' }],
    });
    const computerScope = surfaceScope('computer');
    const computer = surfaceSession({
      id: 'computer',
      title: '预览窗口',
      surface: 'computer',
      provider: 'native-cua',
      state: 'failed',
      updatedAt: 7_000,
      events: [surfaceEvent(computerScope, {
        surface: 'computer',
        provider: 'native-cua',
        sessionState: 'failed',
        phase: 'recover',
        status: 'running',
        userSummary: '正在重新连接预览窗口',
      })],
      outputs: [{ ref: 'file-computer', kind: 'file', label: '最终截图 PNG' }],
    });
    const onControl = vi.fn().mockResolvedValue(undefined);

    const view = render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[managed, relay, computer]}
        translations={surfaceExecutionZh}
        now={10_000}
        onControl={onControl}
      />,
    );

    expect(screen.getByTestId('surface-execution-conversation-panel').getAttribute('data-placement')).toBe('conversation');
    expect(screen.getAllByTestId('surface-execution-session')).toHaveLength(3);
    expect(screen.getByText('3 个执行会话')).toBeTruthy();
    expect(view.container.textContent).toContain('旅行网站首页');
    expect(view.container.textContent).toContain('订单确认页');
    expect(view.container.textContent).toContain('Preview · 预览窗口');
    expect(view.container.textContent).toContain('旅行网站 HTML');
    expect(view.container.textContent).toContain('订单回执');
    expect(view.container.textContent).toContain('最终截图 PNG');
    expect(screen.getByTestId('surface-human-takeover-card')).toBeTruthy();
    expect(screen.getByTestId('surface-recovery-card')).toBeTruthy();
    expect(screen.getAllByTestId('surface-evidence-list')[0].getAttribute('data-persistence')).toBe('conversation');
    expect(screen.getAllByTestId('surface-resources')[0].getAttribute('data-persistence')).toBe('conversation');

    const managedCard = screen.getByRole('heading', { level: 3, name: /旅行网站首页/ }).closest('article');
    expect(managedCard).not.toBeNull();
    fireEvent.click(within(managedCard!).getByRole('button', { name: /^暂停:/ }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-managed',
      action: 'pause',
    }));
  });

  it('forces compatibility projections to remain read-only even if controls are present', () => {
    const compatibility = surfaceSession({
      id: 'compat',
      title: '旧会话页面',
      source: 'compat',
      writable: false,
    });
    compatibility.availableControls = ['pause', 'takeover', 'stop'];
    compatibility.events[0].availableControls = ['pause', 'stop'];
    const onControl = vi.fn();

    render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[compatibility]}
        translations={surfaceExecutionZh}
        onControl={onControl}
      />,
    );

    expect(screen.getByText('历史兼容记录')).toBeTruthy();
    expect(screen.getByTestId('surface-controls').getAttribute('data-readonly')).toBe('true');
    expect(screen.queryByRole('button', { name: /^暂停:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^我来操作:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^停止:/ })).toBeNull();
    expect(onControl).not.toHaveBeenCalled();
  });

  it('filters wrong-conversation sessions and wrong-owner events before rendering', () => {
    const owner = surfaceSession({ id: 'owner', title: 'Owner target' });
    const foreignScope = surfaceScope('foreign', 'conversation-2');
    owner.events.push(surfaceEvent(foreignScope, { userSummary: 'Foreign event must stay hidden' }));

    const { rerender } = render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[owner, surfaceSession({ id: 'foreign', conversationId: 'conversation-2' })]}
        translations={surfaceExecutionZh}
      />,
    );

    expect(screen.getAllByTestId('surface-execution-session')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 3, name: /Owner target/ })).toBeTruthy();
    expect(screen.queryByText('Foreign event must stay hidden')).toBeNull();

    rerender(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        projection={{
          version: 1,
          conversationId: 'conversation-2',
          sessions: [owner],
          mode: 'native',
          updatedAt: 10,
        }}
        translations={surfaceExecutionZh}
      />,
    );
    expect(screen.queryByTestId('surface-execution-conversation-panel')).toBeNull();
  });

  it('never renders internal refs, raw operations, selectors, grant ids, paths, or binary evidence', () => {
    const session = surfaceSession({
      id: 'safe',
      title: 'Safe target',
      provider: 'browser_action selector=#password',
      evidence: [surfaceEvidence('grant-raw-evidence', {
        assetRef: 'data:image/png;base64,surface-secret-canary-asset',
      })],
      outputs: [{ ref: '/Users/linchen/private/secret.png', kind: 'file', label: 'Safe result' }],
    });
    session.events[0].operation = {
      action: 'browser_action',
      risk: 'selector=#password',
      approvalScope: 'grantId=grant-raw',
      expectedOutcome: '{"selector":"#password"}',
    };
    Object.assign(session.events[0], { reasoning: 'private model chain of thought' });
    if (session.session.activeTarget?.kind === 'browser') {
      session.session.activeTarget.origin = 'https://surface-secret-canary-domain.example/private';
    }
    Object.assign(session.session, { grantId: 'grant-raw' });

    const view = render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[session]}
        translations={surfaceExecutionZh}
      />,
    );
    const html = view.container.innerHTML;

    expect(view.container.textContent).toContain('Safe target');
    expect(view.container.textContent).toContain('Safe result');
    expect(html).not.toContain('browser_action');
    expect(html).not.toContain('#password');
    expect(html).not.toContain('grant-raw');
    expect(html).not.toContain('tab-safe');
    expect(html).not.toContain('/Users/linchen');
    expect(html).not.toContain('surface-secret-canary');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('private model chain of thought');
  });

  it('uses the standalone English surface-execution dictionary', () => {
    useAppStore.setState({ language: 'en' });
    render(
      <SurfaceExecutionConversationPanel
        conversationId="conversation-1"
        sessions={[surfaceSession({ id: 'english', title: 'Checkout page' })]}
      />,
    );

    expect(screen.getByRole('region', { name: 'Surface execution' })).toBeTruthy();
    expect(screen.getByText('Live execution ledger')).toBeTruthy();
    expect(screen.getByText('Permission scope')).toBeTruthy();
    expect(screen.getByText('Execution timeline')).toBeTruthy();
  });
});
