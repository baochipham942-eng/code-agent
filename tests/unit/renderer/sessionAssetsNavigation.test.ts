import { describe, expect, it } from 'vitest';
import { buildSessionAssetsNavigation } from '../../../src/renderer/utils/sessionAssetsNavigation';

describe('buildSessionAssetsNavigation', () => {
  it('opens assets in place for the current session', () => {
    expect(buildSessionAssetsNavigation('session-1', 'session-1')).toEqual({
      targetSessionId: 'session-1',
      shouldSwitchSession: false,
      workspacePreviewItemId: null,
    });
  });

  it('switches sessions before opening another session assets', () => {
    expect(buildSessionAssetsNavigation('session-1', 'session-2')).toEqual({
      targetSessionId: 'session-2',
      shouldSwitchSession: true,
      workspacePreviewItemId: null,
    });
  });

  it('ignores blank target session ids', () => {
    expect(buildSessionAssetsNavigation('session-1', '  ')).toBeNull();
  });

  it('targets a concrete Workspace Preview artifact item when message metadata is available', () => {
    expect(buildSessionAssetsNavigation('session-1', 'session-2', {
      artifactId: 'artifact_chart_1_abc',
      messageId: 'message-9',
    })).toEqual({
      targetSessionId: 'session-2',
      shouldSwitchSession: true,
      workspacePreviewItemId: 'artifact:message-9:artifact_chart_1_abc',
    });
  });

  it('prefers an explicit preview item id for tool-produced assets', () => {
    expect(buildSessionAssetsNavigation('session-1', 'session-2', {
      artifactId: 'artifact_chart_1_abc',
      messageId: 'message-9',
      previewItemId: 'tool-artifact:tool-1:deploy-url',
    })?.workspacePreviewItemId).toBe('tool-artifact:tool-1:deploy-url');
  });

  it('falls back to file item ids for file outputs', () => {
    expect(buildSessionAssetsNavigation('session-1', 'session-2', {
      path: '/repo/app/dist/report.html',
    })?.workspacePreviewItemId).toBe('file:/repo/app/dist/report.html');
  });
});
