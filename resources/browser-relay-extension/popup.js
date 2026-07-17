function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
  setText('status', status.connectionState || 'unknown');
  setText('port', String(status.port || ''));
  setText('attached', String((status.attachedTabs || []).length));

  const current = status.currentTab || null;
  setText('tabTitle', current?.title || '—');
  setText('tabUrl', current?.url || '—');
  setText('tabAttached', current?.attached ? 'yes' : 'no');

  const attachBtn = document.getElementById('attach');
  const detachBtn = document.getElementById('detach');
  if (attachBtn) attachBtn.disabled = !current?.id || Boolean(current?.attached);
  if (detachBtn) detachBtn.disabled = !current?.id || !current?.attached;
}

document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 300);
});

document.getElementById('attach').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'attachCurrentTab' });
  if (result && result.error) {
    setText('status', result.error);
  }
  setTimeout(refresh, 200);
});

document.getElementById('detach').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'detachCurrentTab' });
  if (result && result.error) {
    setText('status', result.error);
  }
  setTimeout(refresh, 200);
});

refresh();
