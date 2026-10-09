// ============================================================================
// toolScreenshotDir — 工具默认截图目录（N-RETENTION-SHOTS-APPDIR）
// 无显式路径的截图改落数据目录（不再写用户工作目录），按会话隔离。
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getToolScreenshotDir,
  getToolScreenshotsRoot,
} from '../../../../src/host/tools/utils/toolScreenshotDir';
import { TOOL_SCREENSHOTS } from '../../../../src/shared/constants';

const dataDirs: string[] = [];
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

beforeEach(() => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tool-screenshot-dir-'));
  dataDirs.push(dataDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  while (dataDirs.length) rmSync(dataDirs.pop()!, { recursive: true, force: true });
});

describe('getToolScreenshotsRoot', () => {
  it('落在 CODE_AGENT_DATA_DIR 下的常量子目录', () => {
    expect(getToolScreenshotsRoot()).toBe(
      path.join(dataDirs[0], 'tool-screenshots'),
    );
    expect(getToolScreenshotsRoot()).toBe(
      path.join(dataDirs[0], TOOL_SCREENSHOTS.DIR_NAME),
    );
  });
});

describe('getToolScreenshotDir', () => {
  it('普通会话 id 得到 <root>/<sessionId>/ 子目录', () => {
    expect(getToolScreenshotDir('sess_ABC-123')).toBe(
      path.join(dataDirs[0], 'tool-screenshots', 'sess_ABC-123'),
    );
  });

  it('未提供 / 空会话 id 落 no-session 兜底目录', () => {
    const fallback = path.join(dataDirs[0], 'tool-screenshots', 'no-session');
    expect(getToolScreenshotDir(undefined)).toBe(fallback);
    expect(getToolScreenshotDir('')).toBe(fallback);
  });

  it('会话 id 带 ../ 时清洗掉分隔符，无法逃出根目录', () => {
    const root = getToolScreenshotsRoot();
    for (const sessionId of ['../evil', '../../etc', '..//..', 'a/../../b', '../../../tmp/x']) {
      const dir = getToolScreenshotDir(sessionId);
      expect(dir.startsWith(root + path.sep)).toBe(true);
      expect(dir).not.toContain('..');
      // 逃逸的对照：如果分隔符没被清洗，路径会跳出 root
      expect(path.relative(root, dir).startsWith('..')).toBe(false);
    }
    // 纯非法字符清洗后为空 → 兜底
    expect(getToolScreenshotDir('../..')).toBe(path.join(root, TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME));
    expect(getToolScreenshotDir('.. . ..')).toBe(path.join(root, TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME));
  });

  it('允许的字符集 [A-Za-z0-9_-] 原样保留，其余字符剔除', () => {
    expect(getToolScreenshotDir('ses.s/i:o*n')).toBe(
      path.join(dataDirs[0], 'tool-screenshots', 'session'),
    );
    expect(getToolScreenshotDir('9f3c2e80-d1a4_7')).toBe(
      path.join(dataDirs[0], 'tool-screenshots', '9f3c2e80-d1a4_7'),
    );
  });
});
