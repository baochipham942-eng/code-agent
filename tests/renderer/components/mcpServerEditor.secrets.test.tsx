import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  McpServerEditor,
  isSensitiveMcpCredentialKey,
} from '../../../src/renderer/components/features/settings/McpServerEditor';

describe('McpServerEditor credential fields', () => {
  it('detects sensitive MCP env and header keys', () => {
    expect(isSensitiveMcpCredentialKey('API_KEY')).toBe(true);
    expect(isSensitiveMcpCredentialKey('Authorization')).toBe(true);
    expect(isSensitiveMcpCredentialKey('x-bearer-token')).toBe(true);
    expect(isSensitiveMcpCredentialKey('BASE_URL')).toBe(false);
  });

  it('masks sensitive env values by default in the form view', () => {
    const html = renderToStaticMarkup(
      React.createElement(McpServerEditor, {
        isOpen: true,
        onClose: vi.fn(),
        onSave: vi.fn(),
        initialConfig: {
          name: 'github',
          type: 'stdio',
          command: 'npx',
          env: {
            API_KEY: 'sk-test-secret',
            BASE_URL: 'https://api.example.test',
          },
        },
      }),
    );

    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="显示敏感值"');
    expect(html).toContain('type="text"');
  });
});
