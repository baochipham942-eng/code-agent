import { describe, expect, it, vi } from 'vitest';

import { createCLIPermissionHandler } from '../../../src/cli/permissionPolicy';
import { getDevCancellableToolPermissionHandler } from '../../../src/web/routes/devCancellableToolSmoke';

const permissionRequest = {
  type: 'dangerous_command' as const,
  tool: 'Bash',
  details: { command: 'node long-running.js' },
  sessionId: 'dev-cancellable-tool-smoke',
};

describe('dev cancellable tool smoke permission boundary', () => {
  it('allows the explicit scripted policy only inside CODE_AGENT_E2E', async () => {
    expect(getDevCancellableToolPermissionHandler(
      { approvalPolicy: 'e2e-scripted-allow' },
      { CODE_AGENT_E2E: '1' },
    )).toBeTypeOf('function');
    expect(getDevCancellableToolPermissionHandler(
      {},
      { CODE_AGENT_E2E: '1' },
    )).toBeUndefined();
    expect(getDevCancellableToolPermissionHandler(
      { approvalPolicy: 'e2e-scripted-allow' },
      {},
    )).toBeUndefined();

    const handler = getDevCancellableToolPermissionHandler(
      { approvalPolicy: 'e2e-scripted-allow' },
      { CODE_AGENT_E2E: '1' },
    );
    await expect(handler?.()).resolves.toEqual({ approved: true, approvalSource: 'scripted' });
  });

  it('keeps the non-test CLI production path fail-closed', async () => {
    const warn = vi.fn();
    const handler = createCLIPermissionHandler({ warn });

    await expect(handler(permissionRequest)).resolves.toEqual({
      approved: false,
      denialSource: 'no-approval-ui',
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});
