import { describe, expect, it } from 'vitest';
import { getPresetConfig, isCommandBlocked, isPathTrusted } from '../../../../src/host/services/core/permissionPresets';

describe('getPresetConfig autoApprove（子 agent 权限档）', () => {
  it('development 放开 network（研究型子 agent 联网调研），write/execute 仍受控', () => {
    const dev = getPresetConfig('development');
    expect(dev.autoApprove.network).toBe(true); // 产品决策：组队/研究子 agent 需要联网
    expect(dev.autoApprove.read).toBe(true);
    expect(dev.autoApprove.write).toBe(false); // 仍由 trustProjectDirectory 收口
    expect(dev.autoApprove.execute).toBe(false);
  });

  it('strict 仍全禁（放开只限 development）', () => {
    expect(getPresetConfig('strict').autoApprove.network).toBe(false);
  });
});

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

describe('ci 档（详情页「放手」）保留硬门', () => {
  it('四类全自动批准', () => {
    const config = getPresetConfig('ci');
    expect(config.autoApprove).toEqual({ read: true, write: true, execute: true, network: true });
  });

  it('硬毙命令仍然拦得住', () => {
    const config = getPresetConfig('ci');
    expect(isCommandBlocked('rm -rf /', config.blockedCommands)).toBe(true);
    expect(isCommandBlocked('sudo rm -rf /var', config.blockedCommands)).toBe(true);
  });

  it('危险命令仍要二次确认', () => {
    expect(getPresetConfig('ci').confirmDangerousCommands).toBe(true);
  });
});
