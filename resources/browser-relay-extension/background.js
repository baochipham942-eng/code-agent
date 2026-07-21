/* global AbortController, URL, WebSocket, chrome, clearTimeout, console, crypto, fetch, importScripts, setTimeout */

importScripts('protocol-v2.js');

const RELAY_PROTOCOL = globalThis.NEO_BROWSER_RELAY_V2;
const PROTOCOL_VERSION = RELAY_PROTOCOL.protocolVersion;
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const STORAGE_KEYS = Object.freeze({
  extensionInstanceId: 'browserRelayExtensionInstanceIdV2',
  leases: 'browserRelayLeasesV2',
  pendingLease: 'browserRelayPendingLeaseV2',
});

const CAPABILITIES = RELAY_PROTOCOL.capabilities;
const ACTION_METHODS = RELAY_PROTOCOL.actionMethods;
const METHOD_ACTIONS = new Map();
for (const [action, method] of Object.entries(ACTION_METHODS)) {
  const actions = METHOD_ACTIONS.get(method) || [];
  actions.push(action);
  METHOD_ACTIONS.set(method, actions);
}
METHOD_ACTIONS.set('lease.return', ['lease:return']);

const ERROR_CODES = Object.freeze({
  ACTION_NOT_ALLOWED: 'RELAY_ACTION_NOT_ALLOWED',
  DEBUGGER_NOT_APPROVED: 'RELAY_CAPABILITY_UNSUPPORTED',
  DIALOG_BLOCKED: 'RELAY_DIALOG_BLOCKED',
  FILE_UPLOAD_BLOCKED: 'RELAY_FILE_UPLOAD_BLOCKED',
  HANDSHAKE_REQUIRED: 'RELAY_HANDSHAKE_REQUIRED',
  INTERNAL: 'RELAY_COMMAND_FAILED',
  INVALID_COMMAND: 'RELAY_COMMAND_FAILED',
  INVALID_LEASE_REQUEST: 'RELAY_COMMAND_FAILED',
  LEASE_EXPIRED: 'RELAY_LEASE_EXPIRED',
  LEASE_NOT_FOUND: 'RELAY_LEASE_REQUIRED',
  LEASE_ORPHANED: 'RELAY_LEASE_NOT_OWNED',
  LEASE_OWNER_MISMATCH: 'RELAY_LEASE_NOT_OWNED',
  METHOD_NOT_ALLOWED: 'RELAY_CAPABILITY_UNSUPPORTED',
  NATIVE_TARGET_FORBIDDEN: 'RELAY_TARGET_CHANGED',
  OPERATION_CANCELLED: 'RELAY_OPERATION_CANCELLED',
  OPERATION_IN_PROGRESS: 'RELAY_COMMAND_FAILED',
  OPERATION_NOT_FOUND: 'RELAY_COMMAND_FAILED',
  OPERATION_TIMEOUT: 'RELAY_OPERATION_TIMEOUT',
  ORIGIN_MISMATCH: 'RELAY_DOMAIN_NOT_ALLOWED',
  PROTOCOL_UNSUPPORTED: 'RELAY_PROTOCOL_VERSION_MISMATCH',
  TAB_ALREADY_LEASED: 'RELAY_LEASE_REQUIRED',
  TAB_RETURN_FAILED: 'RELAY_TAB_RETURN_FAILED',
  TAB_UNAVAILABLE: 'RELAY_TARGET_CHANGED',
  TARGET_NOT_FOUND: 'RELAY_TARGET_CHANGED',
  USER_APPROVAL_REQUIRED: 'RELAY_LEASE_REQUIRED',
});

const ALLOWED_ACTIONS = new Set([...Object.keys(ACTION_METHODS), 'close', 'lease:return']);

class RelayError extends Error {
  constructor(code, message, retryable = false, delivery = null) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.retryable = retryable;
    this.delivery = delivery;
  }
}

let ws = null;
let reconnectDelay = 1000;
let connectionState = 'disconnected';
let handshakeComplete = false;
let config = { port: 23001, token: '' };
let extensionInstanceId = '';
let pendingLeaseRequest = null;
let nextLogCursor = 1;
let nextDialogGeneration = 1;

const leases = new Map();
const cancelledLeaseRequests = new Map();
const nodeRefsByLease = new Map();
const frameRefsByLease = new Map();
const logsByLease = new Map();
const dialogsByLease = new Map();
const dialogOpenWaitersByLease = new Map();
const documentInScopeByLease = new Map();
const activeOperations = new Map();
const leaseReturnPromises = new Map();
const DIALOG_RECOVERY_METHODS = new Set(['dialog.get', 'dialog.handle']);
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

function errorPayload(error, delivery = 'not_attempted') {
  const normalized = relayError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: Boolean(normalized.retryable),
    delivery: normalized.delivery || delivery,
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
    const storedPendingLease = stored[STORAGE_KEYS.pendingLease];
    pendingLeaseRequest = isPersistedPendingLease(storedPendingLease)
      ? storedPendingLease
      : null;
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
      && isNonEmptyString(value.conversationId)
      && isNonEmptyString(value.runId)
      && isNonEmptyString(value.agentId)
      && Number.isInteger(value.nativeTabId),
  );
}

function isPersistedPendingLease(value) {
  return Boolean(
    value
      && isNonEmptyString(value.requestId)
      && isNonEmptyString(value.surfaceSessionId)
      && isNonEmptyString(value.conversationId)
      && isNonEmptyString(value.runId)
      && isNonEmptyString(value.agentId)
      && Array.isArray(value.domainScopes)
      && value.domainScopes.length > 0
      && value.domainScopes.every(isValidDomainScope)
      && Array.isArray(value.actionScopes)
      && value.actionScopes.length > 0
      && value.actionScopes.every((action) => ALLOWED_ACTIONS.has(action))
      && Number.isFinite(value.consentDeadlineAt)
      && value.consentDeadlineAt > Date.now()
      && Number.isFinite(value.expiresAt)
      && value.expiresAt >= value.consentDeadlineAt,
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
    const stored = await chrome.storage.local.get(['relayPort']);
    if (stored.relayPort) config.port = stored.relayPort;
  } catch (error) {
    console.warn('[Agent Neo Relay] Failed to load settings', error);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/browser-relay/config`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'X-Agent-Neo-Relay-Extension': PROTOCOL_VERSION },
    });
    if (response.ok) {
      const autoConfig = await response.json();
      if (autoConfig.port) config.port = autoConfig.port;
      if (autoConfig.token) config.token = autoConfig.token;
      await chrome.storage.local.set({ relayPort: config.port });
    }
  } catch {
    // Agent Neo may not be running yet. Pairing material stays memory-only.
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
  };

  ws.onmessage = (event) => handleMessage(event.data);

  ws.onclose = () => {
    ws = null;
    handshakeComplete = false;
    connectionState = 'disconnected';
    updateBadge();
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
    capabilities: [...CAPABILITIES],
    extensionInstanceId,
    orphanedLeaseIds: Array.from(leases.values())
      .filter((lease) => ['orphaned', 'recovery_required', 'expired'].includes(lease.state))
      .map((lease) => lease.leaseId),
  });
}

function publicLeaseReference(lease) {
  return {
    leaseId: lease.leaseId,
    surfaceSessionId: lease.surfaceSessionId,
    conversationId: lease.conversationId,
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

function setupAlarms() {
  chrome.alarms.create('code-agent-relay-keepalive', { periodInMinutes: 25 / 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'code-agent-relay-keepalive') return;
    expireProtocolState().catch((error) => {
      console.warn('[Agent Neo Relay] Failed to expire relay protocol state', error);
    });
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

  if (message.type === 'lease.request.cancel') {
    await handleLeaseRequestCancel(message);
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
  if (!isNonEmptyString(message.connectionGeneration)
    || !Array.isArray(message.requiredCapabilities)
    || message.requiredCapabilities.length !== CAPABILITIES.length
    || CAPABILITIES.some((capability) => !message.requiredCapabilities.includes(capability))) {
    sendProtocolFailure(message, new RelayError(
      ERROR_CODES.PROTOCOL_UNSUPPORTED,
      'hello_ack does not match the Browser Relay V2 capability manifest',
    ));
    ws?.close(1002, 'Invalid relay capability manifest');
    return;
  }
  handshakeComplete = true;
  connectionState = 'connected';
  updateBadge();
  announceReturnedLeases();
}

function announceReturnedLeases() {
  for (const lease of leases.values()) {
    if (lease.state !== 'returned' || !isCompleteOwner(lease)) continue;
    send({
      type: 'lease.returned',
      protocolVersion: PROTOCOL_VERSION,
      leaseId: lease.leaseId,
      surfaceSessionId: lease.surfaceSessionId,
      conversationId: lease.conversationId,
      runId: lease.runId,
      agentId: lease.agentId,
    });
  }
}

function sendProtocolFailure(message, error, registeredOperation = null) {
  if (message?.type === 'lease.request' && isCompleteOwner(message) && isNonEmptyString(message.requestId)) {
    send({
      type: 'lease.denied',
      protocolVersion: PROTOCOL_VERSION,
      requestId: message.requestId,
      surfaceSessionId: message.surfaceSessionId,
      conversationId: message.conversationId,
      runId: message.runId,
      agentId: message.agentId,
      deniedAt: Date.now(),
    });
    return;
  }
  if (message?.type !== 'command'
    || !isNonEmptyString(message.id)
    || !isNonEmptyString(message.operationId)) return;
  const normalized = relayError(error);
  const rejectedBeforeDelivery = new Set([
    ERROR_CODES.ACTION_NOT_ALLOWED,
    ERROR_CODES.DEBUGGER_NOT_APPROVED,
    ERROR_CODES.DIALOG_BLOCKED,
    ERROR_CODES.FILE_UPLOAD_BLOCKED,
    ERROR_CODES.HANDSHAKE_REQUIRED,
    ERROR_CODES.INVALID_COMMAND,
    ERROR_CODES.LEASE_EXPIRED,
    ERROR_CODES.LEASE_NOT_FOUND,
    ERROR_CODES.LEASE_ORPHANED,
    ERROR_CODES.LEASE_OWNER_MISMATCH,
    ERROR_CODES.METHOD_NOT_ALLOWED,
    ERROR_CODES.NATIVE_TARGET_FORBIDDEN,
    ERROR_CODES.ORIGIN_MISMATCH,
    ERROR_CODES.PROTOCOL_UNSUPPORTED,
  ]).has(normalized.code);
  const delivery = normalized.delivery || (isMutationAction(message?.actionScope)
    && (registeredOperation?.deliveryStarted || !rejectedBeforeDelivery)
    ? 'unknown'
    : 'not_attempted');
  send({
    type: 'response',
    protocolVersion: PROTOCOL_VERSION,
    id: message.id,
    operationId: message.operationId,
    error: errorPayload(normalized, delivery),
  });
}

function isCompleteOwner(value) {
  return ['surfaceSessionId', 'conversationId', 'runId', 'agentId']
    .every((field) => isNonEmptyString(value?.[field]));
}

function isMutationAction(action) {
  return [
    'navigate', 'back', 'forward', 'reload', 'click', 'click_text',
    'type', 'press_key', 'scroll', 'hover', 'drag', 'handle_dialog', 'upload_file',
    'close', 'lease:return',
  ].includes(action);
}

async function handleLeaseRequest(message) {
  try {
    const request = normalizeLeaseRequest(message);
    if (pendingLeaseRequest && pendingLeaseRequest.requestId !== request.requestId) {
      send({
        type: 'lease.denied',
        protocolVersion: PROTOCOL_VERSION,
        requestId: pendingLeaseRequest.requestId,
        surfaceSessionId: pendingLeaseRequest.surfaceSessionId,
        conversationId: pendingLeaseRequest.conversationId,
        runId: pendingLeaseRequest.runId,
        agentId: pendingLeaseRequest.agentId,
        deniedAt: Date.now(),
      });
    }
    pendingLeaseRequest = request;
    await persistProtocolState();
  } catch (error) {
    sendProtocolFailure(message, relayError(error, ERROR_CODES.INVALID_LEASE_REQUEST));
  }
}

async function handleLeaseRequestCancel(message) {
  try {
    if (message.protocolVersion !== PROTOCOL_VERSION || !isNonEmptyString(message.requestId)) {
      throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'lease.request.cancel requires protocolVersion and requestId');
    }
    if (!isCompleteOwner(message)) {
      throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'lease.request.cancel requires a complete owner');
    }
    const request = pendingLeaseRequest;
    if (!request || request.requestId !== message.requestId) return;
    for (const field of ['surfaceSessionId', 'conversationId', 'runId', 'agentId']) {
      if (request[field] !== message[field]) {
        throw new RelayError(ERROR_CODES.LEASE_OWNER_MISMATCH, 'Lease cancellation owner does not match the pending request');
      }
    }
    cancelledLeaseRequests.set(request.requestId, request.expiresAt);
    pendingLeaseRequest = null;
    await persistProtocolState();
  } catch (error) {
    sendProtocolFailure(message, relayError(error, ERROR_CODES.INVALID_LEASE_REQUEST));
  }
}

function normalizeLeaseRequest(message) {
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    throw new RelayError(ERROR_CODES.PROTOCOL_UNSUPPORTED, `Expected protocol ${PROTOCOL_VERSION}`);
  }
  const requestId = message.requestId;
  const domainScopes = Array.from(new Set(Array.isArray(message.domainScopes) ? message.domainScopes : []));
  const actionScopes = Array.from(new Set(Array.isArray(message.actionScopes) ? message.actionScopes : []));
  const consentDeadlineAt = Number(message.consentDeadlineAt);
  const expiresAt = Number(message.expiresAt);

  for (const field of ['requestId', 'surfaceSessionId', 'conversationId', 'runId', 'agentId']) {
    if (!isNonEmptyString(field === 'requestId' ? requestId : message[field])) {
      throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, `${field} is required`);
    }
  }
  if (!domainScopes.length || domainScopes.some((scope) => !isValidDomainScope(scope))) {
    throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'Lease domains must be explicit origins, hosts, or selected-tab-origin');
  }
  if (!actionScopes.length || actionScopes.some((action) => !ALLOWED_ACTIONS.has(action))) {
    throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'Lease actions must be an explicit supported action list');
  }
  if (!Number.isFinite(consentDeadlineAt)
    || consentDeadlineAt <= Date.now()
    || consentDeadlineAt > Date.now() + 30_000
    || !Number.isFinite(expiresAt)
    || expiresAt < consentDeadlineAt
    || expiresAt > Date.now() + (30 * 60_000)) {
    throw new RelayError(ERROR_CODES.INVALID_LEASE_REQUEST, 'Lease expiry must be within the next 30 minutes');
  }

  return {
    requestId,
    surfaceSessionId: message.surfaceSessionId,
    conversationId: message.conversationId,
    runId: message.runId,
    agentId: message.agentId,
    domainScopes,
    actionScopes,
    consentDeadlineAt,
    expiresAt,
    requestedAtMs: Date.now(),
  };
}

function isValidDomainScope(scope) {
  return Boolean(parseDomainScope(scope));
}

async function handleCommand(message) {
  let command;
  let deadlineTimer = null;
  let registeredOperation = null;
  try {
    command = validateCommandEnvelope(message);
    preflightCommandLease(command);
    const existingOperation = activeOperations.get(command.operationId);
    if (existingOperation) {
      throw new RelayError(ERROR_CODES.OPERATION_IN_PROGRESS, 'Operation is already running', true);
    }
    if (dialogsByLease.has(command.leaseId)
      && command.method !== 'lease.return'
      && !DIALOG_RECOVERY_METHODS.has(command.method)) {
      throw new RelayError(
        ERROR_CODES.DIALOG_BLOCKED,
        'A browser dialog is paused; only dialog state or handling is allowed',
        true,
      );
    }
    const conflictingOperations = Array.from(activeOperations.entries())
      .filter(([, active]) => active.leaseId === command.leaseId);
    if (conflictingOperations.length > 0) {
      const currentDialogGeneration = dialogsByLease.get(command.leaseId)?.generation;
      const dialogRecoveryAllowed = command.method === 'dialog.get'
        || (command.method === 'dialog.handle'
          && Number.isInteger(currentDialogGeneration)
          && !conflictingOperations.some(([, active]) => (
            active.method === 'dialog.handle'
            && active.dialogGeneration === currentDialogGeneration
          )));
      if (command.method !== 'lease.return' && !dialogRecoveryAllowed) {
        throw new RelayError(ERROR_CODES.OPERATION_IN_PROGRESS, 'Lease already has an active operation', true);
      }
    }

    const controller = new AbortController();
    deadlineTimer = setTimeout(() => {
      controller.abort(new RelayError(
        ERROR_CODES.OPERATION_TIMEOUT,
        'Relay command exceeded its Host-provided deadline',
        true,
        isMutationAction(command.actionScope) ? 'unknown' : 'not_attempted',
      ));
    }, Math.max(1, command.deadlineAt - Date.now()));
    registeredOperation = {
      controller,
      leaseId: command.leaseId,
      method: command.method,
      actionScope: command.actionScope,
      deliveryStarted: false,
      dialogGeneration: command.method === 'dialog.handle'
        ? dialogsByLease.get(command.leaseId)?.generation ?? null
        : null,
    };
    activeOperations.set(command.operationId, registeredOperation);
    const result = await executeCommand(command, controller.signal);
    throwIfAborted(controller.signal);
    const resultLease = leases.get(command.leaseId);
    if (command.method !== 'lease.return' && resultLease) {
      await requireLeaseTab(resultLease, true);
      throwIfAborted(controller.signal);
    }
    send({
      type: 'response',
      protocolVersion: PROTOCOL_VERSION,
      id: command.id,
      operationId: command.operationId,
      result: {
        ...(result && typeof result === 'object' ? result : { value: result }),
        target: resultLease ? targetMetadata(resultLease) : null,
      },
    });
  } catch (error) {
    const aborted = registeredOperation?.controller.signal.aborted
      ? registeredOperation.controller.signal.reason
      : null;
    sendProtocolFailure(message, aborted || error, registeredOperation);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (command?.operationId
      && registeredOperation
      && activeOperations.get(command.operationId) === registeredOperation) {
      activeOperations.delete(command.operationId);
    }
  }
}

function validateCommandEnvelope(message) {
  if (message.type !== 'command' || message.protocolVersion !== PROTOCOL_VERSION) {
    throw new RelayError(ERROR_CODES.PROTOCOL_UNSUPPORTED, `Expected command protocol ${PROTOCOL_VERSION}`);
  }
  for (const field of ['id', 'surfaceSessionId', 'conversationId', 'runId', 'agentId', 'operationId', 'leaseId', 'method', 'actionScope']) {
    if (!isNonEmptyString(message[field])) {
      throw new RelayError(ERROR_CODES.INVALID_COMMAND, `${field} is required`);
    }
  }
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (!Number.isFinite(message.deadlineAt) || message.deadlineAt <= Date.now()) {
    throw new RelayError(ERROR_CODES.OPERATION_TIMEOUT, 'Relay command deadline has expired', true);
  }
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
    for (const field of ['surfaceSessionId', 'conversationId', 'runId', 'agentId', 'leaseId']) {
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
    active.controller.abort(new RelayError(
      ERROR_CODES.OPERATION_CANCELLED,
      'Operation cancelled by Host',
      true,
      isMutationAction(active.actionScope) ? 'unknown' : 'not_attempted',
    ));
    if (active.method === 'tab.navigate') {
      chrome.debugger.sendCommand({ tabId: lease.nativeTabId }, 'Page.stopLoading', {}).catch(() => {});
    }
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
  const allowedActions = METHOD_ACTIONS.get(command.method);
  if (!allowedActions?.includes(command.actionScope)) {
    throw new RelayError(
      ERROR_CODES.ACTION_NOT_ALLOWED,
      `Relay method ${command.method} does not match action scope ${command.actionScope}`,
    );
  }
  if (command.method === 'lease.return') {
    markOperationDeliveryStarted(signal);
    return returnLease(lease, 'host_request', {
      excludeOperationId: command.operationId,
      deadlineAt: command.deadlineAt,
    });
  }

  await authorizeLeaseAction(lease, command.actionScope);
  throwIfAborted(signal);

  switch (command.method) {
    case 'tab.navigate':
      return navigateTab(lease, command.params, signal);
    case 'tab.back':
      return navigateHistory(lease, -1, signal);
    case 'tab.forward':
      return navigateHistory(lease, 1, signal);
    case 'tab.reload':
      return reloadTab(lease, signal);
    case 'tab.screenshot':
      return captureScreenshot(lease, command.params, signal);
    case 'page.content':
      return capturePageContent(lease, signal);
    case 'dom.snapshot':
      return captureDomSnapshot(lease, command.params, signal);
    case 'ax.snapshot':
      return captureAccessibilitySnapshot(lease, command.params, signal);
    case 'input.click':
      return clickTarget(lease, command.params, signal);
    case 'input.click_text':
      return clickTextTarget(lease, command.params, signal);
    case 'input.type':
      return typeIntoTarget(lease, command.params, signal);
    case 'input.key':
      return pressKey(lease, command.params, signal);
    case 'input.scroll':
      return scrollPage(lease, command.params, signal);
    case 'input.hover':
      return hoverTarget(lease, command.params, signal);
    case 'input.drag':
      return dragTarget(lease, command.params, signal);
    case 'dialog.get':
      return getDialogState(lease);
    case 'dialog.handle':
      return handleDialog(lease, command.params, signal);
    case 'dom.set_file_input_files':
      return uploadFileToTarget(lease, command.params, signal);
    case 'lease.get':
      return getLeaseState(lease);
    case 'operation.wait':
      return waitForOperation(command.params, signal);
    case 'page.logs':
      return getLogMetadata(lease, command.params);
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
    || lease.conversationId !== owner.conversationId
    || lease.runId !== owner.runId
    || lease.agentId !== owner.agentId
  ) {
    throw new RelayError(ERROR_CODES.LEASE_OWNER_MISMATCH, 'Lease owner does not match command owner');
  }
}

function preflightCommandLease(command) {
  const lease = requireLease(command.leaseId);
  assertLeaseOwner(lease, command);
  const allowedActions = METHOD_ACTIONS.get(command.method);
  if (!allowedActions?.includes(command.actionScope)) {
    throw new RelayError(
      ERROR_CODES.ACTION_NOT_ALLOWED,
      `Relay method ${command.method} does not match action scope ${command.actionScope}`,
    );
  }
  return lease;
}

function markOperationDeliveryStarted(signal) {
  for (const active of activeOperations.values()) {
    if (active.controller.signal !== signal) continue;
    active.deliveryStarted = true;
    return;
  }
}

function markOperationDialogGeneration(signal, generation) {
  for (const active of activeOperations.values()) {
    if (active.controller.signal !== signal) continue;
    active.dialogGeneration = generation;
    return;
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
  return actions.includes(action);
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
  if (tab.windowId !== lease.agentWindowId) {
    lease.state = 'recovery_required';
    await persistProtocolState();
    throw new RelayError(
      ERROR_CODES.TAB_UNAVAILABLE,
      'Leased tab left its Surface Session Agent Window',
    );
  }
  if (validateScope && !isUrlWithinLeaseScope(tab.url, lease)) {
    markLeaseDocumentOutOfScope(lease);
    throw new RelayError(
      ERROR_CODES.ORIGIN_MISMATCH,
      `Current tab is outside the approved origin ${lease.origin}`,
    );
  }
  return tab;
}

function validateUrlScope(url, scope) {
  if (!isUrlWithinLeaseScope(url, scope)) {
    throw new RelayError(
      ERROR_CODES.ORIGIN_MISMATCH,
      `Current tab is outside the approved origin ${scope.origin}`,
    );
  }
}

function isUrlWithinLeaseScope(url, lease) {
  const origin = normalizeOrigin(url);
  const hostname = normalizeHostname(url);
  return Boolean(origin && origin === lease.origin && hostname === lease.hostname);
}

function markLeaseDocumentOutOfScope(lease) {
  documentInScopeByLease.set(lease.leaseId, false);
  logsByLease.delete(lease.leaseId);
  dialogsByLease.delete(lease.leaseId);
  advanceDocumentRevision(lease);
  abortLeaseOperationsForOriginMismatch(lease);
}

function abortLeaseOperationsForOriginMismatch(lease) {
  for (const active of activeOperations.values()) {
    if (active.leaseId !== lease.leaseId) continue;
    const delivery = isMutationAction(active.actionScope) && active.deliveryStarted
      ? 'unknown'
      : 'not_attempted';
    active.controller.abort(new RelayError(
      ERROR_CODES.ORIGIN_MISMATCH,
      `Current tab navigated outside the approved origin ${lease.origin}`,
      false,
      delivery,
    ));
  }
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return '';
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

function domainScopesAllowUrl(scopes, value) {
  const origin = normalizeOrigin(value);
  const hostname = normalizeHostname(value);
  if (!origin || !hostname) return false;
  return scopes.some((scope) => {
    const parsed = parseDomainScope(scope);
    if (!parsed) return false;
    if (parsed.kind === 'selected') return true;
    return parsed.kind === 'origin' ? parsed.value === origin : parsed.value === hostname;
  });
}

function parseDomainScope(scope) {
  if (!isNonEmptyString(scope) || scope.includes('*')) return null;
  const normalized = scope.trim().toLowerCase();
  if (normalized === 'selected-tab-origin') return { kind: 'selected', value: '' };
  const raw = normalized.startsWith('origin:') ? normalized.slice('origin:'.length) : normalized;
  if (raw.includes('://')) {
    try {
      const url = new URL(raw);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:')
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
      return { kind: 'origin', value: url.origin };
    } catch {
      return null;
    }
  }
  const hostValue = raw.startsWith('host:') ? raw.slice('host:'.length) : raw;
  try {
    const url = new URL(`https://${hostValue}`);
    if (!url.hostname || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    return { kind: 'host', value: url.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

async function captureScreenshot(lease, params, signal) {
  throwIfAborted(signal);
  const format = params.format === 'png' ? 'png' : 'jpeg';
  const quality = format === 'jpeg'
    ? Math.max(1, Math.min(100, Number(params.quality) || 80))
    : undefined;
  let viewport = {
    captureBeyondViewport: false,
  };
  if (params.fullPage === true) {
    const metrics = await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Page.getLayoutMetrics',
      {},
    );
    const contentSize = metrics?.cssContentSize || metrics?.contentSize;
    const width = Math.ceil(Number(contentSize?.width));
    const height = Math.ceil(Number(contentSize?.height));
    if (!Number.isFinite(width) || !Number.isFinite(height)
      || width <= 0 || height <= 0
      || width > 16_384 || height > 16_384
      || width * height > 100_000_000) {
      throw new RelayError(
        ERROR_CODES.TARGET_NOT_FOUND,
        'Full-page screenshot dimensions are unavailable or exceed the safe capture limit',
        true,
      );
    }
    viewport = {
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    };
  }
  throwIfAborted(signal);
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.captureScreenshot',
    {
      format,
      ...(quality ? { quality } : {}),
      ...viewport,
      fromSurface: true,
    },
  );
  throwIfAborted(signal);
  return {
    imageBase64: result?.data || '',
    imageFormat: format,
    imageMimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    fullPage: params.fullPage === true,
    tabRef: lease.tabRef,
  };
}

async function navigateTab(lease, params, signal) {
  if (!isNonEmptyString(params.url)) {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'tab.navigate requires url');
  }
  validateUrlScope(params.url, lease);
  throwIfAborted(signal);
  markOperationDeliveryStarted(signal);
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.navigate',
    { url: params.url },
  );
  throwIfAborted(signal);
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return {
    accepted: !result?.errorText,
    errorText: result?.errorText || null,
    tabRef: lease.tabRef,
    url: params.url,
  };
}

async function navigateHistory(lease, delta, signal) {
  throwIfAborted(signal);
  const history = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.getNavigationHistory',
    {},
  );
  throwIfAborted(signal);
  const targetIndex = Number(history?.currentIndex) + delta;
  const entry = Array.isArray(history?.entries) ? history.entries[targetIndex] : null;
  if (!entry || !Number.isInteger(entry.id)) {
    throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, delta < 0 ? 'No previous history entry' : 'No next history entry');
  }
  markOperationDeliveryStarted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.navigateToHistoryEntry',
    { entryId: entry.id },
  );
  throwIfAborted(signal);
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return { navigated: true, tabRef: lease.tabRef };
}

async function reloadTab(lease, signal) {
  throwIfAborted(signal);
  markOperationDeliveryStarted(signal);
  await chrome.debugger.sendCommand({ tabId: lease.nativeTabId }, 'Page.reload', { ignoreCache: false });
  throwIfAborted(signal);
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return { reloaded: true, tabRef: lease.tabRef };
}

async function capturePageContent(lease, signal) {
  throwIfAborted(signal);
  const documentResult = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOM.getDocument',
    { depth: 1, pierce: true },
  );
  throwIfAborted(signal);
  const outer = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOM.getOuterHTML',
    { nodeId: documentResult.root.nodeId },
  );
  throwIfAborted(signal);
  const output = typeof outer?.outerHTML === 'string'
    ? outer.outerHTML.slice(0, 1_000_000)
    : '';
  return { output, tabRef: lease.tabRef, truncated: output.length >= 1_000_000 };
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
  const elements = await captureInteractiveElements(lease, signal);
  return {
    tabRef: lease.tabRef,
    snapshot: stripNativeTargetIdentifiers(result || {}),
    elements,
  };
}

async function captureAccessibilitySnapshot(lease, _params, signal) {
  throwIfAborted(signal);
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Accessibility.getFullAXTree',
    {},
  );
  throwIfAborted(signal);
  const elements = await interactiveElementsFromAxTree(lease, result?.nodes || [], signal);
  return { tabRef: lease.tabRef, tree: stripNativeTargetIdentifiers(result || {}), elements };
}

async function captureInteractiveElements(lease, signal) {
  const result = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Accessibility.getFullAXTree',
    {},
  );
  return interactiveElementsFromAxTree(lease, result?.nodes || [], signal);
}

async function interactiveElementsFromAxTree(lease, nodes, signal) {
  const interactiveRoles = new Set([
    'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option',
    'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
  ]);
  const candidates = nodes.filter((node) => (
    Number.isInteger(node.backendDOMNodeId)
    && interactiveRoles.has(String(node.role?.value || '').toLowerCase())
  )).slice(0, 200);
  if (candidates.length === 0) return [];
  const pushed = await pushBackendNodesToFrontend(
    lease,
    candidates.map((node) => node.backendDOMNodeId),
    signal,
  );
  const refs = nodeRefsByLease.get(lease.leaseId) || new Map();
  nodeRefsByLease.set(lease.leaseId, refs);
  const settled = await Promise.allSettled(candidates.map(async (node, index) => {
    const nodeId = pushed?.nodeIds?.[index];
    if (!Number.isInteger(nodeId)) return null;
    const box = await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'DOM.getBoxModel',
      { nodeId },
    );
    const bounds = boundsFromQuad(box?.model?.content || box?.model?.border);
    if (!bounds) return null;
    const ref = opaqueId('node');
    refs.set(ref, { nodeId, backendNodeId: node.backendDOMNodeId });
    return {
      ref,
      backendNodeId: node.backendDOMNodeId,
      frameRef: frameRefForLease(lease.leaseId, node.frameId || 'main'),
      role: String(node.role?.value || ''),
      name: String(node.name?.value || '').slice(0, 500),
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    };
  }));
  throwIfAborted(signal);
  return settled.flatMap((entry) => entry.status === 'fulfilled' && entry.value ? [entry.value] : []);
}

async function pushBackendNodesToFrontend(lease, backendNodeIds, signal) {
  throwIfAborted(signal);
  const documentResult = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOM.getDocument',
    { depth: 1, pierce: true },
  );
  if (!Number.isInteger(documentResult?.root?.nodeId)) {
    throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, 'The leased tab document is unavailable');
  }
  throwIfAborted(signal);
  const pushed = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOM.pushNodesByBackendIdsToFrontend',
    { backendNodeIds },
  );
  throwIfAborted(signal);
  return pushed;
}

async function resolveNodeTarget(lease, params, signal) {
  throwIfAborted(signal);
  const refs = nodeRefsByLease.get(lease.leaseId) || new Map();
  nodeRefsByLease.set(lease.leaseId, refs);

  let nodeId;
  let existingRef = null;
  const requestedRef = isNonEmptyString(params.targetRef?.ref)
    ? params.targetRef.ref
    : params.nodeRef;
  if (isNonEmptyString(requestedRef)) {
    const existing = refs.get(requestedRef);
    if (!existing) {
      throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, 'Opaque node reference is unknown or stale');
    }
    nodeId = existing.nodeId;
    existingRef = requestedRef;
  } else if (isNonEmptyString(params.selector)) {
    const documentResult = await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'DOM.getDocument',
      { depth: 1, pierce: true },
    );
    throwIfAborted(signal);
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
  throwIfAborted(signal);
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
  return dispatchClick(lease, target, params, signal);
}

async function clickTextTarget(lease, params, signal) {
  if (!isNonEmptyString(params.text)) {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'input.click_text requires text');
  }
  const expected = params.text.trim().toLocaleLowerCase();
  const ax = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Accessibility.getFullAXTree',
    {},
  );
  throwIfAborted(signal);
  const candidates = (Array.isArray(ax?.nodes) ? ax.nodes : []).filter((node) => (
    Number.isInteger(node.backendDOMNodeId)
      && isNonEmptyString(node.name?.value)
  ));
  const selected = candidates.find((node) => String(node.name.value).trim().toLocaleLowerCase() === expected)
    || candidates.find((node) => String(node.name.value).toLocaleLowerCase().includes(expected));
  if (!selected) {
    throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, 'No accessible element matched the requested text');
  }
  const pushed = await pushBackendNodesToFrontend(
    lease,
    [selected.backendDOMNodeId],
    signal,
  );
  const nodeId = pushed?.nodeIds?.[0];
  if (!Number.isInteger(nodeId)) {
    throw new RelayError(ERROR_CODES.TARGET_NOT_FOUND, 'The matching accessible element is no longer attached');
  }
  const ref = opaqueId('node');
  const refs = nodeRefsByLease.get(lease.leaseId) || new Map();
  refs.set(ref, { nodeId, backendNodeId: selected.backendDOMNodeId });
  nodeRefsByLease.set(lease.leaseId, refs);
  const target = await resolveNodeTarget(lease, { nodeRef: ref }, signal);
  return dispatchClick(lease, target, params, signal);
}

async function dispatchClick(lease, target, params, signal) {
  const button = ['left', 'middle', 'right'].includes(params.button) ? params.button : 'left';
  const clickCount = Math.max(1, Math.min(3, Number(params.clickCount) || 1));
  const dialogWaiter = createDialogOpeningWaiter(lease.leaseId);
  const abortWaiter = createAbortWaiter(signal);
  try {
    for (const type of ['mousePressed', 'mouseReleased']) {
      throwIfAborted(signal);
      markOperationDeliveryStarted(signal);
      const mouseCommand = chrome.debugger.sendCommand(
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
      const result = await Promise.race([
        mouseCommand.then(() => ({ kind: 'command' })),
        dialogWaiter.promise.then((dialog) => ({ kind: 'dialog', dialog })),
        abortWaiter.promise.then((reason) => ({ kind: 'aborted', reason })),
      ]);
      if (result.kind === 'dialog') {
        void mouseCommand.catch(() => {});
        return {
          clicked: true,
          pending: true,
          type: result.dialog?.type,
          messageLength: result.dialog?.messageLength,
          openedAtMs: result.dialog?.openedAtMs,
          defaultPolicy: 'pause',
          nodeRef: target.nodeRef,
          backendNodeId: target.backendNodeId,
          frameRef: target.frameRef,
          tabRef: lease.tabRef,
        };
      }
      if (result.kind === 'aborted') {
        void mouseCommand.catch(() => {});
        throw result.reason instanceof Error
          ? result.reason
          : new RelayError(ERROR_CODES.OPERATION_CANCELLED, 'Click was cancelled', true, 'unknown');
      }
    }
  } finally {
    dialogWaiter.cancel();
    abortWaiter.cancel();
  }
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return {
    clicked: true,
    nodeRef: target.nodeRef,
    backendNodeId: target.backendNodeId,
    frameRef: target.frameRef,
    tabRef: lease.tabRef,
  };
}

function createDialogOpeningWaiter(leaseId) {
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    const waiters = dialogOpenWaitersByLease.get(leaseId) || new Set();
    const notify = (dialog) => {
      waiters.delete(notify);
      if (waiters.size === 0) dialogOpenWaitersByLease.delete(leaseId);
      resolve(dialog);
    };
    waiters.add(notify);
    dialogOpenWaitersByLease.set(leaseId, waiters);
    cancel = () => {
      waiters.delete(notify);
      if (waiters.size === 0) dialogOpenWaitersByLease.delete(leaseId);
    };
  });
  return { promise, cancel };
}

function createAbortWaiter(signal) {
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    if (signal.aborted) {
      resolve(signal.reason);
      return;
    }
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cancel = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, cancel };
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
  markOperationDeliveryStarted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOM.focus',
    { nodeId: target.nodeId },
  );
  throwIfAborted(signal);

  if (params.replace !== false) {
    const platform = await chrome.runtime.getPlatformInfo();
    throwIfAborted(signal);
    const modifiers = platform.os === 'mac' ? 4 : 2;
    await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers },
    );
    throwIfAborted(signal);
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
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return {
    nodeRef: target.nodeRef,
    backendNodeId: target.backendNodeId,
    frameRef: target.frameRef,
    tabRef: lease.tabRef,
    typed: true,
  };
}

async function pressKey(lease, params, signal) {
  const stroke = keyStroke(params.key);
  throwIfAborted(signal);
  markOperationDeliveryStarted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Input.dispatchKeyEvent',
    {
      type: 'rawKeyDown',
      key: stroke.key,
      code: stroke.code,
      modifiers: stroke.modifiers,
      windowsVirtualKeyCode: stroke.virtualKeyCode,
      ...(stroke.text ? { text: stroke.text } : {}),
    },
  );
  throwIfAborted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: stroke.key,
      code: stroke.code,
      modifiers: stroke.modifiers,
      windowsVirtualKeyCode: stroke.virtualKeyCode,
    },
  );
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return { pressed: true, key: stroke.key, tabRef: lease.tabRef };
}

function keyStroke(value) {
  if (!isNonEmptyString(value) || value.length > 64) {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'input.key requires a supported key');
  }
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  const requestedKey = parts.pop();
  const modifierMap = new Map([
    ['alt', 1], ['option', 1], ['control', 2], ['ctrl', 2],
    ['command', 4], ['cmd', 4], ['meta', 4], ['shift', 8],
  ]);
  let modifiers = 0;
  for (const modifier of parts) {
    const flag = modifierMap.get(modifier.toLowerCase());
    if (!flag) throw new RelayError(ERROR_CODES.INVALID_COMMAND, `Unsupported key modifier: ${modifier}`);
    modifiers |= flag;
  }
  const named = {
    enter: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27],
    esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46],
    arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
    home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33],
    pagedown: ['PageDown', 'PageDown', 34], space: [' ', 'Space', 32],
  };
  const normalized = String(requestedKey || '').toLowerCase();
  if (named[normalized]) {
    const [key, code, virtualKeyCode] = named[normalized];
    return { key, code, virtualKeyCode, modifiers, text: '' };
  }
  if (requestedKey?.length !== 1) {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, `Unsupported key: ${String(requestedKey || '')}`);
  }
  const upper = requestedKey.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : '';
  return {
    key: requestedKey,
    code,
    virtualKeyCode: upper.charCodeAt(0),
    modifiers,
    text: modifiers === 0 ? requestedKey : '',
  };
}

async function scrollPage(lease, params, signal) {
  const direction = params.direction === 'up' ? -1 : 1;
  const amount = Math.max(1, Math.min(10_000, Math.abs(Number(params.amount) || 300)));
  throwIfAborted(signal);
  const metrics = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.getLayoutMetrics',
    {},
  ).catch(() => null);
  throwIfAborted(signal);
  const viewport = metrics?.cssVisualViewport || metrics?.visualViewport || {};
  markOperationDeliveryStarted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Input.dispatchMouseEvent',
    {
      type: 'mouseWheel',
      x: Math.max(0, Number(viewport.clientWidth) || 800) / 2,
      y: Math.max(0, Number(viewport.clientHeight) || 600) / 2,
      deltaX: 0,
      deltaY: direction * amount,
    },
  );
  throwIfAborted(signal);
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return { scrolled: true, direction: direction < 0 ? 'up' : 'down', amount, tabRef: lease.tabRef };
}

function requireOpaqueTargetRef(params, field = 'targetRef') {
  const targetRef = params?.[field];
  if (!targetRef || !isNonEmptyString(targetRef.ref)) {
    throw new RelayError(
      ERROR_CODES.TARGET_NOT_FOUND,
      `${field} must be a fresh opaque reference returned by dom.snapshot`,
      true,
    );
  }
  return targetRef;
}

async function hoverTarget(lease, params, signal) {
  const targetRef = requireOpaqueTargetRef(params);
  const target = await resolveNodeTarget(lease, { targetRef }, signal);
  throwIfAborted(signal);
  markOperationDeliveryStarted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Input.dispatchMouseEvent',
    {
      type: 'mouseMoved',
      x: target.bounds.centerX,
      y: target.bounds.centerY,
      button: 'none',
    },
  );
  throwIfAborted(signal);
  return {
    hovered: true,
    nodeRef: target.nodeRef,
    backendNodeId: target.backendNodeId,
    frameRef: target.frameRef,
    tabRef: lease.tabRef,
  };
}

async function dragTarget(lease, params, signal) {
  const sourceRef = requireOpaqueTargetRef(params);
  const destinationRef = requireOpaqueTargetRef(params, 'destinationTargetRef');
  const source = await resolveNodeTarget(lease, { targetRef: sourceRef }, signal);
  const destination = await resolveNodeTarget(lease, { targetRef: destinationRef }, signal);
  let pressed = false;
  try {
    throwIfAborted(signal);
    markOperationDeliveryStarted(signal);
    await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: source.bounds.centerX,
        y: source.bounds.centerY,
        button: 'none',
      },
    );
    throwIfAborted(signal);
    await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: source.bounds.centerX,
        y: source.bounds.centerY,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      },
    );
    pressed = true;
    for (let step = 1; step <= 10; step += 1) {
      throwIfAborted(signal);
      const progress = step / 10;
      await chrome.debugger.sendCommand(
        { tabId: lease.nativeTabId },
        'Input.dispatchMouseEvent',
        {
          type: 'mouseMoved',
          x: source.bounds.centerX + ((destination.bounds.centerX - source.bounds.centerX) * progress),
          y: source.bounds.centerY + ((destination.bounds.centerY - source.bounds.centerY) * progress),
          button: 'left',
          buttons: 1,
        },
      );
    }
  } finally {
    if (pressed
      && lease.state !== 'returning'
      && lease.state !== 'returned'
      && signal.reason?.code !== ERROR_CODES.ORIGIN_MISMATCH) {
      await chrome.debugger.sendCommand(
        { tabId: lease.nativeTabId },
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          x: destination.bounds.centerX,
          y: destination.bounds.centerY,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        },
      ).catch(() => {});
    }
  }
  throwIfAborted(signal);
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return {
    dragged: true,
    sourceNodeRef: source.nodeRef,
    destinationNodeRef: destination.nodeRef,
    tabRef: lease.tabRef,
  };
}

function getDialogState(lease) {
  const dialog = dialogsByLease.get(lease.leaseId);
  if (!dialog) {
    return {
      pending: false,
      defaultPolicy: 'pause',
      output: 'No browser dialog is currently pending. Dialogs pause by default.',
    };
  }
  return {
    pending: true,
    type: dialog.type,
    messageLength: dialog.messageLength,
    openedAtMs: dialog.openedAtMs,
    defaultPolicy: 'pause',
    output: `A ${dialog.type || 'browser'} dialog is paused for explicit handling.`,
  };
}

async function handleDialog(lease, params, signal) {
  const dialog = dialogsByLease.get(lease.leaseId);
  if (!dialog) {
    throw new RelayError(ERROR_CODES.DIALOG_BLOCKED, 'No paused browser dialog is available');
  }
  const action = params.dialogAction;
  if (action !== 'accept' && action !== 'dismiss') {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'dialogAction must be accept or dismiss');
  }
  if (params.dialogPromptText !== undefined
    && (action !== 'accept' || dialog.type !== 'prompt' || typeof params.dialogPromptText !== 'string')) {
    throw new RelayError(
      ERROR_CODES.ACTION_NOT_ALLOWED,
      'dialogPromptText is only allowed when accepting a prompt dialog',
    );
  }
  if (typeof params.dialogPromptText === 'string' && params.dialogPromptText.length > 100_000) {
    throw new RelayError(ERROR_CODES.INVALID_COMMAND, 'dialogPromptText exceeds the relay limit');
  }
  throwIfAborted(signal);
  markOperationDialogGeneration(signal, dialog.generation);
  markOperationDeliveryStarted(signal);
  await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'Page.handleJavaScriptDialog',
    {
      accept: action === 'accept',
      ...(typeof params.dialogPromptText === 'string'
        ? { promptText: params.dialogPromptText }
        : {}),
    },
  );
  // Once CDP has accepted the command the dialog is no longer pending, even if
  // cancellation races with the response. Clear the local state before
  // surfacing an unknown-delivery cancellation so a retry cannot double-handle
  // a dialog that Chrome already closed.
  if (dialogsByLease.get(lease.leaseId)?.generation === dialog.generation) {
    dialogsByLease.delete(lease.leaseId);
  }
  throwIfAborted(signal);
  advanceDocumentRevision(lease);
  await persistProtocolState();
  return {
    handled: true,
    action,
    type: dialog.type,
    defaultPolicy: 'pause',
    tabRef: lease.tabRef,
  };
}

async function uploadFileToTarget(lease, params, signal) {
  const targetRef = requireOpaqueTargetRef(params);
  if (!isNonEmptyString(params.uploadApprovalRef) || !isNonEmptyString(params.uploadFilePath)) {
    throw new RelayError(
      ERROR_CODES.FILE_UPLOAD_BLOCKED,
      'Relay upload requires one exact Host-approved file',
    );
  }
  const refs = nodeRefsByLease.get(lease.leaseId) || new Map();
  const target = refs.get(targetRef.ref);
  if (!target || !Number.isInteger(target.nodeId) || !Number.isInteger(target.backendNodeId)) {
    throw new RelayError(
      ERROR_CODES.TARGET_NOT_FOUND,
      'The approved file input reference is unknown or stale',
      true,
    );
  }
  throwIfAborted(signal);
  const description = await chrome.debugger.sendCommand(
    { tabId: lease.nativeTabId },
    'DOM.describeNode',
    { nodeId: target.nodeId, depth: 0 },
  );
  const node = description?.node;
  const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
  const attributeMap = new Map();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    attributeMap.set(String(attributes[index]).toLowerCase(), String(attributes[index + 1]).toLowerCase());
  }
  if (String(node?.nodeName || '').toLowerCase() !== 'input'
    || attributeMap.get('type') !== 'file'
    || node?.backendNodeId !== target.backendNodeId) {
    throw new RelayError(
      ERROR_CODES.FILE_UPLOAD_BLOCKED,
      'The approved target is not the same current file input',
    );
  }

  throwIfAborted(signal);
  try {
    markOperationDeliveryStarted(signal);
    await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'DOM.setFileInputFiles',
      {
        files: [params.uploadFilePath],
        backendNodeId: target.backendNodeId,
      },
    );
  } catch {
    throwIfAborted(signal);
    throw new RelayError(
      ERROR_CODES.INTERNAL,
      'Chrome could not assign the approved file to the current input',
      false,
      'unknown',
    );
  }
  throwIfAborted(signal);
  let fileCount;
  let fileSize;
  let remoteObjectId;
  try {
    const resolved = await chrome.debugger.sendCommand(
      { tabId: lease.nativeTabId },
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
    );
    throwIfAborted(signal);
    remoteObjectId = resolved?.object?.objectId;
    if (isNonEmptyString(remoteObjectId)) {
      const verification = await chrome.debugger.sendCommand(
        { tabId: lease.nativeTabId },
        'Runtime.callFunctionOn',
        {
          objectId: remoteObjectId,
          functionDeclaration: 'function () { const files = this.files; return { fileCount: files ? files.length : 0, fileSize: files && files.length === 1 ? files[0].size : -1 }; }',
          returnByValue: true,
          silent: true,
        },
      );
      const value = verification?.result?.value;
      if (Number.isSafeInteger(value?.fileCount)) fileCount = value.fileCount;
      if (Number.isSafeInteger(value?.fileSize)) fileSize = value.fileSize;
    }
  } catch {
    throwIfAborted(signal);
    // Host treats missing verification fields as a failed postcondition. The
    // file-input command has already been delivered, so never claim otherwise.
  } finally {
    if (isNonEmptyString(remoteObjectId) && !signal.aborted) {
      try {
        await chrome.debugger.sendCommand(
          { tabId: lease.nativeTabId },
          'Runtime.releaseObject',
          { objectId: remoteObjectId },
        );
      } catch {
        // Best-effort release of a transient CDP handle; no file data is retained.
      }
    }
  }
  advanceDocumentRevision(lease);
  await persistProtocolState();
  throwIfAborted(signal);
  return {
    fileAssigned: true,
    ...(Number.isSafeInteger(fileCount) ? { fileCount } : {}),
    ...(Number.isSafeInteger(fileSize) ? { fileSize } : {}),
    tabRef: lease.tabRef,
  };
}

function getLeaseState(lease) {
  return {
    lease: publicLeaseReference(lease),
    output: `Relay tab lease is ${lease.state}.`,
  };
}

async function waitForOperation(params, signal) {
  const timeoutMs = Math.max(0, Math.min(30_000, Number(params.timeoutMs) || 1_000));
  await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  throwIfAborted(signal);
  return { waited: true, timeoutMs };
}

function getLogMetadata(lease, params = {}) {
  const afterCursor = Number.isFinite(params.afterCursor) ? Number(params.afterCursor) : 0;
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 100));
  const entries = (logsByLease.get(lease.leaseId) || [])
    .filter((entry) => entry.cursor > afterCursor)
    .slice(-limit);
  return {
    entries,
    nextCursor: entries.at(-1)?.cursor || afterCursor,
    output: `${entries.length} redacted browser log entries available.`,
    tabRef: lease.tabRef,
  };
}

function advanceDocumentRevision(lease) {
  lease.documentRevision = opaqueId('document');
  nodeRefsByLease.delete(lease.leaseId);
  frameRefsByLease.delete(lease.leaseId);
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
  if (Date.now() >= request.consentDeadlineAt) {
    pendingLeaseRequest = null;
    await persistProtocolState();
    throw new RelayError(ERROR_CODES.LEASE_EXPIRED, 'Pending lease request has expired');
  }

  assertLeaseRequestActive(request);

  const tab = await getCurrentActiveTab();
  assertLeaseRequestActive(request);
  if (!domainScopesAllowUrl(request.domainScopes, tab.url)) {
    throw new RelayError(ERROR_CODES.ORIGIN_MISMATCH, 'Current tab is outside the requested Relay domain scope');
  }
  const approvedOrigin = normalizeOrigin(tab.url);
  const approvedHostname = normalizeHostname(tab.url);
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
  let agentWindowId;
  let debuggerApproved = false;

  try {
    original.placeholderTabId = await createReturnPlaceholderIfNeeded(tab);
    assertLeaseRequestActive(request);
    if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: false });
    agentWindowId = await moveToAgentWindow(tab, request.surfaceSessionId);
    assertLeaseRequestActive(request);

    // The only debugger.attach path is this user-triggered popup approval flow.
    await chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_PROTOCOL_VERSION);
    debuggerApproved = true;
    await Promise.allSettled([
      chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {}),
      chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.enable', {}),
      chrome.debugger.sendCommand({ tabId: tab.id }, 'Accessibility.enable', {}),
      chrome.debugger.sendCommand({ tabId: tab.id }, 'Log.enable', {}),
      chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
        maxPostDataSize: 0,
      }),
      chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable', {}),
    ]);

    assertLeaseRequestActive(request);
    if (Date.now() >= request.expiresAt) {
      throw new RelayError(ERROR_CODES.LEASE_EXPIRED, 'Lease request expired during approval');
    }

    const lease = {
      leaseId: opaqueId('lease'),
      tabRef: opaqueId('tab'),
      agentWindowRef: opaqueId('agent_window'),
      originalWindowRef: opaqueId('original_window'),
      surfaceSessionId: request.surfaceSessionId,
      conversationId: request.conversationId,
      runId: request.runId,
      agentId: request.agentId,
      origin: approvedOrigin,
      hostname: approvedHostname,
      actions: request.actionScopes,
      expiresAtMs: request.expiresAt,
      documentRevision: opaqueId('document'),
      approvedAtMs: Date.now(),
      state: 'leased',
      nativeTabId: tab.id,
      agentWindowId,
      original,
      debuggerApproved,
    };
    leases.set(lease.leaseId, lease);
    documentInScopeByLease.set(lease.leaseId, true);
    pendingLeaseRequest = null;
    await persistProtocolState();
    send({
      type: 'lease.approved',
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      surfaceSessionId: request.surfaceSessionId,
      conversationId: request.conversationId,
      runId: request.runId,
      agentId: request.agentId,
      leaseId: lease.leaseId,
      approvalRef: opaqueId('approval'),
      approvedAt: lease.approvedAtMs,
      expiresAt: lease.expiresAtMs,
      domainScopes: [`origin:${approvedOrigin}`],
      actionScopes: [...lease.actions],
      placement: {
        browserInstanceRef: extensionInstanceId,
        tabRef: lease.tabRef,
        agentWindowRef: lease.agentWindowRef,
        originalWindowRef: lease.originalWindowRef,
        originalIndex: original.index,
        originalPinned: original.pinned,
        originalActive: original.active,
        origin: approvedOrigin,
        documentRevision: lease.documentRevision,
      },
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

function assertLeaseRequestActive(request) {
  if (cancelledLeaseRequests.has(request.requestId)
    || pendingLeaseRequest?.requestId !== request.requestId) {
    throw new RelayError(ERROR_CODES.OPERATION_CANCELLED, 'Lease approval was cancelled by Host', true);
  }
  if (Date.now() >= request.consentDeadlineAt) {
    throw new RelayError(ERROR_CODES.LEASE_EXPIRED, 'Lease consent deadline expired during approval');
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
    surfaceSessionId: request.surfaceSessionId,
    conversationId: request.conversationId,
    runId: request.runId,
    agentId: request.agentId,
    deniedAt: Date.now(),
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

async function returnLease(lease, reason, options = {}) {
  if (lease.state === 'returned') return { returned: true, alreadyReturned: true };
  const existing = leaseReturnPromises.get(lease.leaseId);
  if (existing) return existing;
  const returning = performLeaseReturn(lease, reason, options);
  leaseReturnPromises.set(lease.leaseId, returning);
  try {
    return await returning;
  } finally {
    if (leaseReturnPromises.get(lease.leaseId) === returning) {
      leaseReturnPromises.delete(lease.leaseId);
    }
  }
}

async function performLeaseReturn(lease, reason, options) {
  if (lease.state === 'returned') return { returned: true, alreadyReturned: true };
  const excludeOperationId = isNonEmptyString(options.excludeOperationId)
    ? options.excludeOperationId
    : null;
  const deadlineAt = Number.isFinite(options.deadlineAt)
    ? Number(options.deadlineAt)
    : Date.now() + 2_000;
  lease.state = 'returning';
  abortLeaseOperationsForReturn(lease.leaseId, excludeOperationId);
  await persistProtocolState();

  await waitForLeaseOperationsToStop(
    lease.leaseId,
    excludeOperationId,
    Math.min(deadlineAt, Date.now() + 25),
  );

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

    // Detaching debugger authority makes any non-cooperative in-flight CDP call
    // incapable of delivering further input. Give aborted handlers one bounded
    // turn to unwind before the tab is moved back to the user.
    await waitForLeaseOperationsToStop(
      lease.leaseId,
      excludeOperationId,
      Math.min(deadlineAt, Date.now() + 250),
    );

    await restoreOriginalPlacement(lease.nativeTabId, lease.original);
    lease.state = 'returned';
    lease.returnedAtMs = Date.now();
    lease.returnReason = reason;
    nodeRefsByLease.delete(lease.leaseId);
    frameRefsByLease.delete(lease.leaseId);
    logsByLease.delete(lease.leaseId);
    dialogsByLease.delete(lease.leaseId);
    dialogOpenWaitersByLease.delete(lease.leaseId);
    documentInScopeByLease.delete(lease.leaseId);
    await persistProtocolState();
    send({
      type: 'lease.returned',
      protocolVersion: PROTOCOL_VERSION,
      leaseId: lease.leaseId,
      surfaceSessionId: lease.surfaceSessionId,
      conversationId: lease.conversationId,
      runId: lease.runId,
      agentId: lease.agentId,
    });
    return { returned: true, leaseId: lease.leaseId };
  } catch (error) {
    lease.state = 'recovery_required';
    await persistProtocolState();
    const relayFailure = new RelayError(
      ERROR_CODES.TAB_RETURN_FAILED,
      `Failed to restore the leased tab to its original placement: ${error?.message || String(error)}`,
      false,
      'unknown',
    );
    sendLeaseRecoveryRequired(lease, relayFailure);
    throw relayFailure;
  }
}

function abortLeaseOperationsForReturn(leaseId, excludeOperationId) {
  for (const [operationId, active] of activeOperations) {
    if (active.leaseId !== leaseId || operationId === excludeOperationId) continue;
    const delivery = isMutationAction(active.actionScope) && active.deliveryStarted
      ? 'unknown'
      : 'not_attempted';
    active.controller.abort(new RelayError(
      ERROR_CODES.OPERATION_CANCELLED,
      'Operation cancelled so the leased tab can be returned',
      true,
      delivery,
    ));
  }
}

async function waitForLeaseOperationsToStop(leaseId, excludeOperationId, deadlineAt) {
  const hasConflictingOperation = () => Array.from(activeOperations.entries()).some(
    ([operationId, active]) => active.leaseId === leaseId && operationId !== excludeOperationId,
  );
  while (hasConflictingOperation() && Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return !hasConflictingOperation();
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

async function expireProtocolState() {
  const now = Date.now();
  let changed = false;
  if (pendingLeaseRequest && now >= pendingLeaseRequest.consentDeadlineAt) {
    const expiredRequest = pendingLeaseRequest;
    pendingLeaseRequest = null;
    changed = true;
    send({
      type: 'lease.denied',
      protocolVersion: PROTOCOL_VERSION,
      requestId: expiredRequest.requestId,
      surfaceSessionId: expiredRequest.surfaceSessionId,
      conversationId: expiredRequest.conversationId,
      runId: expiredRequest.runId,
      agentId: expiredRequest.agentId,
      deniedAt: now,
    });
  }
  for (const [requestId, expiresAt] of cancelledLeaseRequests) {
    if (expiresAt <= now) cancelledLeaseRequests.delete(requestId);
  }
  if (changed) await persistProtocolState();
  const expiredLeases = Array.from(leases.values()).filter((lease) => (
    ['leased', 'orphaned', 'expired'].includes(lease.state) && now >= lease.expiresAtMs
  ));
  await Promise.allSettled(expiredLeases.map((lease) => returnLease(lease, 'expired')));
}

function sendLeaseRecoveryRequired(lease, error) {
  send({
    type: 'lease.recovery_required',
    protocolVersion: PROTOCOL_VERSION,
    leaseId: lease.leaseId,
    surfaceSessionId: lease.surfaceSessionId,
    conversationId: lease.conversationId,
    runId: lease.runId,
    agentId: lease.agentId,
    error: errorPayload(error),
  });
}

function handleDebuggerEvent(source, method, params) {
  if (!Number.isInteger(source.tabId)) return;
  const lease = Array.from(leases.values()).find((candidate) => (
    candidate.nativeTabId === source.tabId && candidate.state === 'leased'
  ));
  if (!lease) return;
  if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
    handleLeaseDocumentNavigation(lease, params?.frame?.url);
    persistProtocolState();
    return;
  }
  if (method === 'Page.navigatedWithinDocument') {
    handleLeaseDocumentNavigation(lease, params?.url);
    persistProtocolState();
    return;
  }
  if (documentInScopeByLease.get(lease.leaseId) !== true) return;
  if (method === 'Page.javascriptDialogOpening') {
    const type = ['alert', 'beforeunload', 'confirm', 'prompt'].includes(params?.type)
      ? params.type
      : 'alert';
    const dialog = {
      generation: nextDialogGeneration++,
      type,
      messageLength: typeof params?.message === 'string' ? params.message.length : 0,
      openedAtMs: Date.now(),
    };
    dialogsByLease.set(lease.leaseId, dialog);
    const waiters = dialogOpenWaitersByLease.get(lease.leaseId);
    if (waiters) {
      for (const notify of [...waiters]) notify(dialog);
    }
    return;
  }
  if (method === 'Page.javascriptDialogClosed') {
    dialogsByLease.delete(lease.leaseId);
    return;
  }
  let entry = null;
  if (method === 'Log.entryAdded' && params?.entry) {
    if (params.entry.url && !isUrlWithinLeaseScope(params.entry.url, lease)) return;
    entry = {
      level: String(params.entry.level || 'info'),
      source: String(params.entry.source || 'browser'),
      text: redactLogText(params.entry.text),
      url: safeLogUrl(params.entry.url),
      timestamp: Number(params.entry.timestamp) || Date.now(),
    };
  } else if (method === 'Runtime.consoleAPICalled') {
    const text = (Array.isArray(params?.args) ? params.args : [])
      .map((argument) => {
        if (['string', 'number', 'boolean'].includes(typeof argument?.value)) return String(argument.value);
        return typeof argument?.description === 'string' ? argument.description : `[${String(argument?.type || 'value')}]`;
      })
      .join(' ');
    entry = {
      level: String(params?.type || 'log'),
      source: 'console',
      text: redactLogText(text),
      url: '',
      timestamp: Number(params?.timestamp) || Date.now(),
    };
  } else if (method === 'Network.requestWillBeSent' && params?.request) {
    if (!isUrlWithinLeaseScope(params.request.url, lease)) return;
    entry = {
      level: 'info',
      source: 'network',
      text: `request ${String(params.request.method || 'GET').slice(0, 16)}`,
      url: safeLogUrl(params.request.url),
      timestamp: Number(params?.timestamp) || Date.now(),
    };
  } else if (method === 'Network.responseReceived' && params?.response) {
    if (!isUrlWithinLeaseScope(params.response.url, lease)) return;
    const status = Number(params.response.status) || 0;
    entry = {
      level: status >= 400 ? 'error' : 'info',
      source: 'network',
      text: `response ${status || 'unknown'} ${String(params.response.mimeType || '').slice(0, 120)}`.trim(),
      url: safeLogUrl(params.response.url),
      timestamp: Number(params?.timestamp) || Date.now(),
    };
  } else if (method === 'Network.loadingFailed') {
    entry = {
      level: params?.canceled ? 'info' : 'error',
      source: 'network',
      text: redactLogText(`failed ${String(params?.errorText || 'unknown network error')}`),
      url: '',
      timestamp: Number(params?.timestamp) || Date.now(),
    };
  }
  if (!entry) return;
  const entries = logsByLease.get(lease.leaseId) || [];
  entries.push({ cursor: nextLogCursor++, ...entry });
  if (entries.length > 500) entries.splice(0, entries.length - 500);
  logsByLease.set(lease.leaseId, entries);
}

function handleLeaseDocumentNavigation(lease, url) {
  dialogsByLease.delete(lease.leaseId);
  if (!isUrlWithinLeaseScope(url, lease)) {
    markLeaseDocumentOutOfScope(lease);
    return;
  }
  documentInScopeByLease.set(lease.leaseId, true);
  advanceDocumentRevision(lease);
}

function redactLogText(value) {
  return String(value || '')
    .slice(0, 10_000)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|set-cookie|password|passwd|token|api[-_]?key|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
}

function safeLogUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}`.slice(0, 2_000);
  } catch {
    return '';
  }
}

chrome.debugger.onEvent.addListener(handleDebuggerEvent);

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!Number.isInteger(source.tabId) || intentionalDebuggerDetach.has(source.tabId)) return;
  const lease = Array.from(leases.values()).find((candidate) => (
    candidate.nativeTabId === source.tabId && candidate.state !== 'returned'
  ));
  if (!lease) return;
  lease.debuggerApproved = false;
  lease.state = 'recovery_required';
  persistProtocolState();
  sendLeaseRecoveryRequired(lease, new RelayError(
    ERROR_CODES.TAB_UNAVAILABLE,
    `Chrome debugger detached: ${reason}`,
    true,
  ));
});

chrome.tabs.onRemoved.addListener((nativeTabId) => {
  const lease = Array.from(leases.values()).find((candidate) => (
    candidate.nativeTabId === nativeTabId && candidate.state !== 'returned'
  ));
  if (!lease) return;
  lease.state = 'recovery_required';
  lease.debuggerApproved = false;
  persistProtocolState();
  sendLeaseRecoveryRequired(lease, new RelayError(
    ERROR_CODES.TAB_UNAVAILABLE,
    'The borrowed tab was closed before it could be returned',
  ));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let changed = false;
  if (changes.relayPort && changes.relayPort.newValue !== config.port) {
    config.port = changes.relayPort.newValue;
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
  let currentTab;
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
  const pending = pendingLeaseRequest && pendingLeaseRequest.consentDeadlineAt > Date.now()
    ? {
        requestId: pendingLeaseRequest.requestId,
        surfaceSessionId: pendingLeaseRequest.surfaceSessionId,
        conversationId: pendingLeaseRequest.conversationId,
        runId: pendingLeaseRequest.runId,
        agentId: pendingLeaseRequest.agentId,
        origin: pendingLeaseRequest.domainScopes.join(', '),
        hostname: pendingLeaseRequest.domainScopes.join(', '),
        actions: pendingLeaseRequest.actionScopes,
        expiresAtMs: pendingLeaseRequest.consentDeadlineAt,
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
