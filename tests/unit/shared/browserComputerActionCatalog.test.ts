import { describe, expect, it } from 'vitest';
import {
  getBrowserComputerActionCatalogEntry,
  getBrowserComputerActionCatalogForArgs,
  getBrowserComputerSurfaceCapabilityDescriptor,
  getStrictBrowserComputerActionCatalogEntry,
  isBrowserScopedComputerUseAction,
} from '../../../src/shared/utils/browserComputerActionCatalog';

describe('browser/computer action catalog', () => {
  it('describes browser file actions without changing approval ownership', () => {
    expect(getBrowserComputerActionCatalogEntry('browser_action', 'upload_file', {
      action: 'upload_file',
    })).toMatchObject({
      tool: 'browser_action',
      action: 'upload_file',
      risk: 'browser_action',
      scope: 'managed_browser',
      requiresManagedSession: true,
      evidenceKind: 'artifact',
      approvalKind: 'tool_executor_file',
      safeRecovery: 'refresh_managed_snapshot',
    });
  });

  it('classifies browser-scoped computer actions as managed browser work', () => {
    expect(isBrowserScopedComputerUseAction('smart_type', {
      action: 'smart_type',
      selector: '#email',
    })).toBe(true);
    expect(getBrowserComputerActionCatalogEntry('computer_use', 'smart_type', {
      action: 'smart_type',
      selector: '#email',
    })).toMatchObject({
      tool: 'computer_use',
      action: 'smart_type',
      risk: 'browser_action',
      scope: 'browser_scoped_computer',
      requiresManagedSession: true,
      evidenceKind: 'action_trace',
      approvalKind: 'tool_executor',
      safeRecovery: 'refresh_managed_snapshot',
    });
  });

  it('keeps targetApp locate_role on the desktop Computer Surface path', () => {
    expect(isBrowserScopedComputerUseAction('locate_role', {
      action: 'locate_role',
      targetApp: 'Notes',
      role: 'textbox',
    })).toBe(false);
    expect(getBrowserComputerActionCatalogEntry('computer_use', 'locate_role', {
      action: 'locate_role',
      targetApp: 'Notes',
      role: 'textbox',
    })).toMatchObject({
      risk: 'read',
      scope: 'desktop_surface',
      requiresManagedSession: false,
      evidenceKind: 'ax_candidates',
      approvalKind: 'tool_executor_read_only',
      safeRecovery: 'desktop_readonly_probe',
    });
  });

  it('keeps targetApp smart actions on the desktop Computer Surface path', () => {
    expect(isBrowserScopedComputerUseAction('smart_type', {
      action: 'smart_type',
      targetApp: 'Google Chrome',
      selector: '#email',
    })).toBe(false);
    expect(getBrowserComputerActionCatalogEntry('computer_use', 'smart_type', {
      action: 'smart_type',
      targetApp: 'Google Chrome',
      selector: '#email',
    })).toMatchObject({
      risk: 'desktop_input',
      scope: 'desktop_surface',
      requiresManagedSession: false,
      safeRecovery: 'desktop_readonly_probe',
    });
  });

  it('marks desktop preparation actions as read-only evidence collection', () => {
    expect(getBrowserComputerActionCatalogEntry('computer_use', 'get_windows', {
      action: 'get_windows',
      targetApp: 'Preview',
    })).toMatchObject({
      risk: 'read',
      scope: 'desktop_surface',
      requiresManagedSession: false,
      evidenceKind: 'window_candidates',
      approvalKind: 'tool_executor_read_only',
      safeRecovery: 'desktop_readonly_probe',
    });
  });

  it('classifies stateful operation names without a legacy action field', () => {
    expect(getBrowserComputerActionCatalogForArgs({
      toolName: 'computer_use',
      arguments: { operation: 'observe', target: { pid: 1, windowId: 2 } },
    })).toMatchObject({ risk: 'read', evidenceKind: 'desktop_observation' });
    expect(getBrowserComputerActionCatalogForArgs({
      toolName: 'computer_use',
      arguments: { operation: 'act', stateId: 'state-1' },
    })).toMatchObject({ risk: 'desktop_input', evidenceKind: 'action_trace' });
  });

  it('provides a strict lookup for Host enforcement without changing legacy preview fallback', () => {
    expect(getStrictBrowserComputerActionCatalogEntry('browser_action', 'navigate', {
      action: 'navigate',
    })?.action).toBe('navigate');
    expect(getStrictBrowserComputerActionCatalogEntry('browser_action', 'unknown_action', {
      action: 'unknown_action',
    })).toBeNull();
    expect(getBrowserComputerActionCatalogEntry('browser_action', 'unknown_action', {
      action: 'unknown_action',
    })?.risk).toBe('browser_action');
  });

  it('registers hover and drag as Browser input mutations', () => {
    for (const action of ['hover', 'drag']) {
      expect(getBrowserComputerSurfaceCapabilityDescriptor('browser_action', action, {
        action,
      })).toMatchObject({
        surface: 'browser',
        capabilities: ['input'],
        mutation: true,
        catalog: {
          action,
          scope: 'managed_browser',
          evidenceKind: 'action_trace',
        },
      });
    }
  });

  it('separates safe dialog observation from explicit destructive acceptance', () => {
    expect(getBrowserComputerSurfaceCapabilityDescriptor('browser_action', 'get_dialog_state', {
      action: 'get_dialog_state',
    })).toMatchObject({ capabilities: ['observe'], mutation: false });
    expect(getBrowserComputerSurfaceCapabilityDescriptor('browser_action', 'handle_dialog', {
      action: 'handle_dialog',
      dialogAction: 'dismiss',
    })).toMatchObject({ capabilities: ['input'], mutation: true });
    expect(getBrowserComputerSurfaceCapabilityDescriptor('browser_action', 'handle_dialog', {
      action: 'handle_dialog',
      dialogAction: 'accept',
      dialogPromptText: 'sensitive prompt response',
    })).toMatchObject({ capabilities: ['input', 'secret', 'destructive'], mutation: true });
  });

  it('treats clipboard reads as capability-scoped operations and clipboard writes as input', () => {
    expect(getBrowserComputerSurfaceCapabilityDescriptor('browser_action', 'read_clipboard', {
      action: 'read_clipboard',
    })).toMatchObject({ capabilities: ['observe', 'secret'], mutation: true });
    expect(getBrowserComputerSurfaceCapabilityDescriptor('browser_action', 'write_clipboard', {
      action: 'write_clipboard',
      clipboardText: 'sensitive clipboard value',
    })).toMatchObject({ capabilities: ['input', 'secret'], mutation: true });
  });
});
