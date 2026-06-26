import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionResult } from '../../../../src/host/tools/types';

const { fetchDocumentMock } = vi.hoisted(() => ({
  fetchDocumentMock: vi.fn(),
}));

vi.mock('../../../../src/host/tools/web/fetchDocument', () => ({
  fetchDocument: (...args: unknown[]) => fetchDocumentMock(...args),
}));

import { autoExtractFallback } from '../../../../src/host/tools/web/search';

describe('autoExtract primary evidence selection', () => {
  it('fetches ranked primary evidence before SEO-looking results', async () => {
    fetchDocumentMock.mockImplementation(async (url: string) => ({
      finalUrl: url,
      contentType: 'text/markdown',
      content: `# ${url}\n\n${'primary content '.repeat(20)}`,
    }));
    const searchResult: ToolExecutionResult = {
      success: true,
      output: '',
      result: {
        results: [
          {
            title: 'Best AI coding assistant 2026 - ranked list',
            url: 'https://best-tools.example.com/ai-coding-assistant-2026',
            snippet: 'Affiliate-heavy SEO result.',
            source: 'brave',
          },
          {
            title: 'OpenAI Codex documentation',
            url: 'https://developers.openai.com/codex',
            snippet: 'Official documentation for Codex.',
            source: 'exa',
          },
        ],
      },
    };

    const output = await autoExtractFallback(searchResult, 1);

    expect(fetchDocumentMock).toHaveBeenCalledTimes(1);
    expect(fetchDocumentMock).toHaveBeenCalledWith('https://developers.openai.com/codex');
    expect(output).toContain('https://developers.openai.com/codex');
  });
});
