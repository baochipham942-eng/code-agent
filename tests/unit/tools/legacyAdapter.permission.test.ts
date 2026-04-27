import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '../../../src/main/tools/types';
import { buildProtocolContext } from '../../../src/main/tools/dispatch/shadowAdapter';
import { wrapLegacyTool } from '../../../src/main/tools/modules/_helpers/legacyAdapter';
import type { CanUseToolFn } from '../../../src/main/protocol/tools';

function makeProtocolCtx() {
  return buildProtocolContext({
    sessionId: 'sess-legacy-adapter',
    workingDirectory: '/tmp',
    legacyCtx: {
      workingDirectory: '/tmp',
      requestPermission: async () => true,
    } as never,
  });
}

describe('legacyAdapter wrapper permissions', () => {
  it('blocks browser_action.upload_file when inner upload approval is denied', async () => {
    const browserUploadTool: Tool = {
      name: 'browser_action',
      description: 'browser action',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute',
      execute: async (_params, context) => {
        const approved = await context.requestPermission({
          type: 'file_read',
          tool: 'browser_action.upload_file',
          details: { action: 'upload_file', file: 'secret.env' },
          reason: '上传敏感路径下的本地文件需要确认。',
        });
        return approved
          ? { success: true, output: 'uploaded' }
          : {
              success: false,
              error: 'Upload file permission denied',
              metadata: { code: 'UPLOAD_FILE_PERMISSION_DENIED' },
            };
      },
    };

    const handler = await wrapLegacyTool(browserUploadTool, {
      category: 'vision',
      permissionLevel: 'execute',
    }).createHandler();
    const canUseTool = vi.fn<CanUseToolFn>(async (name) => (
      name === 'browser_action'
        ? { allow: true }
        : { allow: false, reason: 'blocked by test' }
    ));

    const result = await handler.execute(
      { action: 'upload_file', uploadFilePath: '/tmp/secret.env' },
      makeProtocolCtx(),
      canUseTool,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.meta?.code).toBe('UPLOAD_FILE_PERMISSION_DENIED');
    }
    expect(canUseTool).toHaveBeenNthCalledWith(
      1,
      'browser_action',
      { action: 'upload_file', uploadFilePath: '/tmp/secret.env' },
    );
    expect(canUseTool).toHaveBeenCalledWith(
      'browser_action.upload_file',
      { action: 'upload_file', file: 'secret.env' },
      '上传敏感路径下的本地文件需要确认。',
      expect.objectContaining({
        type: 'file_read',
        tool: 'browser_action.upload_file',
      }),
    );
  });

  it('blocks computer_use when inner desktop action approval is denied', async () => {
    const computerUseTool: Tool = {
      name: 'computer_use',
      description: 'computer use',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute',
      execute: async (_params, context) => {
        const approved = await context.requestPermission({
          type: 'command',
          tool: 'computer_use',
          details: { action: 'click', targetApp: 'Safari' },
          reason: 'Approve Computer Use for the current foreground Safari window.',
        });
        return approved
          ? { success: true, output: 'clicked' }
          : {
              success: false,
              error: 'Computer Use for Safari was not approved.',
              metadata: { code: 'COMPUTER_SURFACE_BLOCKED' },
            };
      },
    };

    const handler = await wrapLegacyTool(computerUseTool, {
      category: 'vision',
      permissionLevel: 'execute',
    }).createHandler();
    const canUseTool = vi.fn<CanUseToolFn>()
      .mockResolvedValueOnce({ allow: true })
      .mockResolvedValueOnce({ allow: false, reason: 'blocked by test' });

    const result = await handler.execute(
      { action: 'click', targetApp: 'Safari' },
      makeProtocolCtx(),
      canUseTool,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not approved');
      expect(result.meta?.code).toBe('COMPUTER_SURFACE_BLOCKED');
    }
    expect(canUseTool).toHaveBeenCalledTimes(2);
  });
});
