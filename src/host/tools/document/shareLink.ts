import * as fs from 'fs';
import * as path from 'path';
import type {
  DeliverableShareLink,
  DeliverableShareLinkInfo,
} from '../../../shared/contract/deliverable';
import { SHARE_SERVICE, SHARE_SERVICE_TIMEOUTS } from '../../../shared/constants/shareService';
import { getConfigService } from '../../services/core/configService';
import {
  listPublishedVersions,
  loadMeta,
  saveMeta,
  type PublishedVersionMeta,
} from './snapshotManager';

type ShareApiResponse = {
  token: string;
  url: string;
  expiresAt: number | null;
  createdAt?: number;
  updatedAt?: number;
  revokedAt?: number;
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function latestPublishedMeta(filePath: string): PublishedVersionMeta | undefined {
  return (loadMeta(filePath).publishedVersions ?? []).reduce<PublishedVersionMeta | undefined>(
    (latest, item) => (!latest || item.version > latest.version ? item : latest),
    undefined,
  );
}

function getServiceContext(): { baseUrl: string; token: string } {
  const configService = getConfigService();
  const token = configService?.getServiceApiKey('neo-share')?.trim();
  if (!token) throw new Error('Share service token not configured');
  const configuredBaseUrl = configService?.getSettings().shareService?.baseUrl?.trim();
  const baseUrl = (configuredBaseUrl || SHARE_SERVICE.DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { baseUrl, token };
}

function hasServiceToken(): boolean {
  return Boolean(getConfigService()?.getServiceApiKey('neo-share')?.trim());
}

function contentHeaders(snapshotPath: string, ttlSeconds: number): Record<string, string> {
  const fileName = path.basename(snapshotPath);
  const encodedName = encodeURIComponent(fileName).replace(/[!'()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return {
    'Content-Type': MIME_BY_EXTENSION[path.extname(snapshotPath).toLowerCase()] ?? 'application/octet-stream',
    'X-Share-Name': `UTF-8''${encodedName}`,
    'X-Share-Ttl-Seconds': String(ttlSeconds),
  };
}

async function shareRequest(
  url: string,
  token: string,
  init: RequestInit,
): Promise<ShareApiResponse> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(SHARE_SERVICE_TIMEOUTS.REQUEST_MS),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Share service request failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return response.json() as Promise<ShareApiResponse>;
}

function readSnapshot(snapshotPath: string): Buffer {
  const stat = fs.statSync(snapshotPath);
  if (stat.size > SHARE_SERVICE.MAX_BYTES) throw new Error('File exceeds 25 MB');
  return fs.readFileSync(snapshotPath);
}

function writeShare(filePath: string, share: DeliverableShareLink): DeliverableShareLinkInfo {
  const meta = loadMeta(filePath);
  meta.share = share;
  saveMeta(filePath, meta);
  return getShareLink(filePath);
}

export function getShareLink(filePath: string): DeliverableShareLinkInfo {
  const meta = loadMeta(filePath);
  const latest = latestPublishedMeta(filePath);
  return {
    share: meta.share ?? null,
    stale: Boolean(meta.share && latest && latest.contentHash !== meta.share.pushedHash),
    latestPublishedVersion: latest?.version,
    tokenConfigured: hasServiceToken(),
  };
}

export async function createShareLink(
  filePath: string,
  ttlSeconds: number,
): Promise<DeliverableShareLinkInfo> {
  const { baseUrl, token } = getServiceContext();
  const latest = listPublishedVersions(filePath)[0];
  if (!latest) throw new Error('No published version');
  const latestMeta = latestPublishedMeta(filePath);
  if (!latestMeta) throw new Error('No published version');
  const bytes = readSnapshot(latest.snapshotPath);
  const result = await shareRequest(`${baseUrl}/api/share`, token, {
    method: 'POST',
    headers: contentHeaders(filePath, ttlSeconds),
    body: Uint8Array.from(bytes),
  });
  return writeShare(filePath, {
    token: result.token,
    url: result.url,
    expiresAt: result.expiresAt,
    createdAt: result.createdAt ?? Date.now(),
    ttlSeconds,
    pushedVersion: latest.version,
    pushedHash: latestMeta.contentHash,
  });
}

export async function updateShareLinkTtl(
  filePath: string,
  ttlSeconds: number,
): Promise<DeliverableShareLinkInfo> {
  const { baseUrl, token } = getServiceContext();
  const meta = loadMeta(filePath);
  const share = meta.share;
  if (!share || share.revokedAt) throw new Error('No active share link');
  const result = await shareRequest(`${baseUrl}/api/share/${share.token}`, token, {
    method: 'PUT',
    headers: {
      'Content-Length': '0',
      'X-Share-Ttl-Seconds': String(ttlSeconds),
    },
  });
  meta.share = { ...share, expiresAt: result.expiresAt, ttlSeconds, lastError: undefined };
  saveMeta(filePath, meta);
  return getShareLink(filePath);
}

export async function pushLatestToShareLink(filePath: string): Promise<DeliverableShareLinkInfo> {
  const { baseUrl, token } = getServiceContext();
  const meta = loadMeta(filePath);
  const share = meta.share;
  if (!share || share.revokedAt) return getShareLink(filePath);
  const latest = listPublishedVersions(filePath)[0];
  const latestMeta = latestPublishedMeta(filePath);
  if (!latest || !latestMeta) return getShareLink(filePath);
  if (latestMeta.contentHash === share.pushedHash) {
    if (latest.version !== share.pushedVersion) {
      meta.share = { ...share, pushedVersion: latest.version, lastError: undefined };
      saveMeta(filePath, meta);
    }
    return getShareLink(filePath);
  }

  try {
    const bytes = readSnapshot(latest.snapshotPath);
    const result = await shareRequest(`${baseUrl}/api/share/${share.token}`, token, {
      method: 'PUT',
      headers: contentHeaders(filePath, share.ttlSeconds),
      body: Uint8Array.from(bytes),
    });
    meta.share = {
      ...share,
      expiresAt: result.expiresAt,
      pushedVersion: latest.version,
      pushedHash: latestMeta.contentHash,
      lastError: undefined,
    };
  } catch (error) {
    meta.share = {
      ...share,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
  saveMeta(filePath, meta);
  return getShareLink(filePath);
}

export async function revokeShareLink(filePath: string): Promise<DeliverableShareLinkInfo> {
  const { baseUrl, token } = getServiceContext();
  const meta = loadMeta(filePath);
  const share = meta.share;
  if (!share) throw new Error('No share link');
  if (share.revokedAt) return getShareLink(filePath);
  const result = await shareRequest(`${baseUrl}/api/share/${share.token}`, token, { method: 'DELETE' });
  meta.share = { ...share, revokedAt: result.revokedAt ?? Date.now(), lastError: undefined };
  saveMeta(filePath, meta);
  return getShareLink(filePath);
}
