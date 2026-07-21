import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_RELAY_ACTION_METHODS_V2,
  BROWSER_RELAY_CAPABILITIES_V2,
  BROWSER_RELAY_PROTOCOL_VERSION_V2,
} from '../../../src/shared/contract/browserRelay';

const extensionRoot = path.join(process.cwd(), 'resources', 'browser-relay-extension');
const read = (file: string) => fs.readFileSync(path.join(extensionRoot, file), 'utf8');
const background = read('background.js');
const protocolSource = read('protocol-v2.js');
const popup = read('popup.js');
const popupHtml = read('popup.html');
const options = read('options.js');
const optionsHtml = read('options.html');
const manifest = JSON.parse(read('manifest.json')) as {
  version: string;
  host_permissions: string[];
};

function extensionProtocol(): { protocolVersion: string; capabilities: string[]; actionMethods: Record<string, string> } {
  const context = vm.createContext({});
  vm.runInContext(protocolSource, context);
  const value = vm.runInContext('globalThis.NEO_BROWSER_RELAY_V2', context) as {
    protocolVersion: string;
    capabilities: string[];
    actionMethods: Record<string, string>;
  };
  return {
    protocolVersion: value.protocolVersion,
    capabilities: [...value.capabilities],
    actionMethods: { ...value.actionMethods },
  };
}

describe('Browser Relay extension protocol v2 static boundary', () => {
  it('mirrors the shared protocol version, capabilities, and complete action catalog exactly', () => {
    const extension = extensionProtocol();
    expect(extension.protocolVersion).toBe(BROWSER_RELAY_PROTOCOL_VERSION_V2);
    expect(extension.capabilities).toEqual([...BROWSER_RELAY_CAPABILITIES_V2]);
    expect(extension.actionMethods).toEqual(BROWSER_RELAY_ACTION_METHODS_V2);
    for (const method of new Set(Object.values(BROWSER_RELAY_ACTION_METHODS_V2))) {
      expect(background).toContain(`case '${method}'`);
    }
    expect(background).toContain("METHOD_ACTIONS.set('lease.return', ['lease:return'])");
  });

  it('handshakes before accepting Host commands and requires the complete owner envelope', () => {
    expect(background).toContain("importScripts('protocol-v2.js')");
    expect(background).toContain("type: 'hello'");
    expect(background).toContain('capabilities: [...CAPABILITIES]');
    expect(background).toContain('orphanedLeaseIds:');
    expect(background).toContain("message.type === 'hello_ack'");
    expect(background).toContain('if (!handshakeComplete)');
    for (const field of ['surfaceSessionId', 'conversationId', 'runId', 'agentId']) {
      expect(background).toContain(`'${field}'`);
    }
    expect(background).not.toContain("type: 'relay.ready'");
    expect(background).not.toContain("type: 'lease.pending_user_approval'");
  });

  it('invalidates pre-owner leases and never accepts raw native target identifiers from Host', () => {
    expect(background).toContain('isNonEmptyString(value.conversationId)');
    expect(background).toContain('isPersistedPendingLease(storedPendingLease)');
    expect(background).toContain('assertNoNativeTabReference(params)');
    expect(background).toContain("key.toLowerCase() === 'tabid'");
    expect(background).toContain("key.toLowerCase() === 'windowid'");
    expect(background).not.toContain('params.tabId');
    expect(background).not.toContain("case 'debugger.attach'");
    expect(background).not.toContain("case 'debugger.detach'");
    expect(background).not.toContain("case 'lease.resume'");
  });

  it('attaches only after popup consent and returns the original tab placement with a flat approval', () => {
    expect(background.match(/chrome\.debugger\.attach/g)).toHaveLength(1);
    expect(background).toContain('async function approveLatestPendingLease()');
    expect(background.indexOf('async function approveLatestPendingLease()'))
      .toBeLessThan(background.indexOf('chrome.debugger.attach'));
    expect(background).toContain("type: 'lease.approved'");
    expect(background).toContain('approvalRef:');
    expect(background).toContain('placement: {');
    expect(background).not.toContain('lease: publicLeaseReference(lease),\n    });');
    expect(background).toContain('restoreOriginalPlacement(lease.nativeTabId, lease.original)');
    expect(background).toContain("type: 'lease.returned'");
    expect(popup).toContain("type: 'approvePendingLease'");
    expect(popup).toContain("type: 'returnCurrentLease'");
    expect(popupHtml).toContain('Approve current tab');
  });

  it('uses real CDP DOM, AX, screenshot, input, history, wait, and redacted log operations', () => {
    for (const method of [
      'Page.captureScreenshot',
      'DOMSnapshot.captureSnapshot',
      'Accessibility.getFullAXTree',
      'DOM.pushNodesByBackendIdsToFrontend',
      'DOM.describeNode',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
      'Page.getNavigationHistory',
      'Page.navigateToHistoryEntry',
    ]) {
      expect(background).toContain(`'${method}'`);
    }
    expect(background).toContain('imageBase64: result?.data');
    expect(background).toContain('backendNodeId: node.backendDOMNodeId');
    expect(background).toContain('frameRef: frameRefForLease');
    expect(background).toContain('async function waitForOperation');
    expect(background).toContain('function redactLogText');
    expect(background).not.toContain('Runtime.evaluate');
    expect(background).not.toMatch(/\.click\s*\(/);
    expect(background).not.toMatch(/\.value\s*=(?!=)/);
  });

  it('implements exact-file upload while keeping download on the Managed cleanup boundary', () => {
    expect(BROWSER_RELAY_ACTION_METHODS_V2.upload_file).toBe('dom.set_file_input_files');
    expect(BROWSER_RELAY_ACTION_METHODS_V2).not.toHaveProperty('wait_for_download');
    for (const method of [
      'DOM.setFileInputFiles',
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
      'Runtime.releaseObject',
    ]) {
      expect(background).toContain(`'${method}'`);
    }
    expect(background).not.toContain('Browser.setDownloadBehavior');
    expect(background).not.toContain('Browser.cancelDownload');
    expect(background).not.toContain('Page.setDownloadBehavior');
  });

  it('keeps pairing material out of extension UI and persistent local storage', () => {
    expect(background).toContain("headers: { 'X-Agent-Neo-Relay-Extension': PROTOCOL_VERSION }");
    expect(background).toContain("chrome.storage.local.get(['relayPort'])");
    expect(background).not.toContain("chrome.storage.local.get(['relayPort', 'authToken'])");
    expect(options).not.toContain('authToken');
    expect(options).not.toContain('toggleToken');
    expect(optionsHtml).not.toContain('Auth token');
    expect(optionsHtml).not.toContain('Show');
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.version).toBe('0.2.0');
  });
});
