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
    it('confines a nonexistent target when the real root uses its canonical tmp alias', () => {
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

    it('preserves paths for an in-place run expressed through different aliases', () => {
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
});
