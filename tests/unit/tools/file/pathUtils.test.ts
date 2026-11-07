// ============================================================================
// Path Utils Tests
// ============================================================================

import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import {
  confineEvalPath,
  expandTilde,
  isChatUploadPath,
  resolvePath,
} from '../../../../src/host/tools/file/pathUtils';

const originalEvalRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  if (originalEvalRealRoot === undefined) {
    delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
  } else {
    process.env.CODE_AGENT_EVAL_REAL_ROOT = originalEvalRealRoot;
  }
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// macOS 上 /tmp → /private/tmp、/var → /private/var 是软链，才构造得出「词法路径 ≠ 规范路径」。
// Linux CI 的 os.tmpdir() 没有这层别名，下面两条别名用例的场景在该平台根本不存在——
// 跳过并留痕，而不是让前提断言变成假红（也不让它静默降级成普通用例假绿）。
const TMP_HAS_ALIAS = fs.realpathSync.native(os.tmpdir()) !== path.resolve(os.tmpdir());

describe('Path Utilities', () => {
  const homeDir = os.homedir();

  // --------------------------------------------------------------------------
  // expandTilde
  // --------------------------------------------------------------------------
  describe('expandTilde', () => {
    it('should expand ~/path to absolute path', () => {
      expect(expandTilde('~/Documents')).toBe(`${homeDir}/Documents`);
    });

    it('should expand ~/nested/path', () => {
      expect(expandTilde('~/a/b/c')).toBe(`${homeDir}/a/b/c`);
    });

    it('should expand bare ~ to home directory', () => {
      expect(expandTilde('~')).toBe(homeDir);
    });

    it('should not modify absolute paths', () => {
      expect(expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
    });

    it('should not modify relative paths without tilde', () => {
      expect(expandTilde('src/host.ts')).toBe('src/host.ts');
    });

    it('should not expand tilde in middle of path', () => {
      expect(expandTilde('/home/~user')).toBe('/home/~user');
    });

    it('should handle empty string', () => {
      expect(expandTilde('')).toBe('');
    });

    it('should handle tilde-only path with slash', () => {
      expect(expandTilde('~/')).toBe(homeDir);
    });
  });

  // --------------------------------------------------------------------------
  // resolvePath
  // --------------------------------------------------------------------------
  describe('resolvePath', () => {
    const workingDir = '/home/user/project';

    it('should resolve relative paths against working directory', () => {
      expect(resolvePath('src/host.ts', workingDir)).toBe('/home/user/project/src/host.ts');
    });

    it('should preserve absolute paths', () => {
      expect(resolvePath('/etc/config', workingDir)).toBe('/etc/config');
    });

    it('should expand tilde before resolving', () => {
      const result = resolvePath('~/Documents/file.txt', workingDir);
      expect(result).toBe(`${homeDir}/Documents/file.txt`);
    });

    it('should resolve dot-relative paths', () => {
      expect(resolvePath('./test.ts', workingDir)).toBe('/home/user/project/test.ts');
    });

    it('should resolve parent-relative paths', () => {
      expect(resolvePath('../sibling/file.ts', workingDir)).toBe('/home/user/sibling/file.ts');
    });

    it('should handle bare filename as relative', () => {
      expect(resolvePath('file.txt', workingDir)).toBe('/home/user/project/file.txt');
    });

    it('should handle ~ as absolute path (home dir)', () => {
      const result = resolvePath('~', workingDir);
      expect(result).toBe(homeDir);
    });
  });

  describe('confineEvalPath', () => {
    it.skipIf(!TMP_HAS_ALIAS)('confines a nonexistent target when the real root uses its canonical tmp alias', () => {
      const lexicalRoot = createTemporaryDirectory('eval-real-root-');
      const canonicalRoot = fs.realpathSync.native(lexicalRoot);
      const sandbox = createTemporaryDirectory('eval-sandbox-');
      const target = path.join(lexicalRoot, 'x.md');
      process.env.CODE_AGENT_EVAL_REAL_ROOT = canonicalRoot;

      expect(canonicalRoot).not.toBe(path.resolve(lexicalRoot));
      expect(confineEvalPath(target, sandbox)).toBe(
        path.join(fs.realpathSync.native(sandbox), 'x.md'),
      );
      expect(fs.existsSync(target)).toBe(false);
    });

    it('preserves a path that is actually outside the real root', () => {
      const lexicalRoot = createTemporaryDirectory('eval-real-root-');
      const outside = path.join(createTemporaryDirectory('eval-outside-'), 'x.md');
      const sandbox = createTemporaryDirectory('eval-sandbox-');
      process.env.CODE_AGENT_EVAL_REAL_ROOT = fs.realpathSync.native(lexicalRoot);

      expect(confineEvalPath(outside, sandbox)).toBe(outside);
    });

    it.skipIf(!TMP_HAS_ALIAS)('preserves paths for an in-place run expressed through different aliases', () => {
      const lexicalRoot = createTemporaryDirectory('eval-in-place-');
      const canonicalRoot = fs.realpathSync.native(lexicalRoot);
      const target = path.join(canonicalRoot, 'x.md');
      process.env.CODE_AGENT_EVAL_REAL_ROOT = canonicalRoot;

      expect(confineEvalPath(target, lexicalRoot)).toBe(target);
    });

    it('returns the input byte-for-byte when eval confinement is disabled', () => {
      delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      const target = '/var/../var/not-created/x.md';

      expect(confineEvalPath(target, '/private/var/sandbox')).toBe(target);
    });

    it('falls back to lexical confinement when canonical resolution throws', () => {
      const linksDirectory = createTemporaryDirectory('eval-deep-links-');
      const destination = path.join(linksDirectory, 'destination');
      fs.mkdirSync(destination);
      for (let index = 41; index >= 0; index -= 1) {
        const target = index === 41 ? 'destination' : `link-${index + 1}`;
        fs.symlinkSync(target, path.join(linksDirectory, `link-${index}`));
      }
      const lexicalRoot = path.join(linksDirectory, 'link-0');
      const target = path.join(lexicalRoot, 'x.md');
      const sandbox = createTemporaryDirectory('eval-sandbox-');
      process.env.CODE_AGENT_EVAL_REAL_ROOT = lexicalRoot;

      expect(() => confineEvalPath(target, sandbox)).not.toThrow();
      expect(confineEvalPath(target, sandbox)).toBe(path.join(sandbox, 'x.md'));
    });
  });

  // --------------------------------------------------------------------------
  // isChatUploadPath
  //
  // macOS os.tmpdir() 返回 /var/...（软链别名），realpath 是 /private/var/...。
  // 上传回执 / document-evidence 锚常以 realpath 形态回到 Read 工具
  // （realrun20：/private/var/folders/…/T/code-agent-uploads/…/sales.csv 重读
  // ENOENT 却没吃到「上传已过期」提示）。用真实临时目录 + 软链构造同样的
  // 「词法根 ≠ 规范根」形态，不许手拼假路径。
  // --------------------------------------------------------------------------
  describe('isChatUploadPath', () => {
    const originalTmpdir = process.env.TMPDIR;
    let lexicalTmp: string;
    let canonicalTmp: string;

    beforeEach(() => {
      // 目录先在原始 tmpdir 下建好，再改 TMPDIR——os.tmpdir() 每次调用现读 env。
      // base 本身可能就在 /var 软链层下（macOS vitest tmp），先规范化出真身，
      // 保证「词法根 ≠ 规范根」的形态和 macOS 生产一致。
      const base = fs.realpathSync.native(createTemporaryDirectory('chat-upload-'));
      canonicalTmp = path.join(base, 'real-tmp');
      lexicalTmp = path.join(base, 'lex-tmp');
      fs.mkdirSync(path.join(canonicalTmp, 'code-agent-uploads'), { recursive: true });
      fs.symlinkSync(canonicalTmp, lexicalTmp);
      process.env.TMPDIR = lexicalTmp;
      expect(os.tmpdir()).toBe(lexicalTmp);
      expect(fs.realpathSync.native(lexicalTmp)).toBe(canonicalTmp);
      expect(canonicalTmp).not.toBe(path.resolve(lexicalTmp));
    });

    afterEach(() => {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    });

    it('accepts the lexical tmpdir form of an upload path', () => {
      expect(isChatUploadPath(path.join(lexicalTmp, 'code-agent-uploads', 'uuid-1', 'a.csv'))).toBe(true);
    });

    it('accepts the realpath (canonical) form even when the uploaded file is gone', () => {
      // 重启后 webServer 清空上传目录内容：uuid 目录与文件都没了，只剩根。
      const realpathForm = path.join(canonicalTmp, 'code-agent-uploads', 'uuid-1', 'a.csv');
      expect(fs.existsSync(realpathForm)).toBe(false);
      expect(isChatUploadPath(realpathForm)).toBe(true);
    });

    it('accepts the realpath form when the upload root itself is gone too', () => {
      fs.rmSync(path.join(canonicalTmp, 'code-agent-uploads'), { recursive: true, force: true });
      const realpathForm = path.join(canonicalTmp, 'code-agent-uploads', 'uuid-1', 'a.csv');
      expect(fs.existsSync(path.join(canonicalTmp, 'code-agent-uploads'))).toBe(false);
      expect(isChatUploadPath(realpathForm)).toBe(true);
    });

    it('rejects non-upload paths in either form', () => {
      expect(isChatUploadPath(path.join(canonicalTmp, 'other', 'a.csv'))).toBe(false);
      expect(isChatUploadPath(path.join(lexicalTmp, 'a.csv'))).toBe(false);
      expect(isChatUploadPath('/etc/hosts')).toBe(false);
    });
  });
});
