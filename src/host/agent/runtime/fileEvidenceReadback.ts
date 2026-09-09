import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { makeEvidenceRef, type EvidenceRef } from '../../../shared/contract/evidence';

const MAX_EVIDENCE_READBACK_BYTES = 10 * 1024 * 1024;
const TEXT_DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.html', '.csv']);

/** Shared locator for completion and goal gates. Never repair a missing locator by guessing. */
export function readbackFileEvidence(filePath: string, cwd: string, source: string): {
  evidence: EvidenceRef;
  documentText?: string;
} {
  const canonical = realpathSync(resolve(cwd, filePath));
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.size > MAX_EVIDENCE_READBACK_BYTES) throw new Error('FILE_EVIDENCE_UNREADABLE_OR_TOO_LARGE');
  const bytes = readFileSync(canonical);
  return {
    evidence: makeEvidenceRef({ kind: 'file', ref: canonical, source,
      digest: createHash('sha256').update(bytes).digest('hex'), state: 'read' }),
    ...(TEXT_DOCUMENT_EXTENSIONS.has(extname(canonical).toLowerCase()) ? { documentText: bytes.toString('utf8') } : {}),
  };
}
