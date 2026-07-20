function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setHidden(id, hidden) {
  const element = document.getElementById(id);
  if (element) element.hidden = hidden;
}

function showResult(result) {
  if (result?.error) {
    setText('message', `${result.error.code}: ${result.error.message}`);
    return false;
  }
  setText('message', '');
  return true;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
  if (!showResult(status)) return;

  setText('status', status.handshakeComplete ? 'connected · protocol v2' : (status.connectionState || 'unknown'));
  setText('port', String(status.port || ''));
  setText('leased', String(status.activeLeaseCount || 0));

  const current = status.currentTab || null;
  const currentLease = current?.lease || null;
  setText('tabTitle', current?.title || '—');
  setText('tabUrl', current?.url || '—');
  setText('tabLease', currentLease ? `${currentLease.state} · ${currentLease.leaseId}` : 'not leased');
  const returnButton = document.getElementById('returnLease');
  if (returnButton) returnButton.disabled = !currentLease;

  const pending = status.pendingLease || null;
  setHidden('pendingCard', !pending);
  setHidden('noPending', Boolean(pending));
  if (pending) {
    setText('pendingOrigin', pending.origin);
    setText('pendingActions', pending.actions.join(', '));
    setText('pendingAgent', pending.agentId);
    setText('pendingSession', pending.surfaceSessionId);
    setText('pendingExpiry', new Date(pending.expiresAtMs).toLocaleString());
  }

  const approveButton = document.getElementById('approve');
  const denyButton = document.getElementById('deny');
  if (approveButton) approveButton.disabled = !pending || !current || !status.handshakeComplete;
  if (denyButton) denyButton.disabled = !pending;
}

document.getElementById('reconnect').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'reconnect' });
  showResult(result);
  setTimeout(refresh, 300);
});

document.getElementById('approve').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'approvePendingLease' });
  if (showResult(result)) setText('message', 'Lease approved for the current tab.');
  setTimeout(refresh, 200);
});

document.getElementById('deny').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'denyPendingLease' });
  if (showResult(result)) setText('message', 'Lease request denied.');
  setTimeout(refresh, 200);
});

document.getElementById('returnLease').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'returnCurrentLease' });
  if (showResult(result)) setText('message', 'Tab returned to its original window.');
  setTimeout(refresh, 200);
});

refresh();
