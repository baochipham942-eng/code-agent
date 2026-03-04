// ============================================================================
// Meeting Recorder Tool - 会议记录工具
// 音频文件 → 本地 ASR 转写 → LLM 后处理 → 结构化会议纪要
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { createLogger } from '../../services/infra/logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('MeetingRecorder');

// 配置
const CONFIG = {
  SEGMENT_DURATION: 300, // 5 分钟分段
  OLLAMA_URL: 'http://localhost:11434/api/chat',
  OLLAMA_MODEL: 'qwen2.5:14b',
  OLLAMA_TIMEOUT_MS: 120000, // LLM 2 分钟超时
  FFMPEG_TIMEOUT_MS: 60000,
  SUPPORTED_FORMATS: ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm', '.aac', '.wma'],
};

const MEETING_SUMMARY_PROMPT = `你是一个会议纪要助手。请根据以下会议转写文本，生成结构化的会议纪要。

转写文本：
{transcript}

{participants_section}

请按以下格式输出：
## 会议摘要
（3-5 句话概括）

## 议题详情
（按议题分段整理）

## 待办事项
（提取 action items，格式：- [ ] 内容）

## 关键决策
（列出本次会议做出的重要决策）`;

interface MeetingRecorderParams {
  file_path: string;
  output_path?: string;
  language?: string;
  participants?: string;
}

/**
 * 获取音频时长（秒）
 */
async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stderr } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: CONFIG.FFMPEG_TIMEOUT_MS });

    const duration = parseFloat(stderr.trim() || '0');
    if (isNaN(duration)) {
      // fallback: parse from ffmpeg output
      const { stderr: ffmpegStderr } = await execFileAsync('ffmpeg', [
        '-i', filePath,
      ], { timeout: CONFIG.FFMPEG_TIMEOUT_MS }).catch(e => ({ stderr: e.stderr || '' }));

      const match = String(ffmpegStderr).match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (match) {
        return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
      }
      return 0;
    }
    return duration;
  } catch (error: any) {
    // ffprobe 可能不存在，尝试 ffmpeg
    try {
      const result = await execFileAsync('ffmpeg', ['-i', filePath], {
        timeout: CONFIG.FFMPEG_TIMEOUT_MS,
      }).catch(e => ({ stdout: '', stderr: e.stderr || '' }));

      const match = String(result.stderr).match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (match) {
        return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
      }
    } catch {
      // ignore
    }
    return 0;
  }
}

/**
 * 分割音频为多段
 */
async function splitAudio(
  filePath: string,
  duration: number,
  tempDir: string
): Promise<string[]> {
  const segments: string[] = [];
  const segmentCount = Math.ceil(duration / CONFIG.SEGMENT_DURATION);

  for (let i = 0; i < segmentCount; i++) {
    const start = i * CONFIG.SEGMENT_DURATION;
    const segPath = path.join(tempDir, `segment_${i}.wav`);

    await execFileAsync('ffmpeg', [
      '-i', filePath,
      '-ss', String(start),
      '-t', String(CONFIG.SEGMENT_DURATION),
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y',
      segPath,
    ], { timeout: CONFIG.FFMPEG_TIMEOUT_MS });

    segments.push(segPath);
  }

  return segments;
}

/**
 * 调用本地 ASR 转写单个文件
 * 复用 localSpeechToText 的逻辑，但直接调用 whisper-cpp
 */
async function transcribeFile(
  filePath: string,
  language: string,
  context: ToolContext
): Promise<string> {
  // 通过 toolRegistry 调用 local_speech_to_text
  const registry = context.toolRegistry;
  if (registry) {
    const asrTool = registry.get('local_speech_to_text');
    if (asrTool) {
      const result = await asrTool.execute(
        { file_path: filePath, language, output_format: 'text' },
        context
      );
      if (result.success && result.output) {
        return result.output;
      }
      throw new Error(result.error || 'ASR 转写失败');
    }
  }
  throw new Error('local_speech_to_text 工具不可用，请确保已注册');
}

/**
 * 调用 Ollama 生成会议纪要
 */
async function generateMeetingSummary(
  transcript: string,
  participants?: string
): Promise<string> {
  const participantsSection = participants
    ? `参会人员：${participants}\n请在纪要中尽量识别和标注发言人。`
    : '';

  const prompt = MEETING_SUMMARY_PROMPT
    .replace('{transcript}', transcript)
    .replace('{participants_section}', participantsSection);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.OLLAMA_TIMEOUT_MS);

    const response = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API 错误: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { message?: { content?: string } };
    return result.message?.content || '无法生成会议纪要';
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('Ollama 响应超时，请检查模型是否已加载');
    }
    // Ollama 可能未启动
    if (error.cause?.code === 'ECONNREFUSED') {
      throw new Error('无法连接 Ollama（localhost:11434）。请确保 Ollama 已启动: ollama serve');
    }
    throw error;
  }
}

/**
 * 格式化时长
 */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export const meetingRecorderTool: Tool = {
  name: 'meeting_recorder',
  description: `会议录音转写与纪要生成。

接收音频文件，通过本地 ASR 转写后由 LLM 生成结构化会议纪要。

参数：
- file_path: 音频文件路径（必填）
- output_path: 输出 Markdown 路径（可选，默认同目录下 _meeting_notes.md）
- language: 语言代码（可选，默认 zh）
- participants: 参会人列表，逗号分隔（可选，帮助识别发言人）

功能：
- 超过 5 分钟的音频自动分段转写
- 使用 Ollama 本地 LLM 生成结构化纪要
- 输出包含：会议摘要、议题详情、待办事项、关键决策

前置要求：
- whisper-cpp（brew install whisper-cpp）
- Ollama（ollama serve）+ 已拉取模型
- ffmpeg（音频处理）

示例：
\`\`\`
meeting_recorder { "file_path": "/path/to/meeting.mp3" }
meeting_recorder { "file_path": "meeting.wav", "participants": "张三,李四", "output_path": "notes.md" }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '音频文件路径',
      },
      output_path: {
        type: 'string',
        description: '输出 Markdown 文件路径',
      },
      language: {
        type: 'string',
        description: '语言代码（如 zh, en），默认 zh',
      },
      participants: {
        type: 'string',
        description: '参会人列表，逗号分隔',
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const typedParams = params as unknown as MeetingRecorderParams;
    const startTime = Date.now();

    try {
      // 1. 解析文件路径
      let filePath = typedParams.file_path;
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(context.workingDirectory, filePath);
      }

      if (!fs.existsSync(filePath)) {
        return { success: false, error: `文件不存在: ${filePath}` };
      }

      const ext = path.extname(filePath).toLowerCase();
      if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
        return {
          success: false,
          error: `不支持的音频格式: ${ext}。支持: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
        };
      }

      const language = typedParams.language || 'zh';

      context.emit?.('tool_output', {
        tool: 'meeting_recorder',
        message: '正在分析音频文件...',
      });

      // 2. 获取音频时长
      const duration = await getAudioDuration(filePath);
      logger.info('[会议记录] 音频信息', {
        file: path.basename(filePath),
        duration: formatDuration(duration),
      });

      // 3. 转写
      let transcript: string;

      if (duration > CONFIG.SEGMENT_DURATION) {
        // 长音频分段处理
        const tempDir = path.join(path.dirname(filePath), `_meeting_temp_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
          const segmentCount = Math.ceil(duration / CONFIG.SEGMENT_DURATION);
          context.emit?.('tool_output', {
            tool: 'meeting_recorder',
            message: `音频时长 ${formatDuration(duration)}，分为 ${segmentCount} 段转写...`,
          });

          const segments = await splitAudio(filePath, duration, tempDir);
          const transcripts: string[] = [];

          for (let i = 0; i < segments.length; i++) {
            context.emit?.('tool_output', {
              tool: 'meeting_recorder',
              message: `正在转写第 ${i + 1}/${segments.length} 段...`,
            });

            const segText = await transcribeFile(segments[i], language, context);
            transcripts.push(segText);
          }

          transcript = transcripts.join('\n');
        } finally {
          // 清理临时目录
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      } else {
        // 短音频直接转写
        context.emit?.('tool_output', {
          tool: 'meeting_recorder',
          message: `正在转写 (${formatDuration(duration)})...`,
        });

        transcript = await transcribeFile(filePath, language, context);
      }

      if (!transcript.trim()) {
        return {
          success: false,
          error: '转写结果为空，音频中可能没有可识别的语音内容。',
        };
      }

      // 4. LLM 后处理生成会议纪要
      context.emit?.('tool_output', {
        tool: 'meeting_recorder',
        message: '正在生成会议纪要...',
      });

      let meetingNotes: string;
      try {
        meetingNotes = await generateMeetingSummary(transcript, typedParams.participants);
      } catch (error: any) {
        // LLM 不可用时，返回原始转写文本
        logger.warn('[会议记录] LLM 生成纪要失败，返回原始转写', { error: error.message });
        meetingNotes = `## 会议转写文本\n\n> LLM 纪要生成失败 (${error.message})，以下为原始转写内容：\n\n${transcript}`;
      }

      // 5. 保存输出
      const outputPath = typedParams.output_path
        ? (path.isAbsolute(typedParams.output_path)
            ? typedParams.output_path
            : path.join(context.workingDirectory, typedParams.output_path))
        : filePath.replace(ext, '_meeting_notes.md');

      const header = `# 会议纪要\n\n- **源文件**: ${path.basename(filePath)}\n- **时长**: ${formatDuration(duration)}\n- **语言**: ${language}\n- **生成时间**: ${new Date().toLocaleString('zh-CN')}\n${typedParams.participants ? `- **参会人员**: ${typedParams.participants}\n` : ''}\n---\n\n`;

      const fullContent = header + meetingNotes;
      fs.writeFileSync(outputPath, fullContent, 'utf-8');

      const processingTime = Date.now() - startTime;

      logger.info('[会议记录] 完成', {
        outputPath,
        transcriptLength: transcript.length,
        processingTimeMs: processingTime,
      });

      return {
        success: true,
        output: fullContent,
        metadata: {
          filePath,
          outputPath,
          audioDuration: formatDuration(duration),
          audioDurationSeconds: duration,
          transcriptLength: transcript.length,
          notesLength: meetingNotes.length,
          processingTimeMs: processingTime,
        },
      };
    } catch (error: any) {
      logger.error('[会议记录] 失败', { error: error.message });
      return {
        success: false,
        error: `会议记录处理失败: ${error.message}`,
      };
    }
  },
};
