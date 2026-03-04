// ============================================================================
// Meeting IPC - 会议录音的 IPC 处理器
// 保存录音、转写、生成会议纪要
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

const logger = createLogger('Meeting');
const execFileAsync = promisify(execFile);

export const MEETING_CHANNELS = {
  SAVE_RECORDING: 'meeting:save-recording',
  TRANSCRIBE: 'meeting:transcribe',
  GENERATE_MINUTES: 'meeting:generate-minutes',
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
// Transcribe
// ============================================================================

interface TranscribeRequest {
  filePath: string;
  language?: string;
}

interface TranscribeResponse {
  success: boolean;
  text?: string;
  duration?: number;
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
    ], { timeout: 300000 }); // 5 min timeout for long meetings

    return stdout.trim();
  } finally {
    // 清理临时 wav 文件
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

async function transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
  const { filePath, language = 'zh' } = request;

  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: '录音文件不存在' };
  }

  const startTime = Date.now();
  logger.info('Starting transcription', { filePath, language });

  try {
    // 优先使用本地 whisper-cpp
    const text = await transcribeWithWhisperCpp(filePath, language);
    const duration = (Date.now() - startTime) / 1000;
    logger.info(`Local transcription completed in ${duration}s`);
    return { success: true, text, duration };
  } catch (err) {
    if (err instanceof Error && err.message === 'WHISPER_NOT_AVAILABLE') {
      logger.info('whisper-cpp not available, falling back to Groq API');
    } else {
      logger.warn('Local transcription failed, falling back to Groq:', err);
    }
  }

  // Fallback: Groq Whisper API
  try {
    const text = await transcribeWithGroq(filePath, language);
    const duration = (Date.now() - startTime) / 1000;
    logger.info(`Groq transcription completed in ${duration}s`);
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
// Generate Minutes
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

async function generateMinutes(request: GenerateMinutesRequest): Promise<GenerateMinutesResponse> {
  const { transcript, participants = [], language = 'zh' } = request;

  if (!transcript || transcript.trim().length === 0) {
    return { success: false, error: '转写文本为空' };
  }

  const participantInfo = participants.length > 0
    ? `\n参与者: ${participants.join(', ')}`
    : '';

  const prompt = language === 'zh'
    ? `请基于以下会议录音转写文本，生成结构化的会议纪要。包含：
1. 会议主题
2. 关键讨论点
3. 决策事项
4. 行动项（TODO）
5. 简要总结
${participantInfo}

转写文本：
${transcript}`
    : `Generate structured meeting minutes from the following transcript. Include:
1. Meeting topic
2. Key discussion points
3. Decisions made
4. Action items (TODO)
5. Brief summary
${participantInfo}

Transcript:
${transcript}`;

  // 尝试 Ollama
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
        logger.info('Minutes generated with Ollama');
        return { success: true, minutes, model: 'qwen2.5:7b' };
      }
    }
  } catch (err) {
    logger.warn('Ollama not available:', err instanceof Error ? err.message : err);
  }

  // Fallback: 返回带时间戳的原始文本
  const now = new Date().toLocaleString('zh-CN');
  const fallbackMinutes = `# 会议记录\n\n**时间**: ${now}\n${participantInfo ? `**${participantInfo.trim()}**\n` : ''}\n## 转写内容\n\n${transcript}`;

  logger.info('Using fallback minutes (raw transcript)');
  return { success: true, minutes: fallbackMinutes, model: 'fallback' };
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

  logger.info('Meeting handlers registered');
}
