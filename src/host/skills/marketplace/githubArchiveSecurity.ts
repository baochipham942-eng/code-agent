import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import JSZip from 'jszip';

export const MAX_GITHUB_ARCHIVE_BYTES = 50 * 1024 * 1024;

export async function downloadArchive(
  url: string,
  maxBytes = MAX_GITHUB_ARCHIVE_BYTES,
): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub archive download failed (${response.status}) for ${url}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(
      `GitHub archive exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB download limit`,
    );
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new Error(
          `GitHub archive exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB download limit`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    receivedBytes = chunk.byteLength;
    chunks.push(chunk);
  }
  if (receivedBytes > maxBytes) {
    throw new Error(
      `GitHub archive exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB download limit`,
    );
  }
  return Buffer.concat(chunks, receivedBytes);
}

export function getArchiveSha256(archive: Buffer): string {
  return createHash('sha256').update(archive).digest('hex');
}

function assertSafeZipEntry(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const isAbsolute = normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized);
  if (isAbsolute || segments.includes('..')) {
    throw new Error(`Unsafe zip entry path rejected: ${entryName}`);
  }
}

/**
 * TOFU boundary: the first downloaded archive is trusted and recorded. This
 * prevents post-install drift, but cannot make a malicious first install safe.
 * Cryptographic signing is intentionally deferred to the C2 remote marketplace.
 */
export function assertTrustedArchiveHash(
  previousHash: string | undefined,
  downloadedHash: string,
): void {
  if (previousHash && previousHash !== downloadedHash) {
    throw new Error(
      `Plugin content drift detected: expected sha256 ${previousHash}, received ${downloadedHash}`,
    );
  }
}

export async function extractZipSafely(archive: Buffer, destDir: string): Promise<void> {
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files);

  for (const entry of entries) {
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName
      ?? entry.name;
    assertSafeZipEntry(originalName);
  }

  await fs.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const outputPath = path.join(destDir, entry.name);
    if (entry.dir) {
      await fs.mkdir(outputPath, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, await entry.async('nodebuffer'));
  }
}
