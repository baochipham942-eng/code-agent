// ============================================================================
// 前端热更：bundle 完整性校验（sha256）
// ============================================================================
// 下载的 bundle.tar.gz 必须 sha256 == 已验签 manifest.contentHash 才允许应用。
// 兜底铁律：文件不存在/读取失败 → 返回 false，绝不放过损坏或缺失的 bundle。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function verifyBundleIntegrity(
  filePath: string,
  expectedSha256: string,
): Promise<boolean> {
  try {
    const actual = await computeFileSha256(filePath);
    return actual.toLowerCase() === expectedSha256.toLowerCase();
  } catch {
    // 文件不存在 / 读取失败 → 兜底拒绝
    return false;
  }
}
