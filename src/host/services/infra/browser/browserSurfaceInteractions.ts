import type { Dialog } from 'playwright';
import { buildBrowserDomSnapshot } from './domSnapshotBuilder';
import { BROWSER_TARGET_REF_TTL_MS } from './managedBrowserHelpers';
import { BrowserTargetRefRegistry } from './targetRefRegistry';
import type {
  BrowserDialogState,
  BrowserDomSnapshot,
  BrowserTab,
  BrowserTargetRef,
} from './types';

export interface BrowserPendingDialog {
  dialog: Dialog;
  openedAtMs: number;
}

type GetBrowserTab = (tabId?: string) => BrowserTab;

export async function waitForBrowserSelector(
  tab: BrowserTab,
  selector: string,
  timeout: number,
): Promise<boolean> {
  try {
    await tab.page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

export async function captureBrowserDomSnapshot(
  tab: BrowserTab,
  registry: BrowserTargetRefRegistry,
): Promise<BrowserDomSnapshot> {
  const snapshotId = registry.createSnapshotId();
  const capturedAtMs = Date.now();
  const { snapshot, targetRefRecords } = await buildBrowserDomSnapshot({
    tab,
    snapshotId,
    capturedAtMs,
    targetRefTtlMs: BROWSER_TARGET_REF_TTL_MS,
  });
  registry.addRecords(targetRefRecords, capturedAtMs);
  return snapshot;
}

export async function getBrowserAccessibilitySnapshot(
  tab: BrowserTab,
  domSnapshot: () => Promise<BrowserDomSnapshot>,
): Promise<unknown> {
  const page = tab.page as unknown as {
    accessibility?: { snapshot(options?: { interestingOnly?: boolean }): Promise<unknown> };
  };
  if (page.accessibility?.snapshot) {
    return page.accessibility.snapshot({ interestingOnly: true });
  }
  return {
    fallback: 'playwright_accessibility_snapshot_unavailable',
    domSnapshot: await domSnapshot(),
  };
}

function dialogType(value: string): BrowserDialogState['type'] | undefined {
  switch (value) {
    case 'alert':
    case 'beforeunload':
    case 'confirm':
    case 'prompt':
      return value;
    default:
      return undefined;
  }
}

function clipboardOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null') {
      return url.origin;
    }
  } catch {
    // Fall through to the stable policy error below.
  }
  throw new Error('SURFACE_POLICY_BLOCKED: browser clipboard requires a concrete HTTP(S) origin');
}

export async function hoverBrowserTargetRef(args: {
  getTab: GetBrowserTab;
  registry: BrowserTargetRefRegistry;
  tabId?: string;
  targetRefInput: unknown;
}): Promise<BrowserTargetRef> {
  const resolved = await args.registry.resolveBounds(args.targetRefInput, args.getTab, args.tabId);
  const page = args.getTab(resolved.targetRef.tabId).page;
  await page.mouse.move(
    resolved.bounds.x + (resolved.bounds.width / 2),
    resolved.bounds.y + (resolved.bounds.height / 2),
  );
  return resolved.targetRef;
}

export async function dragBrowserTargetRefs(args: {
  destinationTargetRefInput: unknown;
  getTab: GetBrowserTab;
  registry: BrowserTargetRefRegistry;
  sourceTargetRefInput: unknown;
  tabId?: string;
}): Promise<{ source: BrowserTargetRef; destination: BrowserTargetRef }> {
  const preparedSource = await args.registry.resolveBounds(
    args.sourceTargetRefInput,
    args.getTab,
    args.tabId,
  );
  await args.registry.resolveBounds(
    args.destinationTargetRefInput,
    args.getTab,
    preparedSource.targetRef.tabId,
  );
  const source = await args.registry.resolveBounds(
    args.sourceTargetRefInput,
    args.getTab,
    preparedSource.targetRef.tabId,
    { scrollIntoView: false },
  );
  const destination = await args.registry.resolveBounds(
    args.destinationTargetRefInput,
    args.getTab,
    preparedSource.targetRef.tabId,
    { scrollIntoView: false },
  );
  const page = args.getTab(source.targetRef.tabId).page;
  const sourceX = source.bounds.x + (source.bounds.width / 2);
  const sourceY = source.bounds.y + (source.bounds.height / 2);
  const destinationX = destination.bounds.x + (destination.bounds.width / 2);
  const destinationY = destination.bounds.y + (destination.bounds.height / 2);
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  try {
    await page.mouse.move(destinationX, destinationY, { steps: 10 });
  } finally {
    await page.mouse.up().catch(() => undefined);
  }
  return { source: source.targetRef, destination: destination.targetRef };
}

export function getBrowserDialogState(args: {
  getTab: GetBrowserTab;
  pendingDialogs: Map<string, BrowserPendingDialog>;
  tabId?: string;
}): BrowserDialogState {
  const tab = args.getTab(args.tabId);
  const pending = args.pendingDialogs.get(tab.id);
  if (!pending) return { pending: false, defaultPolicy: 'pause' };
  const type = dialogType(pending.dialog.type());
  return {
    pending: true,
    ...(type ? { type } : {}),
    messageLength: pending.dialog.message().length,
    openedAtMs: pending.openedAtMs,
    defaultPolicy: 'pause',
  };
}

export async function handleBrowserDialog(args: {
  action: 'accept' | 'dismiss';
  emitChanged: () => void;
  getTab: GetBrowserTab;
  pendingDialogs: Map<string, BrowserPendingDialog>;
  promptText?: string;
  tabId?: string;
}): Promise<BrowserDialogState> {
  const tab = args.getTab(args.tabId);
  const pending = args.pendingDialogs.get(tab.id);
  if (!pending) throw new Error('SURFACE_DIALOG_BLOCKED: no paused browser dialog is available');
  if (args.promptText !== undefined
    && (args.action !== 'accept' || pending.dialog.type() !== 'prompt')) {
    throw new Error('SURFACE_POLICY_BLOCKED: dialogPromptText is only allowed when accepting a prompt dialog');
  }
  const state = getBrowserDialogState(args);
  if (args.action === 'accept') await pending.dialog.accept(args.promptText);
  else await pending.dialog.dismiss();
  if (args.pendingDialogs.get(tab.id)?.dialog === pending.dialog) args.pendingDialogs.delete(tab.id);
  args.emitChanged();
  return state;
}

export async function readBrowserClipboardMetadata(tab: BrowserTab): Promise<{ textLength: number }> {
  const origin = clipboardOrigin(tab.page.url());
  await tab.page.context().grantPermissions(['clipboard-read'], { origin });
  try {
    const textLength = await tab.page.evaluate(async () => {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable');
      return (await navigator.clipboard.readText()).length;
    });
    return { textLength };
  } finally {
    await tab.page.context().clearPermissions().catch(() => undefined);
  }
}

export async function writeBrowserClipboard(tab: BrowserTab, text: string): Promise<void> {
  if (text.length > 100_000) throw new Error('Clipboard text exceeds the managed browser limit');
  const origin = clipboardOrigin(tab.page.url());
  await tab.page.context().grantPermissions(['clipboard-write'], { origin });
  try {
    await tab.page.evaluate(async (value) => {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard write is unavailable');
      await navigator.clipboard.writeText(value);
    }, text);
  } finally {
    await tab.page.context().clearPermissions().catch(() => undefined);
  }
}
