export const BROWSER_RELAY_PROTOCOL_VERSION_V2 = '2.2' as const;

export const BROWSER_RELAY_CAPABILITIES_V2 = [
  'lease.request',
  'lease.request.cancel',
  'lease.return',
  'operation.cancel',
  'tab.agent_window',
  'tab.navigate',
  'tab.screenshot',
  'dom.snapshot',
  'ax.snapshot',
  'network.metadata',
  'dialog.control',
  'file.upload',
  'input.mouse',
  'input.keyboard',
] as const;

export type BrowserRelayCapabilityV2 = typeof BROWSER_RELAY_CAPABILITIES_V2[number];

/** Canonical Browser Relay V2 command catalog. Host and extension must mirror it exactly. */
export const BROWSER_RELAY_ACTION_METHODS_V2 = {
  navigate: 'tab.navigate',
  back: 'tab.back',
  forward: 'tab.forward',
  reload: 'tab.reload',
  click: 'input.click',
  click_text: 'input.click_text',
  type: 'input.type',
  press_key: 'input.key',
  scroll: 'input.scroll',
  hover: 'input.hover',
  drag: 'input.drag',
  get_dialog_state: 'dialog.get',
  handle_dialog: 'dialog.handle',
  upload_file: 'dom.set_file_input_files',
  screenshot: 'tab.screenshot',
  get_content: 'page.content',
  get_dom_snapshot: 'dom.snapshot',
  get_a11y_snapshot: 'ax.snapshot',
  get_workbench_state: 'lease.get',
  get_account_state: 'lease.get',
  wait: 'operation.wait',
  get_logs: 'page.logs',
} as const;

export const BROWSER_RELAY_LEASE_ACTION_SCOPES_V2 = [
  ...Object.keys(BROWSER_RELAY_ACTION_METHODS_V2),
  'close',
  'lease:return',
] as const;

export type BrowserRelayActionScopeV2 = keyof typeof BROWSER_RELAY_ACTION_METHODS_V2;
export type BrowserRelayMethodV2 = typeof BROWSER_RELAY_ACTION_METHODS_V2[BrowserRelayActionScopeV2]
  | 'lease.return';

export function browserRelayMethodAllowsActionV2(method: string, actionScope: string): boolean {
  if (method === 'lease.return') return actionScope === 'lease:return';
  return BROWSER_RELAY_ACTION_METHODS_V2[actionScope as BrowserRelayActionScopeV2] === method;
}

export type BrowserRelayStableErrorCodeV2 =
  | 'RELAY_PROTOCOL_VERSION_MISMATCH'
  | 'RELAY_HANDSHAKE_REQUIRED'
  | 'RELAY_CAPABILITY_UNSUPPORTED'
  | 'RELAY_SESSION_NOT_OWNED'
  | 'RELAY_LEASE_REQUIRED'
  | 'RELAY_LEASE_NOT_OWNED'
  | 'RELAY_LEASE_EXPIRED'
  | 'RELAY_DOMAIN_NOT_ALLOWED'
  | 'RELAY_ACTION_NOT_ALLOWED'
  | 'RELAY_DIALOG_BLOCKED'
  | 'RELAY_FILE_UPLOAD_BLOCKED'
  | 'RELAY_OPERATION_CANCELLED'
  | 'RELAY_OPERATION_TIMEOUT'
  | 'RELAY_EXTENSION_DISCONNECTED'
  | 'RELAY_TARGET_CHANGED'
  | 'RELAY_TAB_RETURN_FAILED'
  | 'RELAY_COMMAND_FAILED';

export interface BrowserRelayOwnerV2 {
  surfaceSessionId: string;
  conversationId: string;
  runId: string;
  agentId: string;
}

export interface BrowserRelayHelloV2 {
  type: 'hello';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  extensionInstanceId: string;
  capabilities: BrowserRelayCapabilityV2[];
  orphanedLeaseIds: string[];
}

export interface BrowserRelayHelloAckV2 {
  type: 'hello_ack';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  connectionGeneration: string;
  requiredCapabilities: BrowserRelayCapabilityV2[];
}

export interface BrowserRelayLeaseRequestV2 extends BrowserRelayOwnerV2 {
  type: 'lease.request';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  requestId: string;
  domainScopes: string[];
  actionScopes: string[];
  consentDeadlineAt: number;
  expiresAt: number;
}

export interface BrowserRelayLeaseRequestCancelV2 extends BrowserRelayOwnerV2 {
  type: 'lease.request.cancel';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  requestId: string;
  reason?: string;
}

export interface BrowserRelayApprovedPlacementV2 {
  browserInstanceRef: string;
  tabRef: string;
  agentWindowRef: string;
  originalWindowRef: string;
  originalIndex: number;
  originalPinned: boolean;
  originalActive: boolean;
  origin: string;
  documentRevision: string;
}

export interface BrowserRelayLeaseApprovedV2 extends BrowserRelayOwnerV2 {
  type: 'lease.approved';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  requestId: string;
  leaseId: string;
  approvalRef: string;
  approvedAt: number;
  expiresAt: number;
  domainScopes: string[];
  actionScopes: string[];
  placement: BrowserRelayApprovedPlacementV2;
}

export interface BrowserRelayLeaseDeniedV2 extends BrowserRelayOwnerV2 {
  type: 'lease.denied';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  requestId: string;
  deniedAt: number;
}

export interface BrowserRelayCommandV2 extends BrowserRelayOwnerV2 {
  type: 'command';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  id: string;
  operationId: string;
  leaseId: string;
  method: BrowserRelayMethodV2;
  actionScope: string;
  deadlineAt: number;
  params: Record<string, unknown>;
}

export interface BrowserRelayCancelV2 extends BrowserRelayOwnerV2 {
  type: 'cancel';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  operationId: string;
  leaseId: string;
  reason?: string;
}

export interface BrowserRelayErrorV2 {
  code: BrowserRelayStableErrorCodeV2;
  message: string;
  retryable: boolean;
  delivery: 'not_attempted' | 'unknown';
}

export interface BrowserRelayResponseV2 {
  type: 'response';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  id: string;
  operationId: string;
  result?: unknown;
  error?: BrowserRelayErrorV2;
}

export interface BrowserRelayLeaseReturnResultV2 extends BrowserRelayOwnerV2 {
  type: 'lease.returned' | 'lease.recovery_required';
  protocolVersion: typeof BROWSER_RELAY_PROTOCOL_VERSION_V2;
  leaseId: string;
  error?: BrowserRelayErrorV2;
}

export type BrowserRelayExtensionMessageV2 =
  | BrowserRelayHelloV2
  | BrowserRelayLeaseApprovedV2
  | BrowserRelayLeaseDeniedV2
  | BrowserRelayResponseV2
  | BrowserRelayLeaseReturnResultV2;

export type BrowserRelayHostMessageV2 =
  | BrowserRelayHelloAckV2
  | BrowserRelayLeaseRequestV2
  | BrowserRelayLeaseRequestCancelV2
  | BrowserRelayCommandV2
  | BrowserRelayCancelV2;

export function isBrowserRelayOwnerV2(value: unknown): value is BrowserRelayOwnerV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<BrowserRelayOwnerV2>;
  return typeof owner.surfaceSessionId === 'string' && owner.surfaceSessionId.length > 0
    && typeof owner.conversationId === 'string' && owner.conversationId.length > 0
    && typeof owner.runId === 'string' && owner.runId.length > 0
    && typeof owner.agentId === 'string' && owner.agentId.length > 0;
}

export function isBrowserRelayResponseV2(value: unknown): value is BrowserRelayResponseV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Partial<BrowserRelayResponseV2>;
  return response.type === 'response'
    && response.protocolVersion === BROWSER_RELAY_PROTOCOL_VERSION_V2
    && typeof response.id === 'string'
    && typeof response.operationId === 'string';
}
