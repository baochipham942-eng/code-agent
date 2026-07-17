let ws = null;
let reconnectDelay = 1000;
let connectionState = 'disconnected';
let attachedTabs = new Set();
let config = { port: 23001, token: '' };
let pingTimer = null;

async function init() {
  await loadConfig();
  connect();
  setupAlarms();
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
    const response = await fetch(`http://127.0.0.1:${config.port}/api/browser-relay/config`);
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
    // Agent Neo may not be running yet.
  }
}

function updateBadge() {
  const badge = {
    connected: ['ON', '#22C55E'],
    connecting: ['...', '#F59E0B'],
    disconnected: ['OFF', '#71717A'],
  }[connectionState] || ['OFF', '#71717A'];
  chrome.action.setBadgeText({ text: badge[0] });
  chrome.action.setBadgeBackgroundColor({ color: badge[1] });
}

function connect(silent = false) {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  connectionState = 'connecting';
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
    connectionState = 'connected';
    reconnectDelay = 1000;
    updateBadge();
    sendStatus();
    startPingTimer();
  };

  ws.onmessage = (event) => handleMessage(event.data);

  ws.onclose = () => {
    ws = null;
    connectionState = 'disconnected';
    updateBadge();
    stopPingTimer();
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

function disconnect() {
  if (ws) {
    ws.close(1000, 'Manual disconnect');
    ws = null;
  }
  connectionState = 'disconnected';
  updateBadge();
  stopPingTimer();
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

function sendStatus() {
  send({
    type: 'status',
    attachedTabs: Array.from(attachedTabs),
  });
}

function startPingTimer() {
  stopPingTimer();
  pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
}

function stopPingTimer() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function setupAlarms() {
  chrome.alarms.create('code-agent-relay-keepalive', { periodInMinutes: 25 / 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'code-agent-relay-keepalive' && connectionState === 'disconnected') {
      connect(true);
    }
  });
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === 'ping') {
    send({ type: 'pong' });
    return;
  }
  if (!msg.id || !msg.method) return;

  try {
    const result = await executeCommand(msg.method, msg.params || {});
    send({ id: msg.id, result });
  } catch (error) {
    send({ id: msg.id, error: { message: error.message || String(error) } });
  }
}

async function executeCommand(method, params) {
  switch (method) {
    case 'tabs.list':
      return handleTabsList();
    case 'tabs.create':
      return handleTabsCreate(params);
    case 'tabs.navigate':
      return handleTabsNavigate(params);
    case 'tabs.screenshot':
      return handleTabsScreenshot(params);
    case 'debugger.attach':
      return handleDebuggerAttach(params);
    case 'debugger.detach':
      return handleDebuggerDetach(params);
    case 'cdp.send':
      return handleCdpSend(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function handleTabsList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
    index: tab.index,
    pinned: tab.pinned,
    audible: tab.audible,
    status: tab.status,
    attached: attachedTabs.has(tab.id),
  }));
}

async function handleTabsCreate(params) {
  const tab = await chrome.tabs.create({
    url: params.url || 'about:blank',
    active: params.active !== false,
  });
  return { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId };
}

async function handleTabsNavigate(params) {
  if (!params.tabId) throw new Error('tabId is required');
  if (!params.url) throw new Error('url is required');
  const tab = await chrome.tabs.update(params.tabId, { url: params.url });
  return { id: tab.id, url: tab.url, title: tab.title };
}

async function handleTabsScreenshot(params) {
  const tabId = params.tabId || (await getActiveTabId());
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: params.format || 'jpeg',
    quality: params.quality || 80,
    captureBeyondViewport: false,
  });
}

async function handleDebuggerAttach(params) {
  if (!params.tabId) throw new Error('tabId is required');
  await ensureAttached(params.tabId);
  return { attached: true };
}

async function handleDebuggerDetach(params) {
  if (!params.tabId) throw new Error('tabId is required');
  if (!attachedTabs.has(params.tabId)) return { alreadyDetached: true };
  await chrome.debugger.detach({ tabId: params.tabId });
  attachedTabs.delete(params.tabId);
  sendStatus();
  return { detached: true };
}

async function handleCdpSend(params) {
  if (!params.tabId) throw new Error('tabId is required');
  if (!params.method) throw new Error('method is required');
  await ensureAttached(params.tabId);
  return await chrome.debugger.sendCommand({ tabId: params.tabId }, params.method, params.params || {}) || {};
}

async function getActiveTabId() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.id) throw new Error('No active tab found');
  return activeTab.id;
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
  } catch {
    // Ignore pages that do not support Page.enable.
  }
  sendStatus();
}

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
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const active = tabs[0] || null;
      sendResponse({
        connectionState,
        attachedTabs: Array.from(attachedTabs),
        port: config.port,
        currentTab: active
          ? {
              id: active.id,
              title: active.title || '',
              url: active.url || '',
              attached: attachedTabs.has(active.id),
            }
          : null,
      });
    }).catch(() => {
      sendResponse({
        connectionState,
        attachedTabs: Array.from(attachedTabs),
        port: config.port,
        currentTab: null,
      });
    });
    return true;
  }
  if (message.type === 'attachCurrentTab') {
    getActiveTabId()
      .then((tabId) => ensureAttached(tabId).then(() => ({ ok: true, tabId })))
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message || String(error) }));
    return true;
  }
  if (message.type === 'detachCurrentTab') {
    getActiveTabId()
      .then((tabId) => handleDebuggerDetach({ tabId }))
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message || String(error) }));
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

init();
