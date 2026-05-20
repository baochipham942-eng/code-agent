import { parseBrowserTargetRefInput } from './managedBrowserHelpers';
import {
  BrowserTargetRefError,
  type BrowserTab,
  type BrowserTargetRef,
  type BrowserTargetRefRecord,
} from './types';

export class BrowserTargetRefRegistry {
  private records: Map<string, BrowserTargetRefRecord> = new Map();
  private snapshotSequence = 0;

  clear(): void {
    this.records.clear();
  }

  createSnapshotId(): string {
    this.snapshotSequence += 1;
    return `snapshot_${Date.now()}_${this.snapshotSequence}`;
  }

  addRecords(records: BrowserTargetRefRecord[], now = Date.now()): void {
    this.prune(now);
    for (const record of records) {
      this.records.set(record.targetRef.refId, record);
    }
  }

  prune(now = Date.now()): void {
    for (const [refId, record] of this.records.entries()) {
      const ageMs = now - record.targetRef.capturedAtMs;
      if (ageMs > record.targetRef.ttlMs) {
        this.records.delete(refId);
      }
    }
  }

  async resolve(
    targetRefInput: unknown,
    getTab: (tabId: string) => BrowserTab,
    overrideTabId?: string,
  ): Promise<{ targetRef: BrowserTargetRef }> {
    this.prune();
    const { refId, snapshotId } = parseBrowserTargetRefInput(targetRefInput);
    if (!refId) {
      throw new BrowserTargetRefError('targetRef.refId is required. Refresh the DOM snapshot and retry with a fresh targetRef.', null, snapshotId);
    }

    const record = this.records.get(refId);
    if (!record) {
      throw new BrowserTargetRefError(`TargetRef ${refId} is stale or unknown. Refresh the DOM snapshot and retry.`, refId, snapshotId);
    }
    if (snapshotId && record.targetRef.snapshotId !== snapshotId) {
      throw new BrowserTargetRefError(`TargetRef ${refId} does not belong to snapshot ${snapshotId}. Refresh the DOM snapshot and retry.`, refId, snapshotId);
    }

    const tabId = overrideTabId || record.targetRef.tabId;
    if (tabId !== record.targetRef.tabId) {
      throw new BrowserTargetRefError(`TargetRef ${refId} belongs to a different tab. Refresh the DOM snapshot for the active tab and retry.`, refId, record.targetRef.snapshotId);
    }

    const tab = getTab(tabId);
    if (tab.page.url() !== record.url) {
      throw new BrowserTargetRefError(`TargetRef ${refId} is stale after navigation. Refresh the DOM snapshot and retry.`, refId, record.targetRef.snapshotId);
    }

    const element = await tab.page.$(record.targetRef.selector);
    if (!element) {
      throw new BrowserTargetRefError(`TargetRef ${refId} no longer resolves to an element. Refresh the DOM snapshot and retry.`, refId, record.targetRef.snapshotId);
    }
    await element.dispose().catch(() => undefined);

    return { targetRef: record.targetRef };
  }
}
