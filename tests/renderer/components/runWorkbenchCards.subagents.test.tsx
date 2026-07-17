import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SubagentRunRows } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

describe('SubagentRunRows', () => {
  it('renders model tags for subagent rows', () => {
    const html = renderToStaticMarkup(
      React.createElement(SubagentRunRows, {
        subagents: [
          {
            id: 'wf-1-a1',
            parentRunId: 'wf-1',
            role: 'Runtime',
            model: 'kimi-k2.5',
            status: 'running',
            inputSummary: '审计 runtime',
            lastOutput: '',
          },
        ],
      }),
    );

    expect(html).toContain('Runtime');
    expect(html).toContain('kimi-k2.5');
    expect(html).toContain('subagent-model-tag');
  });
});
