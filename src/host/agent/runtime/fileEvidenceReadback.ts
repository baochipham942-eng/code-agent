import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { makeEvidenceRef, type EvidenceRef } from '../../../shared/contract/evidence';

const MAX_EVIDENCE_READBACK_BYTES = 10 * 1024 * 1024;
const TEXT_DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.html', '.csv']);

/**
 * Shared locator for completion and goal gates. Never repair a missing locator by guessing.
 *
 * 「读不回内容」和「文件不存在」是两件事，不许合并成一条打回理由：一个 30MB 的 mp4/pptx
 * 交付物确实在盘上，只是超过了摘要读取上限。基线（statSync().isFile()）对它是放行的，
 * 把它和「不存在」并成一条会让 attempt_completion 被反复打回到预算耗尽，而提示词还说
 * 「产物不可读」。所以：只有 realpath/stat 真的失败（路径不存在、不可达）才抛错；
 * 存在但过大或非普通文件时照样出具存在性证据，只是不带内容摘要、也不做正文断言检查。
 */
export function readbackFileEvidence(filePath: string, cwd: string, source: string): {
  evidence: EvidenceRef;
  documentText?: string;
} {
  const canonical = realpathSync(resolve(cwd, filePath));
  const stat = statSync(canonical);
  if (!stat.isFile()) throw new Error('FILE_EVIDENCE_NOT_A_FILE');
  if (stat.size > MAX_EVIDENCE_READBACK_BYTES) {
    // 存在性成立、内容未读：digest 留空，state 记 'candidate' 而不是 'read'，
    // 别让下游把「没读过」当成「读过且核对无误」。
    return {
      evidence: makeEvidenceRef({ kind: 'file', ref: canonical, source, state: 'candidate' }),
    };
  }
  const bytes = readFileSync(canonical);
  return {
    evidence: makeEvidenceRef({ kind: 'file', ref: canonical, source,
      digest: createHash('sha256').update(bytes).digest('hex'), state: 'read' }),
    ...(TEXT_DOCUMENT_EXTENSIONS.has(extname(canonical).toLowerCase()) ? { documentText: bytes.toString('utf8') } : {}),
  };
}
