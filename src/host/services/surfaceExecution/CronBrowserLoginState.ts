import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserService } from '../infra/browserService';
import type {
  BrowserStorageStateCookie,
  BrowserStorageStateLike,
  BrowserStorageStateOrigin,
} from '../infra/browser/types';

function normalizeHttpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function cookieBelongsToHost(cookie: BrowserStorageStateCookie, host: string): boolean {
  if (typeof cookie.domain !== 'string') return false;
  const domain = cookie.domain.trim().toLowerCase().replace(/^\.+/, '');
  // 登录墙元数据是精确 origin。父域 cookie 也可能触达兄弟 origin，因此只透传
  // 作用域正好落在该 host 的 cookie（前导点 host cookie 会归一化为同一 host）。
  return Boolean(domain) && host === domain;
}

/** 仅保留作用域属于指定站点 origin 的 cookie 与 Web Storage。 */
export function filterBrowserStorageStateForOrigin(
  state: BrowserStorageStateLike,
  siteOrigin: string,
): BrowserStorageStateLike {
  const normalizedOrigin = normalizeHttpOrigin(siteOrigin);
  if (!normalizedOrigin) return { cookies: [], origins: [] };
  const host = new URL(normalizedOrigin).hostname.toLowerCase();
  const cookies = (Array.isArray(state.cookies) ? state.cookies : [])
    .filter((candidate): candidate is BrowserStorageStateCookie => (
      Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
    ))
    .filter((cookie) => cookieBelongsToHost(cookie, host));
  const origins = (Array.isArray(state.origins) ? state.origins : [])
    .filter((candidate): candidate is BrowserStorageStateOrigin => (
      Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
    ))
    .filter((origin) => (
      typeof origin.origin === 'string'
      && normalizeHttpOrigin(origin.origin) === normalizedOrigin
    ));
  return { cookies, origins };
}

/**
 * 导出个人 profile 状态，收窄到单一 origin 后导入 cron 隔离浏览器。
 * 临时文件位于工作区之外，并在本次运行结束前清理。
 */
export async function importBrowserStorageStateForOrigin(
  sourceBrowser: BrowserService,
  targetBrowser: BrowserService,
  siteOrigin: string,
): Promise<boolean> {
  const temporaryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'neo-cron-login-'));
  const sourcePath = path.join(temporaryDir, 'source.json');
  const filteredPath = path.join(temporaryDir, 'filtered.json');
  let primaryError: unknown;
  let imported = false;
  try {
    await sourceBrowser.exportStorageState(sourcePath);
    await fs.promises.chmod(sourcePath, 0o600);
    const rawState = JSON.parse(await fs.promises.readFile(sourcePath, 'utf8')) as BrowserStorageStateLike;
    const filteredState = filterBrowserStorageStateForOrigin(rawState, siteOrigin);
    if ((!Array.isArray(filteredState.cookies) || filteredState.cookies.length === 0)
      && (!Array.isArray(filteredState.origins) || filteredState.origins.length === 0)) {
      return false;
    }
    await fs.promises.writeFile(filteredPath, JSON.stringify(filteredState), { encoding: 'utf8', mode: 0o600 });
    await targetBrowser.importStorageState(filteredPath);
    imported = true;
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await fs.promises.rm(temporaryDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Cron browser login state import and temporary-file cleanup both failed.',
      { cause: cleanupError },
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return imported;
}
