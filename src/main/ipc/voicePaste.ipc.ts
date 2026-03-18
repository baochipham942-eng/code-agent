import { ipcMain, globalShortcut, clipboard, BrowserWindow } from '../platform';
import { spawn, ChildProcess, execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { getConfigService } from '../services/core/configService';
import Groq from 'groq-sdk';

const execFileAsync = promisify(execFile);

// --- Inline ASR functions (extracted from removed meeting.ipc.ts) ---

async function findWhisperCpp(): Promise<string | null> {
  const candidates = ['/opt/homebrew/bin/whisper-cpp'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { stdout } = await execFileAsync('which', ['whisper-cpp']);
    const trimmed = stdout.trim();
    if (trimmed && fs.existsSync(trimmed)) return trimmed;
  } catch { /* not found */ }
  return null;
}

async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');
  if (inputPath.endsWith('.wav')) return inputPath;
  await execFileAsync('ffmpeg', ['-i', inputPath, '-ar', '16000', '-ac', '1', '-y', wavPath]);
  return wavPath;
}

async function transcribeWithWhisperCpp(filePath: string, language: string): Promise<string> {
  const whisperPath = await findWhisperCpp();
  if (!whisperPath) throw new Error('WHISPER_NOT_AVAILABLE');
  const modelPath = path.join(os.homedir(), '.cache', 'whisper', 'ggml-large-v3-turbo.bin');
  if (!fs.existsSync(modelPath)) throw new Error('WHISPER_NOT_AVAILABLE');
  const wavPath = await convertToWav(filePath);
  try {
    const { stdout } = await execFileAsync(whisperPath, ['-m', modelPath, '-l', language, '-f', wavPath], { timeout: 300000 });
    return stdout.trim();
  } finally {
    if (wavPath !== filePath && fs.existsSync(wavPath)) {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  }
}

async function transcribeWithGroq(filePath: string, language: string): Promise<string> {
  const configService = getConfigService();
  const apiKey = configService.getApiKey('groq');
  if (!apiKey) throw new Error('未配置 Groq API Key');
  const groq = new Groq({ apiKey });
  const fileStream = fs.createReadStream(filePath);
  const transcription = await groq.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-large-v3-turbo',
    language,
    response_format: 'text',
  });
  return typeof transcription === 'string' ? transcription : (transcription as any).text || '';
}

async function transcribeAudio(wavPath: string, language: string = 'zh'): Promise<string> {
  // Try whisper-cpp first
  try {
    const text = await transcribeWithWhisperCpp(wavPath, language);
    return text;
  } catch { /* fall through */ }
  // Fall back to Groq
  return await transcribeWithGroq(wavPath, language);
}

// Model API config - read from environment or config
const MODEL_API_ENDPOINTS = {
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
  },
  kimi: {
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
  }
};

let isRecording = false;
let recProcess: ChildProcess | null = null;
let currentTempFile: string | null = null;

function getApiKey(provider: 'zhipu' | 'kimi'): string | null {
  // Try to read from .env file
  const envPath = path.join(os.homedir(), 'Downloads', 'ai', 'code-agent', '.env');
  try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const keyMap: Record<string, string> = {
      zhipu: 'ZHIPU_API_KEY',
      kimi: 'KIMI_API_KEY',
    };
    const varName = keyMap[provider];
    const match = envContent.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function postProcessTranscript(rawText: string): Promise<string> {
  const prompt = `你是语音转写后处理助手。请清理以下ASR原始输出。
规则：
1. 删除口头禅（嗯、啊、那个、就是说、然后、对对对）
2. 修复标点符号
3. 修正语法错误
4. 保持原始语义不变
5. 代码术语保留英文（如 function, component, API）
6. 修正同音字错误
只输出处理后的文本，不要任何解释。

原始文本：
${rawText}`;

  // Try 智谱 GLM-4-Flash first (free & fast)
  const zhipuKey = getApiKey('zhipu');
  if (zhipuKey) {
    try {
      const resp = await fetch(MODEL_API_ENDPOINTS.zhipu.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${zhipuKey}`
        },
        body: JSON.stringify({
          model: MODEL_API_ENDPOINTS.zhipu.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const cleaned = data.choices?.[0]?.message?.content?.trim();
        if (cleaned) {
          console.log('[VoicePaste] Post-processed with GLM-4-Flash');
          return cleaned;
        }
      }
    } catch (e) {
      console.log('[VoicePaste] GLM-4-Flash failed:', (e as Error).message);
    }
  }

  // Try Kimi
  const kimiKey = getApiKey('kimi');
  if (kimiKey) {
    try {
      const resp = await fetch(MODEL_API_ENDPOINTS.kimi.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${kimiKey}`,
        },
        body: JSON.stringify({
          model: MODEL_API_ENDPOINTS.kimi.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const cleaned = data.choices?.[0]?.message?.content?.trim();
        if (cleaned) {
          console.log('[VoicePaste] Post-processed with Kimi');
          return cleaned;
        }
      }
    } catch (e) {
      console.log('[VoicePaste] Kimi failed:', (e as Error).message);
    }
  }

  // Skip post-processing, return raw
  console.log('[VoicePaste] Skipping post-processing, using raw text');
  return rawText;
}

function startRecording(): string {
  const tempFile = path.join(os.tmpdir(), `voice_paste_${Date.now()}.wav`);
  // Use sox's rec command for microphone recording
  recProcess = spawn('rec', [tempFile, 'rate', '16000', 'channels', '1'], {
    stdio: 'ignore',
  });

  recProcess.on('error', (err) => {
    console.error('[VoicePaste] rec process error:', err.message);
    isRecording = false;
    recProcess = null;
  });

  currentTempFile = tempFile;
  return tempFile;
}

function stopRecording(): void {
  if (recProcess) {
    recProcess.kill('SIGTERM');
    recProcess = null;
  }
}

async function pasteText(text: string): Promise<void> {
  // Save current clipboard content
  const previousClipboard = clipboard.readText();

  // Write transcribed text to clipboard
  clipboard.writeText(text);

  // Simulate Cmd+V via AppleScript
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'],
      { timeout: 5000 },
      (error) => {
        // Restore previous clipboard after a delay
        setTimeout(() => {
          clipboard.writeText(previousClipboard);
        }, 500);

        if (error) {
          reject(new Error(`Paste failed: ${error.message}`));
        } else {
          resolve();
        }
      }
    );
  });
}

function notifyRenderer(event: string, data?: any): void {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(event, data);
    }
  });
}

export function registerVoicePasteHandlers(ipcMain_: typeof ipcMain): void {
  const isWebMode = process.env.CODE_AGENT_WEB_MODE === 'true' || !process.versions.electron;

  // Register global shortcut Cmd+`
  if (isWebMode) {
    console.log('[VoicePaste] Global shortcut registration skipped in web mode');
  }
  const registered = isWebMode ? false : globalShortcut.register('CommandOrControl+`', async () => {
    if (!isRecording) {
      // Start recording
      isRecording = true;
      const tempFile = startRecording();
      console.log('[VoicePaste] Recording started:', tempFile);
      notifyRenderer('voice-paste:status', { status: 'recording' });
    } else {
      // Stop recording and process
      isRecording = false;
      stopRecording();
      console.log('[VoicePaste] Recording stopped, processing...');
      notifyRenderer('voice-paste:status', { status: 'transcribing' });

      try {
        if (!currentTempFile || !fs.existsSync(currentTempFile)) {
          throw new Error('No recording file found');
        }

        // Check file size (skip if too small)
        const stats = fs.statSync(currentTempFile);
        if (stats.size < 1000) {
          console.log('[VoicePaste] Recording too short, skipping');
          notifyRenderer('voice-paste:status', { status: 'idle', error: '录音太短' });
          return;
        }

        // Transcribe
        const rawText = await transcribeAudio(currentTempFile);
        if (!rawText || rawText.trim().length === 0) {
          notifyRenderer('voice-paste:status', { status: 'idle', error: '未识别到语音' });
          return;
        }

        // Post-process
        notifyRenderer('voice-paste:status', { status: 'processing' });
        const cleanText = await postProcessTranscript(rawText);

        // Paste
        await pasteText(cleanText);
        console.log('[VoicePaste] Pasted:', cleanText.substring(0, 50) + '...');
        notifyRenderer('voice-paste:status', { status: 'idle' });

      } catch (error) {
        console.error('[VoicePaste] Error:', (error as Error).message);
        notifyRenderer('voice-paste:status', {
          status: 'idle',
          error: (error as Error).message
        });
      } finally {
        // Cleanup temp file
        if (currentTempFile && fs.existsSync(currentTempFile)) {
          fs.unlinkSync(currentTempFile);
          currentTempFile = null;
        }
      }
    }
  });

  if (!registered && !isWebMode) {
    console.error('[VoicePaste] Failed to register global shortcut Cmd+`');
  } else if (registered) {
    console.log('[VoicePaste] Global shortcut Cmd+` registered');
  }

  // IPC handlers for renderer queries
  ipcMain_.handle('voice-paste:get-status', () => {
    return { isRecording };
  });

  ipcMain_.handle('voice-paste:toggle', async () => {
    // Allow renderer to trigger toggle programmatically
    globalShortcut.isRegistered('CommandOrControl+`') &&
      // Simulate the shortcut callback
      (isRecording ? stopRecording() : startRecording());
    return { isRecording };
  });
}

export function unregisterVoicePaste(): void {
  if (isRecording) {
    stopRecording();
  }
  globalShortcut.unregister('CommandOrControl+`');
}
