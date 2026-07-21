import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Locator } from 'playwright';
import { uploadBrowserFile } from '../../../../src/host/services/infra/browser/browserArtifactActions';
import { inspectBrowserUploadFile } from '../../../../src/host/services/infra/browser/browserUploadApprovalRegistry';

const temporaryDirectories: string[] = [];

function harness() {
  type SetInputFilesInput = Parameters<Locator['setInputFiles']>[0];
  const setInputFiles = vi.fn(async (_files: SetInputFilesInput) => undefined);
  const locator = {
    first: () => locator,
    evaluate: vi.fn(async () => true),
    setInputFiles,
  };
  return {
    setInputFiles,
    tab: { page: { locator: vi.fn(() => locator) } },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Managed Browser exact-file upload delivery', () => {
  it('blocks a same-size byte replacement before Playwright receives the file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-upload-approval-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'fixture.txt');
    fs.writeFileSync(filePath, 'approved-before');
    const approvedFile = inspectBrowserUploadFile(filePath);
    fs.writeFileSync(filePath, 'replaced-after!');
    const { setInputFiles, tab } = harness();

    await expect(uploadBrowserFile({
      approvedFile,
      selector: '#upload',
      sessionId: 'session-upload',
      getTab: () => tab as never,
      resolveTargetRef: vi.fn(),
    })).rejects.toThrow('SURFACE_APPROVAL_INVALID');
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it('blocks an inode replacement before Playwright receives the file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-upload-inode-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'fixture.txt');
    const replacementPath = path.join(directory, 'replacement.txt');
    fs.writeFileSync(filePath, 'approved inode bytes');
    const approvedFile = inspectBrowserUploadFile(filePath);
    fs.writeFileSync(replacementPath, 'replacement inode bytes');
    fs.renameSync(replacementPath, filePath);
    const { setInputFiles, tab } = harness();

    await expect(uploadBrowserFile({
      approvedFile,
      selector: '#upload',
      sessionId: 'session-upload',
      getTab: () => tab as never,
      resolveTargetRef: vi.fn(),
    })).rejects.toThrow('SURFACE_APPROVAL_INVALID');
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it('blocks a symbolic-link swap before Playwright receives the file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-upload-symlink-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'fixture.txt');
    const otherPath = path.join(directory, 'other.txt');
    fs.writeFileSync(filePath, 'approved file bytes');
    fs.writeFileSync(otherPath, 'other file bytes');
    const approvedFile = inspectBrowserUploadFile(filePath);
    fs.unlinkSync(filePath);
    fs.symlinkSync(otherPath, filePath);
    const { setInputFiles, tab } = harness();

    await expect(uploadBrowserFile({
      approvedFile,
      selector: '#upload',
      sessionId: 'session-upload',
      getTab: () => tab as never,
      resolveTargetRef: vi.fn(),
    })).rejects.toThrow('SURFACE_POLICY_BLOCKED');
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it('delivers an immutable verified buffer instead of reopening the approved path in Playwright', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-upload-buffer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'fixture.txt');
    const contents = Buffer.from('approved upload buffer');
    fs.writeFileSync(filePath, contents);
    const approvedFile = inspectBrowserUploadFile(filePath);
    const { setInputFiles, tab } = harness();

    const artifact = await uploadBrowserFile({
      approvedFile,
      selector: '#upload',
      sessionId: 'session-upload',
      getTab: () => tab as never,
      resolveTargetRef: vi.fn(),
    });

    expect(setInputFiles).toHaveBeenCalledWith(expect.objectContaining({
      name: 'fixture.txt',
      buffer: contents,
    }));
    expect(setInputFiles.mock.calls[0][0]).not.toEqual(approvedFile.normalizedPath);
    expect(artifact).toMatchObject({
      name: approvedFile.name,
      size: approvedFile.size,
      sha256: approvedFile.sha256,
    });
  });
});
