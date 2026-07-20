const PROTOCOL_VERSION = '2.0';
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const STORAGE_KEYS = Object.freeze({
  extensionInstanceId: 'browserRelayExtensionInstanceIdV2',
  leases: 'browserRelayLeasesV2',
  pendingLease: 'browserRelayPendingLeaseV2',
});

const CAPABILITIES = Object.freeze({
  leaseProtocol: 'v2',
  explicitUserApproval: true,
  opaqueTargetReferences: true,
  orphanRecovery: true,
  operationCancellation: true,
  tabReturn: true,
  methods: [
    'lease.resume',
    'lease.return',
    'tabs.navigate',
    'tabs.screenshot',
    'dom.query',
    'dom.snapshot',
    'accessibility.snapshot',
    'input.click',
    'input.type',
    'cdp.send',
  ],
  cdpMethods: [
    'Page.captureScreenshot',
    'Page.getLayoutMetrics',
    'DOMSnapshot.captureSnapshot',
    'Accessibility.getFullAXTree',
    'Network.getResponseBody',
  ],
});

const ERROR_CODES = Object.freeze({
  ACTION_NOT_ALLOWED: 'RELAY_ACTION_NOT_ALLOWED',
  DEBUGGER_NOT_APPROVED: 'RELAY_DEBUGGER_NOT_APPROVED',
  HANDSHAKE_REQUIRED: 'RELAY_HANDSHAKE_REQUIRED',
  INTERNAL: 'RELAY_INTERNAL_ERROR',
  INVALID_COMMAND: 'RELAY_INVALID_COMMAND',
  INVALID_LEASE_REQUEST: 'RELAY_INVALID_LEASE_REQUEST',
  LEASE_EXPIRED: 'RELAY_LEASE_EXPIRED',
  LEASE_NOT_FOUND: 'RELAY_LEASE_NOT_FOUND',
  LEASE_ORPHANED: 'RELAY_LEASE_ORPHANED',
  LEASE_OWNER_MISMATCH: 'RELAY_LEASE_OWNER_MISMATCH',
  METHOD_NOT_ALLOWED: 'RELAY_METHOD_NOT_ALLOWED',
  NATIVE_TARGET_FORBIDDEN: 'RELAY_NATIVE_TARGET_FORBIDDEN',
  OPERATION_CANCELLED: 'RELAY_OPERATION_CANCELLED',
  OPERATION_IN_PROGRESS: 'RELAY_OPERATION_IN_PROGRESS',
  OPERATION_NOT_FOUND: 'RELAY_OPERATION_NOT_FOUND',
  ORIGIN_MISMATCH: 'RELAY_ORIGIN_MISMATCH',
  PROTOCOL_UNSUPPORTED: 'RELAY_PROTOCOL_UNSUPPORTED',
  TAB_ALREADY_LEASED: 'RELAY_TAB_ALREADY_LEASED',
  TAB_RETURN_FAILED: 'RELAY_TAB_RETURN_FAILED',
  TAB_UNAVAILABLE: 'RELAY_TAB_UNAVAILABLE',
  TARGET_NOT_FOUND: 'RELAY_TARGET_NOT_FOUND',
  USER_APPROVAL_REQUIRED: 'RELAY_USER_APPROVAL_REQUIRED',
});

const ALLOWED_ACTIONS = new Set([
  'accessibility',
  'cdp-read',
  'dom',
  'input',
  'navigation',
  'network-read',
  'observe',
  'screenshot',
]);

const CDP_ACTIONS = new Map([
  ['Page.captureScreenshot', 'screenshot'],
  ['Page.getLayoutMetrics', 'dom'],
  ['DOMSnapshot.captureSnapshot', 'dom'],
  ['Accessibility.getFullAXTree', 'accessibility'],
  ['Network.getResponseBody', 'network-read'],
]);

class RelayError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.retryable = retryable;
  }
}

let ws = null;
let reconnectDelay = 1000;
let connectionState = 'disconnected';
let handshakeComplete = false;
let config = { port: 23001, token: '' };
let pingTimer = null;
let extensionInstanceId = '';
let pendingLeaseRequest = null;

const leases = new Map();
const nodeRefsByLease = new Map();
const frameRefsByLease = new Map();
const activeOperations = new Map();
const intentionalDebuggerDetach = new Set();

function opaqueId(prefix) {
  const random = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${random}`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function relayError(error, fallbackCode = ERROR_CODES.INTERNAL) {
  if (error instanceof RelayError) return error;
  return new RelayError(fallbackCode, error?.message || String(error));
}

function errorPayload(error) {
  const normalized = relayError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: Boolean(normalized.retryable),
  };
}

async function init() {
  await restoreProtocolState();
  await loadConfig();
  connect();
  setupAlarms();
}

async function restoreProtocolState() {
  try {
    const stored = await chrome.storage.session.get([
      STORAGE_KEYS.extensionInstanceId,
      STORAGE_KEYS.leases,
      STORAGE_KEYS.pendingLease,
    ]);

    extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId] || opaqueId('extension');
    for (const persisted of stored[STORAGE_KEYS.leases] || []) {
      if (!isPersistedLease(persisted)) continue;
      const restored = {
        ...persisted,
        state: ['leased', 'returning', 'orphaned'].includes(persisted.state)
          ? 'orphaned'
          : persisted.state,
      };
      leases.set(restored.leaseId, restored);
    }
    pendingLeaseRequest = stored[STORAGE_KEYS.pendingLease] || null;
    await persistProtocolState();
  } catch (error) {
    console.warn('[Agent Neo Relay] Failed to restore protocol state', error);
    extensionInstanceId = opaqueId('extension');
  }
}

function isPersistedLease(value) {
  return Boolean(
    value
      && isNonEmptyString(value.leaseId)
      && isNonEmptyString(value.surfaceSessionId)
      && isNonEmptyString(value.runId)
      && isNonEmptyString(value.agentId)
      && Number.isInteger(value.nativeTabId),
  );
}

async function persistProtocolState() {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEYS.extensionInstanceId]: extensionInstanceId,
      [STORAGE_KEYS.leases]: Array.from(leases.values()),
      [STORAGE_KEYS.pendingLease]: pendingLeaseRequest,
    });
  } catch (error) {
    console.warn('[Agent Neo Relay] Failed to persist protocol state', error);
  }
}

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(['relayPort', 'authToken']);
    if (stored.relayPort) config.port = stored.relayPort;
    if (stored.authToken) config.token = stored.authToken;
  } catch (error) {
    console.warn('[Agent Neo Relay] Failed to load settings', error);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/browser-relay/config`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'X-Agent-Neo-Relay-Extension': '2' },
    });
    if (response.ok) {
      const autoConfig = await response.json();
      if (autoConfig.port) config.port = autoConfig.port;
      if (autoConfig.token) config.token = autoConfig.token;
      await chrome.storage.local.set({
        relayPort: config.port,
        authToken: config.token,
      });
    }
  } catch {
    // Agent Neo may not be running yet. A manually stored token remains available.
  }
}

function updateBadge() {
  const badge = {
    connected: ['ON', '#22C55E'],
    connecting: ['...', '#F59E0B'],
    handshaking: ['V2', '#F59E0B'],
    disconnected: ['OFF', '#71717A'],
  }[connectionState] || ['OFF', '#71717A'];
  chrome.action.setBadgeText({ text: badge[0] });
  chrome.action.setBadgeBackgroundColor({ color: badge[1] });
}

function connect(silent = false) {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  connectionState = 'connecting';
  handshakeComplete = false;
  if (!silent) updateBadge();
  const url = `ws://127.0.0.1:${config.port}/ws/browser-relay?token=${encodeURIComponent(config.token)}`;

  try {
    ws = new WebSocket(url);
  } catch {
    connectionState = 'disconnected';
    updateBadge();
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connectionState = 'handshaking';
    reconnectDelay = 1000;
    updateBadge();
    sendHello();
    startPingTimer();
  };

  ws.onmessage = (event) => handleMessage(event.data);

  ws.onclose = () => {
    ws = null;
    handshakeComplete = false;
    connectionState = 'disconnected';
    updateBadge();
    stopPingTimer();
    markLeasesOrphaned();
    cancelActiveOperations('Relay connection closed');
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

function disconnect() {
  if (ws) {
    ws.close(1000, 'Manual disconnect');
    ws = null;
  }
  handshakeComplete = false;
  connectionState = 'disconnected';
  updateBadge();
  stopPingTimer();
  markLeasesOrphaned();
  cancelActiveOperations('Relay disconnected');
}

function scheduleReconnect() {
  setTimeout(() => {
    if (connectionState === 'disconnected') connect(true);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendHello() {
  send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: CAPABILITIES,
    extensionInstanceId,
    orphanedLeases: Array.from(leases.values())
      .filter((lease) => ['orphaned', 'recovery_required', 'expired'].includes(lease.state))
      .map(publicLeaseReference),
  });
}

function sendReady() {
  send({
    type: 'relay.ready',
    protocolVersion: PROTOCOL_VERSION,
    extensionInstanceId,
    leases: Array.from(leases.values())
      .filter((lease) => lease.state !== 'returned')
      .map(publicLeaseReference),
  });
}

function publicLeaseReference(lease) {
  return {
    leaseId: lease.leaseId,
    surfaceSessionId: lease.surfaceSessionId,
    runId: lease.runId,
    agentId: lease.agentId,
    browserInstanceRef: extensionInstanceId,
    tabRef: lease.tabRef,
    agentWindowRef: lease.agentWindowRef,
    originalWindowRef: lease.originalWindowRef,
    originalIndex: lease.original.index,
    originalPinned: lease.original.pinned,
    originalActive: lease.original.active,
    state: lease.state,
    origin: lease.origin,
    hostname: lease.hostname,
    actions: lease.actions,
    expiresAtMs: lease.expiresAtMs,
    documentRevision: lease.documentRevision,
  };
}

function targetMetadata(lease) {
  return {
    origin: lease.origin,
    documentRevision: lease.documentRevision,
  };
}

function startPingTimer() {
  stopPingTimer();
  pingTimer = setInterval(() => {
    if (handshakeComplete) {
      send({ type: 'ping', protocolVersion: PROTOCOL_VERSION });
    }
  }, 20000);
}

function stopPingTimer() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function setupAlarms() {
  chrome.alarms.create('code-agent-relay-keepalive', { periodInMinutes: 25 / 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'code-agent-relay-keepalive') return;
    expireProtocolState();
    if (connectionState === 'disconnected') connect(true);
  });
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === 'ping') {
    send({ type: 'pong', protocolVersion: PROTOCOL_VERSION });
    return;
  }

  if (message.type === 'hello_ack') {
    handleHelloAck(message);
    return;
  }

  if (!handshakeComplete) {
    sendProtocolFailure(message, new RelayError(
      ERROR_CODES.HANDSHAKE_REQUIRED,
      'Relay command rejected before protocol v2 hello_ack',
      true,
    ));
    return;
  }

  if (message.type === 'lease.request') {
    await handleLeaseRequest(message);
    return;
  }

  if (message.type === 'cancel') {
    await handleCancel(message);
    return;
  }

  if (message.type === 'command') {
    await handleCommand(message);
    return;
  }

  sendProtocolFailure(message, new RelayError(
    ERROR_CODES.INVALID_COMMAND,
    `Unsupported relay message type: ${String(message.type || '')}`,
  ));
}

function handleHelloAck(message) {
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    sendProtocolFailure(message, new RelayError(
      ERROR_CODES.PROTOCOL_UNSUPPORTED,
      `Expected protocol ${PROTOCOL_VERSION}`,
    ));
    ws?.close(1002, 'Unsupported relay protocol');
    return;
  }
  handshakeComplete = true;
  connectionState = 'connected';
  updateBadge();
  sendReady();
}

function sendProtocolFailure(message, error) {
  send({
    type: message?.type === 'command' ? 'command.error' : 'protocol.error',
    protocolVersion: PROTOCOL_VERSION,
    id: message?.id || null,
    operationId: message?.operationId || null,
    leaseId: message?.leaseId || null,
    error: errorPayload(error),
  });
}

async function handleLeaseRequest(message) {
  try {
    const request = normalizeLeaseRequest(message);
    if (pendingLeaseRequest && pendingLeaseRequest.requestId !== request.requestId) {
      send({
        type: 'lease.denied',
        protocolVersion: PROTOCOL_VERSION,
        requestId: pendingLeaseRequest.requestId,
        error: {
          code: 'RELAY_LEASE_REQUEST_SUPERSEDED',
          message: 'A newer lease request replaced this pending request',
          retryable: true,
        },
      });
    }
    pendingLeaseRequest = request;
    await persistProtocolState();
    send({
      type: 'lease.pending_user_approval',
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      surfaceSessionId: request.surfaceSessionId,
      expiresAtMs: request.expiresAtMs,
    });
  } catch (error) {
    sendProtocolFailure(message, relayError(error, ERROR_CODES.INVALID_LEASE_REQUEST));
  }
}

function normalizeLeaseRequest(message) {
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    throw new RelayError(ERROR_CODES.PROTOCOL_UNSUPPORTED, `Expected protocol ${PROTOCOL_VERSION}`);
  }
  const scope = message.scope && typeof message.scope === 'object' ? message.scope : {};
  const requestId = message.requestId || message.id;
  const origin = normalizeOrigin(scope.origin || message.origin);
  const hostname = normalizeHostname(scope.hostname || message.hostname);
  const actions = Array.from(new Set(scope.actions || message.actionScope || []));
  const expiresAtMs = Number(scope.expiresAtMs || message.expiresAtMs);

  for (const field of ['requestId', 'surfaceSessionId', 'runId', 'agentId']) {
    if (!isNonEmptyString(field === 'requestId' ? requestId : message[field])) {
      throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, `${field} is required`);
    }
  }
  if (!origin || !hostname || new URL(origin).hostname !== hostname) {
    throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'Exact origin and hostname must agree');
  }
  if (!actions.length || actions.some((action) => !ALLOWED_ACTIONS.has(action))) {
    throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'Lease actions must be an explicit supported action list');
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'Lease expiry must be in the future');
  }

  return {
    requestId,
    surfaceSessionId: message.surfaceSessionId,
    runId: message.runId,
    agentId: message.agentId,
    origin,
    hostname,
    actions,
    expiresAtMs,
    requestedAtMs: Date.now(),
  };
}

async function handleCommand(message) {
  let command;
  try {
    command = validateCommandEnvelope(message);
    const existingOperation = activeOperations.get(command.operationId);
    if (existingOperation) {
      throw new RelayError(ERROR_CODES.OPERATION_IN_PROGRESS, 'Operation is already running', true);
    }
    if (Array.from(activeOperations.values()).some((active) => active.leaseId === command.leaseId)) {
      throw new RelayError(ERROR_CODES.OPERATION_IN_PROGRESS, 'Lease already has an active operation', true);
    }

    const controller = new AbortController();
    activeOperations.set(command.operationId, {
      controller,
      leaseId: command.leaseId,
      method: command.method,
    });
    const result = await executeCommand(command, controller.signal);
    throwIfAborted(controller.signal);
    const resultLease = leases.get(command.leaseId);
    send({
      type: 'command.result',
      protocolVersion: PROTOCOL_VERSION,
      id: command.id,
      operationId: command.operationId,
      leaseId: command.leaseId,
      surfaceSessionId: command.surfaceSessionId,
      result: {
        ...(result && typeof result === 'object' ? result : { value: result }),
        target: resultLease ? targetMetadata(resultLease) : null,
      },
    });
  } catch (error) {
    sendProtocolFailure(message, error);
  } finally {
    if (command?.operationId) activeOperations.delete(command.operationId);
  }
}

function validateCommandEnvelope(message) {
  if (message.type !== 'command' || message.protocolVersion !== PROTOCOL_VERSION) {
    throw new RelayError(ERROR_CODES.PROTOCOL_UNSUPPORTED, `Expected command protocol ${PROTOCOL_VERSION}`);
  }
  for (const field of ['id', 'surfaceSessionId', 'runId', 'agentId', 'operationId', 'leaseId', 'method']) {
    if (!isNonEmptyString(message[field])) {
      throw new RelayError(ERROR_CODES.INVALID_COMMAND, `${field} is required`);
    }
  }
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  assertNoNativeTabReference(params);
  return { ...message, params };
}

function assertNoNativeTabReference(value, visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase() === 'tabid' || key.toLowerCase() === 'windowid') {
      throw new RelayError(
        ERROR_CODES.NATIVE_TARGET_FORBIDDEN,
        'Host commands must resolve browser targets only through leaseId and opaque refs',
      );
    }
    assertNoNativeTabReference(nested, visited);
  }
}

async function handleCancel(message) {
  try {
    if (message.protocolVersion !== PROTOCOL_VERSION || !isNonEmptyString(message.operationId)) {
      throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'cancel requires protocolVersion and operationId');
    }
    for (const field of ['surfaceSessionId', 'runId', 'agentId', 'leaseId']) {
      if (!isNonEmptyString(message[field])) {
        throw new RelayError(ERROR_CODES.INVALID_COMMAND, `${field} is required`);
      }
    }
    const lease = requireLease(message.leaseId);
    assertLeaseOwner(lease, message);
    const active = activeOperations.get(message.operationId);
    if (!active || active.leaseId !== lease.leaseId) {
      throw new RelayError(ERROR_CODES.OPERATION_NOT_FOUND, 'Operation is not active');
    }
    active.controller.abort(new RelayError(ERROR_CODES.OPERATION_CANCELLED, 'Operation cancelled by Host'));
    if (active.method === 'tabs.navigate') {
      chrome.debugger.sendCommand({ tabId: lease.nativeTabId }, 'Page.stopLoading', {}).catch(() => {});
    }
    send({
      type: 'cancel.ack',
      protocolVersion: PROTOCOL_VERSION,
      operationId: message.operationId,
      leaseId: lease.leaseId,
    });
  } catch (error) {
    sendProtocolFailure(message, error);
  }
}

function cancelActiveOperations(message) {
  for (const operation of activeOperations.values()) {
    operation.controller.abort(new RelayError(ERROR_CODES.OPERATION_CANCELLED, message));
  }
}

async function executeCommand(command, signal) {
  const lease = requireLease(command.leaseId);
  assertLeaseOwner(lease, command);

  if (command.method === 'lease.return') {
    return returnLease(lease, 'host_request');
  }
  if (command.method === 'lease.resume') {
    return resumeLease(lease);
  }

  const action = actionForCommand(command);
  await authorizeLeaseAction(lease, action);
  throwIfAborted(signal);

  switch (command.method) {
    case 'tabs.navigate':
      return navigateTab(lease, command.params, signal);
    case 'tabs.screenshot':
      return captureScreenshot(lease, command.params, signal);
    case 'dom.query':
      return queryDom(lease, command.params, signal);
    case 'dom.snapshot':
      return captureDomSnapshot(lease, command.params, signal);
    case 'accessibility.snapshot':
      return captureAccessibilitySnapshot(lease, command.params, signal);
    case 'input.click':
      return clickTarget(lease, command.params, signal);
    case 'input.type':
      return typeIntoTarget(lease, command.params, signal);
    case 'cdp.send':
      return sendAllowlistedCdp(lease, command.params, signal);
    default:
      throw new RelayError(ERROR_CODES.METHOD_NOT_ALLOWED, `Relay method is not allowed: ${command.method}`);
  }
}

function actionForCommand(command) {
  switch (command.method) {
    case 'tabs.navigate': return 'navigation';
    case 'tabs.screenshot': return 'screenshot';
    case 'dom.query':
    case 'dom.snapshot': return 'dom';
    case 'accessibility.snapshot': return 'accessibility';
    case 'input.click':
    case 'input.type': return 'input';
    case 'cdp.send': {
      const cdpMethod = command.params.method;
      const action = CDP_ACTIONS.get(cdpMethod);
      if (!action) {
        throw new RelayError(ERROR_CODES.METHOD_NOT_ALLOWED, `CDP method is not allowlisted: ${String(cdpMethod || '')}`);
      }
      return action;
    }
    default:
      throw new RelayError(ERROR_CODES.METHOD_NOT_ALLOWED, `Relay method is not allowed: ${command.method}`);
  }
}

function requireLease(leaseId) {
  const lease = leases.get(leaseId);
  if (!lease || lease.state === 'returned') {
    throw new RelayError(ERROR_CODES.LEASE_NOT_FOUND, 'Lease does not exist');
  }
  return lease;
}

function assertLeaseOwner(lease, owner) {
  if (
    lease.surfaceSessionId !== owner.surfaceSessionId
    || lease.runId !== owner.runId
    || lease.agentId !== owner.agentId
  ) {
    throw new RelayError(ERROR_CODES.LEASE_OWNER_MISMATCH, 'Lease owner does not match command owner');
  }
}

async function authorizeLeaseAction(lease, action) {
  if (Date.now() >= lease.expiresAtMs) {
    lease.state = 'expired';
    await persistProtocolState();
    throw new RelayError(ERROR_CODES.LEASE_EXPIRED, 'Lease has expired');
  }
  if (lease.state === 'orphaned' || lease.state === 'recovery_required') {
    throw new RelayError(ERROR_CODES.LEASE_ORPHANED, 'Lease must be explicitly resumed or returned', true);
  }
  if (lease.state !== 'leased') {
    throw new RelayError(ERROR_CODES.LEASE_NOT_FOUND, `Lease is not active: ${lease.state}`);
  }
  if (!isLeaseActionAllowed(lease.actions, action)) {
    throw new RelayError(ERROR_CODES.ACTION_NOT_ALLOWED, `Lease does not authorize action: ${action}`);
  }
  if (!lease.debuggerApproved) {
    throw new RelayError(ERROR_CODES.DEBUGGER_NOT_APPROVED, 'Debugger attachment was not approved in the popup');
  }
  await requireLeaseTab(lease, true);
}

function isLeaseActionAllowed(actions, action) {
  if (actions.includes(action)) return true;
  if (actions.includes('observe') && ['screenshot', 'dom', 'accessibility', 'cdp-read', 'network-read'].includes(action)) {
    return true;
  }
  return false;
}

async function requireLeaseTab(lease, validateScope) {
  let tab;
  try {
    tab = await chrome.tabs.get(lease.nativeTabId);
  } catch {
    lease.state = 'recovery_required';
    await persistProtocolState();
    throw new RelayError(ERROR_CODES.TAB_UNAVAILABLE, 'Leased tab is no longer available');
  }
  if (validateScope) validateUrlScope(tab.url, lease);
  return tab;
}

function validateUrlScope(url, scope) {
  const origin = normalizeOrigin(url);
  const hostname = normalizeHostname(url);
  if (!origin || origin !== scope.origin || hostname !== scope.hostname) {
    throw new RelayError(
      ERROR_CODES.ORIGIN_MISMATCH,
      `Current tab is outside the approved origin ${scope.origin}`,
    );
  }
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function normalizeHostname(value) {
  try {
    if (String(value || '').includes('://')) return new URL(String(value)).hostname.toLowerCase();
    return new URL(`https://${String(value || '')}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function resumeLease(lease) {
  if (!['orphaned', 'recovery_required'].includes(lease.state)) {
    return { lease: publicLeaseReference(lease), resumed: lease.state === 'leased' };
  }
  if (Date.now() >= lease.expiresAtMs) {
    lease.state = 'expired';
    await persistProtocolState();
    throw new RelayError(ERROR_CODES.LEASE_EXPIRED, 'Lease has expired');
  }
  await requireLeaseTab(lease, true);
  const targets = await chrome.debugger.getTargets();
  const target = targets.find((candidate) => candidate.tabId === lease.nativeTabId);
  if (!target?.attached || !lease.debuggerApproved) {
    lease.state = 'recovery_required';
    await persistProtocolState();
    throw new RelayError(
      ERROR_CODES.DEBUGGER_NOT_APPROVED,
      'Debugger is no longer attached; a fresh popup approval is required',
    );
  }
  lease.state = 'leased';
  await persistProtocolState();
  return { lease: publicLeaseReference(lease), resumed: true };
}

async function captureScreenshot(lease, params, signal) {
  throwIfAborted(signal);
  const format = params.format === 'png' ? 'png' : 'jpeg';
  const quality = format === 'jpeg'
    ? Math.max(1, Math.min(100, Number(params.quality) || 80))
    : undefined;
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.captureScreenshot',
    {
      format,
      ...(quality ? { quality } : {}),
      captureBeyondViewport: false,
      fromSurface: true,
    },
  );
  throwIfAborted(signal);
  return {
    data: result?.data || '',
    format,
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    tabRef: lease.tabRef,
  };
}

async function navigateTab(lease, params, signal) {
  if (!isNonEmptyString(params.url)) {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'tabs.navigate requires url');
  }
  validateUrlScope(params.url, lease);
  throwIfAborted(signal);
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.navigate',
    { url: params.url },
  );
  throwIfAborted(signal);
  lease.documentRevision = opaqueId('document');
  await persistProtocolState();
  return {
    accepted: !result?.errorText,
    errorText: result?.errorText || null,
    tabRef: lease.tabRef,
    url: params.url,
  };
}

async function queryDom(lease, params, signal) {
  const target = await resolveNodeTarget(lease, params, signal);
  return {
    tabRef: lease.tabRef,
    nodeRef: target.nodeRef,
    backendNodeId: target.backendNodeId,
    frameRef: target.frameRef,
    role: target.role,
    name: target.name,
    bounds: target.bounds,
  };
}

async function captureDomSnapshot(lease, params, signal) {
  throwIfAborted(signal);
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOMSnapshot.captureSnapshot',
    {
      computedStyles: Array.isArray(params.computedStyles) ? params.computedStyles.slice(0, 64) : [],
      includeDOMRects: true,
      includePaintOrder: false,
    },
  );
  throwIfAborted(signal);
  return { tabRef: lease.tabRef, snapshot: stripNativeTargetIdentifiers(result || {}) };
}

async function captureAccessibilitySnapshot(lease, _params, signal) {
  throwIfAborted(signal);
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Accessibility.getFullAXTree',
    {},
  );
  throwIfAborted(signal);
  return { tabRef: lease.tabRef, tree: stripNativeTargetIdentifiers(result || {}) };
}

async function resolveNodeTarget(lease, params, signal) {
  throwIfAborted(signal);
  const refs = nodeRefsByLease.get(lease.leaseId) || new Map();
  nodeRefsByLease.set(lease.leaseId, refs);

  let nodeId = null;
  let existingRef = null;
  if (isNonEmptyString(params.nodeRef)) {
    const existing = refs.get(params.nodeRef);
    if (!existing) {
      throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, 'Opaque node reference is unknown or stale');
    }
    nodeId = existing.nodeId;
    existingRef = params.nodeRef;
  } else if (isNonEmptyString(params.selector)) {
    const documentResult = await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'DOM.getDocument',
      { depth: 1, pierce: true },
    );
    const queryResult = await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'DOM.querySelector',
      { nodeId: documentResult.root.nodeId, selector: params.selector },
    );
    nodeId = queryResult?.nodeId || null;
  } else {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'selector or opaque nodeRef is required');
  }

  if (!nodeId) {
    throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, 'DOM target was not found');
  }
  throwIfAborted(signal);
  const [boxResult, description] = await Promise.all([
    chrome.debugger.sendCommand({ tabId: lease.nativeTabId }, 'DOM.getBoxModel', { nodeId }),
    chrome.debugger.sendCommand({ tabId: lease.nativeTabId }, 'DOM.describeNode', { nodeId, depth: 0 }),
  ]);
  const bounds = boundsFromQuad(boxResult?.model?.content || boxResult?.model?.border);
  if (!bounds) {
    throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, 'DOM target has no visible box');
  }

  const backendNodeId = description?.node?.backendNodeId;
  let accessibility = null;
  if (Number.isInteger(backendNodeId)) {
    accessibility = await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Accessibility.queryAXTree',
      { backendNodeId, fetchRelatives: false },
    ).catch(() => null);
  }
  const axNode = accessibility?.nodes?.[0] || null;
  const nodeRef = existingRef || opaqueId('node');
  refs.set(nodeRef, { nodeId, backendNodeId });
  return {
    nodeId,
    nodeRef,
    backendNodeId: Number.isInteger(backendNodeId) ? backendNodeId : null,
    frameRef: frameRefForLease(lease.leaseId, description?.node?.frameId || 'main'),
    role: axNode?.role?.value || description?.node?.nodeName?.toLowerCase() || '',
    name: axNode?.name?.value || '',
    bounds,
  };
}

function frameRefForLease(leaseId, nativeFrameId) {
  const refs = frameRefsByLease.get(leaseId) || new Map();
  frameRefsByLease.set(leaseId, refs);
  if (!refs.has(nativeFrameId)) refs.set(nativeFrameId, opaqueId('frame'));
  return refs.get(nativeFrameId);
}

function boundsFromQuad(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    centerX: left + ((right - left) / 2),
    centerY: top + ((bottom - top) / 2),
  };
}

async function clickTarget(lease, params, signal) {
  const target = await resolveNodeTarget(lease, params, signal);
  const button = ['left', 'middle', 'right'].includes(params.button) ? params.button : 'left';
  const clickCount = Math.max(1, Math.min(3, Number(params.clickCount) || 1));
  for (const type of ['mousePressed', 'mouseReleased']) {
    throwIfAborted(signal);
    await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Input.dispatchMouseEvent',
      {
        type,
        x: target.bounds.centerX,
        y: target.bounds.centerY,
        button,
        clickCount,
      },
    );
  }
  lease.documentRevision = opaqueId('document');
  await persistProtocolState();
  return { clicked: true, nodeRef: target.nodeRef, tabRef: lease.tabRef };
}

async function typeIntoTarget(lease, params, signal) {
  if (typeof params.text !== 'string') {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'input.type requires text');
  }
  if (params.text.length > 100000) {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'input.type text exceeds the relay limit');
  }
  const target = await resolveNodeTarget(lease, params, signal);
  throwIfAborted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOM.focus',
    { nodeId: target.nodeId },
  );

  if (params.replace !== false) {
    const platform = await chrome.runtime.getPlatformInfo();
    const modifiers = platform.os === 'mac' ? 4 : 2;
    await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers },
    );
    await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'a', code: 'KeyA', modifiers },
    );
  }

  throwIfAborted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Input.insertText',
    { text: params.text },
  );
  throwIfAborted(signal);
  lease.documentRevision = opaqueId('document');
  await persistProtocolState();
  return { nodeRef: target.nodeRef, tabRef: lease.tabRef, typed: true };
}

async function sendAllowlistedCdp(lease, params, signal) {
  const method = params.method;
  if (!CDP_ACTIONS.has(method)) {
    throw new RelayError(ERROR_CODES.METHOD_NOT_ALLOWED, `CDP method is not allowlisted: ${String(method || '')}`);
  }
  throwIfAborted(signal);
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    method,
    params.params && typeof params.params === 'object' ? params.params : {},
  );
  throwIfAborted(signal);
  return { tabRef: lease.tabRef, result: stripNativeTargetIdentifiers(result || {}) };
}

function stripNativeTargetIdentifiers(value) {
  if (Array.isArray(value)) return value.map(stripNativeTargetIdentifiers);
  if (!value || typeof value !== 'object') return value;
  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/^(tabId|windowId|targetId|nodeId|backendNodeId|backendDOMNodeId|objectId|executionContextId|frameId|loaderId)$/i.test(key)) {
      continue;
    }
    sanitized[key] = stripNativeTargetIdentifiers(nested);
  }
  return sanitized;
}

function throwIfAborted(signal) {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof RelayError
    ? reason
    : new RelayError(ERROR_CODES.OPERATION_CANCELLED, 'Operation was cancelled');
}

async function approveLatestPendingLease() {
  const request = pendingLeaseRequest;
  if (!request) {
    throw new RelayError(ERROR_CODES.USER_APPROVAL_REQUIRED, 'There is no pending lease request');
  }
  if (!handshakeComplete) {
    throw new RelayError(ERROR_CODES.HANDSHAKE_REQUIRED, 'Host handshake is not active', true);
  }
  if (Date.now() >= request.expiresAtMs) {
    pendingLeaseRequest = null;
    await persistProtocolState();
    throw new RelayError(ERROR_CODES.LEASE_EXPIRED, 'Pending lease request has expired');
  }

  const tab = await getCurrentActiveTab();
  validateUrlScope(tab.url, request);
  if (Array.from(leases.values()).some((lease) => lease.nativeTabId === tab.id && lease.state !== 'returned')) {
    throw new RelayError(ERROR_CODES.TAB_ALREADY_LEASED, 'Current tab already belongs to a relay lease');
  }

  const original = {
    windowId: tab.windowId,
    index: tab.index,
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    placeholderTabId: null,
  };
  let agentWindowId = null;
  let debuggerApproved = false;

  try {
    original.placeholderTabId = await createReturnPlaceholderIfNeeded(tab);
    if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: false });
    agentWindowId = await moveToAgentWindow(tab, request.surfaceSessionId);

    // The only debugger.attach path is this user-triggered popup approval flow.
    await chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_PROTOCOL_VERSION);
    debuggerApproved = true;
    await Promise.allSettled([
      chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {}),
      chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.enable', {}),
      chrome.debugger.sendCommand({ tabId: tab.id }, 'Accessibility.enable', {}),
    ]);

    if (Date.now() >= request.expiresAtMs) {
      throw new RelayError(ERROR_CODES.LEASE_EXPIRED, 'Lease request expired during approval');
    }

    const lease = {
      leaseId: opaqueId('lease'),
      tabRef: opaqueId('tab'),
      agentWindowRef: opaqueId('agent_window'),
      originalWindowRef: opaqueId('original_window'),
      surfaceSessionId: request.surfaceSessionId,
      runId: request.runId,
      agentId: request.agentId,
      origin: request.origin,
      hostname: request.hostname,
      actions: request.actions,
      expiresAtMs: request.expiresAtMs,
      documentRevision: opaqueId('document'),
      approvedAtMs: Date.now(),
      state: 'leased',
      nativeTabId: tab.id,
      agentWindowId,
      original,
      debuggerApproved,
    };
    leases.set(lease.leaseId, lease);
    pendingLeaseRequest = null;
    await persistProtocolState();
    send({
      type: 'lease.approved',
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      lease: publicLeaseReference(lease),
    });
    return { lease: publicLeaseReference(lease), ok: true };
  } catch (error) {
    if (debuggerApproved) {
      intentionalDebuggerDetach.add(tab.id);
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
      intentionalDebuggerDetach.delete(tab.id);
    }
    await restoreOriginalPlacement(tab.id, original).catch(() => {});
    throw error;
  }
}

async function denyLatestPendingLease() {
  const request = pendingLeaseRequest;
  if (!request) return { denied: false };
  pendingLeaseRequest = null;
  await persistProtocolState();
  send({
    type: 'lease.denied',
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    error: {
      code: 'RELAY_LEASE_DENIED',
      message: 'User denied the lease request',
      retryable: false,
    },
  });
  return { denied: true };
}

async function createReturnPlaceholderIfNeeded(tab) {
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length !== 1) return null;
  const placeholder = await chrome.tabs.create({
    windowId: tab.windowId,
    url: 'about:blank',
    active: false,
  });
  return placeholder.id;
}

async function moveToAgentWindow(tab, surfaceSessionId) {
  const existing = Array.from(leases.values()).find((lease) => (
    lease.surfaceSessionId === surfaceSessionId
    && lease.state !== 'returned'
    && Number.isInteger(lease.agentWindowId)
  ));
  if (existing) {
    try {
      await chrome.windows.get(existing.agentWindowId);
      await chrome.tabs.move(tab.id, { windowId: existing.agentWindowId, index: -1 });
      await chrome.windows.update(existing.agentWindowId, { focused: true });
      return existing.agentWindowId;
    } catch {
      // The previous Agent Window is gone; create a new isolated one below.
    }
  }

  const agentWindow = await chrome.windows.create({
    tabId: tab.id,
    focused: true,
    type: 'normal',
  });
  if (!Number.isInteger(agentWindow.id)) {
    throw new RelayError(ERROR_CODES.TAB_UNAVAILABLE, 'Failed to create Surface Session Agent Window');
  }
  return agentWindow.id;
}

async function returnLease(lease, reason) {
  if (lease.state === 'returned') return { returned: true, alreadyReturned: true };
  lease.state = 'returning';
  await persistProtocolState();

  try {
    if (lease.debuggerApproved) {
      intentionalDebuggerDetach.add(lease.nativeTabId);
      try {
        await chrome.debugger.detach({ tabId: lease.nativeTabId });
      } catch (error) {
        const message = String(error?.message || error);
        if (!message.toLowerCase().includes('not attached')) throw error;
      } finally {
        intentionalDebuggerDetach.delete(lease.nativeTabId);
      }
      lease.debuggerApproved = false;
    }

    await restoreOriginalPlacement(lease.nativeTabId, lease.original);
    lease.state = 'returned';
    lease.returnedAtMs = Date.now();
    lease.returnReason = reason;
    nodeRefsByLease.delete(lease.leaseId);
    frameRefsByLease.delete(lease.leaseId);
    await persistProtocolState();
    send({
      type: 'lease.returned',
      protocolVersion: PROTOCOL_VERSION,
      leaseId: lease.leaseId,
      surfaceSessionId: lease.surfaceSessionId,
      reason,
    });
    return { returned: true, leaseId: lease.leaseId };
  } catch (error) {
    lease.state = 'recovery_required';
    await persistProtocolState();
    throw new RelayError(
      ERROR_CODES.TAB_RETURN_FAILED,
      `Failed to restore the leased tab to its original placement: ${error?.message || String(error)}`,
    );
  }
}

async function restoreOriginalPlacement(nativeTabId, original) {
  if (!original || !Number.isInteger(original.windowId)) {
    throw new RelayError(ERROR_CODES.TAB_RETURN_FAILED, 'Original tab placement is unavailable');
  }
  await chrome.windows.get(original.windowId);
  await chrome.tabs.get(nativeTabId);
  await chrome.tabs.move(nativeTabId, {
    windowId: original.windowId,
    index: Math.max(0, Number(original.index) || 0),
  });
  await chrome.tabs.update(nativeTabId, {
    pinned: Boolean(original.pinned),
    active: Boolean(original.active),
  });
  if (original.active) await chrome.windows.update(original.windowId, { focused: true });
  await removeUntouchedPlaceholder(original.placeholderTabId);
}

async function removeUntouchedPlaceholder(placeholderTabId) {
  if (!Number.isInteger(placeholderTabId)) return;
  try {
    const placeholder = await chrome.tabs.get(placeholderTabId);
    if (placeholder.url === 'about:blank' || placeholder.pendingUrl === 'about:blank') {
      await chrome.tabs.remove(placeholderTabId);
    }
  } catch {
    // The placeholder may already have been removed by the user.
  }
}

async function getCurrentActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !Number.isInteger(activeTab.id)) {
    throw new RelayError(ERROR_CODES.TAB_UNAVAILABLE, 'No active tab found');
  }
  return activeTab;
}

function markLeasesOrphaned() {
  let changed = false;
  for (const lease of leases.values()) {
    if (lease.state === 'leased') {
      lease.state = 'orphaned';
      changed = true;
    }
  }
  if (changed) persistProtocolState();
}

function expireProtocolState() {
  const now = Date.now();
  let changed = false;
  if (pendingLeaseRequest && now >= pendingLeaseRequest.expiresAtMs) {
    pendingLeaseRequest = null;
    changed = true;
  }
  for (const lease of leases.values()) {
    if (['leased', 'orphaned'].includes(lease.state) && now >= lease.expiresAtMs) {
      lease.state = 'expired';
      changed = true;
      send({
        type: 'lease.expired',
        protocolVersion: PROTOCOL_VERSION,
        leaseId: lease.leaseId,
        surfaceSessionId: lease.surfaceSessionId,
      });
    }
  }
  if (changed) persistProtocolState();
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!Number.isInteger(source.tabId) || intentionalDebuggerDetach.has(source.tabId)) return;
  const lease = Array.from(leases.values()).find((candidate) => (
    candidate.nativeTabId === source.tabId && candidate.state !== 'returned'
  ));
  if (!lease) return;
  lease.debuggerApproved = false;
  lease.state = 'recovery_required';
  persistProtocolState();
  send({
    type: 'lease.interrupted',
    protocolVersion: PROTOCOL_VERSION,
    leaseId: lease.leaseId,
    surfaceSessionId: lease.surfaceSessionId,
    error: {
      code: 'RELAY_DEBUGGER_DETACHED',
      message: `Chrome debugger detached: ${reason}`,
      retryable: true,
    },
  });
});

chrome.tabs.onRemoved.addListener((nativeTabId) => {
  const lease = Array.from(leases.values()).find((candidate) => (
    candidate.nativeTabId === nativeTabId && candidate.state !== 'returned'
  ));
  if (!lease) return;
  lease.state = 'recovery_required';
  lease.debuggerApproved = false;
  persistProtocolState();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let changed = false;
  if (changes.relayPort) {
    config.port = changes.relayPort.newValue;
    changed = true;
  }
  if (changes.authToken) {
    config.token = changes.authToken.newValue;
    changed = true;
  }
  if (changed) {
    disconnect();
    connect();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'getStatus') {
    getPopupStatus().then(sendResponse).catch((error) => {
      sendResponse({ error: errorPayload(error) });
    });
    return true;
  }
  if (message.type === 'approvePendingLease') {
    approveLatestPendingLease().then(sendResponse).catch((error) => {
      sendResponse({ error: errorPayload(error) });
    });
    return true;
  }
  if (message.type === 'denyPendingLease') {
    denyLatestPendingLease().then(sendResponse).catch((error) => {
      sendResponse({ error: errorPayload(error) });
    });
    return true;
  }
  if (message.type === 'returnCurrentLease') {
    returnCurrentLease().then(sendResponse).catch((error) => {
      sendResponse({ error: errorPayload(error) });
    });
    return true;
  }
  if (message.type === 'reconnect') {
    disconnect();
    loadConfig().then(() => connect(false));
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

async function getPopupStatus() {
  let currentTab = null;
  try {
    const active = await getCurrentActiveTab();
    const lease = Array.from(leases.values()).find((candidate) => (
      candidate.nativeTabId === active.id && candidate.state !== 'returned'
    ));
    currentTab = {
      title: active.title || '',
      url: active.url || '',
      lease: lease ? publicLeaseReference(lease) : null,
    };
  } catch {
    currentTab = null;
  }
  const pending = pendingLeaseRequest && pendingLeaseRequest.expiresAtMs > Date.now()
    ? {
        requestId: pendingLeaseRequest.requestId,
        surfaceSessionId: pendingLeaseRequest.surfaceSessionId,
        runId: pendingLeaseRequest.runId,
        agentId: pendingLeaseRequest.agentId,
        origin: pendingLeaseRequest.origin,
        hostname: pendingLeaseRequest.hostname,
        actions: pendingLeaseRequest.actions,
        expiresAtMs: pendingLeaseRequest.expiresAtMs,
      }
    : null;
  return {
    connectionState,
    handshakeComplete,
    port: config.port,
    activeLeaseCount: Array.from(leases.values()).filter((lease) => lease.state !== 'returned').length,
    currentTab,
    pendingLease: pending,
  };
}

async function returnCurrentLease() {
  const tab = await getCurrentActiveTab();
  const lease = Array.from(leases.values()).find((candidate) => (
    candidate.nativeTabId === tab.id && candidate.state !== 'returned'
  ));
  if (!lease) throw new RelayError(ERROR_CODES.LEASE_NOT_FOUND, 'Current tab is not leased');
  return returnLease(lease, 'user_request');
}

init();
