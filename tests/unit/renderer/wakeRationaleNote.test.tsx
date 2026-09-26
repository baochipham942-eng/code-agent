// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageMetadata } from '../../../src/shared/contract/message';
import {
  WakeRationaleNote,
  wakeRationaleFromMetadata,
} from '../../../src/renderer/components/features/chat/WakeRationaleNote';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      wakeRationale: {
        why: '为什么',
        whyAria: '为什么推荐这条',
        missing: '这条没有记录理由',
        evidenceLabel: '依据',
      },
    },
  }),
}));

afterEach(() => cleanup());

describe('wakeRationaleFromMetadata', () => {
  it('prefers wakeRationale metadata', () => {
    expect(wakeRationaleFromMetadata({
      wakeRationale: { rationale: '该跟进周报', evidence: 'history.md', missing: false },
    })).toEqual({ rationale: '该跟进周报', evidence: 'history.md', missing: false });
  });

  it('maps role_wake result notices; created notices without fields stay hidden', () => {
    const automation: MessageMetadata = {
      automation: {
        automationId: 'role_wake:s1',
        automationType: 'role_wake',
        event: 'created',
        sourceSessionId: 'src',
      },
    };
    expect(wakeRationaleFromMetadata(automation)).toBeNull();
    expect(wakeRationaleFromMetadata({
      automation: {
        ...automation.automation!,
        event: 'completed',
        rationaleMissing: true,
      },
    })?.missing).toBe(true);
    expect(wakeRationaleFromMetadata({
      automation: {
        ...automation.automation!,
        event: 'completed',
        rationale: '该提醒',
        evidence: 'a.md',
        rationaleMissing: false,
      },
    })).toEqual({ rationale: '该提醒', evidence: 'a.md', missing: false });
  });

  it('ignores unrelated messages', () => {
    expect(wakeRationaleFromMetadata({ automation: {
      automationId: 'cron:1',
      automationType: 'cron',
      event: 'created',
      sourceSessionId: 'src',
    } })).toBeNull();
  });
});

describe('WakeRationaleNote', () => {
  it('expands to show recorded rationale and evidence', () => {
    render(<WakeRationaleNote fields={{ rationale: '周报两周没更新。', evidence: 'history.md', missing: false }} />);
    expect(screen.queryByTestId('wake-rationale-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('wake-rationale-why'));
    expect(screen.getByTestId('wake-rationale-text').textContent).toBe('周报两周没更新。');
    expect(screen.getByTestId('wake-rationale-evidence').textContent).toContain('history.md');
  });

  it('expands to the missing copy and does not invent a reason', () => {
    render(<WakeRationaleNote fields={{ missing: true }} />);
    fireEvent.click(screen.getByTestId('wake-rationale-why'));
    expect(screen.getByTestId('wake-rationale-missing').textContent).toBe('这条没有记录理由');
    expect(screen.queryByTestId('wake-rationale-text')).toBeNull();
  });
});
