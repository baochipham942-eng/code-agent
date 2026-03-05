// ============================================================================
// Meeting IPC - 会议录音的 IPC 处理器
// 保存录音、转写（Qwen3-ASR → whisper-cpp → Groq）、生成会议纪要（Ollama → Kimi → DeepSeek → fallback）
// ============================================================================

import { IpcMain } from 'electron';
import { createLogger } from '../services/infra/logger';
import { getConfigService } from '../services/core/configService';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Groq from 'groq-sdk';
import { MODEL_API_ENDPOINTS } from '@shared/constants';

import { getQwen3AsrService } from './qwen3AsrService';

const logger = createLogger('Meeting');
const execFileAsync = promisify(execFile);

/** Resolve script path — works both in source (src/main/ipc/) and bundled (dist/main/) */
function findScript(name: string): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'scripts', name),       // dist/main/ → project root
    path.join(__dirname, '..', '..', '..', 'scripts', name), // src/main/ipc/ → project root
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

export const MEETING_CHANNELS = {
  SAVE_RECORDING: 'meeting:save-recording',
  TRANSCRIBE: 'meeting:transcribe',
  GENERATE_MINUTES: 'meeting:generate-minutes',
  CHECK_ASR_ENGINES: 'meeting:check-asr-engines',
  LIVE_ASR_START: 'meeting:live-asr-start',
  LIVE_ASR_STOP: 'meeting:live-asr-stop',
  LIVE_ASR_CHUNK: 'meeting:live-asr-chunk',
} as const;

// ============================================================================
// Save Recording
// ============================================================================

interface SaveRecordingRequest {
  audioData: string;  // base64
  mimeType: string;
  sessionId: string;
}

interface SaveRecordingResponse {
  success: boolean;
  filePath?: string;
  error?: string;
}

async function saveRecording(request: SaveRecordingRequest): Promise<SaveRecordingResponse> {
  const { audioData, mimeType, sessionId } = request;

  if (!audioData || !sessionId) {
    return { success: false, error: '缺少音频数据或会话 ID' };
  }

  const meetingsDir = path.join(os.homedir(), 'Documents', 'code-agent', 'meetings');
  await fs.promises.mkdir(meetingsDir, { recursive: true });

  const ext = mimeType.includes('mp4') ? '.mp4' : mimeType.includes('wav') ? '.wav' : '.webm';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `meeting_${sessionId}_${timestamp}${ext}`;
  const filePath = path.join(meetingsDir, fileName);

  const buffer = Buffer.from(audioData, 'base64');
  await fs.promises.writeFile(filePath, buffer);

  logger.info('Recording saved', { filePath, size: buffer.length });
  return { success: true, filePath };
}

// ============================================================================
// Transcribe — whisper-cpp (local) → Groq Whisper API (cloud)
// ============================================================================

interface TranscribeRequest {
  filePath: string;
  language?: string;
}

interface TranscribeResponse {
  success: boolean;
  text?: string;
  duration?: number;
  engine?: string; // 实际使用的 ASR 引擎
  error?: string;
}

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

  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-y',
    wavPath,
  ]);
  return wavPath;
}

async function transcribeWithWhisperCpp(filePath: string, language: string): Promise<string> {
  const whisperPath = await findWhisperCpp();
  if (!whisperPath) throw new Error('WHISPER_NOT_AVAILABLE');

  const modelPath = path.join(os.homedir(), '.cache', 'whisper', 'ggml-large-v3-turbo.bin');
  if (!fs.existsSync(modelPath)) throw new Error('WHISPER_NOT_AVAILABLE');

  const wavPath = await convertToWav(filePath);

  try {
    const { stdout } = await execFileAsync(whisperPath, [
      '-m', modelPath,
      '-l', language,
      '-f', wavPath,
    ], { timeout: 300000 });

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

  return typeof transcription === 'string'
    ? transcription
    : (transcription as any).text || '';
}

async function transcribeWithQwen3Asr(wavPath: string): Promise<string> {
  const scriptPath = findScript('qwen3-asr-inference.py');

  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath, '--audio', wavPath, '--model', '0.6b'],
      { timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Qwen3-ASR failed: ${error.message}`));
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            reject(new Error(result.error));
          } else if (result.text && result.text.trim()) {
            resolve(result.text.trim());
          } else {
            reject(new Error('Qwen3-ASR returned empty text'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Qwen3-ASR output: ${stdout}`));
        }
      }
    );
  });
}

async function checkQwen3AsrAvailability(): Promise<{ available: boolean; modelPath?: string }> {
  const scriptPath = findScript('qwen3-asr-inference.py');
  return new Promise((resolve) => {
    execFile('python3', [scriptPath, '--check'], { timeout: 10000 }, (error, stdout) => {
      if (error) {
        resolve({ available: false });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve({ available: result.available, modelPath: result.model_path });
      } catch {
        resolve({ available: false });
      }
    });
  });
}

export async function transcribeAudio(wavPath: string, language: string = 'zh'): Promise<string> {
  // Try Qwen3-ASR first
  try {
    logger.info('[ASR] Trying Qwen3-ASR...');
    const text = await transcribeWithQwen3Asr(wavPath);
    logger.info('[ASR] Qwen3-ASR succeeded, text length:', text.length);
    return text;
  } catch (e) {
    logger.info('[ASR] Qwen3-ASR failed:', (e as Error).message);
  }

  // Try whisper-cpp
  try {
    logger.info('[ASR] Trying whisper-cpp...');
    const text = await transcribeWithWhisperCpp(wavPath, language);
    logger.info('[ASR] whisper-cpp succeeded, text length:', text.length);
    return text;
  } catch (e) {
    logger.info('[ASR] whisper-cpp failed:', (e as Error).message);
  }

  // Fall back to Groq
  logger.info('[ASR] Trying Groq...');
  return await transcribeWithGroq(wavPath, language);
}

async function transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
  const { filePath, language = 'zh' } = request;

  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: '录音文件不存在' };
  }

  const startTime = Date.now();
  logger.info('Starting transcription', { filePath, language });

  try {
    const text = await transcribeAudio(filePath, language);
    const duration = (Date.now() - startTime) / 1000;
    logger.info(`Transcription completed in ${duration}s`);
    logger.info('[Meeting] Transcription complete, text length:', text.length);
    return { success: true, text, duration };
  } catch (err) {
    logger.error('All transcription methods failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : '转写失败',
    };
  }
}

// ============================================================================
// Generate Minutes — Ollama → DeepSeek → Kimi → fallback
// ============================================================================

interface GenerateMinutesRequest {
  transcript: string;
  participants?: string[];
  language?: string;
}

interface GenerateMinutesResponse {
  success: boolean;
  minutes?: string;
  model?: string;
  error?: string;
}

function buildMinutesPrompt(transcript: string, participants?: string[], language?: string): string {
  const lang = language || 'zh';
  const participantInfo = participants?.length
    ? `参与者: ${participants.join(', ')}`
    : '参与者: 未指定';

  return `你是专业的会议纪要生成助手（飞书妙记风格），请严格按以下格式输出结构化纪要：

## 📋 会议概要
- **主题**: [从内容推断会议主题]
- **${participantInfo}**
- **时长**: [从内容估算]

## 📝 总结
[2-3 句话概括会议核心内容和结论]

## 📖 讨论章节

[将讨论自动分为 2-5 个章节，每章用 #### 标题]

#### [章节1标题]
- **要点**: [本章核心观点]
- **细节**: [支撑细节和讨论过程]

#### [章节2标题]
- **要点**: [本章核心观点]
- **细节**: [支撑细节和讨论过程]

[...根据内容自动增减章节...]

## ✅ 行动项
- [ ] [具体行动] — [负责人] | [截止时间]
- [ ] [具体行动] — [负责人] | [截止时间]

## 🔑 关键决策
- [决策1及其理由]
- [决策2及其理由]

## 💡 待跟进事项
- [需要后续讨论或确认的事项]

---

规则：
1. 使用${lang === 'zh' ? '中文' : 'English'}输出
2. 章节标题要简洁有力，反映讨论主题
3. 行动项必须包含负责人（如果能从上下文推断）
4. 如无法确定负责人，标注"待定"
5. 关键决策要附带简要理由
6. 待跟进事项列出需要后续确认的未决问题
7. 根据内容长度自适应输出：
   - 短内容（<200字转写）：只输出总结和关键要点，省略章节分段
   - 中等内容（200-1000字）：输出完整格式但精简每个部分
   - 长内容（>1000字）：输出完整详细格式
8. 不要编造内容，如果转写文本中没有明确的行动项、决策或待跟进事项，对应部分写"无"
9. 每个二级标题必须保留对应的 emoji 前缀（📋📝📖✅🔑💡）

以下是会议转写文本：

${transcript}`;
}

/** Call OpenAI-compatible API */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number = 60000,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function generateMinutes(request: GenerateMinutesRequest): Promise<GenerateMinutesResponse> {
  const { transcript, participants = [], language = 'zh' } = request;

  if (!transcript || transcript.trim().length === 0) {
    return { success: false, error: '转写文本为空' };
  }

  const prompt = buildMinutesPrompt(transcript, participants, language);
  const configService = getConfigService();

  // 1. Ollama (local)
  logger.info('[Minutes] Trying Ollama qwen2.5:7b...');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      const minutes = data.message?.content || '';
      if (minutes) {
        logger.info('Minutes generated with Ollama qwen2.5:7b');
        logger.info('[Minutes] Generated with: Ollama qwen2.5:7b');
        return { success: true, minutes, model: 'Ollama qwen2.5:7b (local)' };
      }
    }
  } catch (err) {
    logger.info('[Minutes] Ollama failed:', err instanceof Error ? err.message : String(err));
    logger.warn('Ollama not available:', err instanceof Error ? err.message : err);
  }

  // 2. Kimi (主力模型)
  logger.info('[Minutes] Trying Kimi K2.5...');
  const moonshotKey = configService.getApiKey('moonshot');
  if (moonshotKey) {
    const minutes = await callOpenAICompatible(
      MODEL_API_ENDPOINTS.kimiK25,
      moonshotKey,
      'kimi-k2.5',
      prompt,
    );
    if (minutes) {
      logger.info('Minutes generated with Kimi K2.5');
      logger.info('[Minutes] Generated with: Kimi K2.5');
      return { success: true, minutes, model: 'Kimi K2.5' };
    }
    logger.info('[Minutes] Kimi K2.5 failed');
    logger.warn('Kimi K2.5 failed for minutes generation');
  }

  // 3. DeepSeek
  logger.info('[Minutes] Trying DeepSeek...');
  const deepseekKey = configService.getApiKey('deepseek');
  if (deepseekKey) {
    const minutes = await callOpenAICompatible(
      MODEL_API_ENDPOINTS.deepseek,
      deepseekKey,
      'deepseek-chat',
      prompt,
    );
    if (minutes) {
      logger.info('Minutes generated with DeepSeek');
      logger.info('[Minutes] Generated with: DeepSeek Chat');
      return { success: true, minutes, model: 'DeepSeek Chat' };
    }
    logger.info('[Minutes] DeepSeek failed');
    logger.warn('DeepSeek failed for minutes generation');
  }

  // 4. 智谱 GLM
  logger.info('[Minutes] Trying Zhipu GLM-4-Flash...');
  const zhipuKey = configService.getApiKey('zhipu');
  if (zhipuKey) {
    const minutes = await callOpenAICompatible(
      MODEL_API_ENDPOINTS.zhipu,
      zhipuKey,
      'glm-4-flash',
      prompt,
    );
    if (minutes) {
      logger.info('Minutes generated with Zhipu GLM');
      logger.info('[Minutes] Generated with: 智谱 GLM-4-Flash');
      return { success: true, minutes, model: '智谱 GLM-4-Flash' };
    }
    logger.info('[Minutes] Zhipu failed');
    logger.warn('Zhipu failed for minutes generation');
  }

  // 5. Fallback: 返回格式化原文
  const now = new Date().toLocaleString('zh-CN');
  const participantInfo = participants.length > 0 ? `**参与者**: ${participants.join(', ')}\n` : '';
  const fallbackMinutes = `# 会议记录\n\n**时间**: ${now}\n${participantInfo}\n## 转写内容\n\n${transcript}\n\n---\n*未能连接 LLM 服务，显示原始转写文本*`;

  logger.info('[Minutes] Generated with: fallback (no LLM)');
  logger.info('Using fallback minutes (no LLM available)');
  return { success: true, minutes: fallbackMinutes, model: '无 LLM (原始转写)' };
}

// ============================================================================
// Register Handlers
// ============================================================================

export function registerMeetingHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    MEETING_CHANNELS.SAVE_RECORDING,
    async (_event, request: SaveRecordingRequest) => saveRecording(request)
  );

  ipcMain.handle(
    MEETING_CHANNELS.TRANSCRIBE,
    async (_event, request: TranscribeRequest) => transcribe(request)
  );

  ipcMain.handle(
    MEETING_CHANNELS.GENERATE_MINUTES,
    async (_event, request: GenerateMinutesRequest) => generateMinutes(request)
  );

  ipcMain.handle(MEETING_CHANNELS.CHECK_ASR_ENGINES, async () => {
    const qwen3 = await checkQwen3AsrAvailability();
    const whisperAvailable = fs.existsSync('/opt/homebrew/bin/whisper-cpp');
    return {
      engines: [
        { name: 'Qwen3-ASR', available: qwen3.available, modelPath: qwen3.modelPath },
        { name: 'whisper-cpp', available: whisperAvailable },
        { name: 'Groq', available: true }, // always available via API
      ],
    };
  });

  // Live ASR handlers (persistent Qwen3-ASR process)
  ipcMain.handle(MEETING_CHANNELS.LIVE_ASR_START, async () => {
    try {
      await getQwen3AsrService().start();
      return { success: true };
    } catch (err) {
      logger.error('[LiveASR] Start failed:', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(MEETING_CHANNELS.LIVE_ASR_STOP, async () => {
    try {
      await getQwen3AsrService().stop();
      return { success: true };
    } catch (err) {
      logger.error('[LiveASR] Stop failed:', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    MEETING_CHANNELS.LIVE_ASR_CHUNK,
    async (_event, data: { audioBase64: string; mimeType: string }) => {
      try {
        // Write base64 audio to temp file
        const tmpDir = path.join(os.tmpdir(), 'code-agent-live-asr');
        await fs.promises.mkdir(tmpDir, { recursive: true });

        const ext = data.mimeType.includes('mp4') ? '.mp4' : data.mimeType.includes('wav') ? '.wav' : '.webm';
        const tmpFile = path.join(tmpDir, `chunk_${Date.now()}${ext}`);
        const buffer = Buffer.from(data.audioBase64, 'base64');
        await fs.promises.writeFile(tmpFile, buffer);

        // Convert to WAV (16kHz mono) — frontend sends sliding window (~5s), so this is fast
        const wavPath = await convertToWav(tmpFile);

        // Transcribe via persistent Qwen3-ASR process
        const result = await getQwen3AsrService().transcribeChunk(wavPath);

        // Cleanup
        fs.promises.unlink(tmpFile).catch(() => {});
        if (wavPath !== tmpFile) fs.promises.unlink(wavPath).catch(() => {});

        return { success: true, text: result.text, duration: result.duration };
      } catch (err) {
        logger.error('[LiveASR] Chunk transcription failed:', err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  logger.info('Meeting handlers registered');
}
