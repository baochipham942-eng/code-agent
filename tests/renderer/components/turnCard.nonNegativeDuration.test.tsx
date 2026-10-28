// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('TurnCard non-negative projected duration', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ disclosureLevel: 'standard', language: 'zh' });
  });

  it('renders 0s for a finished turn whose last node predates its user message', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: '读取并完成', timestamp: 10_000 },
      {
        id: 'assistant-old',
        role: 'assistant',
        content: '完成',
        timestamp: 9_000,
        toolCalls: [{
          id: 'read-old',
          name: 'Read',
          arguments: { file_path: '/work/notes.md' },
          result: { toolCallId: 'read-old', success: true, output: 'ok' },
        }],
      },
    ];
    const projection = projectTurns(messages, 'session-1', false);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].endTime).toBe(10_000);

    useAppStore.setState({ disclosureLevel: 'simple', language: 'zh' });
    render(<TurnCard turn={projection.turns[0]} />);

    const text = screen.getByRole('button', { name: /用时/ }).textContent ?? '';
    expect(text).not.toMatch(/-\s*\d/);
    expect(text).toBe('用时 0s');
  });
});
