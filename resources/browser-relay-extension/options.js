const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const toggleTokenBtn = document.getElementById('toggleToken');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');

async function loadSettings() {
  const stored = await chrome.storage.local.get(['relayPort', 'authToken']);
  portInput.value = stored.relayPort || 23001;
  tokenInput.value = stored.authToken || '';
}

async function saveSettings() {
  const port = Number(portInput.value);
  const token = tokenInput.value.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    status.textContent = 'Invalid port';
    status.style.color = '#fca5a5';
    return;
  }
  await chrome.storage.local.set({ relayPort: port, authToken: token });
  chrome.runtime.sendMessage({ type: 'reconnect' });
  status.textContent = 'Saved';
  status.style.color = '#86efac';
}

toggleTokenBtn.addEventListener('click', () => {
  tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
  toggleTokenBtn.textContent = tokenInput.type === 'password' ? 'Show' : 'Hide';
});
saveBtn.addEventListener('click', saveSettings);
portInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveSettings();
});
tokenInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveSettings();
});

loadSettings();
