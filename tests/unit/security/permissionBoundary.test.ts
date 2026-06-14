import { describe, expect, it } from 'vitest';
import {
  listAuthInventoryItems,
  listPermissionBoundaries,
  listPrivacyBoundaryIndexEntries,
  listVoiceTranscriptionPaths,
  PERMISSION_BOUNDARY_IDS,
  PERMISSION_BOUNDARY_REGISTRY,
} from '../../../src/shared/contract';

describe('permission and privacy boundary contracts', () => {
  it('keeps permission boundary ids unique and complete', () => {
    expect(new Set(PERMISSION_BOUNDARY_IDS).size).toBe(PERMISSION_BOUNDARY_IDS.length);

    for (const boundary of listPermissionBoundaries()) {
      expect(boundary.title).toBeTruthy();
      expect(boundary.trigger).toBeTruthy();
      expect(boundary.dataAccess.length).toBeGreaterThan(0);
      expect(boundary.storage).toBeTruthy();
      expect(boundary.cloud).toBeTruthy();
      expect(boundary.redaction).toBeTruthy();
      expect(boundary.revoke).toBeTruthy();
    }
  });

  it('requires sensitive boundaries to explain cloud, redaction and revoke behavior', () => {
    const sensitive = listPermissionBoundaries().filter((boundary) => boundary.sensitivity === 'high');
    expect(sensitive.length).toBeGreaterThan(0);

    for (const boundary of sensitive) {
      expect(boundary.cloud.length).toBeGreaterThan(8);
      expect(boundary.redaction.length).toBeGreaterThan(8);
      expect(boundary.revoke.length).toBeGreaterThan(8);
    }
  });

  it('covers the P0/P1 privacy index, voice paths and auth inventory', () => {
    expect(listPrivacyBoundaryIndexEntries().map((entry) => entry.id)).toEqual([
      'desktop',
      'voice',
      'channel',
      'mcp_plugin',
      'model_provider',
      'memory',
      'telemetry_diagnostic',
    ]);

    for (const entry of listPrivacyBoundaryIndexEntries()) {
      expect(entry.data.length).toBeGreaterThan(0);
      expect(entry.storage).toBeTruthy();
      expect(entry.cloud).toBeTruthy();
      expect(entry.actionTarget.tab).toBeTruthy();
      for (const boundaryId of entry.permissionBoundaryIds) {
        expect(PERMISSION_BOUNDARY_REGISTRY[boundaryId]).toBeTruthy();
      }
    }

    expect(listVoiceTranscriptionPaths()).toHaveLength(4);
    for (const path of listVoiceTranscriptionPaths()) {
      expect(path.providers.length).toBeGreaterThan(0);
      expect(path.cloud).toBeTruthy();
      expect(path.temporaryStorage).toBeTruthy();
      expect(path.cleanupPolicy).toBeTruthy();
      expect(path.logPolicy).toContain('不记录');
    }

    expect(listAuthInventoryItems()).toHaveLength(6);
    for (const item of listAuthInventoryItems()) {
      expect(item.storage).toBeTruthy();
      expect(item.display).toBeTruthy();
      expect(item.revoke).toBeTruthy();
      expect(item.diagnosticPolicy).toBeTruthy();
    }
  });
});
