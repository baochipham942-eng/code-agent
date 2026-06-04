import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeFileSha256,
  verifyBundleIntegrity,
} from '../../src/main/services/renderer/rendererBundleIntegrity';

// 'hello' 的 sha256（固定常量，自证测试不依赖实现）
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

describe('rendererBundleIntegrity（sha256 完整性校验 + 兜底）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rbi-'));
    file = join(dir, 'bundle.tar.gz');
    writeFileSync(file, 'hello');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('computeFileSha256 对已知内容返回正确 hash', async () => {
    expect(await computeFileSha256(file)).toBe(HELLO_SHA);
  });

  it('hash 匹配（大小写不敏感）→ 通过', async () => {
    expect(await verifyBundleIntegrity(file, HELLO_SHA)).toBe(true);
    expect(await verifyBundleIntegrity(file, HELLO_SHA.toUpperCase())).toBe(true);
  });

  it('hash 不匹配 → 拒绝（兜底，绝不放过损坏 bundle）', async () => {
    expect(await verifyBundleIntegrity(file, 'deadbeef')).toBe(false);
  });

  it('文件不存在 → 拒绝（兜底，不抛异常）', async () => {
    expect(await verifyBundleIntegrity(join(dir, 'nope.tar.gz'), HELLO_SHA)).toBe(false);
  });
});
