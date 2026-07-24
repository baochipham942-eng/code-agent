// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpServerEditor,
  isSensitiveMcpCredentialKey,
  type McpServerConfig,
} from '../../../src/renderer/components/features/settings/McpServerEditor';
import { MCP_SECRET_REF_PREFIX } from '../../../src/shared/constants';

const renderEditor = (
  initialConfig: Partial<McpServerConfig>,
  onSave = vi.fn(),
) => {
  const result = render(
    <McpServerEditor
      isOpen
      onClose={vi.fn()}
      onSave={onSave}
      initialConfig={initialConfig}
    />,
  );
  return { ...result, onSave };
};

const saveEditor = () => {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
};

afterEach(() => {
  cleanup();
});

describe('McpServerEditor credential fields', () => {
  it('detects sensitive MCP env and header keys', () => {
    expect(isSensitiveMcpCredentialKey('API_KEY')).toBe(true);
    expect(isSensitiveMcpCredentialKey('Authorization')).toBe(true);
    expect(isSensitiveMcpCredentialKey('x-bearer-token')).toBe(true);
    expect(isSensitiveMcpCredentialKey('BASE_URL')).toBe(false);
  });

  it('passes only sensitive env keys to onSave in form mode', () => {
    const { container, onSave } = renderEditor({
      name: 'github',
      type: 'stdio',
      command: 'npx',
      env: {
        API_KEY: 'sk-test-secret',
        BASE_URL: 'https://api.example.test',
      },
    });
    const passwordInput = container.querySelector<HTMLInputElement>('input[type="password"]');

    expect(passwordInput?.value).toBe('sk-test-secret');
    saveEditor();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          API_KEY: 'sk-test-secret',
          BASE_URL: 'https://api.example.test',
        },
      }),
      {
        secretEnvKeys: ['API_KEY'],
        secretHeaderKeys: [],
      },
    );
  });

  it('passes only sensitive header keys to onSave in form mode', () => {
    const { onSave } = renderEditor({
      name: 'remote-docs',
      type: 'http',
      url: 'https://mcp.example.test',
      headers: {
        Authorization: 'Bearer test-token',
        Accept: 'application/json',
      },
    });

    saveEditor();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token',
          Accept: 'application/json',
        },
      }),
      {
        secretEnvKeys: [],
        secretHeaderKeys: ['Authorization'],
      },
    );
  });

  it('detects sensitive env keys entered in JSON mode', () => {
    const { onSave } = renderEditor({
      name: 'json-server',
      type: 'stdio',
      command: 'node',
    });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'JSON' }));
    fireEvent.change(dialog.querySelector('textarea') as HTMLTextAreaElement, {
      target: {
        value: JSON.stringify({
          name: 'json-server',
          type: 'stdio',
          command: 'node',
          env: {
            ACCESS_TOKEN: 'json-secret',
            BASE_URL: 'https://api.example.test',
          },
        }),
      },
    });

    saveEditor();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          ACCESS_TOKEN: 'json-secret',
          BASE_URL: 'https://api.example.test',
        },
      }),
      {
        secretEnvKeys: ['ACCESS_TOKEN'],
        secretHeaderKeys: [],
      },
    );
  });

  it('omits the secrets argument when no sensitive keys exist', () => {
    const { onSave } = renderEditor({
      name: 'public-server',
      type: 'stdio',
      command: 'node',
      env: {
        BASE_URL: 'https://api.example.test',
      },
    });

    saveEditor();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]).toHaveLength(1);
  });

  it('does not expose a saved secureref value in the credential input', () => {
    const secretReference = `${MCP_SECRET_REF_PREFIX}mcp_feishu.APP_SECRET`;
    const { container } = renderEditor({
      name: 'feishu',
      type: 'stdio',
      command: 'npx',
      env: {
        APP_SECRET: secretReference,
      },
    });
    const keyInput = Array.from(container.querySelectorAll('input')).find(
      (input) => input.value === 'APP_SECRET',
    );
    const valueInput = keyInput?.parentElement?.querySelector<HTMLInputElement>('input[type="password"]');

    expect(valueInput).toBeTruthy();
    expect(valueInput?.value).toBe('');
    expect(valueInput?.value).not.toBe(secretReference);
    expect(valueInput?.placeholder).toBe('••••••••');
    expect(screen.getByText('已保存 · 留空即保留')).toBeTruthy();
  });

  it('retains an untouched secureref and excludes it from secretEnvKeys', () => {
    const secretReference = `${MCP_SECRET_REF_PREFIX}mcp_feishu.APP_SECRET`;
    const { onSave } = renderEditor({
      name: 'feishu',
      type: 'stdio',
      command: 'npx',
      env: {
        APP_SECRET: secretReference,
      },
    });

    saveEditor();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          APP_SECRET: secretReference,
        },
      }),
    );
    expect(onSave.mock.calls[0]).toHaveLength(1);
  });
});
