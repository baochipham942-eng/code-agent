// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const BODY = [
  '可见正文',
  '<cron_snapshot>',
  'SECRET_SNAPSHOT',
  '</cron_snapshot>',
  '<cron_alert>',
  '新发现的冲突',
  '</cron_alert>',
  '<cron_summary>',
  'urgency: fyi',
  '本周汇总完成',
  'artifact: report.md',
  '</cron_summary>',
].join('\n');

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: [], currentSessionId: null });
});

function mount(kind: 'cron' | 'heartbeat' | 'manual') {
  useSessionStore.setState({
    currentSessionId: 'run-1',
    sessions: [{
      id: 'run-1',
      origin: { kind, id: 'job-1' },
      workingDirectory: '/work/run',
    } as never],
  });
  return render(
    <MessageContent
      content={BODY}
      isUser={false}
      messageId="assistant-1"
      mediaContext={{ sessionId: 'run-1' }}
    />,
  );
}

describe('cron run session machine headers', () => {
  it('renders a summary card for cron and heartbeat sessions and hides raw tags', async () => {
    for (const kind of ['cron', 'heartbeat'] as const) {
      const view = mount(kind);
      await waitFor(() => {
        expect(screen.getByTestId('cron-run-summary')).toBeTruthy();
      });
      expect(screen.getByTestId('cron-run-summary').textContent).toContain('本次运行摘要');
      expect(screen.getByTestId('cron-run-summary').textContent).toContain('本周汇总完成');
      expect(screen.getByTestId('cron-alert-body').textContent).toContain('新发现的冲突');
      expect(screen.getByText('可见正文')).toBeTruthy();
      const open = screen.getByTestId('cron-artifact-open');
      expect(open.textContent).toContain('report.md');
      expect(open.getAttribute('title')).toBe('/work/run/report.md');
      expect(view.container.textContent).not.toContain('SECRET_SNAPSHOT');
      expect(view.container.textContent).not.toContain('urgency:');
      expect(view.container.textContent).not.toContain('<cron_');
      view.unmount();
    }
  });

  it('leaves the tags in place for a session that is not a cron or heartbeat run', async () => {
    const view = mount('manual');
    await waitFor(() => {
      expect(view.container.textContent).toContain('可见正文');
    });
    expect(screen.queryByTestId('cron-run-summary')).toBeNull();
    expect(view.container.textContent).toContain('SECRET_SNAPSHOT');
    expect(view.container.textContent).toContain('urgency: fyi');
  });
});
