// ============================================================================
// Popup Script - 插件弹窗逻辑
// ============================================================================

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const pageTitle = document.getElementById('pageTitle');
const pageUrl = document.getElementById('pageUrl');
const captureBtn = document.getElementById('captureBtn');
const resultDiv = document.getElementById('result');
const apiUrlInput = document.getElementById('apiUrl');
const apiKeyInput = document.getElementById('apiKey');
const saveSettingsBtn = document.getElementById('saveSettings');
const autoCaptureToggle = document.getElementById('autoCapture');
const captureCountBadge = document.getElementById('captureCount');

function setConnected(connected) {
  if (connected) {
    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Code Agent 已连接';
    captureBtn.disabled = false;
  } else {
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Code Agent 未连接';
    captureBtn.disabled = true;
  }
}

// 带超时的消息发送
function sendMsg(msg, timeoutMs = 3000) {
  return Promise.race([
    chrome.runtime.sendMessage(msg),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

// 直接 fetch health（绕过 background service worker）
async function directHealthCheck() {
  const url = apiUrlInput.value || 'http://localhost:8080';
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

// 初始化
async function init() {
  // 加载设置
  try {
    const config = await sendMsg({ type: 'getConfig' });
    apiUrlInput.value = config.apiUrl || 'http://localhost:8080';
    apiKeyInput.value = config.apiKey || '';
    autoCaptureToggle.checked = config.autoCapture !== false;
  } catch {
    // background 可能还没启动，用默认值
    const stored = await chrome.storage.local.get(['codeAgentApiUrl', 'codeAgentApiKey', 'codeAgentAutoCapture']);
    apiUrlInput.value = stored.codeAgentApiUrl || 'http://localhost:8080';
    apiKeyInput.value = stored.codeAgentApiKey || '';
    autoCaptureToggle.checked = stored.codeAgentAutoCapture !== false;
  }

  // 加载采集数量
  try {
    const stats = await sendMsg({ type: 'getStats' });
    captureCountBadge.textContent = stats.capturedCount || 0;
  } catch { /* ignore */ }

  // 检查连接 - 先通过 background，失败就直接 fetch
  try {
    const { connected } = await sendMsg({ type: 'checkConnection' });
    setConnected(connected);
  } catch {
    // background 没响应，直接 fetch 检查
    const ok = await directHealthCheck();
    setConnected(ok);
  }

  // 获取当前页面信息
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      pageTitle.textContent = tab.title || '-';
      pageUrl.textContent = tab.url || '-';
    }
  } catch { /* ignore */ }
}

// 手动采集当前页面
captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = '采集中...';
  resultDiv.style.display = 'none';

  try {
    const response = await sendMsg({
      type: 'capture',
      data: { source: 'browser_extension' },
    }, 10000);

    if (response.success) {
      resultDiv.className = 'result success';
      resultDiv.textContent = '采集成功！';
      try {
        const stats = await sendMsg({ type: 'getStats' });
        captureCountBadge.textContent = stats.capturedCount || 0;
      } catch { /* ignore */ }
    } else {
      throw new Error(response.error || '采集失败');
    }
  } catch (error) {
    resultDiv.className = 'result error';
    resultDiv.textContent = error.message;
  } finally {
    resultDiv.style.display = 'block';
    captureBtn.disabled = false;
    captureBtn.textContent = '手动采集此页';
  }
});

// 自动采集开关
autoCaptureToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({
    codeAgentAutoCapture: autoCaptureToggle.checked,
  });
});

// 保存设置
saveSettingsBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    codeAgentApiUrl: apiUrlInput.value,
    codeAgentApiKey: apiKeyInput.value,
  });
  saveSettingsBtn.textContent = '已保存';

  // 保存后重新检查连接
  const ok = await directHealthCheck();
  setConnected(ok);

  setTimeout(() => { saveSettingsBtn.textContent = '保存设置'; }, 1500);
});

init();
