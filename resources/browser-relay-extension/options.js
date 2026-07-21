/* global chrome, document */

const portInput = document.getElementById('port');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');

async function loadSettings() {
  const stored = await chrome.storage.local.get(['relayPort']);
  portInput.value = stored.relayPort || 23001;
}

async function saveSettings() {
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    status.textContent = 'Invalid port';
    status.style.color = '#fca5a5';
    return;
  }
  await chrome.storage.local.set({ relayPort: port });
  chrome.runtime.sendMessage({ type: 'reconnect' });
  status.textContent = 'Saved';
  status.style.color = '#86efac';
}

saveBtn.addEventListener('click', saveSettings);
portInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveSettings();
});
loadSettings();
