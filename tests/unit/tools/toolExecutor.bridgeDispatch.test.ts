import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRunContext,
  resolveCanonicalRunPath,
} from '../../../src/host/runtime/runContext';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  ToolExecutor,
  type ToolExecutionDelegate,
} from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';

describe('ToolExecutor Bridge dispatch', () => {
  let tempRoot: string;
  let permissionRequests: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-executor-bridge-'));
    permissionRequests = [];
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('runs Bridge success through permission, write isolation, and artifact persistence', async () => {
    const workspace = path.join(tempRoot, 'repo');
    await fs.mkdir(workspace, { recursive: true });
    const runContext = createRunContext({
      runId: 'run-bridge-pipeline',
      sessionId: 'session-bridge-pipeline',
      workspace,
    });
    const dispatch: ToolExecutionDelegate = vi.fn(async (_tool, _params, context) => ({
      success: true,
      output: 'bridge-write-complete',
      result: 'bridge-write-complete',
      metadata: {
        imageBase64: Buffer.alloc(64, 7).toString('base64'),
        mimeType: 'image/png',
        observedRunId: context.runId,
      },
    }));
    const baseExecutor = new ToolExecutor({
      workingDirectory: tempRoot,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return true;
      },
    });
    baseExecutor.setAuditEnabled(false);
    const executor = baseExecutor.forRun(runContext, dispatch);

    const result = await executor.execute(
      'Write',
      { file_path: 'output.txt', content: 'must be written by Bridge' },
      {
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        skillToolBoundary: { skillName: 'bridge-pipeline-test', allowedTools: [] },
      },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      type: 'file_write',
      sessionId: runContext.sessionId,
      boundary: { id: 'file.project_write' },
    });
    expect(dispatch).toHaveBeenCalledWith(
      'Write',
      expect.objectContaining({ file_path: 'output.txt' }),
      expect.objectContaining({
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        workspace: runContext.workspace,
        workingDirectory: runContext.cwd,
      }),
      expect.objectContaining({ runId: runContext.runId, sessionId: runContext.sessionId }),
    );
    expect(result).toMatchObject({
      success: true,
      metadata: {
        imageBase64Persisted: true,
        observedRunId: runContext.runId,
        writeIsolation: {
          kind: 'file',
          targetPath: resolveCanonicalRunPath(path.join(workspace, 'output.txt')),
        },
      },
    });
    await expect(fs.stat(path.join(workspace, 'output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(workspace, '.code-agent/artifacts/images'))).resolves.toMatchObject({});
  });
});
