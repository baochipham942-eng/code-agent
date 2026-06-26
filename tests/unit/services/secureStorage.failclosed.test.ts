import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 锁住 secureStorage 的三条安全不变量（纯回归测试，不改实现）：
//   1. fail-closed 不清盘：新 key + legacy key 双双解密失败时，磁盘文件字节不被覆盖
//   2. 掩码 round-trip：set→get 取回原值，且磁盘上绝不出现明文
//   3. safeStorage 不可用降级：仍走 AES 加密落盘，绝不落明文
//
// 通过 getSecureStorage() 公共入口测试（LocalEncryptedStore 未导出）。
// mock platform 模块：让 app.getPath('userData') 确定性返回临时目录，并可控 safeStorage —
// 避免依赖 getUserDataPath 的模块级缓存（不稳定，且可能误写用户真实 ~/.code-agent）。

const platformState = vi.hoisted(() => ({
  dataDir: '',
  encryptionAvailable: false,
}));

vi.mock('../../../src/host/platform', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? platformState.dataDir : platformState.dataDir),
  },
  safeStorage: {
    isEncryptionAvailable: () => platformState.encryptionAvailable,
    encryptString: (plainText: string) => Buffer.from(plainText),
    decryptString: (encrypted: Buffer) => encrypted.toString(),
  },
}));

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secstore-test-'));
  platformState.dataDir = dir;
  return dir;
}

async function loadService() {
  process.env.CODE_AGENT_CLI_MODE = '1'; // 跳过 keytar（native 模块），只走 electron-store 加密路径
  vi.resetModules();
  const mod = await import('../../../src/host/services/core/secureStorage');
  return mod.getSecureStorage();
}

// 复刻 LocalEncryptedStore 的 AES-256-GCM 加密格式，用任意 key 造一个“外来”加密文件
function encryptWithKey(plain: string, keyStr: string): string {
  const key = crypto.createHash('sha256').update(keyStr).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  });
}

beforeEach(() => {
  platformState.encryptionAvailable = false;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.CODE_AGENT_CLI_MODE;
});

describe('secureStorage 安全不变量回归', () => {
  it('fail-closed：新 key 与 legacy key 双双解密失败时，绝不清空磁盘文件', async () => {
    const dir = freshDir();
    // 预置一个已知的持久化 key（64 hex），让服务用它作为新 key
    fs.writeFileSync(path.join(dir, '.secure-key'), 'a'.repeat(64), { mode: 0o600 });
    // 预置一个用“完全不同的 key”加密的 secure-storage.json —— 新 key 和 legacy key 都解不开
    const storeFile = path.join(dir, 'secure-storage.json');
    const foreignContent = encryptWithKey(
      JSON.stringify({ 'supabase.session': 'should-survive-onto-disk' }),
      'a-totally-unrelated-foreign-key-no-match'
    );
    fs.writeFileSync(storeFile, foreignContent, { mode: 0o600 });
    const bytesBefore = fs.readFileSync(storeFile);

    const svc = await loadService();

    // 解密失败 → 返回空，读不到任何值（数据没被错误地以明文/空值覆盖）
    expect(svc.get('supabase.session')).toBeUndefined();
    expect(svc.getApiKey('deepseek')).toBeUndefined();

    // 关键不变量：磁盘文件字节未被改动（没有被清空或重写）
    const bytesAfter = fs.readFileSync(storeFile);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
    expect(bytesAfter.toString('utf-8')).toBe(foreignContent);
  });

  it('round-trip：setApiKey→getApiKey 取回原值，且磁盘上不出现明文', async () => {
    const dir = freshDir();
    const svc = await loadService();

    const secret = 'sk-secret-PLAINTEXT-MUST-NOT-LEAK-9f8e7d';
    svc.setApiKey('deepseek', secret);

    // 内存往返正确
    expect(svc.getApiKey('deepseek')).toBe(secret);

    // 重新加载一个实例（清缓存）后仍能取回 → 证明真的持久化了而非只在内存
    const svc2 = await loadService();
    expect(svc2.getApiKey('deepseek')).toBe(secret);

    // 磁盘文件绝不包含明文
    const raw = fs.readFileSync(path.join(dir, 'secure-storage.json'), 'utf-8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('PLAINTEXT-MUST-NOT-LEAK');
  });

  it('safeStorage 不可用时仍走 AES 加密落盘（合法的 iv/tag/data 密文，非明文）', async () => {
    const dir = freshDir();
    platformState.encryptionAvailable = false; // 显式模拟 safeStorage 不可用
    const svc = await loadService();

    const secret = 'sk-zhipu-NEVER-PLAINTEXT-abc123';
    svc.setApiKey('zhipu', secret);

    const raw = fs.readFileSync(path.join(dir, 'secure-storage.json'), 'utf-8');
    const payload = JSON.parse(raw) as Record<string, unknown>;
    // 落盘是标准 AES-256-GCM payload 结构
    expect(typeof payload.iv).toBe('string');
    expect(typeof payload.tag).toBe('string');
    expect(typeof payload.data).toBe('string');
    // 且明文不可见
    expect(raw).not.toContain(secret);
    // round-trip 仍成立
    expect(svc.getApiKey('zhipu')).toBe(secret);
  });
});
