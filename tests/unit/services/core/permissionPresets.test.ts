import { describe, expect, it } from 'vitest';
import { isPathTrusted } from '../../../../src/host/services/core/permissionPresets';

describe('isPathTrusted', () => {
  describe('posix', () => {
    it('matches the directory itself and subpaths', () => {
      expect(isPathTrusted('/Users/me/project', ['/Users/me/project'], 'darwin')).toBe(true);
      expect(isPathTrusted('/Users/me/project/src/a.ts', ['/Users/me/project'], 'darwin')).toBe(true);
    });

    it('does not match prefix-collision siblings', () => {
      // /foo 不能匹配 /foobar
      expect(isPathTrusted('/Users/me/project-evil', ['/Users/me/project'], 'darwin')).toBe(false);
    });

    it('rejects paths outside trusted dirs and traversal escapes', () => {
      expect(isPathTrusted('/etc/passwd', ['/Users/me/project'], 'darwin')).toBe(false);
      expect(isPathTrusted('/Users/me/project/../other', ['/Users/me/project'], 'darwin')).toBe(false);
    });

    it('handles trailing slashes', () => {
      expect(isPathTrusted('/Users/me/project/', ['/Users/me/project'], 'darwin')).toBe(true);
      expect(isPathTrusted('/Users/me/project/src', ['/Users/me/project/'], 'darwin')).toBe(true);
    });

    it('is case-sensitive on posix', () => {
      expect(isPathTrusted('/Users/Me/Project', ['/users/me/project'], 'darwin')).toBe(false);
    });

    it('returns false for empty inputs', () => {
      expect(isPathTrusted('', ['/Users/me'], 'darwin')).toBe(false);
      expect(isPathTrusted('/Users/me', [], 'darwin')).toBe(false);
    });
  });

  describe('win32', () => {
    it('matches drive paths with backslashes', () => {
      expect(isPathTrusted('C:\\Users\\me\\project', ['C:\\Users\\me\\project'], 'win32')).toBe(true);
      expect(isPathTrusted('C:\\Users\\me\\project\\src\\a.ts', ['C:\\Users\\me\\project'], 'win32')).toBe(true);
    });

    it('matches mixed separators (forward slashes normalized)', () => {
      expect(isPathTrusted('C:/Users/me/project/src', ['C:\\Users\\me\\project'], 'win32')).toBe(true);
    });

    it('is case-insensitive on win32 (NTFS)', () => {
      expect(isPathTrusted('c:\\users\\ME\\Project\\src', ['C:\\Users\\me\\project'], 'win32')).toBe(true);
    });

    it('does not match prefix-collision siblings', () => {
      expect(isPathTrusted('C:\\Users\\me\\project-evil', ['C:\\Users\\me\\project'], 'win32')).toBe(false);
    });

    it('rejects cross-drive paths', () => {
      expect(isPathTrusted('D:\\Users\\me\\project\\a.ts', ['C:\\Users\\me\\project'], 'win32')).toBe(false);
    });

    it('rejects traversal escapes', () => {
      expect(isPathTrusted('C:\\Users\\me\\project\\..\\other', ['C:\\Users\\me\\project'], 'win32')).toBe(false);
    });
  });
});
