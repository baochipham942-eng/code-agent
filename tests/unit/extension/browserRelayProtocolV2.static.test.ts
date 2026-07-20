import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const extensionRoot = path.join(process.cwd(), 'resources', 'browser-relay-extension');
const background = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
const popup = fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(extensionRoot, 'popup.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8')) as {
  version: string;
};

describe('Browser Relay extension protocol v2 static boundary', () => {
  it('handshakes with protocol v2 before accepting any Host command', () => {
    expect(background).toContain("const PROTOCOL_VERSION = '2.0'");
    expect(background).toContain("type: 'hello'");
    expect(background).toContain('capabilities: CAPABILITIES');
    expect(background).toContain('extensionInstanceId');
    expect(background).toContain("message.type === 'hello_ack'");
    expect(background).toContain('if (!handshakeComplete)');
    expect(background).toContain('RELAY_HANDSHAKE_REQUIRED');
    expect(background.indexOf('sendHello();')).toBeLessThan(background.indexOf('sendReady();'));
  });

  it('requires the full owner and operation envelope and rejects native tab references', () => {
    for (const field of [
      'id',
      'surfaceSessionId',
      'runId',
      'agentId',
      'operationId',
      'leaseId',
      'method',
    ]) {
      expect(background).toContain(`'${field}'`);
    }
    expect(background).toContain("message.type !== 'command'");
    expect(background).toContain('assertNoNativeTabReference(params)');
    expect(background).toContain('RELAY_NATIVE_TARGET_FORBIDDEN');
    expect(background).not.toContain('params.tabId');
    expect(background).not.toContain("case 'tabs.list'");
    expect(background).not.toContain("case 'debugger.attach'");
    expect(background).not.toContain("case 'debugger.detach'");
  });

  it('validates lease owner, exact origin, explicit action, expiry, and debugger approval before operations', () => {
    expect(background).toContain('assertLeaseOwner(lease, command)');
    expect(background).toContain('await authorizeLeaseAction(lease, action)');
    expect(background).toContain('Date.now() >= lease.expiresAtMs');
    expect(background).toContain('isLeaseActionAllowed(lease.actions, action)');
    expect(background).toContain('validateUrlScope(tab.url, lease)');
    expect(background).toContain('origin !== scope.origin || hostname !== scope.hostname');
    expect(background).toContain('if (!lease.debuggerApproved)');
  });

  it('attaches the debugger only from explicit popup approval and exposes no attach control', () => {
    expect(background.match(/chrome\.debugger\.attach/g)).toHaveLength(1);
    expect(background).toContain('async function approveLatestPendingLease()');
    expect(background.indexOf('async function approveLatestPendingLease()'))
      .toBeLessThan(background.indexOf('chrome.debugger.attach'));
    expect(background).not.toContain("message.type === 'attachCurrentTab'");
    expect(popup).toContain("type: 'approvePendingLease'");
    expect(popup).toContain("type: 'denyPendingLease'");
    expect(popup).not.toContain('attachCurrentTab');
    expect(popupHtml).toContain('Approve current tab');
    expect(popupHtml).not.toContain('Attach current tab');
  });

  it('moves an approved tab to an Agent Window and returns its original placement', () => {
    expect(background).toContain('moveToAgentWindow(tab, request.surfaceSessionId)');
    expect(background).toContain('originalWindowRef');
    expect(background).toContain('originalIndex');
    expect(background).toContain('originalPinned');
    expect(background).toContain('originalActive');
    expect(background).toContain('agentWindowRef');
    expect(background).toContain('restoreOriginalPlacement(lease.nativeTabId, lease.original)');
    expect(background).toContain('RELAY_TAB_RETURN_FAILED');
    expect(popup).toContain("type: 'returnCurrentLease'");
  });

  it('uses CDP Input for click and type and never injects DOM click or value assignment', () => {
    expect(background).toContain("'Input.dispatchMouseEvent'");
    expect(background).toContain("'Input.dispatchKeyEvent'");
    expect(background).toContain("'Input.insertText'");
    expect(background).toContain("'DOM.focus'");
    expect(background).not.toMatch(/\.click\s*\(/);
    expect(background).not.toMatch(/\.value\s*=/);
    expect(background).not.toContain('Runtime.evaluate');
  });

  it('returns screenshot data, opaque placement refs, element identity, and successor target metadata', () => {
    expect(background).toContain('data: result?.data');
    expect(background).toContain('browserInstanceRef: extensionInstanceId');
    expect(background).toContain("tabRef: opaqueId('tab')");
    expect(background).toContain("documentRevision: opaqueId('document')");
    expect(background).toContain('backendNodeId: target.backendNodeId');
    expect(background).toContain('frameRef: target.frameRef');
    expect(background).toContain('role: target.role');
    expect(background).toContain('name: target.name');
    expect(background).toContain('target: resultLease ? targetMetadata(resultLease) : null');
  });

  it('supports cancellation and reconnect recovery without reporting global tab metadata', () => {
    expect(background).toContain("message.type === 'cancel'");
    expect(background).toContain('active.controller.abort');
    expect(background).toContain('RELAY_OPERATION_CANCELLED');
    expect(background).toContain('markLeasesOrphaned()');
    expect(background).toContain('orphanedLeases:');
    expect(background).toContain("command.method === 'lease.resume'");
    expect(background).not.toContain('chrome.tabs.query({})');
    expect(background).not.toContain('attachedTabs');
  });

  it('uses the extension-only config bootstrap marker and ships the v2 manifest', () => {
    expect(background).toContain("'X-Agent-Neo-Relay-Extension': '2'");
    expect(background).toContain("credentials: 'omit'");
    expect(manifest.version).toBe('0.2.0');
  });
});
