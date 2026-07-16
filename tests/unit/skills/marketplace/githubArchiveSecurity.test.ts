import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractZipSafely } from '../../../../src/host/skills/marketplace/githubArchiveSecurity';

describe('GitHub archive extraction security', () => {
  let tempRoot: string;
  let destDir: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-github-archive-'));
    destDir = path.join(tempRoot, 'extracted');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('restores executable permissions from a UNIX archive entry', async () => {
    const zip = new JSZip();
    zip.file('plugin/bin/run.sh', '#!/bin/sh\necho ready\n', {
      unixPermissions: 0o100755,
    });
    const archive = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });

    await extractZipSafely(archive, destDir);

    const stat = await fs.stat(path.join(destDir, 'plugin/bin/run.sh'));
    expect(stat.mode & 0o777).toBe(0o755);
  });

  it('strips privileged permission bits from UNIX archive entries', async () => {
    const zip = new JSZip();
    zip.file('plugin/bin/privileged', 'binary', {
      unixPermissions: 0o107755,
    });
    const archive = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });

    await extractZipSafely(archive, destDir);

    const stat = await fs.stat(path.join(destDir, 'plugin/bin/privileged'));
    expect(stat.mode & 0o7777).toBe(0o755);
  });

  it('rejects UNIX symlink entries before writing archive contents', async () => {
    const zip = new JSZip();
    zip.file('plugin/SKILL.md', 'safe');
    zip.file('plugin/latest', 'SKILL.md', {
      unixPermissions: 0o120777,
    });
    const archive = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });

    await expect(extractZipSafely(archive, destDir)).rejects.toThrow(
      'Symbolic link zip entry rejected: plugin/latest',
    );
    await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
