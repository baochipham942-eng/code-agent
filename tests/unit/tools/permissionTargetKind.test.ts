import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequestData } from '../../../src/host/tools/types';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');

describe('ToolExecutor PermissionRequest targetKind', () => {
  const definitions = new Map<string, unknown>([
    ['Write', {
      name: 'Write',
      description: 'write test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
    ['Edit', {
      name: 'Edit',
      description: 'edit test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
    ['Append', {
      name: 'Append',
      description: 'append test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
  ]);

  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  function makeExecutor(requestPermission: (request: PermissionRequestData) => Promise<boolean>, workingDirectory = '/tmp/workbench') {
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory,
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  const forceConfirm = {
    sessionId: 's1',
    skillToolBoundary: { skillName: 'test-skill', allowedTools: ['Read'] },
  };

  async function capturedRequest(filePath: string, tool = 'Write', workingDirectory?: string): Promise<PermissionRequestData> {
    const requestPermission = vi.fn<(request: PermissionRequestData) => Promise<boolean>>(async () => true);
    await makeExecutor(requestPermission, workingDirectory).execute(
      tool,
      { file_path: filePath, content: 'x' },
      forceConfirm,
    );
    expect(requestPermission).toHaveBeenCalled();
    return requestPermission.mock.calls[0]![0];
  }

  it.skipIf(process.platform === 'win32')('Append /dev/null carries targetKind device (write-through)', async () => {
    const request = await capturedRequest('/dev/null', 'Append');
    expect(request.details.targetKind).toBe('device');
  });

  it.skipIf(process.platform === 'win32')('Append through a symlink to /dev/null is device; Write replaces the link and stays regular', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'target-kind-mode-'));
    const link = path.join(dir, 'link-to-null');
    symlinkSync('/dev/null', link);
    try {
      const appendRequest = await capturedRequest(link, 'Append');
      expect(appendRequest.details.targetKind).toBe('device');
      const writeRequest2 = await capturedRequest(link);
      expect(writeRequest2.details.targetKind).toBe('regular');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('Write /dev/null carries targetKind device', async () => {
    const request = await capturedRequest('/dev/null');
    expect(request.details.targetKind).toBe('device');
  });

  it('Write missing path carries targetKind unknown, never device', async () => {
    const request = await capturedRequest('/tmp/file-target-kind-missing-xyz.md');
    expect(request.details.targetKind).toBe('unknown');
    expect(request.details.targetKind).not.toBe('device');
  });

  it('#1692 constructions are not marked device', async () => {
    const filePaths = process.platform === 'win32'
      ? ['/dev/shm/report.md', '\\dev\\null']
      : ['/dev/shm/report.md', 'NUL', '\\dev\\null'];
    for (const filePath of filePaths) {
      const request = await capturedRequest(filePath);
      expect(request.details.targetKind).not.toBe('device');
    }
  });

  it.skipIf(process.platform === 'win32')('Edit keeps literal-~ resolution (multiEdit semantics), classifier mirrors it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'target-kind-edit-tilde-'));
    const workbench = path.join(dir, 'workbench');
    mkdirSync(path.join(workbench, 'dev'), { recursive: true });
    // Edit resolves '~/../dev/null' to <workbench>/dev/null (a regular file here);
    // expanding ~ would point at a different target than Edit actually writes.
    writeFileSync(path.join(workbench, 'dev', 'null'), 'payload');
    try {
      const request = await capturedRequest('~/../dev/null', 'Edit', workbench);
      expect(request.details.targetKind).toBe('regular');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
