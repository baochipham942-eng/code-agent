// ============================================================================
// Seatbelt 写禁锢 profile 文本断言（#1997）
// 产物逃逸工单：bash 写权限必须收进工作区子树——profile 不得把工作区之外的
// 路径（HOME 根、~/Downloads、工作区兄弟目录的祖先）授予 file-write。
// 执行侧真隔离由 tests/integration/sandbox/seatbeltWrap.test.ts 覆盖。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateProfile, type SeatbeltConfig } from '../../../../src/host/sandbox/seatbelt';

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function allowWriteSubpaths(profile: string): string[] {
  return [...profile.matchAll(/\(allow file-write\* \(subpath "([^"]+)"\)\)/g)]
    .map((match) => match[1]);
}

function baseConfig(overrides: Partial<SeatbeltConfig>): SeatbeltConfig {
  return {
    allowNetwork: false,
    readPaths: [],
    writePaths: [],
    executePaths: [],
    allowProcessExec: true,
    allowProcessFork: true,
    envPassthrough: [],
    customEnv: {},
    sensitivePaths: [],
    ...overrides,
  };
}

describe('seatbelt write confinement profile (#1997)', () => {
  it('denies writes by default and only re-allows /dev, TMPDIR and the workspace subtree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-confine-'));
    const home = path.join(root, 'neo-home');
    const workspace = path.join(home, 'ws', 'gdp-772e7524');
    fs.mkdirSync(workspace, { recursive: true });
    try {
      // bash 工具路径（SandboxManager.wrapCommand darwin 分支）的传参形态：
      // workingDirectory 可写默认关闭，写根 = workspaceScope/收缩后的 workspace。
      const profile = generateProfile(baseConfig({
        workingDirectory: home, // 默认会话 cwd = HOME（最坏的逃逸场景）
        allowWorkingDirectoryWrite: false,
        writePaths: [workspace],
      }));

      expect(profile).toContain('(deny file-write*)');
      // SBPL 后规则覆盖先规则：deny 必须在所有 allow file-write 之前
      expect(profile.indexOf('(deny file-write*)'))
        .toBeLessThan(profile.indexOf('(allow file-write*'));

      const granted = allowWriteSubpaths(profile);
      const expected = new Set([
        '/dev',
        realPath(process.env.TMPDIR || os.tmpdir() || '/tmp'),
        realPath(workspace),
      ]);
      expect(new Set(granted)).toEqual(expected);

      // 工作区之外一律不得授予写：HOME 根、~/Downloads、ws/ 祖先（兄弟目录 gdp-7724 的容器）
      expect(granted).not.toContain(realPath(home));
      expect(granted).not.toContain(realPath(path.join(home, 'Downloads')));
      expect(granted).not.toContain(realPath(path.join(home, 'ws')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('grants the legacy cwd write root only when explicitly enabled (not the bash path)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-legacy-'));
    const workspace = path.join(root, 'proj');
    fs.mkdirSync(workspace);
    try {
      const profile = generateProfile(baseConfig({ workingDirectory: workspace }));
      expect(allowWriteSubpaths(profile)).toContain(realPath(workspace));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('seatbelt single-file write grant (one-shot escalation)', () => {
  it('allows the file by literal path and grants no subtree for it', () => {
    const dir = realPath(fs.mkdtempSync(path.join(os.homedir(), '.seatbelt-file-grant-')));
    const file = path.join(dir, 'out.txt');
    try {
      const profile = generateProfile(baseConfig({ writeFiles: [file] }));
      expect(profile).toContain(`(allow file-write* (literal "${file}"))`);
      // 反向变异：若把 literal 写成 subpath，这两条会红——文件被建成目录后里面就全可写了
      expect(allowWriteSubpaths(profile)).not.toContain(file);
      expect(allowWriteSubpaths(profile)).not.toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves symlinks in the parent directory of a file that does not exist yet', () => {
    const real = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-file-real-')));
    const alias = path.join(path.dirname(real), `seatbelt-file-alias-${process.pid}`);
    fs.symlinkSync(real, alias, 'dir');
    try {
      const profile = generateProfile(baseConfig({ writeFiles: [path.join(alias, 'new.txt')] }));
      expect(profile).toContain(`(allow file-write* (literal "${path.join(real, 'new.txt')}"))`);
    } finally {
      fs.rmSync(alias, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
