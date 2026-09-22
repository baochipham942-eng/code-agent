// ============================================================================
// upload helpers：workspace 文件白名单与 content-type 映射（handleTempUpload 之外）。
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
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

  // 会话工作目录用 home 下的真实临时目录：cwd/tmpdir 是恒放行基线根，只有 home
  // 下新造的目录才真的落在会话分支上（mac/linux 都成立）。
  function withSessionRoot(fn: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.homedir(), '.code-agent-wsallow-'));
    try {
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('allows media files (incl. CJK path) under a bound session working directory', () => {
    withSessionRoot((root) => {
      const file = path.join(root, '资料', '截图-报错.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'png');
      expect(isWorkspaceFileAllowed(file, [root])).toBe(true);
    });
  });

  it('allows any file type under the session .code-agent/artifacts subtree', () => {
    withSessionRoot((root) => {
      const file = path.join(root, '.code-agent', 'artifacts', 'preview', 'index.html');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '<html></html>');
      expect(isWorkspaceFileAllowed(file, [root])).toBe(true);
    });
  });

  it('denies non-previewable extensions and missing files under the session root (fail closed)', () => {
    withSessionRoot((root) => {
      const key = path.join(root, 'id_rsa');
      fs.writeFileSync(key, 'secret');
      expect(isWorkspaceFileAllowed(key, [root])).toBe(false);
      expect(isWorkspaceFileAllowed(path.join(root, 'missing.png'), [root])).toBe(false);
    });
  });

  it('denies symlink escapes from a bound session working directory', () => {
    withSessionRoot((root) => {
      fs.symlinkSync('/etc/passwd', path.join(root, 'escape.png'));
      expect(isWorkspaceFileAllowed(path.join(root, 'escape.png'), [root])).toBe(false);
    });
  });

  it('ignores over-broad session roots like the home directory or filesystem root', () => {
    withSessionRoot((root) => {
      const file = path.join(root, 'a.png');
      fs.writeFileSync(file, 'png');
      expect(isWorkspaceFileAllowed(file, [os.homedir()])).toBe(false);
      expect(isWorkspaceFileAllowed(file, [path.parse(root).root])).toBe(false);
    });
  });

  it('still denies paths outside every bound session working directory', () => {
    withSessionRoot((root) => {
      expect(isWorkspaceFileAllowed('/etc/passwd', [root])).toBe(false);
      expect(isWorkspaceFileAllowed(path.join(root, '..', 'etc', 'passwd'), [root])).toBe(false);
    });
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
