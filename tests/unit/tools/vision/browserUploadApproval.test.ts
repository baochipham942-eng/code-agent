import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { requestBrowserUploadApproval } from '../../../../src/host/tools/vision/browserUploadApproval';

describe('requestBrowserUploadApproval', () => {
  it('always force-confirms the exact file without placing its absolute path in permission details', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-request-'));
    const filePath = path.join(directory, 'ordinary.txt');
    fs.writeFileSync(filePath, 'approved upload bytes');
    const requestPermission = vi.fn(async () => true);
    try {
      const result = await requestBrowserUploadApproval({
        filePath,
        engine: 'relay',
        context: {
          workingDirectory: directory,
          sessionId: 'conversation-upload',
          runId: 'run-upload',
          agentId: 'agent-upload',
          currentToolCallId: 'operation-upload',
          requestPermission,
        },
      });

      expect(result).toMatchObject({
        approved: true,
        relayToken: expect.stringMatching(/^relay_upload_/),
        file: {
          normalizedPath: fs.realpathSync.native(filePath),
          name: 'ordinary.txt',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
        type: 'file_read',
        tool: 'browser_action.upload_file',
        forceConfirm: true,
        details: expect.objectContaining({
          file: '.../ordinary.txt',
          action: 'upload_file',
          engine: 'relay',
          approvalMode: 'host_one_time_exact_file',
          sizeBytes: Buffer.byteLength('approved upload bytes'),
          sha256: expect.stringMatching(/^[a-f0-9]{12}$/),
        }),
      }));
      expect(JSON.stringify(requestPermission.mock.calls)).not.toContain(directory);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('denies a valid inspected file without issuing a Relay token or exposing its path', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-denied-'));
    const filePath = path.join(directory, 'denied-upload.txt');
    fs.writeFileSync(filePath, 'denied upload bytes');
    try {
      const result = await requestBrowserUploadApproval({
        filePath,
        engine: 'relay',
        context: {
          workingDirectory: directory,
          sessionId: 'conversation-upload',
          runId: 'run-upload',
          agentId: 'agent-upload',
          currentToolCallId: 'operation-upload',
          requestPermission: vi.fn(async () => false),
        },
      });

      expect(result).toEqual({
        approved: false,
        reason: 'The selected upload file was not explicitly approved.',
        code: 'SURFACE_APPROVAL_REQUIRED',
      });
      expect(JSON.stringify(result)).not.toContain(directory);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when the file changes while the exact-file confirmation is open', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-race-'));
    const filePath = path.join(directory, 'raced-upload.txt');
    fs.writeFileSync(filePath, 'approved-before');
    try {
      const result = await requestBrowserUploadApproval({
        filePath,
        engine: 'managed',
        context: {
          workingDirectory: directory,
          sessionId: 'conversation-upload',
          runId: 'run-upload',
          agentId: 'agent-upload',
          currentToolCallId: 'operation-upload',
          requestPermission: vi.fn(async () => {
            fs.writeFileSync(filePath, 'replaced-after!');
            return true;
          }),
        },
      });

      expect(result).toMatchObject({
        approved: false,
        code: 'SURFACE_APPROVAL_INVALID',
        reason: expect.stringContaining('approved upload file changed before delivery'),
      });
      expect(JSON.stringify(result)).not.toContain(directory);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
