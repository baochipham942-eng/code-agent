import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';

describe('ToolExecutor 解析失败会话粘性 fail-closed', () => {
  let workspace: string;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    resetPermissionModeManager();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'command-analysis-sticky-'));
  });

  afterEach(async () => {
    resetPermissionModeManager();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('同指纹第二次在 permission_request 边界前拒绝，不同会话仍独立首报', async () => {
    const permissionEvents: PermissionRequestData[] = [];
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionEvents.push(request);
        return true;
      },
    });
    executor.setAuditEnabled(false);
    const command = "printf 'unterminated";

    const first = await executor.execute('Bash', { command }, { sessionId: 'sticky-session-a' });
    expect(first).toMatchObject({ success: false });
    expect(first.error).toContain('不能从当前会话审批放行');
    expect(permissionEvents).toHaveLength(1);

    const repeated = await executor.execute('Bash', { command }, { sessionId: 'sticky-session-a' });
    expect(repeated).toMatchObject({
      success: false,
      metadata: { code: 'COMMAND_ANALYSIS_STICKY_DENY' },
    });
    expect(permissionEvents).toHaveLength(1);

    const otherSession = await executor.execute('Bash', { command }, { sessionId: 'sticky-session-b' });
    expect(otherSession).toMatchObject({ success: false });
    expect(permissionEvents).toHaveLength(2);
  });
});
