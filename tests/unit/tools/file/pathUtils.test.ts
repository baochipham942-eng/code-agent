// ============================================================================
// Path Utils Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import os from 'os';
import { expandTilde, resolvePath } from '../../../../src/main/tools/file/pathUtils';

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
      expect(expandTilde('src/main.ts')).toBe('src/main.ts');
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
      expect(resolvePath('src/main.ts', workingDir)).toBe('/home/user/project/src/main.ts');
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
});
