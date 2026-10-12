// ============================================================================
// N-SANDBOX-ESCALATE-DIR-FORBIDDEN · 目录子树扩权的禁写名清单（getForbiddenWritePathsUnderRoot）
// 设计稿 docs/architecture/designs/sandbox-escalate-dir.md 边界一（D1-B 清单）：
// 授予整树写之后，子树内命中的凭据/笼子/钩子/shell rc/LaunchAgents 现存名仍保持只读。
// 撞 walk 上限只 warn 记名、绝不静默跳过；软链不跟；root 本体落在禁区时 root 即条目。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: loggerWarn, error: () => {} }),
}));

import { ESCALATE_DIR_FORBIDDEN_WALK } from '../../../../src/shared/constants/sandbox';
import {
  getForbiddenWritePathsUnderRoot,
  isProtectedWritePath,
  type SensitiveSandboxPath,
} from '../../../../src/host/sandbox/sensitivePaths';

function mkdtmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pathsOf(entries: SensitiveSandboxPath[]): string[] {
  return entries.map((entry) => entry.path);
}

describe('forbidden write names under a granted directory root (DIR-FORBIDDEN)', () => {
  beforeEach(() => {
    isProtectedWritePath.resetCacheForTest();
    loggerWarn.mockClear();
  });

  it('lists existing credential/cage/hook/rc/launch-agent names at nested depths, not plain names', () => {
    const root = mkdtmp('forbidden-names-');
    try {
      fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(root, '.git', 'config'), '[core]');
      fs.writeFileSync(path.join(root, '.zshrc'), '# rc');
      fs.writeFileSync(path.join(root, '.bash_profile'), '# rc');
      fs.writeFileSync(path.join(root, '.npmrc'), 'registry=x');
      fs.writeFileSync(path.join(root, '.env.production'), 'SECRET=1');
      fs.writeFileSync(path.join(root, 'normal.txt'), 'plain');
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(root, 'vendor', 'repo', '.git', 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(root, 'Library', 'LaunchAgents'), { recursive: true });
      fs.mkdirSync(path.join(root, '.config', 'gh'), { recursive: true });
      fs.mkdirSync(path.join(root, 'nested', '.ssh'), { recursive: true });

      const entries = getForbiddenWritePathsUnderRoot(root);
      for (const expected of [
        { kind: 'directory', path: path.join(root, '.git', 'hooks') },
        { kind: 'file', path: path.join(root, '.git', 'config') },
        { kind: 'file', path: path.join(root, '.zshrc') },
        { kind: 'file', path: path.join(root, '.bash_profile') },
        { kind: 'file', path: path.join(root, '.npmrc') },
        { kind: 'file', path: path.join(root, '.env.production') },
        { kind: 'directory', path: path.join(root, 'vendor', 'repo', '.git', 'hooks') },
        { kind: 'directory', path: path.join(root, 'Library', 'LaunchAgents') },
        { kind: 'directory', path: path.join(root, '.config', 'gh') },
        { kind: 'directory', path: path.join(root, 'nested', '.ssh') },
      ]) {
        expect(entries, JSON.stringify(expected)).toContainEqual(expected);
      }
      // 普通名字与未被点名的中间目录不进清单
      expect(pathsOf(entries)).not.toContain(path.join(root, 'normal.txt'));
      expect(pathsOf(entries)).not.toContain(path.join(root, 'src'));
      expect(pathsOf(entries)).not.toContain(path.join(root, 'vendor'));
      expect(pathsOf(entries)).not.toContain(path.join(root, '.git'));
      expect(loggerWarn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the root itself when it equals or lies inside a home-secret or cage path', () => {
    const home = mkdtmp('forbidden-home-');
    const dataDir = path.join(home, 'data');
    try {
      fs.mkdirSync(path.join(home, '.ssh', 'custom'), { recursive: true });
      fs.mkdirSync(path.join(dataDir, 'hooks'), { recursive: true });
      const env = { CODE_AGENT_DATA_DIR: dataDir };

      // 落在 home-secret 目录内部：root 本身就是条目
      expect(getForbiddenWritePathsUnderRoot(path.join(home, '.ssh', 'custom'), { homeDir: home, env }))
        .toEqual([{ kind: 'directory', path: path.join(home, '.ssh', 'custom') }]);
      // root 恰是 home-secret 目录
      expect(getForbiddenWritePathsUnderRoot(path.join(home, '.ssh'), { homeDir: home, env }))
        .toEqual([{ kind: 'directory', path: path.join(home, '.ssh') }]);
      // root 恰是数据目录笼子的 hooks 目录（isProtectedWritePath 的数据目录条目）
      expect(getForbiddenWritePathsUnderRoot(path.join(dataDir, 'hooks'), { homeDir: home, env }))
        .toEqual([{ kind: 'directory', path: path.join(dataDir, 'hooks') }]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('treats a root that is itself a forbidden directory name as the entry (.git/hooks, LaunchAgents)', () => {
    // 判定口径（本单取舍，见证据档）：root 自身名字命中目录版禁写名规则时同样只授只读——
    // 授权根恰是 .git/hooks / LaunchAgents 这类持久化执行向量时，没有理由放开整树
    const parent = mkdtmp('forbidden-root-name-');
    try {
      const hooks = path.join(parent, 'repo', '.git', 'hooks');
      const launchAgents = path.join(parent, 'Library2', 'LaunchAgents');
      fs.mkdirSync(hooks, { recursive: true });
      fs.mkdirSync(launchAgents, { recursive: true });
      expect(getForbiddenWritePathsUnderRoot(hooks)).toEqual([{ kind: 'directory', path: hooks }]);
      expect(getForbiddenWritePathsUnderRoot(launchAgents)).toEqual([{ kind: 'directory', path: launchAgents }]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('does not follow symlinks: secrets behind a link are not enumerated', () => {
    const root = mkdtmp('forbidden-symlink-');
    const outside = mkdtmp('forbidden-symlink-outside-');
    try {
      fs.writeFileSync(path.join(outside, '.npmrc'), 'registry=x');
      fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
      const entries = getForbiddenWritePathsUnderRoot(root);
      expect(pathsOf(entries)).not.toContain(path.join(root, 'link'));
      expect(pathsOf(entries)).not.toContain(path.join(root, 'link', '.npmrc'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stops at the depth cap with a warn that names the cap; deeper names stay unwalked', () => {
    const root = mkdtmp('forbidden-depth-');
    try {
      fs.writeFileSync(path.join(root, '.npmrc'), 'registry=x');
      let deep = root;
      for (let i = 0; i < ESCALATE_DIR_FORBIDDEN_WALK.MAX_DEPTH + 2; i += 1) {
        deep = path.join(deep, `d${i}`);
      }
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, '.npmrc'), 'registry=x');

      const entries = getForbiddenWritePathsUnderRoot(root);
      expect(pathsOf(entries)).toContain(path.join(root, '.npmrc'));
      expect(pathsOf(entries)).not.toContain(path.join(deep, '.npmrc'));
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('depth cap'),
        expect.objectContaining({ cap: 'ESCALATE_DIR_FORBIDDEN_WALK.MAX_DEPTH' }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops at the entry cap with a warn that names the cap', () => {
    const root = mkdtmp('forbidden-entries-');
    try {
      for (let i = 0; i < ESCALATE_DIR_FORBIDDEN_WALK.MAX_ENTRIES + 5; i += 1) {
        fs.writeFileSync(path.join(root, `f${i}`), '');
      }
      const entries = getForbiddenWritePathsUnderRoot(root);
      expect(entries).toEqual([]);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('entry cap'),
        expect.objectContaining({ cap: 'ESCALATE_DIR_FORBIDDEN_WALK.MAX_ENTRIES' }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
