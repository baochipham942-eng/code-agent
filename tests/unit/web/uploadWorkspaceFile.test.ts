// ============================================================================
// upload helpers：workspace 文件白名单与 content-type 映射（handleTempUpload 之外）。
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getContentType, isWorkspaceFileAllowed } from '../../../src/web/helpers/upload';

describe('isWorkspaceFileAllowed', () => {
  it('allows files under process.cwd()', () => {
    const target = path.join(process.cwd(), 'package.json');
    expect(isWorkspaceFileAllowed(target)).toBe(true);
  });

  it('allows files under os.tmpdir()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-allow-'));
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    try {
      expect(isWorkspaceFileAllowed(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies absolute paths outside cwd and tmp', () => {
    expect(isWorkspaceFileAllowed('/etc/passwd')).toBe(false);
    expect(isWorkspaceFileAllowed('/var/log/system.log')).toBe(false);
  });

  it('denies traversal that escapes cwd even if path starts with cwd prefix text', () => {
    const escaped = path.resolve(process.cwd(), '..', 'outside-escape.txt');
    // Only assert deny when the resolved path is truly outside both allowed roots
    const allowed = isWorkspaceFileAllowed(escaped);
    if (
      !escaped.startsWith(path.resolve(process.cwd()) + path.sep)
      && !escaped.startsWith(path.resolve(os.tmpdir()) + path.sep)
    ) {
      expect(allowed).toBe(false);
    }
  });
});

describe('getContentType', () => {
  it('maps common image and text extensions', () => {
    expect(getContentType('a.png')).toBe('image/png');
    expect(getContentType('a.JPG')).toBe('image/jpeg');
    expect(getContentType('a.webp')).toBe('image/webp');
    expect(getContentType('a.svg')).toBe('image/svg+xml');
    expect(getContentType('a.md')).toBe('text/markdown; charset=utf-8');
    expect(getContentType('a.json')).toBe('application/json; charset=utf-8');
    expect(getContentType('a.js')).toBe('text/javascript; charset=utf-8');
    expect(getContentType('a.ts')).toBe('text/plain; charset=utf-8');
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(getContentType('archive.xyz')).toBe('application/octet-stream');
    expect(getContentType('noext')).toBe('application/octet-stream');
  });
});
