import type { Browser, CDPSession } from 'playwright';
import {
  parseBrowserDomSnapshot,
  type CdpDomSnapshotPayload,
} from './domSnapshotParser';
import type {
  BrowserDomSnapshot,
  BrowserTab,
  BrowserTargetRefRecord,
} from './types';

export interface BrowserDomSnapshotBuildResult {
  snapshot: BrowserDomSnapshot;
  targetRefRecords: BrowserTargetRefRecord[];
}

interface BrowserWithCdp extends Browser {
  newBrowserCDPSession(): Promise<CDPSession>;
}

function isBrowserWithCdp(browser: Browser | null): browser is BrowserWithCdp {
  return Boolean(browser && typeof (browser as Partial<BrowserWithCdp>).newBrowserCDPSession === 'function');
}

async function discoverUnavailableOopifDocuments(args: {
  page: BrowserTab['page'];
  snapshotId: string;
  capturedFrameIds: Set<string>;
}): Promise<NonNullable<BrowserDomSnapshot['frameDocuments']>> {
  const browser = args.page.context().browser();
  if (!isBrowserWithCdp(browser) || args.capturedFrameIds.size === 0) return [];
  let session: CDPSession | null = null;
  try {
    session = await browser.newBrowserCDPSession();
    const { targetInfos } = await session.send('Target.getTargets');
    const iframeTargets = targetInfos.filter((target) => target.type === 'iframe');
    const reachableParentIds = new Set(args.capturedFrameIds);
    const unavailable: NonNullable<BrowserDomSnapshot['frameDocuments']> = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const target of iframeTargets) {
        if (reachableParentIds.has(target.targetId)) continue;
        const parentId = target.parentFrameId;
        if (!parentId || !reachableParentIds.has(parentId)) continue;
        reachableParentIds.add(target.targetId);
        unavailable.push({
          frameId: target.targetId,
          documentRevision: `document_${args.snapshotId}_${target.targetId}`,
          url: target.url,
          status: 'unavailable',
          reason: 'oopif_requires_dedicated_cdp_session',
        });
        changed = true;
      }
    }
    return unavailable;
  } catch {
    return [];
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

export async function buildBrowserDomSnapshot(args: {
  tab: BrowserTab;
  snapshotId: string;
  capturedAtMs: number;
  targetRefTtlMs: number;
}): Promise<BrowserDomSnapshotBuildResult> {
  const { tab, snapshotId, capturedAtMs, targetRefTtlMs } = args;
  const page = tab.page;
  let session: CDPSession | null = null;
  let payload: CdpDomSnapshotPayload;
  try {
    session = await page.context().newCDPSession(page);
    payload = await session.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
    }) as CdpDomSnapshotPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to capture Host-verifiable browser DOM identity: ${message}`, { cause: error });
  } finally {
    await session?.detach().catch(() => undefined);
  }

  const pageUrl = page.url();
  const parsed = parseBrowserDomSnapshot({
    payload,
    snapshotId,
    tabId: tab.id,
    pageUrl,
    capturedAtMs,
    targetRefTtlMs,
  });
  const unavailableFrames = await discoverUnavailableOopifDocuments({
    page,
    snapshotId,
    capturedFrameIds: new Set(parsed.frameDocuments.map((document) => document.frameId)),
  });

  return {
    snapshot: {
      snapshotId,
      tabId: tab.id,
      capturedAtMs,
      url: pageUrl,
      title: await page.title(),
      headings: parsed.headings,
      frameDocuments: [...parsed.frameDocuments, ...unavailableFrames],
      interactiveElements: parsed.interactiveElements,
    },
    targetRefRecords: parsed.targetRefRecords,
  };
}
