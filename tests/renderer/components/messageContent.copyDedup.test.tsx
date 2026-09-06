// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { dedupeCodeCopyLinks } from '../../../src/renderer/components/features/chat/MessageBubble/dedupeCodeCopyLinks';
import { useI18n } from '../../../src/renderer/hooks/useI18n';

const command = 'echo hello';
const fence = `\`\`\`bash\n${command}\n\`\`\``;
const copyLink = '[Copy command](!copy)';

function Labels() {
  const { t } = useI18n();
  return <span data-testid="copy-label">{t.toolDisplay.copy}</span>;
}

async function renderMessage(content: string, isStreaming = false) {
  const result = render(<><Labels /><MessageContent content={content} isUser={false} isStreaming={isStreaming} /></>);
  await waitFor(() => expect(result.container.querySelector('[data-code-block-lines]')).toBeTruthy());
  return result;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('code block copy deduplication', () => {
  it.each([
    ['immediately after', `${fence}\n${copyLink}`],
    ['one blank line after', `${fence}\n\n${copyLink}`],
    ['several blank lines after', `${fence}\n\n\n\n${copyLink}`],
    ['immediately before', `${copyLink}\n${fence}`],
    ['one blank line before', `${copyLink}\n\n${fence}`],
    ['both sides', `${copyLink}\n\n${fence}\n\n${copyLink}`],
    ['unlabelled single-line fence', `\`\`\`\n${command}\n\`\`\`\n\n${copyLink}`],
    ['tilde fence', `~~~bash\n${command}\n~~~\n\n${copyLink}`],
  ])('keeps only the header copy button: %s', async (_name, content) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      const result = await renderMessage(content);
      expect(result.queryByRole('button', { name: 'Copy command' })).toBeNull();
      const headerCopy = result.getAllByRole('button', { name: result.getByTestId('copy-label').textContent! });
      expect(headerCopy).toHaveLength(1);
      fireEvent.click(headerCopy[0]);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['prose after', `${fence}\n\nKeep this identifier.\n\n${copyLink}`],
    ['prose before', `${copyLink}\n\nRun this command.\n\n${fence}`],
    ['inline prose', `${fence}\n\nSave ${copyLink} for later.`],
    ['another container', `${fence}\n\n> ${copyLink}`],
    ['separator', `${fence}\n\n---\n\n${copyLink}`],
  ])('preserves the independent copy action: %s', async (_name, content) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      const result = await renderMessage(content);
      const independentCopy = result.getByRole('button', { name: 'Copy command' });
      fireEvent.click(independentCopy);
      expect(writeText).toHaveBeenCalledWith('Copy command');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('deduplicates across streaming block boundaries and after completion', async () => {
    const result = await renderMessage(`${copyLink}\n\n${fence}\n\n${copyLink}`, true);
    expect(result.queryByRole('button', { name: 'Copy command' })).toBeNull();
    result.rerender(<MessageContent content={`${copyLink}\n\n${fence}\n\n${copyLink}`} isUser={false} />);
    await waitFor(() => expect(result.container.querySelector('[data-code-block-lines]')).toBeTruthy());
    expect(result.queryByRole('button', { name: 'Copy command' })).toBeNull();
  });

  it('preserves copy syntax inside code and only removes the outside action', async () => {
    const result = await renderMessage(`\`\`\`text\n${copyLink}\n\`\`\`\n\n${copyLink}`);
    const block = result.container.querySelector('[data-code-block-lines]')!;
    expect(block.textContent).toContain(copyLink);
    expect(within(result.container).queryByRole('button', { name: 'Copy command' })).toBeNull();
  });

  it.each(['mermaid', 'chart', 'generative_ui', 'neo_ui', 'spreadsheet', 'document'])('preserves actions next to special %s renderers', (language) => {
    const content = `\`\`\`${language}\n{}\n\`\`\`\n\n${copyLink}`;
    expect(dedupeCodeCopyLinks(content)).toBe(content);
  });

  it('preserves standalone copy links without a code block', () => {
    expect(dedupeCodeCopyLinks(copyLink)).toBe(copyLink);
  });
});
