import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// app.getPath('userData') 优先于 CODE_AGENT_DATA_DIR，测里必须让它缺席，
// 否则 store 会落到 electron mock 的目录上，测的就不是本用例说的那件事。
vi.mock('../../../../src/host/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  app: null,
}));

describe('readModelCredentialsFromDataDir', () => {
  let root: string;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'securestore-'));
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('跨目录只读取模型凭据，会话/审批那几类一条都不给', async () => {
    const source = path.join(root, 'source');
    process.env.CODE_AGENT_DATA_DIR = source;
    const mod = await import('../../../../src/host/services/core/secureStorage');
    const store = mod.getSecureStorage();
    store.set('apikey.deepseek', 'sk-prod-deepseek');
    store.set('serviceBaseUrl.openai', 'https://example.test/v1');
    store.set('settings.devModeAutoApprove', 'true');
    store.set('supabase.session', 'session-blob');
    store.set('auth.saved_password', 'hunter2');

    // 真读盘：加密文件 + .secure-key 都在 source 目录里
    expect(fs.existsSync(path.join(source, 'secure-storage.json'))).toBe(true);
    const credentials = mod.readModelCredentialsFromDataDir(source);

    expect(credentials).toEqual({
      'apikey.deepseek': 'sk-prod-deepseek',
      'serviceBaseUrl.openai': 'https://example.test/v1',
    });
  });

  it('目录里没有 .secure-key 时安静返回空，不抛不写', async () => {
    process.env.CODE_AGENT_DATA_DIR = path.join(root, 'self');
    const mod = await import('../../../../src/host/services/core/secureStorage');
    const empty = path.join(root, 'nothing-here');
    fs.mkdirSync(empty, { recursive: true });
    expect(mod.readModelCredentialsFromDataDir(empty)).toEqual({});
    expect(fs.readdirSync(empty)).toEqual([]);
  });
});
