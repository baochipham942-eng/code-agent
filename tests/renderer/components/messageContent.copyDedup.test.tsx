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
  it('keeps multiline inline code inline', async () => {
    const result = render(<MessageContent content={'Before `echo\nhello` after.'} isUser={false} />);
    await waitFor(() => expect(result.getByText('echo hello')).toBeTruthy());
    expect(result.container.querySelector('[data-code-block-lines]')).toBeNull();
  });

  it('keeps a copy header for an empty unlabelled fence', async () => {
    const result = await renderMessage(`\`\`\`\n\`\`\`\n\n${copyLink}`);
    expect(result.queryByRole('button', { name: 'Copy command' })).toBeNull();
    expect(result.getAllByRole('button', { name: result.getByTestId('copy-label').textContent! })).toHaveLength(1);
  });

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

  // 这些块一律不去重：组件里有 handleCopy 只代表「渲染成功时有按钮」，而每一种都带早退分支
  // （ChartBlock/SpreadsheetBlock/DocumentBlock/GenerativeUIBlock/MermaidDiagram 各有 return null，
  // neo_ui 走 GenerativeUIHost 根本不渲染按钮）。预处理层无法预判，宁可漏删也不能误删唯一入口。
  it.each(['mermaid', 'chart', 'generative_ui', 'neo_ui', 'spreadsheet', 'document'])('preserves actions next to special %s renderers', (language) => {
    const content = `\`\`\`${language}\n{}\n\`\`\`\n\n${copyLink}`;
    expect(dedupeCodeCopyLinks(content)).toBe(content);
  });


  it('preserves standalone copy links without a code block', () => {
    expect(dedupeCodeCopyLinks(copyLink)).toBe(copyLink);
  });

  // 以下三条来自 PR #1677 的 ai-review：它们是对**正则切分**实现提的 Important，
  // 本实现走 mdast 天然免疫，钉在这里防止有人把解析退回字符串切分。
  it('keeps two adjacent fences separate when only a copy link sits between them', () => {
    const content = `\`\`\`bash\na\n\`\`\`\n${copyLink}\n\`\`\`bash\nb\n\`\`\`\n`;
    const fenceLines = (text: string) => text.split('\n').filter(line => line.startsWith('```')).length;
    // 删除若吞掉换行，前块的结束围栏会和后块的开始围栏拼成一行，围栏行数随之减少。
    expect(fenceLines(dedupeCodeCopyLinks(content))).toBe(fenceLines(content));
  });

  it('never rewrites a copy link that lives inside a four-backtick fence', () => {
    const content = `\`\`\`\`md\n\`\`\`bash\nx\n\`\`\`\n${copyLink}\n\`\`\`\`\n`;
    expect(dedupeCodeCopyLinks(content)).toBe(content);
  });

  it('removes the duplicate action next to a tilde fence', () => {
    const content = `~~~bash\nnpm i\n~~~\n\n${copyLink}`;
    expect(dedupeCodeCopyLinks(content)).not.toContain('!copy');
  });
});
