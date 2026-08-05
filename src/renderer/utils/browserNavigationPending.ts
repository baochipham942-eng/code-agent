// 浏览器地址栏导航 pending 态（二期 N1）：
// 回车后立刻锁定归一化 URL + 反馈，导航落地后再回写真实 URL；
// 失败则保留错误并可还原，避免「输入被清空且无反馈」窗口。

export type BrowserNavigationPendingStatus = 'pending' | 'failed';

export interface BrowserNavigationPending {
  url: string;
  status: BrowserNavigationPendingStatus;
  error?: string;
  /** 进入 pending 前地址栏上的 URL（失败时还原用） */
  previousUrl: string | null;
}

/** 判断页面真实 URL 是否已经落到用户请求的导航目标（同源或完整匹配）。 */
export function navigationTargetSettled(activeUrl: string | null | undefined, pendingUrl: string): boolean {
  if (!activeUrl) return false;
  try {
    const active = new URL(activeUrl);
    const pending = new URL(pendingUrl);
    if (active.href === pending.href) return true;
    // surface 只回 origin 时：同源即视为落地（path 随后由 managedUrl 补全）。
    if (active.origin === pending.origin) {
      if (active.pathname === '/' && !active.search && !active.hash) return true;
      return active.href.startsWith(pending.origin);
    }
    // 跨子域跳转（baidu.com → www.baidu.com）也算落地：主机尾部互为后缀即同站。
    const activeHost = active.hostname.replace(/^www\./, '');
    const pendingHost = pending.hostname.replace(/^www\./, '');
    if (activeHost === pendingHost
      || activeHost.endsWith(`.${pendingHost}`)
      || pendingHost.endsWith(`.${activeHost}`)) {
      return true;
    }
    return false;
  } catch {
    return activeUrl === pendingUrl
      || activeUrl.startsWith(pendingUrl)
      || pendingUrl.startsWith(activeUrl);
  }
}

export function createNavigationPending(
  url: string,
  previousUrl: string | null,
): BrowserNavigationPending {
  return { url, status: 'pending', previousUrl };
}

export function failNavigationPending(
  pending: BrowserNavigationPending,
  error: string,
): BrowserNavigationPending {
  return { ...pending, status: 'failed', error };
}

/** 地址栏失焦是否允许还原到 activeUrl——pending 期间禁止清空用户输入。 */
export function shouldRestoreAddressOnBlur(
  pending: BrowserNavigationPending | null,
): boolean {
  return pending === null;
}

/** 地址栏应显示的草稿：pending 优先于远端 activeUrl。 */
export function resolveAddressDraft(input: {
  pending: BrowserNavigationPending | null;
  activeUrl: string | null;
  editingDraft: string;
  addressEditing: boolean;
}): string {
  if (input.pending) return input.pending.url;
  if (input.addressEditing) return input.editingDraft;
  return input.activeUrl ?? '';
}
