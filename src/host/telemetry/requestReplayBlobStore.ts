import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import type { RequestManifestAttachmentBlobRef } from '../agent/runtime/turnTrace';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('RequestReplayBlobStore');
const BLOB_SUBDIR = 'request-replay-blobs';

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function blobRoot(): string {
  return path.join(getUserConfigDir(), BLOB_SUBDIR);
}

function decodeCanonicalBase64(base64: string): Buffer | null {
  try {
    const content = Buffer.from(base64, 'base64');
    return content.toString('base64') === base64 ? content : null;
  } catch {
    return null;
  }
}

/** Store model-visible attachment bytes outside content_cache. */
export function storeRequestReplayBlob(base64: string): RequestManifestAttachmentBlobRef | null {
  const content = decodeCanonicalBase64(base64);
  if (!content) {
    logger.warn('Attachment is not canonical base64; request replay will be degraded');
    return null;
  }
  const contentHash = sha256(content);
  const bytes = content.byteLength;
  const dir = path.join(blobRoot(), contentHash.slice(0, 2));
  const filePath = path.join(dir, `${contentHash}.blob`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath);
      if (existing.byteLength !== bytes || sha256(existing) !== contentHash) {
        logger.error('Existing request replay blob failed content-address verification', { contentHash });
        return null;
      }
    } else {
      fs.writeFileSync(filePath, content, { flag: 'wx' });
    }
    return { version: 1, filePath, sha256: contentHash, bytes };
  } catch (error) {
    // The caller turns this into manifest.degraded=true. Never fall back to
    // content_cache, because that would put the base64 payload back in SQLite.
    logger.warn('Failed to externalize request replay attachment', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Read and verify an externalized attachment, returning canonical base64. */
export function readRequestReplayBlob(ref: RequestManifestAttachmentBlobRef): string | null {
  try {
    const root = path.resolve(blobRoot());
    const resolved = path.resolve(ref.filePath);
    if (!resolved.startsWith(`${root}${path.sep}`)) return null;
    const content = fs.readFileSync(resolved);
    if (content.byteLength !== ref.bytes || sha256(content) !== ref.sha256) return null;
    return content.toString('base64');
  } catch {
    return null;
  }
}
