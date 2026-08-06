/**
 * Cookie import IPC client for the browser panel ⋯ menu (P1).
 * Target is the shared personal managed profile (same as P0 user browse).
 */
import type {
  BrowserCookieImportResult,
  BrowserProfileDescriptor,
  BrowserProfileSourceId,
} from '../../shared/contract/desktop';
import { IPC_DOMAINS } from '../../shared/ipc/domains';
import { ipcService } from './ipcService';

export async function listImportableBrowserProfiles(): Promise<BrowserProfileDescriptor[]> {
  const list = await ipcService.invokeDomain<BrowserProfileDescriptor[]>(
    IPC_DOMAINS.DESKTOP,
    'listBrowserProfiles',
  );
  return Array.isArray(list) ? list : [];
}

export async function importBrowserProfileCookiesToPersonal(args: {
  source: BrowserProfileSourceId;
  profileId: string;
}): Promise<BrowserCookieImportResult> {
  const response = await ipcService.invokeDomain<{ result?: BrowserCookieImportResult } | BrowserCookieImportResult>(
    IPC_DOMAINS.DESKTOP,
    'importBrowserProfileCookies',
    {
      source: args.source,
      profileId: args.profileId,
      userConfirmed: true,
    },
  );
  if (response && typeof response === 'object' && 'result' in response && response.result) {
    return response.result;
  }
  return response as BrowserCookieImportResult;
}
