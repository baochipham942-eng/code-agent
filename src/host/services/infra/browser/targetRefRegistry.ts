import { randomUUID } from 'node:crypto';
import type { CDPSession } from 'playwright';
import { parseBrowserTargetRefInput } from './managedBrowserHelpers';
import {
  BrowserTargetRefError,
  type BrowserTab,
  type BrowserTargetRef,
  type BrowserTargetRefRecord,
} from './types';

interface ResolvedNodeIdentity {
  connected: boolean;
  documentUrl: string | null;
}

export interface ResolvedBrowserTargetBounds {
  targetRef: BrowserTargetRef;
  bounds: { x: number; y: number; width: number; height: number };
}

export class BrowserTargetRefRegistry {
  private records: Map<string, BrowserTargetRefRecord> = new Map();

  clear(): void {
    this.records.clear();
  }

  createSnapshotId(): string {
    return `snapshot_${randomUUID()}`;
  }

  addRecords(records: BrowserTargetRefRecord[], now = Date.now()): void {
    this.prune(now);
    // A fresh observed document state supersedes all prior backend node identities,
    // including same-URL DOM revisions.
    this.records.clear();
    for (const record of records) this.records.set(record.targetRef.refId, record);
  }

  prune(now = Date.now()): void {
    for (const [refId, record] of this.records.entries()) {
      if (now - record.targetRef.capturedAtMs > record.targetRef.ttlMs) {
        this.records.delete(refId);
      }
    }
  }

  async resolve(
    targetRefInput: unknown,
    getTab: (tabId: string) => BrowserTab,
    overrideTabId?: string,
  ): Promise<{ targetRef: BrowserTargetRef }> {
    return await this.withResolvedNode(targetRefInput, getTab, overrideTabId, async (_session, _objectId, targetRef) => ({
      targetRef,
    }));
  }

  async click(
    targetRefInput: unknown,
    getTab: (tabId: string) => BrowserTab,
    overrideTabId?: string,
  ): Promise<BrowserTargetRef> {
    const resolved = await this.resolveBounds(targetRefInput, getTab, overrideTabId);
    await getTab(resolved.targetRef.tabId).page.mouse.click(
      resolved.bounds.x + (resolved.bounds.width / 2),
      resolved.bounds.y + (resolved.bounds.height / 2),
    );
    return resolved.targetRef;
  }

  async fill(
    targetRefInput: unknown,
    text: string,
    getTab: (tabId: string) => BrowserTab,
    overrideTabId?: string,
  ): Promise<BrowserTargetRef> {
    return await this.withResolvedNode(targetRefInput, getTab, overrideTabId, async (session, objectId, targetRef) => {
      const filled = await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(value) {
          if (!this || this.isConnected !== true) return false;
          if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
            const prototype = this instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (!setter) return false;
            setter.call(this, value);
          } else if (this.isContentEditable) {
            this.textContent = value;
          } else {
            return false;
          }
          this.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }`,
        arguments: [{ value: text }],
        returnByValue: true,
        userGesture: true,
      });
      if (filled.result.value !== true) {
        throw this.stale(targetRef, 'no longer resolves to a fillable element');
      }
      return targetRef;
    });
  }

  async resolveBounds(
    targetRefInput: unknown,
    getTab: (tabId: string) => BrowserTab,
    overrideTabId?: string,
    options: { scrollIntoView?: boolean } = {},
  ): Promise<ResolvedBrowserTargetBounds> {
    return await this.withResolvedNode(targetRefInput, getTab, overrideTabId, async (session, _objectId, targetRef) => {
      if (options.scrollIntoView !== false) {
        await session.send('DOM.scrollIntoViewIfNeeded', {
          backendNodeId: targetRef.backendNodeId as number,
        });
      }
      const box = await session.send('DOM.getBoxModel', {
        backendNodeId: targetRef.backendNodeId as number,
      });
      const quad = box.model?.border || box.model?.content;
      if (!Array.isArray(quad) || quad.length < 8) {
        throw this.stale(targetRef, 'has no current visible bounds');
      }
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
        throw this.stale(targetRef, 'has invalid or empty current bounds');
      }
      return {
        targetRef,
        bounds: {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        },
      };
    });
  }

  private async withResolvedNode<T>(
    targetRefInput: unknown,
    getTab: (tabId: string) => BrowserTab,
    overrideTabId: string | undefined,
    action: (
      session: CDPSession,
      objectId: string,
      targetRef: BrowserTargetRef,
    ) => Promise<T>,
  ): Promise<T> {
    const record = this.requireRecord(targetRefInput, overrideTabId);
    const targetRef = record.targetRef;
    const tab = getTab(targetRef.tabId);
    if (tab.page.url() !== record.url) {
      throw this.stale(targetRef, 'is stale after tab navigation');
    }
    if (!Number.isSafeInteger(targetRef.backendNodeId)) {
      throw this.stale(
        targetRef,
        'has no Host-captured backend node identity; the frame may be an unavailable OOPIF',
      );
    }

    let session: CDPSession | null = null;
    let objectId: string | null = null;
    try {
      session = await tab.page.context().newCDPSession(tab.page);
      const resolved = await session.send('DOM.resolveNode', {
        backendNodeId: targetRef.backendNodeId as number,
      });
      objectId = resolved.object.objectId || null;
      if (!objectId) throw this.stale(targetRef, 'no longer resolves to a live DOM node');
      const checked = await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          return {
            connected: this?.isConnected === true,
            documentUrl: this?.ownerDocument?.URL || null,
          };
        }`,
        returnByValue: true,
      });
      const identity = checked.result.value as ResolvedNodeIdentity | undefined;
      if (!identity?.connected || identity.documentUrl !== (record.documentUrl || record.url)) {
        throw this.stale(targetRef, 'belongs to a stale or different frame document');
      }
      return await action(session, objectId, targetRef);
    } catch (error) {
      if (error instanceof BrowserTargetRefError) throw error;
      throw this.stale(targetRef, 'cannot be safely resolved from its Host-captured backend identity');
    } finally {
      if (session && objectId) {
        await session.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
      await session?.detach().catch(() => undefined);
    }
  }

  private requireRecord(
    targetRefInput: unknown,
    overrideTabId?: string,
  ): BrowserTargetRefRecord {
    this.prune();
    const { refId, snapshotId } = parseBrowserTargetRefInput(targetRefInput);
    if (!refId) {
      throw new BrowserTargetRefError(
        'targetRef.refId is required. Refresh the DOM snapshot and retry with a fresh targetRef.',
        null,
        snapshotId,
      );
    }
    const record = this.records.get(refId);
    if (!record) throw new BrowserTargetRefError(`TargetRef ${refId} is stale or unknown. Refresh the DOM snapshot and retry.`, refId, snapshotId);
    if (snapshotId && record.targetRef.snapshotId !== snapshotId) {
      throw new BrowserTargetRefError(`TargetRef ${refId} does not belong to snapshot ${snapshotId}. Refresh the DOM snapshot and retry.`, refId, snapshotId);
    }

    const supplied = targetRefInput && typeof targetRefInput === 'object' && !Array.isArray(targetRefInput)
      ? targetRefInput as Record<string, unknown>
      : null;
    this.assertSuppliedIdentity(record.targetRef, supplied);
    const tabId = overrideTabId || record.targetRef.tabId;
    if (tabId !== record.targetRef.tabId) {
      throw this.stale(record.targetRef, 'belongs to a different tab');
    }
    return record;
  }

  private assertSuppliedIdentity(
    targetRef: BrowserTargetRef,
    supplied: Record<string, unknown> | null,
  ): void {
    const suppliedTabId = typeof supplied?.tabId === 'string' ? supplied.tabId.trim() : '';
    if (suppliedTabId && suppliedTabId !== targetRef.tabId) {
      throw this.stale(targetRef, 'belongs to a different tab');
    }
    const suppliedBackendNodeId = supplied?.backendNodeId;
    if (Number.isSafeInteger(suppliedBackendNodeId) && suppliedBackendNodeId !== targetRef.backendNodeId) {
      throw this.stale(targetRef, 'points to a different backend node');
    }
    const suppliedFrameId = typeof supplied?.frameId === 'string' ? supplied.frameId : '';
    if (suppliedFrameId && suppliedFrameId !== targetRef.frameId) {
      throw this.stale(targetRef, 'belongs to a different frame');
    }
    const suppliedRevision = typeof supplied?.documentRevision === 'string'
      ? supplied.documentRevision
      : '';
    if (suppliedRevision && suppliedRevision !== targetRef.documentRevision) {
      throw this.stale(targetRef, 'belongs to a different document revision');
    }
  }

  private stale(targetRef: BrowserTargetRef, reason: string): BrowserTargetRefError {
    return new BrowserTargetRefError(
      `TargetRef ${targetRef.refId} ${reason}. Refresh the DOM snapshot and retry.`,
      targetRef.refId,
      targetRef.snapshotId,
    );
  }
}
