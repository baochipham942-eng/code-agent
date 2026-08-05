// 设计导入源路径守卫：多 root 语义（2026-08-05 会话级 cwd 进允许名单）。
// 真实临时目录 + 真实 symlink，不 mock 路径解析——守卫的价值就在真实文件系统语义上。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'design-paths-'));
const configDir = path.join(tmpBase, 'config');
const appRoot = path.join(tmpBase, 'app-workspace');
const sessionRoot = path.join(tmpBase, 'session-workspace');
const outsideDir = path.join(tmpBase, 'outside');

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => configDir,
}));

const { assertWithinDesignImportSource } = await import('../../../src/host/ipc/workspaceDesignPaths');

beforeAll(() => {
  for (const dir of [configDir, path.join(configDir, 'design'), appRoot, sessionRoot, outsideDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(sessionRoot, 'gen.png'), 'x');
  fs.writeFileSync(path.join(appRoot, 'app.png'), 'x');
  fs.writeFileSync(path.join(outsideDir, 'secret.png'), 'x');
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('assertWithinDesignImportSource 多 root', () => {
  it('会话级工作目录在允许名单里时放行其下文件', () => {
    const p = path.join(sessionRoot, 'gen.png');
    expect(assertWithinDesignImportSource(p, [sessionRoot, appRoot])).toBe(fs.realpathSync(p));
  });

  it('单 root 旧签名（字符串）继续工作', () => {
    const p = path.join(appRoot, 'app.png');
    expect(assertWithinDesignImportSource(p, appRoot)).toBe(fs.realpathSync(p));
  });

  it('不在任何 root 下的路径仍被拒绝（多 root 不放水）', () => {
    const p = path.join(outsideDir, 'secret.png');
    expect(() => assertWithinDesignImportSource(p, [sessionRoot, appRoot])).toThrow('路径越界');
  });

  it('数组里的空值/相对路径条目被忽略而不是放行一切', () => {
    const p = path.join(outsideDir, 'secret.png');
    expect(() => assertWithinDesignImportSource(p, [undefined, null, 'relative/dir'])).toThrow('路径越界');
  });

  it('symlink 从会话目录逃逸到外部仍被拒绝', () => {
    const link = path.join(sessionRoot, 'escape.png');
    fs.symlinkSync(path.join(outsideDir, 'secret.png'), link);
    expect(() => assertWithinDesignImportSource(link, [sessionRoot])).toThrow('路径越界');
  });
});
