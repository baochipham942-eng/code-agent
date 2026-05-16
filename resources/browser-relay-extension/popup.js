async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
  document.getElementById('status').textContent = status.connectionState || 'unknown';
  document.getElementById('port').textContent = String(status.port || '');
  document.getElementById('attached').textContent = String((status.attachedTabs || []).length);
}

document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 300);
});

refresh();
