import {
  createShareLink,
  getShareLink,
  pushLatestToShareLink,
  revokeShareLink,
  updateShareLinkTtl,
} from '../tools/modules/document/shareLink';

export async function handleWorkspaceShareLinkAction(action: string, payload: unknown): Promise<unknown> {
  const { filePath, ttlSeconds } = payload as { filePath: string; ttlSeconds?: number };
  switch (action) {
    case 'getShareLink': return getShareLink(filePath);
    case 'createShareLink': return createShareLink(filePath, ttlSeconds ?? 0);
    case 'updateShareLinkTtl': return updateShareLinkTtl(filePath, ttlSeconds ?? 0);
    case 'pushShareLink': return pushLatestToShareLink(filePath);
    case 'revokeShareLink': return revokeShareLink(filePath);
    default: throw new Error(`Unsupported share link action: ${action}`);
  }
}
