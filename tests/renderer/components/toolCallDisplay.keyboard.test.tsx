// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';

const openPreview = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/appStore', () => {
  const state = {
    processingSessionIds: new Set<string>(),
    openPreview,
    workingDirectory: '/repo',
    language: 'en' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  };
  return {
    useAppStore: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-1' }),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'Read',
    arguments: { file_path: '/repo/readme.md' },
    result: { toolCallId: 'tool-1', success: true, output: 'done' },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  openPreview.mockReset();
});

describe('ToolCallDisplay keyboard interaction', () => {
  it('puts the row in the Tab order and toggles aria-expanded with Enter and Space', () => {
    const { getByTestId } = render(
      <ToolCallDisplay toolCall={makeToolCall()} index={0} total={1} />,
    );
    const row = getByTestId('tool-call-row-Read');

    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('aria-expanded')).toBe('false');

    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(row, { key: ' ' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('reveals the collapsed result summary when focus is within the tool group', () => {
    const { container } = render(
      <ToolCallDisplay toolCall={makeToolCall()} index={0} total={1} />,
    );

    expect(container.querySelector('.group-focus-within\\:opacity-100')).toBeTruthy();
  });

  it('keeps the nested Write file button isolated from row activation', () => {
    const { getByTestId, getByTitle } = render(
      <ToolCallDisplay
        toolCall={makeToolCall({
          name: 'Write',
          arguments: { file_path: '/repo/output.txt' },
          result: {
            toolCallId: 'tool-1',
            success: true,
            output: 'Created file: /repo/output.txt',
          },
        })}
        index={0}
        total={1}
      />,
    );
    const row = getByTestId('tool-call-row-Write');
    const fileButton = getByTitle('/repo/output.txt');

    fireEvent.click(fileButton);
    fireEvent.keyDown(fileButton, { key: 'Enter' });

    expect(openPreview).toHaveBeenCalledWith('/repo/output.txt');
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });
});
