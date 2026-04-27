import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplayMessageBlock } from '../../../src/renderer/components/features/evalCenter/ReplayMessageBlock';

describe('ReplayMessageBlock observability evidence', () => {
  it('renders tool schema and permission trace evidence in collapsed tool calls', () => {
    const html = renderToStaticMarkup(React.createElement(ReplayMessageBlock, {
      block: {
        type: 'tool_call',
        content: 'read_file',
        timestamp: 1,
        toolCall: {
          id: 'tool-read-1',
          name: 'read_file',
          args: { file_path: 'src/main.ts' },
          argsSource: 'telemetry_actual',
          toolSchema: {
            name: 'read_file',
            inputSchema: { type: 'object' },
            requiresPermission: false,
            permissionLevel: 'read',
          },
          permissionTrace: [
            {
              eventType: 'permission_denied',
              summary: 'Denied once before approval',
              timestamp: 2,
            },
          ],
          result: 'ok',
          success: true,
          duration: 8,
          category: 'Read',
        },
      },
    }));

    expect(html).toContain('args: actual telemetry');
    expect(html).toContain('schema: read_file/read/no-permission');
    expect(html).toContain('permission: permission_denied Denied once before approval');
  });

  it('renders model decision schema count', () => {
    const html = renderToStaticMarkup(React.createElement(ReplayMessageBlock, {
      block: {
        type: 'model_call',
        content: 'mock/gpt-test: tool_use',
        timestamp: 1,
        modelDecision: {
          provider: 'mock',
          model: 'gpt-test',
          responseType: 'tool_use',
          toolCallCount: 1,
          latencyMs: 12,
          toolSchemas: [{ name: 'read_file' }],
        },
      },
    }));

    expect(html).toContain('mock/gpt-test');
    expect(html).toContain('response: tool_use');
    expect(html).toContain('schemas: 1');
  });
});
